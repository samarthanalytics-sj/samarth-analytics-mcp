/**
 * McpChatPanel - the GTM and GA4 AI chat tab.
 *
 * Copy to: src/components/McpChatPanel.tsx in the gtm-ai-automator repo.
 *
 * Differences from the existing GTMChatAssistantUI: responses stream token by token, the assistant
 * can actually read the user's live container or property through MCP tools, and every tool call is
 * shown as a chip so the user can see what it looked at rather than trusting a claim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useGTMContainer } from '@/contexts/GTMContainerContext';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Copy,
  Loader2,
  Send,
  Square,
  Terminal,
  User,
  XCircle,
} from 'lucide-react';
import {
  expandCommand,
  fetchCommands,
  useMcpChat,
  type ChatProduct,
  type ChatTurn,
  type ToolTrace,
} from '@/hooks/useMcpChat';

const STARTERS: Record<ChatProduct, string[]> = {
  gtm: [
    'What is in my container right now?',
    'Which tags are paused or have no firing trigger?',
    'Why might my purchase tag not be firing?',
    'Audit this container and show me the errors first.',
  ],
  ga4: [
    'Which key events are configured on this property?',
    'Show me sessions by channel for the last 28 days.',
    'What custom dimensions and metrics exist?',
    'Is enhanced measurement on, and what is it collecting?',
  ],
};

export function McpChatPanel() {
  const [product, setProduct] = useState<ChatProduct>('gtm');
  const [input, setInput] = useState('');
  const [commands, setCommands] = useState<{ name: string; title: string; description: string }[]>(
    [],
  );
  const { selectedContainer } = useGTMContainer();
  const { turns, send, stop, reset, isStreaming, usage } = useMcpChat(product);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCommands().then(setCommands).catch(() => setCommands([]));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  const context = useMemo(
    () => ({
      accountId: selectedContainer?.accountId,
      containerId: selectedContainer?.containerId,
      workspaceId: selectedContainer?.selectedWorkspace?.workspaceId,
    }),
    [selectedContainer],
  );

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    void send(text, context);
  }, [context, input, isStreaming, send]);

  const runCommand = useCallback(
    async (name: string) => {
      if (isStreaming) return;
      const text = await expandCommand(name, {
        account: context.accountId ?? '',
        container: context.containerId ?? '',
      });
      if (text) void send(text, context);
    },
    [context, isStreaming, send],
  );

  return (
    <Card className="flex h-[calc(100vh-12rem)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <Tabs value={product} onValueChange={(v) => setProduct(v as ChatProduct)}>
          <TabsList>
            <TabsTrigger value="gtm">Tag Manager</TabsTrigger>
            <TabsTrigger value="ga4">Analytics 4</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          {selectedContainer ? (
            <Badge variant="secondary" className="font-normal">
              {selectedContainer.name}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              No container selected
            </Badge>
          )}
          <Badge variant="outline" className="font-normal text-muted-foreground">
            Read-only
          </Badge>
          {turns.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={isStreaming}>
              New chat
            </Button>
          )}
        </div>
      </div>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 p-0">
        <ScrollArea className="min-h-0 flex-1 px-4 pt-4">
          {turns.length === 0 ? (
            <EmptyState
              product={product}
              commands={commands}
              onPick={(text) => void send(text, context)}
              onCommand={runCommand}
              disabled={isStreaming}
            />
          ) : (
            <div className="flex flex-col gap-6 pb-4">
              {turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} isStreaming={isStreaming} />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </ScrollArea>

        <div className="border-t p-4">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                product === 'gtm'
                  ? 'Ask about your container, tags, triggers, or variables'
                  : 'Ask about your GA4 property, events, or reports'
              }
              rows={2}
              className="max-h-40 min-h-[2.75rem] resize-none"
              disabled={isStreaming}
            />
            {isStreaming ? (
              <Button onClick={stop} variant="secondary" size="icon" aria-label="Stop generating">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={submit} disabled={!input.trim()} size="icon" aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Answers come from your live {product === 'gtm' ? 'container' : 'property'}. This chat can
            read but not change anything.
            {usage.promptTokens > 0 && (
              <span className="ml-2 tabular-nums">
                {(usage.promptTokens + usage.completionTokens).toLocaleString()} tokens this session
              </span>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  product,
  commands,
  onPick,
  onCommand,
  disabled,
}: {
  product: ChatProduct;
  commands: { name: string; title: string; description: string }[];
  onPick: (text: string) => void;
  onCommand: (name: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-10">
      <div className="text-center">
        <Bot className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <h3 className="text-lg font-semibold">
          {product === 'gtm' ? 'Ask about your GTM container' : 'Ask about your GA4 property'}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Connected to your account, so it answers from what is actually configured.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {STARTERS[product].map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            disabled={disabled}
            className="rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      {commands.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Guided workflows
          </p>
          <div className="flex flex-wrap gap-2">
            {commands.map((c) => (
              <Button
                key={c.name}
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onCommand(c.name)}
                title={c.description}
              >
                /{c.name}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TurnView({ turn, isStreaming }: { turn: ChatTurn; isStreaming: boolean }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[85%] rounded-lg bg-primary px-4 py-2 text-primary-foreground">
          <p className="whitespace-pre-wrap text-sm">{turn.content}</p>
        </div>
        <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
          <User className="h-4 w-4" />
        </div>
      </div>
    );
  }

  const waiting = isStreaming && !turn.content && turn.tools.length === 0;

  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {turn.tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {turn.tools.map((tool) => (
              <ToolChip key={tool.id} tool={tool} />
            ))}
          </div>
        )}

        {waiting ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Thinking
          </div>
        ) : (
          turn.content && <MessageBody content={turn.content} />
        )}

        {turn.note && <p className="text-xs text-muted-foreground">{turn.note}</p>}

        {turn.error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{turn.error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolTrace }) {
  const icon =
    tool.status === 'running' ? (
      <Loader2 className="h-3 w-3 animate-spin" />
    ) : tool.status === 'ok' ? (
      <CheckCircle2 className="h-3 w-3 text-emerald-600" />
    ) : (
      <XCircle className="h-3 w-3 text-destructive" />
    );

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
      title={tool.summary ?? tool.name}
    >
      {icon}
      <Terminal className="h-3 w-3" />
      <code className="font-mono">{tool.name}</code>
    </span>
  );
}

/**
 * Minimal markdown rendering: fenced code blocks get their own block with a copy button, everything
 * else stays plain text. Deliberately not an HTML renderer, because model output is untrusted.
 */
function MessageBody({ content }: { content: string }) {
  const blocks = useMemo(() => splitFences(content), [content]);

  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <CodeBlock key={i} code={block.text} lang={block.lang} />
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {block.text}
          </p>
        ),
      )}
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative rounded-md border bg-muted/50">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{lang || 'code'}</span>
        <Button variant="ghost" size="sm" className="h-6 px-2" onClick={copy}>
          <Copy className="mr-1 h-3 w-3" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3">
        <code className="font-mono text-xs">{code}</code>
      </pre>
    </div>
  );
}

interface Block {
  type: 'text' | 'code';
  text: string;
  lang?: string;
}

/** Splits on triple-backtick fences, tolerating an unterminated fence mid-stream. */
function splitFences(content: string): Block[] {
  const blocks: Block[] = [];
  const parts = content.split(/```/);

  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      if (part.trim()) blocks.push({ type: 'text', text: part.trim() });
      return;
    }
    const newline = part.indexOf('\n');
    const lang = newline > 0 ? part.slice(0, newline).trim() : '';
    const code = newline > 0 ? part.slice(newline + 1) : part;
    blocks.push({ type: 'code', text: code.replace(/\n$/, ''), lang });
  });

  return blocks;
}
