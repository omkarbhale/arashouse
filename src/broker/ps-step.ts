// One step of a generated Windows script (`baseline-steps.ps1`, `slot-steps.ps1`): a
// `powershell.exe -File <script> -Step <name>` process with a JSON request on stdin and one marked
// result line on stdout. A non-zero exit, or no result line, is the step's error, from its last stderr lines.

import { spawn } from "node:child_process";
import { redact } from "../core/redact.js";
import { RESULT_MARKER } from "./baseline-steps.js";

export interface PsStepOptions {
  /** The step is killed past this. */
  readonly timeoutMs: number;
  /** Told each stderr line (redacted). */
  readonly onLog?: (line: string) => void;
}

/** Runs one step; resolves with its result object. The request may carry a secret: it goes only to stdin. */
export function runPsScript(script: string, step: string, request: object, options: PsStepOptions): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Step", step], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      err += d;
      for (const line of d.split(/\r?\n/)) if (line.trim()) options.onLog?.(redact(line.trim()));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith(RESULT_MARKER));
      if (code !== 0 || line === undefined) {
        const why = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(" / ");
        reject(new Error(redact(`${step} failed (exit ${code ?? "killed"})${why ? `: ${why}` : ""}`)));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(RESULT_MARKER.length)) as Record<string, unknown>);
      } catch {
        reject(new Error(`${step} answered something that is not JSON`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
