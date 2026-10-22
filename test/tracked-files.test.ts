import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findSecretShapes, forbiddenTrackedReason, repoRoot, trackedFiles, trackedTextFiles } from "./helpers.js";

describe("tracked files", () => {
  it("holds no installer, backup, archive, key, licence or media file", () => {
    const offenders = trackedFiles()
      .map((path) => ({ path, reason: forbiddenTrackedReason(path) }))
      .filter((o) => o.reason);
    expect(offenders).toEqual([]);
  });

  it("holds no licence-key-shaped value and no literal PASSWORD or SECRET assignment", () => {
    const offenders = trackedTextFiles()
      .map(({ path, text }) => ({ path, shapes: findSecretShapes(text) }))
      .filter((o) => o.shapes.length > 0);
    expect(offenders).toEqual([]);
  });
});

describe("forbiddenTrackedReason", () => {
  it.each(["a.msi", "dir/Core140.BAK", "x.zip", "id.key", "aras.lic", "media/12sp9/InnovatorSetup.msi", "media/notes.txt"])(
    "rejects %s",
    (path) => {
      expect(forbiddenTrackedReason(path)).toBeDefined();
    },
  );

  it.each(["media/README.md", "src/core/index.ts", "docs/README.md", "package.json"])("allows %s", (path) => {
    expect(forbiddenTrackedReason(path)).toBeUndefined();
  });
});

describe("findSecretShapes", () => {
  // Samples are assembled from parts so this file never contains a secret-shaped literal itself.
  const sample = (...parts: string[]) => parts.join("");

  it.each([
    sample("lic_key", "=", "ABCD-1234"),
    sample("ACT_KEY", " = ", "abc123"),
    sample("sa_pass", "word", " = ", '"', "hunter2", '"'),
    sample("const API_SEC", "RET", ": ", "'", "tok", "'", ";"),
    sample("SA_PASS", "WORD", "=", "hunter2"),
    sample("export DB_SEC", "RET", "=", "hunter2"),
    sample("set SA_PASS", "WORD", "=", "hunter2"),
    sample("$env:SA_PASS", "WORD", " = ", "'", "hunter2", "'"),
  ])("flags %s", (text) => {
    expect(findSecretShapes(text)).not.toEqual([]);
  });

  it.each([
    sample("lic_key", "="),
    sample("lic_key", "= ", "\n"),
    sample("sa_pass", "word", " = ", '""'),
    sample("const pass", "word", ": string;"),
    sample("const pass", "word", " = await promptHidden();"),
    sample("SA_PASS", "WORD", "=", "$", "{SA_PASS", "WORD}"),
    sample("SA_PASS", "WORD", "=", "$", "SA_PASS", "WORD"),
    sample("pass", "word", " = ", '"', "$", "SA", '"'),
    "The SQL sa password is typed at a hidden prompt and never stored.",
  ])("ignores %s", (text) => {
    expect(findSecretShapes(text)).toEqual([]);
  });
});

describe(".gitignore", () => {
  const ignored = (path: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  };

  it.each([
    "media/12sp9/InnovatorSetup.msi",
    "media/23/Core140.bak",
    "media/35/CD.zip",
    "media/notes.txt",
    "InnovatorSetup.msi",
    "Core140.bak",
    "image.zip",
    ".arashouse/state.json",
    "spike-out/run1/log.txt",
    "secrets/sa",
    "token.key",
    "aras.lic",
    ".env",
    ".env.local",
    "node_modules/x/index.js",
    "dist/cli/index.js",
  ])("ignores %s", (path) => {
    expect(ignored(path)).toBe(true);
  });

  it.each(["media/README.md", "src/cli/index.ts", "docs/README.md", "package.json"])("does not ignore %s", (path) => {
    expect(ignored(path)).toBe(false);
  });
});
