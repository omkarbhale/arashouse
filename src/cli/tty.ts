// The WSL-side hidden prompt: a no-echo TTY read. The typed characters are never written to the
// output; only the question and a final newline are.

import type { HiddenPrompter } from "../core/secret-store.js";
import { Secret, type SecretKind } from "../core/secret.js";

/** The slice of a TTY input stream the reader uses (a `tty.ReadStream`, or a stand-in in tests). */
export interface TtyInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TtyOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

/** The user pressed Ctrl-C at the prompt. */
export class PromptAbortedError extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptAbortedError";
  }
}

/**
 * Read one line from `input` in raw mode, without echo. Enter or Ctrl-D ends it, Backspace edits it,
 * Ctrl-C throws PromptAbortedError. If the input ends or fails first, it throws. Raw mode is always
 * restored.
 */
export function readHiddenLine(input: TtyInput, output: TtyOutput, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("a hidden prompt needs a terminal"));
      return;
    }
    let line = "";
    output.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();

    const finish = (done: () => void) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      done();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish(() => resolve(line));
          return;
        }
        if (ch === "\u0003") {
          finish(() => reject(new PromptAbortedError()));
          return;
        }
        if (ch === "\u007f" || ch === "\b") line = Array.from(line).slice(0, -1).join("");
        else if (ch >= " ") line += ch;
      }
    };
    const onEnd = () => finish(() => reject(new Error("the terminal closed before the prompt was answered")));
    const onError = (error: Error) =>
      finish(() => reject(new Error(`the terminal failed before the prompt was answered: ${error.message}`)));
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

/** A HiddenPrompter on a terminal: interactive only when both input and output are TTYs. */
export function ttyPrompter(input: TtyInput = process.stdin, output: TtyOutput = process.stderr): HiddenPrompter {
  return {
    get interactive() {
      return Boolean(input.isTTY && output.isTTY);
    },
    async promptSecret(question: string, kind: SecretKind): Promise<Secret> {
      return Secret.of(await readHiddenLine(input, output, question), kind);
    },
  };
}
