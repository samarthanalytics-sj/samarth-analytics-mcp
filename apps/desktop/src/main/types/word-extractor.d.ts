// word-extractor ships no types. Minimal surface used by attachments.ts.
declare module 'word-extractor' {
  class Document {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
  }
  export default class WordExtractor {
    extract(filePathOrBuffer: string | Buffer): Promise<Document>;
  }
}
