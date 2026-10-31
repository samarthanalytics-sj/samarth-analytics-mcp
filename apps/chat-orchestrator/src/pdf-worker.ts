/**
 * Worker thread entry: extracts a PDF's text with pdf-parse (pdf.js) away from the main thread.
 *
 * Run only by extractPdf in attachments.ts, which starts it with heap limits, watches its memory and
 * terminates it on a deadline. That is the whole point of the thread: pdf.js inflates each stream
 * whole and has no size cap of its own, so a small upload could otherwise decode to gigabytes in
 * the one process every user's turn runs in.
 *
 * Self-contained on purpose. No relative imports, so it resolves the same way whether tsx runs it
 * from src/ or node runs it from the compiled dist/ next to attachments.js.
 */
import { parentPort, workerData } from 'node:worker_threads';

interface PdfJob {
  data: ArrayBuffer;
  /** Characters worth sending back. The true length travels separately, so truncation stays honest. */
  maxChars: number;
}

const job = workerData as PdfJob;

const run = async (): Promise<void> => {
  const { PDFParse } = await import('pdf-parse');
  // Loading pdf.js is a fixed cost, not the file's. Said here so the caller measures from now on.
  parentPort!.postMessage({ ready: true });
  const parser = new PDFParse({ data: new Uint8Array(job.data) });
  try {
    const out = await parser.getText();
    // pdf-parse writes a "-- 1 of 3 --" marker per page even when a page has no text, so a scan
    // would come back as markers alone. Empty means no page had text, which the caller narrates.
    const text = out.pages.some((p) => p.text.trim()) ? String(out.text ?? '') : '';
    parentPort!.postMessage({ ok: true, text: text.slice(0, job.maxChars), chars: text.length });
  } finally {
    await parser.destroy().catch(() => undefined);
  }
};

run().catch((err: unknown) => {
  parentPort!.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
});
