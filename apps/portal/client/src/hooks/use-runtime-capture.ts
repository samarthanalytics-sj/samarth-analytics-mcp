import { useState } from "react";

export interface RuntimeCapture {
  runtimeText: string;
  runtimeCapture: unknown;
  runtimeError: string;
  /** True once a parseable capture object is loaded. */
  ready: boolean;
  /** Parse and apply pasted/typed text (empty string clears the capture). */
  applyRuntimeText: (text: string) => void;
  /** Read a file and apply its text, surfacing a read error on failure. */
  onRuntimeFile: (file: File | null) => Promise<void>;
  /** Lazily load the synthetic sample capture and apply it. */
  loadSample: () => Promise<void>;
  /** Lazily load the synthetic sample capture and trigger a JSON download. */
  downloadSample: () => Promise<void>;
}

/**
 * Optional runtime-capture import shared by the audit and consent-v2 pages.
 * Runtime evidence is never fabricated — runtime/reconciliation checks only
 * activate once a parseable JSON object is supplied here. The ~6 KB synthetic
 * sample is imported dynamically so it never bloats a page's initial chunk.
 *
 * `onApplied` runs after a sample is loaded (used to scroll the input into
 * view).
 */
export function useRuntimeCapture(onApplied?: () => void): RuntimeCapture {
  const [runtimeText, setRuntimeText] = useState<string>("");
  const [runtimeCapture, setRuntimeCapture] = useState<unknown>(null);
  const [runtimeError, setRuntimeError] = useState<string>("");

  const applyRuntimeText = (text: string) => {
    setRuntimeText(text);
    setRuntimeError("");
    const trimmed = text.trim();
    if (!trimmed) {
      setRuntimeCapture(null);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Not a JSON object");
      }
      setRuntimeCapture(parsed);
    } catch (e) {
      setRuntimeCapture(null);
      setRuntimeError(
        e instanceof Error ? `Invalid JSON: ${e.message}` : "Invalid JSON",
      );
    }
  };

  const onRuntimeFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      applyRuntimeText(text);
    } catch {
      setRuntimeError("Could not read that file.");
    }
  };

  const loadSample = async () => {
    const { SAMPLE_RUNTIME_CAPTURE_JSON } = await import(
      "@/lib/sample-runtime-capture"
    );
    applyRuntimeText(SAMPLE_RUNTIME_CAPTURE_JSON);
    onApplied?.();
  };

  const downloadSample = async () => {
    if (typeof window === "undefined") return;
    const { SAMPLE_RUNTIME_CAPTURE_JSON } = await import(
      "@/lib/sample-runtime-capture"
    );
    const blob = new Blob([SAMPLE_RUNTIME_CAPTURE_JSON], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sample-runtime-capture.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return {
    runtimeText,
    runtimeCapture,
    runtimeError,
    ready: Boolean(runtimeCapture),
    applyRuntimeText,
    onRuntimeFile,
    loadSample,
    downloadSample,
  };
}
