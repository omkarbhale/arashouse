import { describe, expect, it } from "vitest";
import { FLAVORS, FLAVOR_KEYS, RUNTIME_DIRS } from "./flavors.js";
import {
  type ManifestEntry,
  ManifestError,
  assertManifestPath,
  compareTree,
  computeManifestHash,
  formatMtime,
  isFastHashed,
  isRuntimeDir,
  isRuntimePath,
  makeManifest,
  parseManifest,
  pathsToHash,
  serializeManifest,
  summarizeDiff,
} from "./manifest.js";

const H = (c: string) => c.repeat(64);
const entry = (path: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  path,
  size: 10,
  mtime: "2026-10-22T10:11:12.1234567Z",
  sha256: H("a"),
  ...over,
});

describe("runtime directories", () => {
  it("every flavor lists the same runtime directories", () => {
    for (const key of FLAVOR_KEYS) expect(FLAVORS[key].runtimeDirs).toBe(RUNTIME_DIRS);
  });

  it("treats everything under Innovator/Server/temp, dll and logs as runtime, case-insensitively", () => {
    for (const p of ["Innovator/Server/temp/a.tmp", "innovator/server/TEMP/x/y.bin", "Innovator/Server/dll/M.dll", "Innovator/Server/logs/s.log"]) {
      expect(isRuntimePath(p, RUNTIME_DIRS)).toBe(true);
    }
    expect(isRuntimeDir("Innovator/Server/temp", RUNTIME_DIRS)).toBe(true);
    expect(isRuntimeDir("Innovator/Server/temp/sub", RUNTIME_DIRS)).toBe(true);
    expect(isRuntimeDir("Innovator/Server/bin", RUNTIME_DIRS)).toBe(false);
    expect(isRuntimePath("Innovator/Server/templates/a.xml", RUNTIME_DIRS)).toBe(false);
  });

  it("matches the OAuth sqlite and key files by name and nothing else in that folder", () => {
    for (const p of ["OAuthServer/App_Data/oauth.sqlite", "OAuthServer/App_Data/OAuth.SQLITE-wal", "OAuthServer/App_Data/key-1.xml"]) {
      expect(isRuntimePath(p, RUNTIME_DIRS)).toBe(true);
    }
    for (const p of ["OAuthServer/App_Data/readme.xml", "OAuthServer/App_Data/sub/key-1.xml", "OAuthServer/web.config"]) {
      expect(isRuntimePath(p, RUNTIME_DIRS)).toBe(false);
    }
    expect(isRuntimeDir("OAuthServer/App_Data", RUNTIME_DIRS)).toBe(false);
  });

  it("matches the 14.x client and server data-protection keys and nothing else in their App_Data", () => {
    for (const p of ["Innovator/Client/App_Data/key-3eb86b36-9737-4c47-952b-ebec180b19b8.xml", "Innovator/Server/App_Data/KEY-1.xml"]) {
      expect(isRuntimePath(p, RUNTIME_DIRS)).toBe(true);
    }
    for (const p of ["Innovator/Client/App_Data/readme.xml", "Innovator/Server/App_Data/a.sqlite", "Innovator/Client/App_Data/sub/key-1.xml"]) {
      expect(isRuntimePath(p, RUNTIME_DIRS)).toBe(false);
    }
  });

  it("hashes configs and Innovator/Server/bin DLLs in the fast set only", () => {
    expect(isFastHashed("Server/web.config")).toBe(true);
    expect(isFastHashed("Client/Web.Config")).toBe(true);
    expect(isFastHashed("Innovator/Server/bin/Aras.Server.Core.dll")).toBe(true);
    expect(isFastHashed("Client/bin/Other.dll")).toBe(false);
    expect(isFastHashed("Client/app.js")).toBe(false);
  });
});

describe("mtime formatting", () => {
  it("keeps 100 ns resolution", () => {
    expect(formatMtime(1_761_127_872_123_456_700n)).toBe("2025-10-22T10:11:12.1234567Z");
    expect(formatMtime(1_761_127_872_000_000_000n)).toBe("2025-10-22T10:11:12.0000000Z");
    expect(formatMtime(1_761_127_872_000_000_099n)).toBe("2025-10-22T10:11:12.0000000Z");
  });
});

describe("manifest paths", () => {
  it("rejects absolute, backslash, dot and empty-segment paths", () => {
    for (const bad of ["", "/etc/x", "C:/x", "a\\b", "a/../b", "./a", "a//b", "a/b/", "a\0b"]) {
      expect(() => assertManifestPath(bad), bad).toThrow(ManifestError);
    }
    expect(() => assertManifestPath("Client/a b/c.js")).not.toThrow();
  });
});

describe("manifest hash and file", () => {
  it("sorts entries, so input order does not change the hash", () => {
    const a = makeManifest("35", null, [entry("b/x"), entry("a/y"), entry("a/x")]);
    const b = makeManifest("35", null, [entry("a/x"), entry("b/x"), entry("a/y")]);
    expect(a.files.map((f) => f.path)).toEqual(["a/x", "a/y", "b/x"]);
    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.manifestHash).toBe(computeManifestHash(a.files));
  });

  it("changes with any field of any entry", () => {
    const base = makeManifest("35", null, [entry("a"), entry("b")]).manifestHash;
    for (const over of [{ size: 11 }, { mtime: "2026-10-22T10:11:12.1234568Z" }, { sha256: H("b") }]) {
      expect(makeManifest("35", null, [entry("a", over), entry("b")]).manifestHash).not.toBe(base);
    }
    expect(makeManifest("35", null, [entry("a"), entry("c")]).manifestHash).not.toBe(base);
  });

  it("rejects duplicates, an empty list and malformed entries", () => {
    expect(() => makeManifest("35", null, [entry("a"), entry("a")])).toThrow(/duplicate/);
    expect(() => makeManifest("35", null, [])).toThrow(ManifestError);
    expect(() => makeManifest("35", null, [entry("a", { sha256: "xyz" })])).toThrow(/sha256/);
    expect(() => makeManifest("35", null, [entry("a", { mtime: "yesterday" })])).toThrow(/mtime/);
    expect(() => makeManifest("35", null, [entry("a", { size: -1 })])).toThrow(/size/);
  });

  it("round-trips and detects edits", () => {
    const manifest = makeManifest("23", "14.0.9.36073", [entry("a"), entry("b/c", { size: 5 })]);
    const text = serializeManifest(manifest);
    expect(text.split("\n").length).toBe(5);
    expect(parseManifest(text)).toEqual(manifest);
    expect(() => parseManifest(text.replace('"size":5', '"size":6'))).toThrow(/tampered|counts/);
    expect(() => parseManifest(text.replace('"sha256":"' + H("a") + '"', '"sha256":"' + H("b") + '"'))).toThrow(
      expect.objectContaining({ code: "tampered" }),
    );
    expect(() => parseManifest("{")).toThrow(/JSON/);
    expect(() => parseManifest(text.replace('"flavor":"23"', '"flavor":"OLM_Local"'))).toThrow(/unknown flavor/);
  });

  it("rejects unsorted entries", () => {
    const manifest = makeManifest("35", null, [entry("a"), entry("b")]);
    const text = serializeManifest(manifest).replace('"path":"a"', '"path":"c"');
    expect(() => parseManifest(text)).toThrow(/not sorted/);
  });
});

describe("compareTree", () => {
  const manifest = makeManifest("35", null, [entry("Server/web.config"), entry("Client/a.js")]);
  const seen = (path: string, over = {}) => ({ path, kind: "file" as const, size: 10, mtime: "2026-10-22T10:11:12.1234567Z", ...over });
  const opts = { level: "fast" as const, runtimeDirs: RUNTIME_DIRS };

  it("passes on a match", () => {
    const diff = compareTree(manifest, [seen("Client/a.js"), seen("Server/web.config")], new Map(), opts);
    expect(diff).toMatchObject({ ok: true, checked: 2, hashed: 0, counts: { missing: 0, changed: 0, extra: 0 } });
    expect(summarizeDiff(diff)).toBe("fast verify passed: 2 files checked");
  });

  it("records every reason on one file and an unreadable hash", () => {
    const diff = compareTree(
      manifest,
      [seen("Client/a.js", { size: 9, mtime: "2026-10-23T00:00:00.0000000Z" }), seen("Server/web.config")],
      new Map([["Server/web.config", null]]),
      opts,
    );
    expect(diff.changed).toEqual([
      { path: "Client/a.js", reasons: ["size", "mtime"] },
      { path: "Server/web.config", reasons: ["unreadable"] },
    ]);
    expect(summarizeDiff(diff)).toContain("0 missing, 2 changed, 0 extra");
  });

  it("does not flag a runtime path even if the scan passes one in", () => {
    const diff = compareTree(manifest, [seen("Client/a.js"), seen("Server/web.config"), seen("Innovator/Server/temp/x.tmp")], new Map(), opts);
    expect(diff.ok).toBe(true);
  });

  it("skips manifest entries that sit in a runtime directory", () => {
    const odd = makeManifest("35", null, [entry("Client/a.js"), entry("Innovator/Server/temp/old.tmp")]);
    const diff = compareTree(odd, [seen("Client/a.js")], new Map(), opts);
    expect(diff).toMatchObject({ ok: true, checked: 1, skippedRuntime: 1 });
  });

  it("needs a rendered file present but leaves its size, time and content to the caller, without case", () => {
    const rendered = ["server/WEB.config"];
    const observed = [seen("Client/a.js"), seen("Server/web.config", { size: 99, mtime: "2026-10-28T00:00:00.0000000Z" })];
    expect(pathsToHash(manifest, observed, "fast", RUNTIME_DIRS, rendered)).toEqual([]);
    expect(pathsToHash(manifest, observed, "fast", RUNTIME_DIRS)).toEqual(["Server/web.config"]);
    expect(compareTree(manifest, observed, new Map(), { ...opts, rendered })).toMatchObject({ ok: true, checked: 2, hashed: 0 });
    expect(compareTree(manifest, observed, new Map(), opts).changed).toEqual([{ path: "Server/web.config", reasons: ["size", "mtime"] }]);
    expect(compareTree(manifest, [seen("Client/a.js")], new Map(), { ...opts, rendered }).missing).toEqual(["Server/web.config"]);
  });

  it("fails on a problem even when every path matches", () => {
    const diff = compareTree(manifest, [seen("Client/a.js"), seen("Server/web.config")], new Map(), { ...opts, problems: ["wrong build"] });
    expect(diff.ok).toBe(false);
    expect(summarizeDiff(diff)).toContain("wrong build");
  });
});
