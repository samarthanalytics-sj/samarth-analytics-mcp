// The structured main-process logger. Emits leveled lines ([INFO]/[SUCCESS]/[WARNING]/[ERROR]),
// section/banner blocks, and a closing startup summary - so the terminal reads as grouped sections
// with a clear health check at the end instead of a flat wall of lines. Writes via console (so the
// readable-console transliteration from log-format.ts still applies) and tallies each level for the
// summary.

import { banner, section, logLine, LogTally, type LogLevel } from '../shared/log-report';

class Logger {
  readonly tally = new LogTally();

  private write(level: LogLevel, message: string, details: string[]): void {
    this.tally.note(level);
    // console.error keeps these on stderr alongside the app's existing diagnostics.
    console.error(logLine(level, message, details.filter((d) => d !== '')));
  }

  info(message: string, ...details: string[]): void {
    this.write('INFO', message, details);
  }
  success(message: string, ...details: string[]): void {
    this.write('SUCCESS', message, details);
  }
  warn(message: string, ...details: string[]): void {
    this.write('WARNING', message, details);
  }
  error(message: string, ...details: string[]): void {
    this.write('ERROR', message, details);
  }

  /** A framed title banner with optional aligned rows (used for the app header). */
  banner(title: string, rows: Array<[string, string]> = []): void {
    console.error('\n' + banner(title, rows));
  }
  /** A section divider that groups the lines that follow it. */
  section(title: string): void {
    console.error('\n' + section(title));
  }
  /** The closing Startup Summary: a status checklist plus the per-level counts. */
  summary(statuses: string[] = []): void {
    console.error('\n' + this.tally.summary(statuses));
  }
}

export const log = new Logger();
