import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS, type FlavorKey } from "./flavors.js";
import { PROTECTED_FILE_PATTERNS } from "./extract.js";
import { GuardError } from "./guards.js";
import { assertNothingSecretStaged, baselineMessage, ignoreRules, isCommitId, isGitTarget, isNeverCommitted, renderGitignore } from "./git-baseline.js";

/** The paths `git check-ignore` says the flavor's `.gitignore` ignores, of `paths` (relative to Innovator\). */
function ignoredBy(flavor: FlavorKey, paths: readonly string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "arashouse-gitignore-"));
  try {
    execFileSync("git", ["init", "--quiet", "--template=", dir], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    execFileSync("git", ["-C", dir, "config", "core.ignorecase", "true"]);
    writeFileSync(join(dir, ".gitignore"), renderGitignore(flavor));
    let out = "";
    try {
      out = execFileSync("git", ["-C", dir, "check-ignore", "--no-index", "--stdin"], { input: paths.join("\n"), encoding: "utf8" });
    } catch (err) {
      // Exit 1: none of them is ignored.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    return out.split("\n").filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Files the baseline must commit: code a holder edits, and configs that carry no slot value. */
const KEPT = ["Client/scripts/Innovator.aspx", "Client/javascript/x.js", "Client/web.config", "Server/web.config", "web.config", "Server/bin/Aras.Server.Core.dll", "Server/Innovator.xml.bak", "Client/jsBundles/main.js"];

/** Files it must never commit or must leave out, measured on the host (docs/git-baseline.md). */
const IGNORED = [
  "Server/OAuth.config",
  "Server/App_Data/Certificates/InnovatorServer.pfx",
  "Server/App_Data/Certificates/OAuthServer.cer",
  "Server/App_Data/key-bbdf65e3-b72d-402c-bc82-6b8c21541822.xml",
  "Client/App_Data/key-c0ac9652-cb95-46de-bf9a-90bc3da2fe94.xml",
  "Client/Innovator.xml",
  "Server/innovator.xml",
  "Server/temp/2026-10-28.log",
  "Server/dll/method.dll",
  "Server/logs/debug.xml",
  "Client/jsBundles/data.json",
  "Client/jsBundles/compile.log",
  "Client/somewhere/vault.config",
  "Some/Deep/InnovatorServerConfig.xml",
];

describe("the generated .gitignore", () => {
  it.each(FLAVOR_KEYS)("%s: ignores the secrets, the slot's own files and the runtime files, and keeps the code", (flavor) => {
    expect(ignoredBy(flavor, [...IGNORED, ...KEPT]).sort()).toEqual([...IGNORED].sort());
  });

  it("ignores 14.35's client OAuth certificate and config, which 12 SP9 and Release 23 do not have", () => {
    const client35 = ["Client/OAuth.ClientServer.config", "Client/App_Data/Certificates/InnovatorClientServer.pfx"];
    expect(ignoredBy("35", client35)).toEqual(client35);
    expect(ignoredBy("12sp9", ["Client/OAuth.ClientServer.config"])).toEqual([]);
  });

  it("has every protected file name, a note per rule, and LF line endings", () => {
    for (const flavor of FLAVOR_KEYS) {
      const text = renderGitignore(flavor);
      for (const pattern of PROTECTED_FILE_PATTERNS) expect(text.split("\n"), `${flavor} ${pattern}`).toContain(pattern);
      expect(text).not.toContain("\r");
      expect(ignoreRules(flavor).every((r) => r.note.length > 0)).toBe(true);
    }
  });
});

describe("the commit's guards", () => {
  it("knows a secret wherever it is, by name and by the secret rules' paths", () => {
    expect(isNeverCommitted("12sp9", "Server/App_Data/Certificates/a.pfx")).toBe(true);
    expect(isNeverCommitted("12sp9", "server/oauth.config")).toBe(true);
    expect(isNeverCommitted("12sp9", "Server/App_Data/Certificates/readme.txt")).toBe(true);
    expect(isNeverCommitted("35", "Client/OAuth.ClientServer.config")).toBe(true);
    expect(isNeverCommitted("12sp9", "Client/OAuth.ClientServer.config")).toBe(false);
    expect(isNeverCommitted("23", "Client/Innovator.xml")).toBe(false);
    expect(isNeverCommitted("23", "Client/web.config")).toBe(false);
  });

  it("refuses a commit that stages one, naming it", () => {
    expect(() => assertNothingSecretStaged("23", ["Client/a.js", "Client/x/key-1.xml"])).toThrow(GuardError);
    expect(() => assertNothingSecretStaged("23", ["Client/a.js", "Client/x/key-1.xml"])).toThrow(/Client\/x\/key-1\.xml/);
    expect(() => assertNothingSecretStaged("23", ["Client/a.js", ".gitignore"])).not.toThrow();
  });

  it("names the repository's place, the commit and its id", () => {
    expect(isGitTarget("Innovator/.git/config")).toBe(true);
    expect(isGitTarget("innovator/.GITIGNORE")).toBe(true);
    expect(isGitTarget("Innovator/Client/.gitignore")).toBe(false);
    expect(isGitTarget("Innovator/.github/x")).toBe(false);
    expect(baselineMessage("35", "a".repeat(32))).toBe(`arashouse baseline 35 ${"a".repeat(32)}`);
    expect(isCommitId("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isCommitId("HEAD")).toBe(false);
  });
});
