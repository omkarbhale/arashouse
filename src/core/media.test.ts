import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEDIA_ENV,
  MediaError,
  expectedMediaFiles,
  mediaDir,
  mediaFile,
  missingMedia,
  requireMediaFile,
  resolveMediaRoot,
} from "./media.js";

let sandbox: string;
let main: string;
let worktree: string;
let nested: string;
let outside: string;
let other: string;
/** A state home with no config.json, so no machine's own config is read. */
let noConfig: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "ignore" },
  );

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "arashouse-media-")));
  main = join(sandbox, "main");
  worktree = join(sandbox, "worktree");
  outside = join(sandbox, "outside");
  other = join(sandbox, "other");
  noConfig = { ARASHOUSE_HOME: join(sandbox, "home") };
  mkdirSync(main);
  mkdirSync(outside);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "x");
  writeFileSync(join(main, "package.json"), JSON.stringify({ name: "arashouse" }));
  git(main, "add", "README.md", "package.json");
  git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", "--detach", worktree);
  nested = join(worktree, "src", "core");
  mkdirSync(nested, { recursive: true });
  // The installers sit only in the main checkout, as they do for real.
  mkdirSync(join(main, "media", "23"), { recursive: true });
  for (const name of ["InnovatorSetup.msi", "Core140.bak"]) writeFileSync(join(main, "media", "23", name), "x");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("media resolver", () => {
  it("finds the main checkout's media from the main checkout", () => {
    expect(resolveMediaRoot({ env: noConfig, startDir: main })).toBe(join(main, "media"));
    expect(resolveMediaRoot({ env: noConfig, startDir: join(main, "media") })).toBe(join(main, "media"));
  });

  it("finds the same folder from a worktree, even though the worktree has no media of its own", () => {
    expect(resolveMediaRoot({ env: noConfig, startDir: worktree })).toBe(join(main, "media"));
    expect(resolveMediaRoot({ env: noConfig, startDir: nested })).toBe(join(main, "media"));
    expect(mediaDir("23", { env: noConfig, startDir: worktree })).toBe(join(main, "media", "23"));
  });

  it("lets ARASHOUSE_MEDIA override, from anywhere", () => {
    const env = { ...noConfig, [MEDIA_ENV]: join(outside, "m") };
    expect(resolveMediaRoot({ env, startDir: main })).toBe(join(outside, "m"));
    expect(resolveMediaRoot({ env, startDir: worktree })).toBe(join(outside, "m"));
    expect(resolveMediaRoot({ env, startDir: outside })).toBe(join(outside, "m"));
    expect(mediaDir("35", { env, startDir: outside })).toBe(join(outside, "m", "35"));
    expect(resolveMediaRoot({ env: { ...noConfig, [MEDIA_ENV]: " " }, startDir: worktree })).toBe(join(main, "media"));
  });

  it("is not thrown off by a GIT_DIR in the environment", () => {
    const env = { ...noConfig, GIT_DIR: join(outside, "nope") };
    expect(resolveMediaRoot({ env, startDir: worktree })).toBe(join(main, "media"));
  });

  it("explains itself when there is no checkout to start from", () => {
    expect(() => resolveMediaRoot({ env: noConfig, startDir: outside })).toThrow(MediaError);
    expect(() => resolveMediaRoot({ env: noConfig, startDir: outside })).toThrow(/ARASHOUSE_MEDIA/);
  });

  it("takes config.json's media when ARASHOUSE_MEDIA is not set", () => {
    const home = join(sandbox, "configured-home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ media: join(outside, "from-config") }));
    expect(resolveMediaRoot({ env: { ARASHOUSE_HOME: home }, startDir: outside })).toBe(join(outside, "from-config"));
    expect(resolveMediaRoot({ env: { ARASHOUSE_HOME: home, [MEDIA_ENV]: join(outside, "m") }, startDir: outside })).toBe(join(outside, "m"));
    expect(resolveMediaRoot({ env: noConfig, startDir: outside, configured: join(outside, "given") })).toBe(join(outside, "given"));
  });

  it("takes the media the WSL launcher's checkout has, after ARASHOUSE_MEDIA and config.json, before its own", () => {
    const launched = { ...noConfig, ARASHOUSE_CHECKOUT_MEDIA: join(outside, "checkout-media") };
    expect(resolveMediaRoot({ env: launched, startDir: outside })).toBe(join(outside, "checkout-media"));
    expect(resolveMediaRoot({ env: launched, startDir: main })).toBe(join(outside, "checkout-media"));
    expect(resolveMediaRoot({ env: { ...launched, [MEDIA_ENV]: join(outside, "m") }, startDir: outside })).toBe(join(outside, "m"));
    expect(resolveMediaRoot({ env: launched, startDir: outside, configured: join(outside, "given") })).toBe(join(outside, "given"));
  });

  it("never takes another repository's media/: a copy vendored into it names its media explicitly", () => {
    mkdirSync(join(other, "vendor", "arashouse", "dist"), { recursive: true });
    git(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "aras-mr-envs" }));
    mkdirSync(join(other, "media", "23"), { recursive: true });
    const vendored = join(other, "vendor", "arashouse", "dist");
    expect(() => resolveMediaRoot({ env: noConfig, startDir: vendored })).toThrow(/not in its own checkout .*aras-mr-envs.*ARASHOUSE_MEDIA.*config\.json/);
    expect(resolveMediaRoot({ env: { ...noConfig, [MEDIA_ENV]: join(outside, "m") }, startDir: vendored })).toBe(join(outside, "m"));
  });

  it("names the expected files per flavor", () => {
    expect(expectedMediaFiles("23")).toEqual(["InnovatorSetup.msi", "Core140.bak", "CoreAndSolutions140.bak"]);
    expect(expectedMediaFiles("12sp9")).toEqual(["InnovatorSetup.msi", "Core120.bak", "CoreAndSolutions120.bak"]);
  });

  it("reports what is missing and returns what is present", () => {
    const opts = { env: noConfig, startDir: worktree };
    expect(missingMedia("23", opts)).toEqual(["CoreAndSolutions140.bak"]);
    expect(missingMedia("12sp9", opts)).toEqual(expectedMediaFiles("12sp9"));
    expect(requireMediaFile("23", "Core140.bak", opts)).toBe(join(main, "media", "23", "Core140.bak"));
  });

  it("gives an error naming the exact path and the list, never a stack trace", () => {
    const opts = { env: noConfig, startDir: worktree };
    const missingFile = () => requireMediaFile("23", "CoreAndSolutions140.bak", opts);
    expect(missingFile).toThrow(MediaError);
    expect(missingFile).toThrow(join(main, "media", "23", "CoreAndSolutions140.bak"));
    expect(missingFile).toThrow(/ticket 02/);
    expect(missingFile).toThrow(/InnovatorSetup\.msi, Core140\.bak, CoreAndSolutions140\.bak/);
    const missingFolder = () => requireMediaFile("35", "InnovatorSetup.msi", opts);
    expect(missingFolder).toThrow(join(main, "media", "35", "InnovatorSetup.msi"));
    expect(missingFolder).toThrow(/folder does not exist/);
  });

  it("refuses a file name that is not plain", () => {
    const opts = { env: noConfig, startDir: worktree };
    for (const bad of ["", "..", "../x", "a/b", "a\\b"]) expect(() => mediaFile("23", bad, opts)).toThrow(MediaError);
  });
});
