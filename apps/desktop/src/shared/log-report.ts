// Pure formatting for the structured main-process startup log: banners, sections, leveled lines, and
// a startup summary. No I/O or electron - the main-process logger (main/logger.ts) writes these
// strings to the console. Levels: INFO (progress), SUCCESS (done), WARNING (recoverable), ERROR (fail).

export type LogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';

/** The horizontal rule that frames banners and sections. */
export const RULE = '='.repeat(60);

/** A framed banner with a title and optional aligned "Key : Value" rows. */
export function banner(title: string, rows: Array<[string, string]> = []): string {
  const out = [RULE, title];
  if (rows.length) {
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) out.push(`${k.padEnd(w)} : ${v}`);
  }
  out.push(RULE);
  return out.join('\n');
}

/** A section divider: the title framed by rules. */
export function section(title: string): string {
  return `${RULE}\n${title}\n${RULE}`;
}

/** One leveled line, e.g. "[SUCCESS] GTM Tools Loaded", with optional indented detail lines. */
export function logLine(level: LogLevel, message: string, details: string[] = []): string {
  const head = `[${level}] ${message}`;
  return details.length ? head + '\n' + details.map((d) => `  ${d}`).join('\n') : head;
}

/** Counts leveled lines as they are emitted, then renders the closing "Startup Summary". */
export class LogTally {
  private readonly counts: Record<LogLevel, number> = { INFO: 0, SUCCESS: 0, WARNING: 0, ERROR: 0 };

  note(level: LogLevel): void {
    this.counts[level] += 1;
  }
  count(level: LogLevel): number {
    return this.counts[level];
  }

  /** The Startup Summary block: an optional status checklist, then the per-level counts. */
  summary(statuses: string[] = []): string {
    const levels: LogLevel[] = ['INFO', 'SUCCESS', 'WARNING', 'ERROR'];
    const w = Math.max(...levels.map((l) => l.length));
    const lines = [RULE, 'Startup Summary', RULE, ...statuses];
    if (statuses.length) lines.push('');
    for (const l of levels) lines.push(`${l.padEnd(w)} : ${this.counts[l]}`);
    lines.push(RULE);
    return lines.join('\n');
  }
}
