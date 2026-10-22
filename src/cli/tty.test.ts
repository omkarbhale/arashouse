import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PromptAbortedError, readHiddenLine, ttyPrompter, type TtyInput } from "./tty.js";

const TYPED = ["Ty", "ped", "-", "Secret", "9"].join("");

class FakeTty extends PassThrough {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(mode: boolean) {
    this.raw.push(mode);
    return this;
  }
}

function setup(isTTY = true) {
  const input = new FakeTty();
  input.isTTY = isTTY;
  const written: string[] = [];
  const output = { isTTY, write: (t: string) => (written.push(t), true) };
  return { input, output, written };
}

describe("readHiddenLine", () => {
  it("returns the typed line, echoes nothing and restores the terminal", async () => {
    const { input, output, written } = setup();
    const pending = readHiddenLine(input as unknown as TtyInput, output, "Key: ");
    input.write(TYPED + "\r");
    expect(await pending).toBe(TYPED);
    expect(written.join("")).toBe("Key: \n");
    expect(written.join("")).not.toContain(TYPED);
    expect(input.raw).toEqual([true, false]);
  });

  it("handles backspace, a key split over chunks and Ctrl-D", async () => {
    const { input, output } = setup();
    const pending = readHiddenLine(input as unknown as TtyInput, output, "Key: ");
    input.write("abcx\u007f");
    input.write("d");
    input.write("\u0004");
    expect(await pending).toBe("abcd");
  });

  it("ignores control characters and what follows the Enter", async () => {
    const { input, output } = setup();
    const pending = readHiddenLine(input as unknown as TtyInput, output, "Key: ");
    input.write("a\u001b\tb\nignored");
    expect(await pending).toBe("ab");
  });

  it("throws on Ctrl-C and restores the terminal", async () => {
    const { input, output } = setup();
    const pending = readHiddenLine(input as unknown as TtyInput, output, "Key: ");
    input.write("abc\u0003");
    await expect(pending).rejects.toBeInstanceOf(PromptAbortedError);
    expect(input.raw).toEqual([true, false]);
  });

  it("rejects and restores the terminal when the input ends before Enter", async () => {
    const { input, output } = setup();
    const pending = readHiddenLine(input as unknown as TtyInput, output, "Key: ");
    input.write("abc");
    input.end();
    await expect(pending).rejects.toThrow("the terminal closed before the prompt was answered");
    expect(input.raw).toEqual([true, false]);
  });

  it("rejects and restores the terminal when the input fails before Enter", async () => {
    const { input, output } = setup();
    const pending = readHiddenLine(input as unknown as TtyInput, output, "Key: ");
    input.destroy(new Error("EIO"));
    await expect(pending).rejects.toThrow("the terminal failed before the prompt was answered: EIO");
    expect(input.raw).toEqual([true, false]);
  });

  it("refuses without a terminal and writes nothing", async () => {
    const { input, output, written } = setup(false);
    await expect(readHiddenLine(input as unknown as TtyInput, output, "Key: ")).rejects.toThrow(/needs a terminal/);
    expect(written).toEqual([]);
  });
});

describe("ttyPrompter", () => {
  it("is interactive only when input and output are both terminals", () => {
    const both = setup(true);
    expect(ttyPrompter(both.input as unknown as TtyInput, both.output).interactive).toBe(true);
    const piped = setup(false);
    expect(ttyPrompter(piped.input as unknown as TtyInput, piped.output).interactive).toBe(false);
    const outOnly = { isTTY: false, write: () => true };
    expect(ttyPrompter(both.input as unknown as TtyInput, outOnly).interactive).toBe(false);
  });

  it("wraps the answer as a Secret that never prints", async () => {
    const { input, output, written } = setup();
    const prompter = ttyPrompter(input as unknown as TtyInput, output);
    const pending = prompter.promptSecret("Key: ", "licence");
    input.write(TYPED + "\n");
    const secret = await pending;
    expect(secret.reveal()).toBe(TYPED);
    expect(secret.kind).toBe("licence");
    expect(`${secret}${written.join("")}`).not.toContain(TYPED);
  });
});
