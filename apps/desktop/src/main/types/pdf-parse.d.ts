// pdf-parse ships no types. Only the lib file is imported (the package root runs a debug harness
// under ESM import - see attachments.ts).
declare module 'pdf-parse/lib/pdf-parse.js' {
  const pdfParse: (data: Buffer) => Promise<{ text: string; numpages?: number }>;
  export default pdfParse;
}
