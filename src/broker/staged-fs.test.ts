// The staged-folder reads on a real filesystem (Linux in CI; Node reports a Windows junction as a symbolic link too).

import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostError } from "../host/errors.js";
import { copyStaged, entryKind, listStaged, readStaged, removeFile, removeStaged } from "./staged-fs.js";

let dir: string;
let staged: string;
let secret: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "arashouse-staged-"));
  staged = join(dir, "staging", "lease", "code", "1");
  await mkdir(join(staged, "Client"), { recursive: true });
  await writeFile(join(staged, "Client", "a.js"), "a");
  // A file the worker could not read: what a link in the staged folder would point the broker at.
  secret = join(dir, "secrets", "x.bin");
  await mkdir(join(dir, "secrets"));
  await writeFile(secret, "SECRET-BYTES");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function refusal(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

describe("listStaged", () => {
  it("lists the plain files and names the links without walking into them", async () => {
    await symlink(join(dir, "secrets"), join(staged, "Client", "linked"));
    await symlink(secret, join(staged, "x.bin"));
    const listing = await listStaged(staged);
    expect(listing.files).toEqual([{ path: "Client/a.js", size: 1 }]);
    expect([...listing.refused].sort()).toEqual(["Client/linked", "x.bin"]);
  });

  it.skipIf(process.getuid?.() === 0)("refuses what it cannot look at, rather than failing", async () => {
    await mkdir(join(staged, "locked"));
    await writeFile(join(staged, "locked", "x.js"), "x");
    await chmod(join(staged, "locked"), 0o000);
    try {
      const listing = await listStaged(staged);
      expect(listing.refused).toEqual(["locked"]);
      expect(listing.files).toEqual([{ path: "Client/a.js", size: 1 }]);
    } finally {
      await chmod(join(staged, "locked"), 0o700);
    }
  });

  it("refuses a staged folder that is a link or missing", async () => {
    await symlink(staged, join(dir, "staging", "lease", "code", "2"));
    expect((await refusal(listStaged(join(dir, "staging", "lease", "code", "2")))).kind).toBe("Refused");
    expect((await refusal(listStaged(join(dir, "nothing")))).kind).toBe("Refused");
  });
});

describe("copyStaged and readStaged", () => {
  it("copies a plain file through a temporary file, and reads one", async () => {
    const to = join(dir, "slot", "Innovator", "Client", "a.js");
    expect(await copyStaged(join(staged, "Client", "a.js"), to)).toMatchObject({ bytes: 1 });
    expect(await readFile(to, "utf8")).toBe("a");
    expect(new TextDecoder().decode(await readStaged(join(staged, "Client", "a.js"), 10))).toBe("a");
    expect((await refusal(readStaged(join(staged, "Client", "a.js"), 0))).message).toMatch(/larger than 0 bytes/);
  });

  it("refuses a staged symbolic link and a staged hard link, so no file the worker cannot read is copied", async () => {
    await symlink(secret, join(staged, "sym.bin"));
    await link(secret, join(staged, "hard.bin"));
    const to = join(dir, "slot", "out.bin");
    for (const name of ["sym.bin", "hard.bin"]) {
      expect((await refusal(copyStaged(join(staged, name), to))).kind, name).toBe("Refused");
      expect((await refusal(readStaged(join(staged, name), 100))).kind, name).toBe("Refused");
    }
    expect(await entryKind(to)).toBe("missing");
  });

  it("replaces a hard link in the slot's tree rather than writing through it", async () => {
    const target = join(dir, "slot", "Innovator", "x.dll");
    await mkdir(join(dir, "slot", "Innovator"), { recursive: true });
    await link(secret, target);
    await copyStaged(join(staged, "Client", "a.js"), target);
    expect(await readFile(target, "utf8")).toBe("a");
    expect(await readFile(secret, "utf8")).toBe("SECRET-BYTES");
  });
});

describe("removeFile and entryKind", () => {
  it("deletes a plain file, answers false for none, and refuses a folder or a link", async () => {
    await symlink(secret, join(staged, "sym.bin"));
    expect(await entryKind(join(staged, "Client"))).toBe("dir");
    expect(await entryKind(join(staged, "sym.bin"))).toBe("link");
    expect(await removeFile(join(staged, "Client", "a.js"))).toBe(true);
    expect(await removeFile(join(staged, "Client", "a.js"))).toBe(false);
    expect((await refusal(removeFile(join(staged, "Client")))).kind).toBe("Refused");
    expect((await refusal(removeFile(join(staged, "sym.bin")))).kind).toBe("Refused");
    expect(await readFile(secret, "utf8")).toBe("SECRET-BYTES");
  });
});

describe("removeStaged", () => {
  it("removes the staged folder, each link in it removed itself and never followed", async () => {
    await symlink(join(dir, "secrets"), join(staged, "Client", "linked"));
    await symlink(secret, join(staged, "x.bin"));
    await removeStaged(staged);
    expect(await entryKind(staged)).toBe("missing");
    expect(await readFile(secret, "utf8")).toBe("SECRET-BYTES");
    await removeStaged(staged);
  });
});
