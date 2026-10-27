import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "./flavors.js";
import { DEFAULT_INSTALL_ROOT } from "./names.js";
import {
  FOLDER_ACL,
  ROOT_FOLDERS,
  brokerWrapperSource,
  checkSetup,
  prerequisitesFor,
  renderSetupHostScript,
  serviceSid,
  type SetupObservation,
  type SetupScriptOptions,
} from "./setup-host.js";

const HASH = "a".repeat(64);
const base: SetupScriptOptions = {
  version: "0.0.0",
  worker: { name: "sg\\omkarb", sid: "S-1-5-21-1111111111-2222222222-3333333333-1001" },
  flavors: [...FLAVOR_KEYS],
  appFiles: [
    { path: "broker\\index.js", sha256: HASH },
    { path: "broker\\client.js", sha256: HASH },
    { path: "core\\names.js", sha256: HASH },
  ],
  packageJsonSha256: HASH,
};
const script = renderSetupHostScript(base);

/**
 * The script with comments, here-strings and string contents blanked out (same length, so offsets
 * still line up), leaving only code. Enough PowerShell for this script: '...' with '' escapes, "..."
 * without nested quotes, # comments, and @' ... '@ here-strings.
 */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "@" && text.startsWith("@'\n", i)) {
      const end = text.indexOf("\n'@", i);
      const stop = end === -1 ? text.length : end + 3;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === c && text[j + 1] === c && c === "'") j += 2;
        else if (text[j] === c) break;
        else j++;
      }
      out += c + text.slice(i + 1, j).replace(/[^\n]/g, " ") + c;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** [start, end) of the brace block that opens at or after `from`. */
function blockAt(code: string, from: number): [number, number] {
  const open = code.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return [open, i + 1];
  }
  throw new Error(`unbalanced block at ${from}`);
}

/** The functions that change the host; each may be called only from an `Invoke-Change` block. */
const CHANGE_FUNCTIONS = ["New-Folder", "Set-FolderAcl", "Protect-Root", "Copy-BrokerApp", "Build-Wrapper", "Stop-Broker", "Invoke-Native"];
const MUTATING =
  /\b(New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Out-File|Set-Acl|SetAccessControl|New-Service|Set-Service|Start-Service|Stop-Service|Restart-Service|Add-Type|Add-MpPreference|Set-MpPreference|Remove-MpPreference|Add-LocalGroupMember|Remove-LocalGroupMember|robocopy|icacls|takeown|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b/g;

const inside = (at: number, ranges: Iterable<[number, number]>) => [...ranges].some(([s, e]) => at > s && at < e);

/** Every change the script could make outside an `Invoke-Change` block, as "<what> at line <n>". */
function strayChanges(text: string): { stray: string[]; blocks: number } {
  const code = codeOnly(text);
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const changeBlocks: [number, number][] = [...code.matchAll(/Invoke-Change\s/g)]
    .filter((m) => !code.slice(Math.max(0, (m.index ?? 0) - 9), m.index).includes("function"))
    .map((m) => blockAt(code, m.index ?? 0));
  const bodies = new Map(CHANGE_FUNCTIONS.map((name) => [name, blockAt(code, code.indexOf(`function ${name}`))] as const));
  const allowed = [...changeBlocks, ...bodies.values()];
  const stray: string[] = [];
  for (const m of code.matchAll(MUTATING)) if (!inside(m.index ?? 0, allowed)) stray.push(`${m[0]} at line ${lineOf(m.index ?? 0)}`);
  for (const name of CHANGE_FUNCTIONS) {
    for (const m of code.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      const at = m.index ?? 0;
      if (code.slice(Math.max(0, at - 9), at).includes("function")) continue;
      if (!inside(at, allowed)) stray.push(`${name} at line ${lineOf(at)}`);
    }
  }
  return { stray, blocks: changeBlocks.length };
}

const code = codeOnly(script);
const changeRanges = (): [number, number][] =>
  [...code.matchAll(/(Invoke-Change\s|function (New-Folder|Set-FolderAcl|Protect-Root|Copy-BrokerApp|Build-Wrapper|Stop-Broker|Invoke-Native))/g)]
    .filter((m) => !(m[0].startsWith("Invoke") && code.slice(Math.max(0, (m.index ?? 0) - 9), m.index).includes("function")))
    .map((m) => blockAt(code, m.index ?? 0));

describe("setup-host.ps1 (generated)", () => {
  it("is plain ASCII, so Windows PowerShell 5.1 reads it without a BOM", () => {
    expect(script).toMatch(/^[\x00-\x7f]*$/);
  });

  it("names the broker's virtual account by the SID Windows derives from the service name", () => {
    // `sc.exe showsid ArasHouseBroker` on the host, 2026-10-27.
    expect(serviceSid("ArasHouseBroker")).toBe("S-1-5-80-2179007529-4189020980-2315442869-1883171808-2238769431");
    expect(script).toContain("$BrokerSid = 'S-1-5-80-2179007529-4189020980-2315442869-1883171808-2238769431'");
    expect(script).toContain("$BrokerAccount = 'NT SERVICE\\ArasHouseBroker'");
  });

  it("changes nothing without -Apply: every change is made inside an Invoke-Change block", () => {
    expect(script).toMatch(/param\(\s*\[switch\]\$Apply,/);
    const invoke = code.slice(...blockAt(code, code.indexOf("function Invoke-Change(")));
    // The dry-run branch returns before the action runs.
    expect(invoke.indexOf("if (-not $Apply)")).toBeGreaterThan(-1);
    expect(invoke.indexOf("return")).toBeLessThan(invoke.indexOf("& $Action"));
    const { stray, blocks } = strayChanges(script);
    expect(blocks).toBeGreaterThan(15);
    expect(stray).toEqual([]);
    // The scanner itself: a change outside a block, or a change function called outside one, is caught.
    const tail = "\nexit 0\n";
    expect(strayChanges(script.replace(new RegExp(`${tail}$`), `\nNew-Item -Path 'x' -Force${tail}`)).stray).toEqual([expect.stringMatching(/^New-Item at line/)]);
    expect(strayChanges(script.replace(new RegExp(`${tail}$`), `\nProtect-Root${tail}`)).stray).toEqual([expect.stringMatching(/^Protect-Root at line/)]);
    // The one write outside Invoke-Change is the record, and only with -Apply.
    const writes = script.split("\n").filter((l) => /WriteAllText/.test(l));
    expect(writes).toEqual([expect.stringMatching(/^if \(\$Apply -and /)]);
  });

  it("writes nothing under Program Files, and reads it only through $env:ProgramFiles", () => {
    expect(script).not.toMatch(/[A-Za-z]:\\program files/i);
    // The words appear only where the script refuses such a target.
    const mentions = script.split("\n").filter((l) => /program files/i.test(l) && !l.trimStart().startsWith("#"));
    expect(mentions).toEqual([expect.stringContaining("if ($full -match '(?i)program files') { throw")]);
    for (const m of code.matchAll(/\$env:ProgramFiles/g)) {
      expect(inside(m.index ?? 0, changeRanges())).toBe(false);
    }
    // The script refuses a write target under Program Files or outside the root.
    expect(script).toContain("if ($full -match '(?i)program files') { throw");
  });

  it("derives every path from the root constant", () => {
    const root = "D:\\ah_setup_test";
    const other = renderSetupHostScript({ ...base, root });
    expect(other).not.toContain(DEFAULT_INSTALL_ROOT);
    const paths = [...other.matchAll(/(?<![A-Za-z])[A-Za-z]:\\[^'"\s;)]*/g)].map((m) => m[0]);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) expect(p.startsWith(root), p).toBe(true);
    expect(other).toContain(`$Root = '${root}'`);
    for (const folder of ROOT_FOLDERS) expect(other).toContain(`'${folder}' = '${root}\\${folder}'`);
  });

  it("carries the folder ACLs of the plan", () => {
    for (const folder of ROOT_FOLDERS) {
      const line = script.split("\n").find((l) => l.startsWith(`    '${folder}' = @{`));
      expect(line, folder).toBeDefined();
      for (const [principal, right] of Object.entries(FOLDER_ACL[folder])) expect(line).toContain(`${principal} = '${right}'`);
    }
    expect(FOLDER_ACL.staging.worker).toBe("modify");
    expect(FOLDER_ACL.slots.worker).toBe("read");
    expect(FOLDER_ACL.secrets).toEqual({ system: "full", broker: "modify" });
    for (const folder of ROOT_FOLDERS) expect(FOLDER_ACL[folder].broker, folder).toBe("modify");
    expect(Object.entries(FOLDER_ACL).filter(([, acl]) => acl.worker).map(([f]) => f).sort()).toEqual(["broker", "slots", "staging"]);
    expect(Object.entries(FOLDER_ACL).filter(([, acl]) => acl.sql).map(([f, acl]) => `${f}:${acl.sql}`).sort()).toEqual(["golden:read", "sqldata:modify", "staging:read"]);
  });

  it("pins the broker build by SHA-256 and checks it after copying", () => {
    expect(script).toContain(`    @{ path = 'broker\\index.js'; sha256 = '${HASH}' }`);
    expect(script).toContain(`$PackageJsonSha256 = '${HASH}'`);
    expect(script).toContain("is not the one this script was generated with");
  });

  it("checks the prerequisites of the flavors it is given, and installs none", () => {
    expect(prerequisitesFor(["35"]).map((p) => p.id)).toEqual(["iis", "netfx-4.7.2", "aspnetcore-8.0", "ancm-v2", "vcredist-14-x64"]);
    expect(prerequisitesFor(["12sp9", "23"]).find((p) => p.id === "iis")?.flavors).toEqual(["12sp9", "23"]);
    const only23 = renderSetupHostScript({ ...base, flavors: ["23"] });
    expect(only23).toContain("id = 'aspnetcore-6.0'; flavors = '23'");
    expect(only23).not.toContain("aspnetcore-8.0'");
    expect(script).not.toMatch(/Install-WindowsFeature|Enable-WindowsOptionalFeature|msiexec|dotnet-hosting|vc_redist/i);
  });

  it("holds no secret: no token, password or key is read or written", () => {
    expect(script).not.toMatch(/client\.token|password|licen[cs]e|ConvertTo-SecureString|Read-Host/i);
  });

  it("refuses unusable options", () => {
    const bad: [Partial<SetupScriptOptions>, RegExp][] = [
      [{ worker: { name: "omkarb", sid: base.worker.sid } }, /DOMAIN\\user/],
      [{ worker: { name: "sg\\omkarb'; rm", sid: base.worker.sid } }, /DOMAIN\\user/],
      [{ worker: { name: base.worker.name, sid: "S-1-5-18" } }, /account SID/],
      [{ appFiles: [{ path: "..\\x.js", sha256: HASH }] }, /unusable broker build path/],
      [{ appFiles: [{ path: "core\\x.js", sha256: HASH }] }, /no broker\\index\.js/],
      [{ appFiles: [...base.appFiles, { path: "broker\\Index.js", sha256: HASH }] }, /twice/],
      [{ packageJsonSha256: "x" }, /package\.json/],
      [{ flavors: [] }, /at least one flavor/],
      [{ root: "C:\\Program Files\\arashouse" }, /Program Files/],
      [{ root: "C:\\Users\\me\\ah" }, /Users/],
    ];
    for (const [patch, message] of bad) expect(() => renderSetupHostScript({ ...base, ...patch }), JSON.stringify(patch)).toThrow(message);
  });
});

describe("checkSetup (what doctor reads back)", () => {
  const record = {
    schema: 1,
    mode: "install",
    applied: true,
    ok: true,
    time: "2026-10-27T15:00:00Z",
    version: "0.0.0",
    root: { exists: true, aclOk: true },
    folders: ROOT_FOLDERS.map((name) => ({ name, aclOk: true })),
    broker: { status: "Running", ping: "ok" },
    prerequisites: { missing: [] },
    errors: [],
  };
  const access = Object.fromEntries(ROOT_FOLDERS.map((f) => [f, ["slots", "staging", "broker"].includes(f) ? "read" : "denied"])) as SetupObservation["access"];

  it("passes an applied setup the worker sees as planned", () => {
    expect(checkSetup({ record, rootExists: true, access })).toEqual([
      { level: "ok", check: "setup", message: "applied 2026-10-27T15:00:00Z, arashouse 0.0.0: root present, 9 folders with their ACLs, broker Running and answering" },
      { level: "ok", check: "prerequisites", message: "every prerequisite of the flavors in media/ is installed" },
      { level: "ok", check: "setup acl", message: "the worker reads slots\\, staging\\, broker\\ and is kept out of the rest" },
    ]);
  });

  it("fails with no root or no record, and names what the last run did not finish", () => {
    expect(checkSetup({ record: null, rootExists: false, access: {} })).toEqual([
      { level: "fail", check: "setup", message: "the install root is missing; run `arashouse setup` and the script it writes, elevated (docs/setup.md)" },
    ]);
    expect(checkSetup({ record: null, rootExists: true, access })[0]?.message).toMatch(/^no setup record/);
    expect(checkSetup({ record: new Error("bad json"), rootExists: true, access })[0]?.message).toBe("the setup record cannot be read: bad json");
    const half = {
      ...record,
      ok: false,
      folders: record.folders.map((f) => (f.name === "secrets" ? { ...f, aclOk: false } : f)),
      broker: { status: "Stopped", ping: "not run" },
      errors: ["sc.exe failed"],
    };
    expect(checkSetup({ record: half, rootExists: true, access })[0]).toEqual({
      level: "fail",
      check: "setup",
      message: "the last run (2026-10-27T15:00:00Z, arashouse 0.0.0) did not finish: the ACL of secrets; the broker (Stopped, ping not run); sc.exe failed",
    });
    expect(checkSetup({ record: { ...record, applied: false }, rootExists: true, access })[0]?.message).toMatch(/was not an applied install/);
  });

  it("warns about missing prerequisites", () => {
    const r = { ...record, prerequisites: { missing: [{ id: "aspnetcore-8.0", flavors: "35", detail: "x" }] } };
    expect(checkSetup({ record: r, rootExists: true, access })).toContainEqual({ level: "warn", check: "prerequisites", message: "missing: aspnetcore-8.0 (for 35)" });
  });

  it("fails when the worker can read a closed folder or cannot read an open one", () => {
    const leaky = { ...access, secrets: "read", slots: "denied", vaults: "missing" } as SetupObservation["access"];
    expect(checkSetup({ record, rootExists: true, access: leaky }).at(-1)).toEqual({
      level: "fail",
      check: "setup acl",
      message: "the worker cannot read slots\\; vaults\\ is missing; the worker can read secrets\\",
    });
  });
});
