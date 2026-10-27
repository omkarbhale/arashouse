// The broker's audit log: `<root>\logs\broker-YYYYMMDD.log`, one JSON line per request. A line holds
// the time, the request id, the verb, the target (slot id or flavor), the outcome and the time taken,
// and nothing else: no arguments, no message, no token. The fields are taken only from a validated
// request, and the line still goes through `redact` (ticket 23) on its way to the file.

import { appendFile, mkdir } from "node:fs/promises";
import { win32 } from "node:path";
import { auditLogFile } from "../core/names.js";
import { redactingSink } from "../core/redact.js";
import type { HostErrorKind } from "../host/errors.js";

/**
 * - `ok` / `not-ok`: the verb ran and answered `ok: true` / `ok: false`.
 * - a `HostErrorKind`: the verb (or the guards before it) failed that way.
 * - `unauthorised`: the connection did not present the broker's token.
 * - `malformed`: the request line was not a request (bad JSON, too large, a broken envelope).
 */
export type AuditOutcome = "ok" | "not-ok" | HostErrorKind | "unauthorised" | "malformed";

export interface AuditEntry {
  /** ISO time the request arrived. */
  readonly time: string;
  /** The request id, or null when the request had no valid one. */
  readonly id: string | null;
  /** The verb, or null when the request had no valid one. */
  readonly verb: string | null;
  /** The slot id or flavor the request named, or null. */
  readonly target: string | null;
  readonly outcome: AuditOutcome;
  readonly ms: number;
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/** The entry with its fields in a fixed order, so a stray field can never ride along. */
function pick(entry: AuditEntry): AuditEntry {
  return { time: entry.time, id: entry.id, verb: entry.verb, target: entry.target, outcome: entry.outcome, ms: entry.ms };
}

/** One audit line, redacted, without its newline. */
export function auditLine(entry: AuditEntry): string {
  let line = "";
  redactingSink((text) => {
    line = text;
  })(pick(entry));
  return line;
}

export interface FileAuditOptions {
  /** Appends text to a file, creating it; defaults to `fs.appendFile`. Tests map the Windows path to a local one here. */
  readonly append?: (file: string, text: string) => Promise<void>;
  /** Creates a folder and its parents; defaults to `fs.mkdir(..., { recursive: true })`. */
  readonly mkdirp?: (dir: string) => Promise<void>;
}

/** The audit log on disk: each entry goes to the file of its own UTC day under `<root>\logs`. */
export class FileAudit implements AuditSink {
  private readonly append: (file: string, text: string) => Promise<void>;
  private readonly mkdirp: (dir: string) => Promise<void>;
  private madeDir = false;

  constructor(
    private readonly root: string,
    options: FileAuditOptions = {},
  ) {
    this.append = options.append ?? ((file, text) => appendFile(file, text, "utf8"));
    this.mkdirp = options.mkdirp ?? (async (dir) => void (await mkdir(dir, { recursive: true })));
  }

  async write(entry: AuditEntry): Promise<void> {
    const file = auditLogFile(new Date(entry.time), this.root);
    if (!this.madeDir) {
      await this.mkdirp(win32.dirname(file));
      this.madeDir = true;
    }
    await this.append(file, `${auditLine(entry)}\n`);
  }
}

/** An audit sink in memory, for tests. */
export class MemoryAudit implements AuditSink {
  readonly lines: string[] = [];

  async write(entry: AuditEntry): Promise<void> {
    this.lines.push(auditLine(entry));
  }

  entries(): AuditEntry[] {
    return this.lines.map((line) => JSON.parse(line) as AuditEntry);
  }
}
