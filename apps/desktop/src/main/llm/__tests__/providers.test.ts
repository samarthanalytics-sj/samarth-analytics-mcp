import assert from 'node:assert/strict';
import { toOpenAiMessages, parseOpenAiReply, openaiChatBody } from '../openai';
import { toAnthropicMessages, parseAnthropicReply } from '../anthropic';
import { toGeminiContents, parseGeminiReply, geminiFunctionDecl, stripGeminiUnsupported } from '../gemini';
import type { LlmTurn } from '../types';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const convo: LlmTurn[] = [
  { role: 'user', text: 'list accounts' },
  { role: 'assistant', text: 'checking', toolCalls: [{ id: 'c1', name: 'list_gtm_accounts', args: {} }] },
  { role: 'tool', results: [{ id: 'c1', name: 'list_gtm_accounts', content: '[]' }] },
];

console.log('\nLLM provider mappers:');

test('OpenAI: system prepended, tool_calls + tool role mapped', () => {
  const msgs = toOpenAiMessages('SYS', convo);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'SYS');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].tool_calls?.[0].function.name, 'list_gtm_accounts');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
});

test('OpenAI: parse content + tool_calls with JSON args', () => {
  const reply = parseOpenAiReply({
    choices: [
      {
        message: {
          content: 'hi',
          tool_calls: [{ id: '1', type: 'function', function: { name: 't', arguments: '{"x":1}' } }],
        },
      },
    ],
  });
  assert.equal(reply.text, 'hi');
  assert.equal(reply.toolCalls?.[0].name, 't');
  assert.deepEqual(reply.toolCalls?.[0].args, { x: 1 });
});

test('Anthropic: tool_use + tool_result blocks mapped', () => {
  const msgs = toAnthropicMessages(convo);
  assert.equal(msgs[1].content.some((b) => b.type === 'tool_use'), true);
  const toolResultMsg = msgs[2];
  assert.equal(toolResultMsg.role, 'user');
  assert.equal(toolResultMsg.content[0].type, 'tool_result');
  assert.equal(toolResultMsg.content[0].tool_use_id, 'c1');
});

test('Anthropic: parse text + tool_use blocks', () => {
  const reply = parseAnthropicReply({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: '1', name: 't', input: { a: 2 } },
    ],
  });
  assert.equal(reply.text, 'hello');
  assert.equal(reply.toolCalls?.[0].name, 't');
  assert.deepEqual(reply.toolCalls?.[0].args, { a: 2 });
});

test('Gemini: user→user, assistant→model(functionCall), tool→user(functionResponse)', () => {
  const c = toGeminiContents(convo);
  assert.equal(c[0].role, 'user');
  assert.equal(c[1].role, 'model');
  assert.equal(c[1].parts.some((p) => p.functionCall?.name === 'list_gtm_accounts'), true);
  assert.equal(c[2].role, 'user');
  assert.equal(c[2].parts[0].functionResponse?.name, 'list_gtm_accounts');
});

test('Gemini: parse text + functionCall parts', () => {
  const reply = parseGeminiReply({
    candidates: [{ content: { parts: [{ text: 'hi' }, { functionCall: { name: 't', args: { a: 1 } } }] } }],
  });
  assert.equal(reply.text, 'hi');
  assert.equal(reply.toolCalls?.[0].name, 't');
  assert.deepEqual(reply.toolCalls?.[0].args, { a: 1 });
});

test('Gemini: strips additionalProperties RECURSIVELY (nested in array items)', () => {
  // Mirrors the GA4 event-parameter tools: additionalProperties is nested inside
  // parameters.items — Gemini rejects it anywhere, so it must be gone everywhere.
  const schema = {
    type: 'object',
    properties: {
      tagId: { type: 'string' },
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, value: { type: 'string' } },
          required: ['name', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['tagId', 'parameters'],
    additionalProperties: false,
  };
  const json = JSON.stringify(stripGeminiUnsupported(schema));
  assert.equal(json.includes('additionalProperties'), false, 'no additionalProperties survives anywhere');
  // but the meaningful shape is preserved
  const out = stripGeminiUnsupported(schema) as Record<string, any>;
  assert.equal(out.properties.parameters.items.properties.value.type, 'string');
  assert.deepEqual(out.properties.parameters.items.required, ['name', 'value']);
});

test('Gemini: geminiFunctionDecl emits clean params, omits parameters for no-arg tools', () => {
  const withArgs = geminiFunctionDecl({
    name: 'add_ga4_event_parameters_to_all_tags',
    description: 'd',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false },
  });
  assert.equal(withArgs.name, 'add_ga4_event_parameters_to_all_tags');
  assert.ok(withArgs.parameters, 'parameters kept when there are properties');
  assert.equal(JSON.stringify(withArgs).includes('additionalProperties'), false);
  const noArgs = geminiFunctionDecl({ name: 'x', description: 'd', inputSchema: { type: 'object', properties: {} } });
  assert.equal('parameters' in noArgs, false, 'parameters omitted for a no-arg tool');
});

test('OpenAI: request body OMITS tools/tool_choice when there are no tools (empty-array 400 guard)', () => {
  const base = { system: 's', model: 'gpt', apiKey: 'k', messages: [{ role: 'user', text: 'hi' } as LlmTurn] };
  const empty = openaiChatBody({ ...base, tools: [] });
  assert.equal('tools' in empty, false, 'no tools field when empty');
  assert.equal('tool_choice' in empty, false, 'no tool_choice when no tools');
  const withTool = openaiChatBody({ ...base, tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] });
  assert.ok(Array.isArray(withTool.tools) && (withTool.tools as unknown[]).length === 1, 'tools present when supplied');
  assert.equal(withTool.tool_choice, 'auto', 'tool_choice auto when tools present');
});


// ── Native media mapping (pdf/image attachments) ──
const mediaTurn: LlmTurn[] = [
  { role: 'user', text: 'what does the chart show?', media: [
    { kind: 'pdf', mimeType: 'application/pdf', base64: 'UERG', name: 'report.pdf', fallbackText: 'extracted words' },
    { kind: 'image', mimeType: 'image/png', base64: 'UE5H', name: 'shot.png', fallbackText: '[Image attached]' },
  ] },
];

test('Anthropic: pdf -> document block, image -> image block, text last (Claude SEES the pages)', () => {
  const msgs = toAnthropicMessages(mediaTurn);
  const content = msgs[0].content;
  assert.equal(content[0].type, 'document');
  assert.equal(content[0].source!.media_type, 'application/pdf');
  assert.equal(content[0].source!.data, 'UERG');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source!.media_type, 'image/png');
  assert.equal(content[2].type, 'text');
});

test('Gemini: media -> inlineData parts before the text', () => {
  const contents = toGeminiContents(mediaTurn);
  const parts = contents[0].parts as Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;
  assert.equal(parts[0].inlineData!.mimeType, 'application/pdf');
  assert.equal(parts[1].inlineData!.mimeType, 'image/png');
  assert.equal(parts[2].text, 'what does the chart show?');
});

test('OpenAI: image rides as image_url; pdf falls back to its extracted text (no native slot)', () => {
  const msgs = toOpenAiMessages('SYS', mediaTurn);
  const user = msgs[1];
  assert.ok(Array.isArray(user.content), 'content becomes parts when an image is present');
  const parts = user.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(parts[0].type, 'image_url');
  assert.ok(parts[0].image_url!.url.startsWith('data:image/png;base64,'));
  const textPart = parts.find((x) => x.type === 'text')!;
  assert.ok(textPart.text!.includes('extracted words'), 'pdf fallback text included');
  assert.ok(textPart.text!.includes('what does the chart show?'));
});

test('all three: a plain text turn is untouched by the media path', () => {
  const plain: LlmTurn[] = [{ role: 'user', text: 'hi' }];
  assert.deepEqual(toAnthropicMessages(plain)[0].content, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(toGeminiContents(plain)[0].parts, [{ text: 'hi' }]);
  assert.equal(toOpenAiMessages('S', plain)[1].content, 'hi');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
