import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLAVORS } from "../src/core/flavors.js";
import { FAST_VERIFY_BUDGET_MS, ManifestError, isFastHashed, makeManifest, parseManifest, serializeManifest } from "../src/core/manifest.js";
import { SAMPLE_FILES, makeSampleTree, tempDir, writeSampleFile } from "./sample-tree.js";
import { buildManifest, hashFile, readManifest, scanTree, verifyGolden, verifyTree, writeManifestOnce } from "../src/broker/manifest-fs.js";

let dir: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
});
afterEach(async () => {
  await cleanup();
});

/** Flavor `35`'s server build: the sample manifests carry it so the build check passes. */
const BUILD_35 = FLAVORS["35"].serverBuild;

/** A built manifest and its tree, flavor `35`. */
async function sample() {
  const tree = await makeSampleTree(join(dir, "tree"));
  const manifest = await buildManifest(tree, "35", BUILD_35);
  return { tree, manifest };
}

describe("buildManifest", () => {
  it("lists every file outside the runtime directories, hashed and sorted", async () => {
    const { manifest } = await sample();
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toEqual([
      "Client/scripts/app.js",
      "Client/styles/site.css",
      "OAuthServer/App_Data/readme.xml",
      "OAuthServer/web.config",
      "Server/InnovatorServerConfig.xml",
      "Server/bin/Aras.Other.dll",
      "Server/bin/Aras.Server.Core.dll",
      "Server/web.config",
    ]);
    expect(manifest.fileCount).toBe(8);
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.mtime).toBe("2026-10-22T10:11:12.3450000Z");
    }
    expect(manifest.files[0]?.size).toBe(Buffer.byteLength(SAMPLE_FILES["Client/scripts/app.js"] as string));
  });

  it("is deterministic: two builds of the same tree, and of an identical tree, give the same hash", async () => {
    const { tree, manifest } = await sample();
    const again = await buildManifest(tree, "35", BUILD_35);
    expect(again.manifestHash).toBe(manifest.manifestHash);
    expect(serializeManifest(again)).toBe(serializeManifest(manifest));
    const twin = await makeSampleTree(join(dir, "twin"));
    expect((await buildManifest(twin, "35", BUILD_35)).manifestHash).toBe(manifest.manifestHash);
  });

  it("changes the hash when a byte, a size or a timestamp changes", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Client/scripts/app.js", "console.log('CLIENT');\n");
    const changed = await buildManifest(tree, "35", BUILD_35);
    expect(changed.manifestHash).not.toBe(manifest.manifestHash);
    await writeSampleFile(tree, "Client/scripts/app.js", SAMPLE_FILES["Client/scripts/app.js"] as string, new Date("2026-10-23T00:00:00Z"));
    expect((await buildManifest(tree, "35", BUILD_35)).manifestHash).not.toBe(manifest.manifestHash);
  });

  it("does not hash a runtime directory's content into the manifest", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Server/temp/more.tmp", "x");
    await writeSampleFile(tree, "Server/logs/newer.log", "y");
    expect((await buildManifest(tree, "35", BUILD_35)).manifestHash).toBe(manifest.manifestHash);
  });

  it("refuses a tree with a link in it, and an empty tree", async () => {
    const { tree } = await sample();
    await symlink(join(tree, "Client"), join(tree, "Linked"));
    await expect(buildManifest(tree, "35", BUILD_35)).rejects.toMatchObject({ code: "unsupported-entry" });
    const empty = join(dir, "empty");
    await mkdir(empty);
    await expect(buildManifest(empty, "35")).rejects.toMatchObject({ code: "empty" });
  });
});

describe("verifyTree classification", () => {
  it("passes on the tree the manifest was built from, at every level", async () => {
    const { tree, manifest } = await sample();
    for (const level of ["fast", "full", "golden"] as const) {
      const diff = await verifyTree(tree, manifest, { level });
      expect(diff).toMatchObject({ ok: true, level, checked: 8, counts: { missing: 0, changed: 0, extra: 0 }, problems: [] });
    }
  });

  it("classifies a changed byte (same size, same time) in a hashed file at fast, and in any file at full", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Server/web.config", "<configuration><appSettings.../></configuration>\n".slice(0, Buffer.byteLength(SAMPLE_FILES["Server/web.config"] as string)));
    const fast = await verifyTree(tree, manifest, { level: "fast" });
    expect(fast.ok).toBe(false);
    expect(fast.changed).toEqual([{ path: "Server/web.config", reasons: ["content"] }]);

    await writeSampleFile(tree, "Client/scripts/app.js", "console.log('CLIENT');\n");
    expect((await verifyTree(tree, manifest, { level: "fast" })).counts.changed).toBe(1);
    const full = await verifyTree(tree, manifest, { level: "full" });
    expect(full.changed.map((c) => c.path)).toEqual(["Client/scripts/app.js", "Server/web.config"]);
    expect(full.changed.every((c) => c.reasons.join() === "content")).toBe(true);
  });

  it("classifies a changed size", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Client/styles/site.css", "body { margin: 0; } /* more */\n");
    const diff = await verifyTree(tree, manifest, { level: "fast" });
    expect(diff.changed).toEqual([{ path: "Client/styles/site.css", reasons: ["size"] }]);
  });

  it("classifies a touched timestamp", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Client/styles/site.css", SAMPLE_FILES["Client/styles/site.css"] as string, new Date("2026-10-24T00:00:00Z"));
    const diff = await verifyTree(tree, manifest, { level: "fast" });
    expect(diff.changed).toEqual([{ path: "Client/styles/site.css", reasons: ["mtime"] }]);
    expect(diff.counts).toEqual({ missing: 0, changed: 1, extra: 0 });
  });

  it("classifies an extra file, including one a worker added next to the baseline files", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Server/bin/Worker.Method.dll", "worker");
    await writeSampleFile(tree, "Client/new/page.html", "<html/>");
    const diff = await verifyTree(tree, manifest, { level: "fast" });
    expect(diff.ok).toBe(false);
    expect(diff.extra).toEqual(["Client/new/page.html", "Server/bin/Worker.Method.dll"]);
    expect(diff.counts).toEqual({ missing: 0, changed: 0, extra: 2 });
  });

  it("classifies a missing file", async () => {
    const { tree, manifest } = await sample();
    await rm(join(tree, "OAuthServer/web.config"));
    const diff = await verifyTree(tree, manifest, { level: "fast" });
    expect(diff.missing).toEqual(["OAuthServer/web.config"]);
    expect(diff.counts).toEqual({ missing: 1, changed: 0, extra: 0 });
  });

  it("ignores files in a runtime directory: added, changed and removed", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Server/temp/worker-cache.tmp", "deployed by a worker");
    await writeSampleFile(tree, "Server/dll/Worker.dll", "deployed by a worker");
    await writeSampleFile(tree, "Server/logs/server.log", "a much longer log than before\n", new Date("2026-10-25T00:00:00Z"));
    await writeSampleFile(tree, "OAuthServer/App_Data/key-99.xml", "<key/>");
    await rm(join(tree, "OAuthServer/App_Data/oauth.sqlite-wal"));
    const diff = await verifyTree(tree, manifest, { level: "full" });
    expect(diff.ok).toBe(true);
    expect(diff.skippedRuntime).toBeGreaterThan(0);
  });

  it("still flags a non-runtime file next to the runtime ones in OAuthServer/App_Data", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "OAuthServer/App_Data/extra.xml", "<x/>");
    expect((await verifyTree(tree, manifest, { level: "fast" })).extra).toEqual(["OAuthServer/App_Data/extra.xml"]);
  });

  it("reports a link as changed or extra and never enters it", async () => {
    const { tree, manifest } = await sample();
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "not part of the tree");
    await symlink(outside, join(tree, "Client/escape"));
    await rm(join(tree, "Server/web.config"));
    await symlink(join(outside, "secret.txt"), join(tree, "Server/web.config"));
    const diff = await verifyTree(tree, manifest, { level: "full" });
    expect(diff.extra).toEqual(["Client/escape"]);
    expect(diff.changed).toEqual([{ path: "Server/web.config", reasons: ["type"] }]);
  });

  it("limits the listed paths but not the counts", async () => {
    const { tree, manifest } = await sample();
    for (let i = 0; i < 7; i++) await writeSampleFile(tree, `Extra/f${i}.txt`, "x");
    const diff = await verifyTree(tree, manifest, { level: "fast", limit: 3 });
    expect(diff.counts.extra).toBe(7);
    expect(diff.extra).toHaveLength(3);
    expect(diff.truncated).toBe(true);
  });

  it("never puts file contents in the diff", async () => {
    const { tree, manifest } = await sample();
    await writeSampleFile(tree, "Client/scripts/app.js", "TOP-SECRET-CONTENT-MARKER");
    const diff = await verifyTree(tree, manifest, { level: "full" });
    expect(JSON.stringify(diff)).not.toContain("TOP-SECRET-CONTENT-MARKER");
  });

  it("reports a missing tree folder as a problem and everything as missing", async () => {
    const { manifest } = await sample();
    const diff = await verifyTree(join(dir, "nowhere"), manifest, { level: "fast" });
    expect(diff.ok).toBe(false);
    expect(diff.problems).toEqual(["the tree folder does not exist"]);
    expect(diff.counts.missing).toBe(8);
  });
});

describe("the baseline checks", () => {
  it("fails when the manifest's server build is not the registry's", async () => {
    const tree = await makeSampleTree(join(dir, "tree"));
    const wrong = await buildManifest(tree, "23", "14.0.18.39055");
    const diff = await verifyTree(tree, wrong, { level: "golden" });
    expect(diff.ok).toBe(false);
    expect(diff.problems[0]).toContain("14.0.9.36073");
    const right = await buildManifest(tree, "23", FLAVORS["23"].serverBuild);
    expect((await verifyTree(tree, right, { level: "golden" })).ok).toBe(true);
    const unread = await buildManifest(tree, "23");
    expect((await verifyTree(tree, unread, { level: "fast" })).ok).toBe(false);
  });

  it("fails when the manifest is not the golden hash the caller expects", async () => {
    const { tree, manifest } = await sample();
    expect((await verifyTree(tree, manifest, { level: "golden", expectedHash: manifest.manifestHash })).ok).toBe(true);
    const diff = await verifyTree(tree, manifest, { level: "golden", expectedHash: "0".repeat(64) });
    expect(diff.ok).toBe(false);
    expect(diff.problems).toEqual(["the manifest hash is not the expected golden hash"]);
  });

  it("verifies a golden folder against its own manifest.json", async () => {
    const golden = join(dir, "golden", "35");
    const tree = await makeSampleTree(join(golden, "tree"));
    await writeManifestOnce(join(golden, "manifest.json"), await buildManifest(tree, "35", BUILD_35));
    expect((await verifyGolden(golden, "35", { level: "golden" })).ok).toBe(true);
    await writeSampleFile(tree, "Server/web.config", "<tampered/>");
    const diff = await verifyGolden(golden, "35", { level: "golden" });
    expect(diff.ok).toBe(false);
    expect(diff.changed.map((c) => c.path)).toEqual(["Server/web.config"]);
    await expect(verifyGolden(golden, "23", { level: "golden" })).rejects.toBeInstanceOf(ManifestError);
  });
});

describe("the manifest file", () => {
  it("round-trips through writeManifestOnce and readManifest", async () => {
    const { manifest } = await sample();
    const file = join(dir, "golden", "manifest.json");
    await writeManifestOnce(file, manifest);
    expect(await readManifest(file)).toEqual(manifest);
    expect(parseManifest(await readFile(file, "utf8")).manifestHash).toBe(manifest.manifestHash);
  });

  it("is written once: a second write fails and leaves the first untouched", async () => {
    const { manifest } = await sample();
    const file = join(dir, "golden", "manifest.json");
    await writeManifestOnce(file, manifest);
    const before = await readFile(file, "utf8");
    await expect(writeManifestOnce(file, manifest)).rejects.toMatchObject({ code: "exists" });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects a hand-edited manifest as tampered", async () => {
    const { manifest } = await sample();
    const file = join(dir, "manifest.json");
    await writeManifestOnce(file, manifest);
    const text = await readFile(file, "utf8");
    const edited = text.replace(/"size":\d+/, '"size":1');
    await writeFile(join(dir, "edited.json"), edited);
    await expect(readManifest(join(dir, "edited.json"))).rejects.toMatchObject({ code: "tampered" });
  });
});

describe("scanTree", () => {
  it("prunes runtime directories and counts what it skipped", async () => {
    const tree = await makeSampleTree(join(dir, "tree"));
    const scan = await scanTree(tree, FLAVORS["35"].runtimeDirs);
    expect(scan.files.map((f) => f.path)).not.toContain("Server/temp/cache.tmp");
    expect(scan.files).toHaveLength(8);
    // Server/temp, Server/dll and Server/logs pruned; three runtime files in OAuthServer/App_Data skipped.
    expect(scan.skippedRuntime).toBe(6);
  });
});

describe("the fast verify budget", () => {
  it(
    "checks a 40 000-file synthetic tree inside the stat-scan budget",
    async () => {
      const tree = join(dir, "big");
      const dirs = 400;
      const perDir = 100;
      // Plain writes: no per-file mkdir or utimes, so building the tree stays cheap.
      for (let d = 0; d < dirs; d++) {
        const sub = join(tree, "Client", `d${d}`);
        await mkdir(sub, { recursive: true });
        await Promise.all(Array.from({ length: perDir }, (_, f) => writeFile(join(sub, `f${f}.js`), `// ${d}/${f}\n`)));
      }
      await writeSampleFile(tree, "Server/web.config", "<configuration/>");
      await writeSampleFile(tree, "Server/bin/Aras.Server.Core.dll", "MZ");
      // `fast` reads content only for the small hashed set, so the manifest hashes just that set
      // for real; building a real manifest of 40 000 files would only slow the test.
      const { files } = await scanTree(tree, FLAVORS["35"].runtimeDirs);
      const manifest = makeManifest(
        "35",
        BUILD_35,
        await Promise.all(
          files.map(async (o) => ({
            path: o.path,
            size: o.size,
            mtime: o.mtime,
            sha256: isFastHashed(o.path) ? await hashFile(join(tree, o.path)) : "0".repeat(64),
          })),
        ),
      );
      expect(manifest.fileCount).toBe(40_002);

      const start = performance.now();
      const diff = await verifyTree(tree, manifest, { level: "fast" });
      const ms = performance.now() - start;
      expect(diff.ok).toBe(true);
      expect(diff.checked).toBe(40_002);
      expect(ms).toBeLessThan(FAST_VERIFY_BUDGET_MS);

      await writeSampleFile(tree, "Client/d7/extra.js", "x");
      await rm(join(tree, "Client/d9/f9.js"));
      const dirty = await verifyTree(tree, manifest, { level: "fast" });
      expect(dirty.counts).toEqual({ missing: 1, changed: 0, extra: 1 });
    },
    240_000,
  );
});
