#!/usr/bin/env node
/**
 * verify CLI:
 *   verify --url <url> --spec <spec.json> [--headed] [--out report.json]
 *          [--settle-quiet <ms>] [--settle-max <ms>] [--allowlist a.com,b.com]
 *
 * Loads the URL in a real Chromium browser, drives consent + journeys, captures
 * what fired, compares against the spec, and writes a structured JSON report.
 * JSON goes to --out (or stdout); a human-readable summary goes to stderr.
 * Exit code: 1 when overall is Fail, 0 otherwise.
 *
 * This CLI is an explicit local operator invocation, so it performs the full
 * spec-driven interaction (incl. real form submits) without the MCP tool's
 * WEB_AUDIT_ENABLE_VERIFY gate.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { verifyPage, formatHuman, SpecValidationError, type VerifyOptions } from './index.js';
import { PlaywrightMissingError } from '../agent/browser.js';

interface Args {
  url?: string;
  spec?: string;
  headed: boolean;
  out?: string;
  settleQuiet?: number;
  settleMax?: number;
  allowlist?: string[];
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { headed: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => argv[++i];
    switch (a) {
      case '--url': args.url = next(); break;
      case '--spec': args.spec = next(); break;
      case '--headed': args.headed = true; break;
      case '--out': args.out = next(); break;
      case '--settle-quiet': args.settleQuiet = Number(next()); break;
      case '--settle-max': args.settleMax = Number(next()); break;
      case '--allowlist': args.allowlist = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

const USAGE = `verify — TagDrishti Tag Verification Engine

Usage:
  verify --spec <spec.json> [--url <url>] [--headed] [--out <report.json>]
         [--settle-quiet <ms>] [--settle-max <ms>] [--allowlist <a.com,b.com>]

Options:
  --spec          Path to the verification spec (JSON). Required.
  --url           Override the spec's url.
  --headed        Run Chromium headed (debugging; results can differ from headless).
  --out           Write the JSON report to this path (default: stdout).
  --settle-quiet  Stop capturing after this many ms with no new GA4 collect (default 2000).
  --settle-max    Hard cap on capture time in ms (default 10000).
  --allowlist     Comma-separated host suffixes the browser may load.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.spec) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(args.spec, 'utf8'));
  } catch (err) {
    process.stderr.write(`Could not read spec "${args.spec}": ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (args.url && raw && typeof raw === 'object') {
    (raw as Record<string, unknown>).url = args.url;
  }

  const opts: VerifyOptions = { headless: !args.headed };
  if (args.settleQuiet !== undefined && Number.isFinite(args.settleQuiet)) opts.settleQuietMs = args.settleQuiet;
  if (args.settleMax !== undefined && Number.isFinite(args.settleMax)) opts.settleMaxMs = args.settleMax;
  if (args.allowlist) opts.allowlist = args.allowlist;

  let report;
  try {
    report = await verifyPage(raw, opts);
  } catch (err) {
    if (err instanceof SpecValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof PlaywrightMissingError) {
      process.stderr.write(`${err.message}\n`);
      return 3;
    }
    process.stderr.write(`verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(args.out, json, 'utf8');
    process.stderr.write(`report written to ${args.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  process.stderr.write(`\n${formatHuman(report)}\n`);

  return report.overall === 'Fail' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
