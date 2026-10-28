// Ticket 50's adversarial audit, the offline half (docs/audit.md): every broker verb asked to act on names and paths
// the tool must never reach, in the shapes an attacker or an accident would use. Each refusal must happen before
// anything on the host changes. The host half (the pipe's ACL, the ports, SQL as the broker's login, the secret
// search) is recorded in docs/audit.md.

import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planDeploy } from "../src/core/code-deploy.js";
import { DENIED_DATABASES, GuardError, assertOwned, assertValidRoot, nameDenial } from "../src/core/guards.js";
import { DEFAULT_INSTALL_ROOT, slotNames, stagingDir, stampFile, type SlotRef } from "../src/core/names.js";
import { parseRecipe } from "../src/core/recipe.js";
import { backupProblems } from "../src/core/restore.js";
import { HOST_METHODS } from "../src/host/driver.js";
import { MemoryAudit } from "../src/broker/audit.js";
import { registerBaselineVerbs } from "../src/broker/baseline-verbs.js";
import { Broker } from "../src/broker/broker.js";
import { registerDeployVerb } from "../src/broker/code-deploy.js";
import { registerHealthVerb } from "../src/broker/health.js";
import { registerLicenceVerbs } from "../src/broker/licence-verbs.js";
import { mappedRoot, type MappedRoot } from "../src/broker/mapped-fs.fixture.js";
import { registerOotbRootVerb } from "../src/broker/ootb-root.js";
import { HOST_SIDE_VERBS, type BrokerResponse, type BrokerVerb } from "../src/broker/protocol.js";
import { SlotLocks, provisionSlotOnHost, registerSlotVerbs } from "../src/broker/provision.js";
import { registerResetVerbs } from "../src/broker/reset-tree.js";
import { FakeSlotSystem } from "../src/broker/slot-system.fixture.js";
import { registerCoreVerbs } from "../src/broker/verbs.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const LEASE = "a".repeat(32);

/** Look-alikes of `OLM_Local` and of the tool's own names: Cyrillic, Greek and fullwidth letters, a zero-width space. */
const LOOKALIKES = ["ОLM_Local", "OLМ_Local", "ＯＬＭ_Local", "O\u200bLM_Local", "аrashouse_12sp9_01", "arashouse_12ѕp9_01", "arashouse_12sp9_０1", "ah‐12sp9‐01"];

let mapped: MappedRoot;
let system: FakeSlotSystem;
let audit: MemoryAudit;
let broker: Broker;
let n = 0;

/** The broker as the service builds it (service.ts), every verb registered, over the in-memory slot system. */
function fullBroker(): Broker {
  const b = new Broker({ root: ROOT, isReparsePoint: mapped.fs.isReparsePoint, realPath: mapped.fs.realPath, audit });
  const brokerSystem = { fs: mapped.fs, brokerVersion: "9.9.9", os: () => "Windows_NT 10", freeRamBytes: () => 8 * 1024 ** 3, sqlLogin: async () => null };
  registerCoreVerbs(b, brokerSystem);
  registerBaselineVerbs(b, brokerSystem);
  const locks = new SlotLocks();
  registerSlotVerbs(b, system, locks);
  registerResetVerbs(b, system, locks);
  registerHealthVerb(b, system, locks);
  registerDeployVerb(b, system, locks);
  registerLicenceVerbs(b, system.secrets);
  registerOotbRootVerb(b, system.secrets);
  return b;
}

/** Everything the slot system holds outside `staging\`, hashed: a refused request must leave it as it was. */
function hostState(): string {
  const hash = createHash("sha256");
  for (const rel of system.filesUnder(ROOT).filter((p) => !p.startsWith("staging\\"))) hash.update(`${rel}=${system.text(win32.join(ROOT, rel))}\n`);
  for (const o of [...system.objects].sort()) hash.update(`object ${o}\n`);
  return hash.digest("hex");
}

const ask = (request: Record<string, unknown>): Promise<BrokerResponse> => broker.handle({ id: `a-${++n}`, ...request });

function refused(response: BrokerResponse, what: string): string {
  expect(response.ok, `${what}: ${JSON.stringify(response)}`).toBe(false);
  if (response.ok) return "";
  expect(response.error.kind, `${what}: ${response.error.message}`).toBe("Refused");
  if (process.env.AUDIT_LOG) console.log(`${what} => ${response.error.message}`);
  return response.error.message;
}

beforeEach(async () => {
  mapped = mappedRoot(ROOT);
  audit = new MemoryAudit();
  system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, slotNames(s1, ROOT), ROOT);
  const stamp = JSON.parse(system.text(stampFile(s1, ROOT))!) as Record<string, unknown>;
  system.put(stampFile(s1, ROOT), JSON.stringify({ ...stamp, leaseId: LEASE }));
  system.calls.length = 0;
  broker = fullBroker();
});

afterEach(() => mapped.cleanup());

describe("check 1: every verb, asked about a target the tool does not own", () => {
  const verbs: BrokerVerb[] = [...HOST_METHODS, ...HOST_SIDE_VERBS];

  it("the broker serves exactly the host-driver methods and the two host-side verbs, and refuses any other verb", async () => {
    // baselineBuild is never served: the build runs in the captain's elevated session (docs/broker.md).
    expect([...broker.registered()].sort()).toEqual(verbs.filter((v) => v !== "baselineBuild").sort());
    refused(await ask({ verb: "baselineBuild", flavor: "12sp9" }), "baselineBuild");
    for (const verb of ["runCommand", "exec", "sql", "__proto__", "constructor", "toString", "PING", "ping ", "restore"]) {
      refused(await ask({ verb }), verb);
    }
  });

  it("refuses every slot verb a slot record of a deny-listed, look-alike, odd-case or out-of-range name, before acting", async () => {
    const before = hostState();
    const flavors = ["OLM_Local", "olm", "12SP9", "12sp9 ", "12sp9.", "１２sp9", "12ѕp9", "..", "..\\12sp9", "\\\\?\\C:", "prod", "InnovatorSolutions", ...LOOKALIKES];
    const numbers: unknown[] = [0, 100, -1, 1.5, 1e9, "01", null, true];
    for (const verb of verbs) {
      for (const flavor of flavors) refused(await ask({ verb, slot: { flavor, slot: 1 } }), `${verb} ${flavor}`);
      for (const slot of numbers) refused(await ask({ verb, slot: { flavor: "12sp9", slot } }), `${verb} slot ${String(slot)}`);
      refused(await ask({ verb, slot: { flavor: "12sp9", slot: 1, database: "OLM_Local" } }), `${verb} with an extra slot field`);
      refused(await ask({ verb, slot: "12sp9-01" }), `${verb} with a slot id string`);
    }
    expect(hostState()).toBe(before);
    expect(system.calls).toEqual([]);
  });

  it("refuses every flavor verb a flavor that is not registered, and every verb a flavor where it takes none", async () => {
    for (const verb of verbs) {
      for (const flavor of ["OLM_Local", "12SP9", "12sp9 ", "..\\golden", "23\\..\\..", "35.", ...LOOKALIKES]) refused(await ask({ verb, flavor }), `${verb} ${flavor}`);
    }
    expect(system.calls).toEqual([]);
  });

  it("audits each refusal with the validated fields only: a refused name never reaches the log", async () => {
    await ask({ verb: "readStamp", slot: { flavor: "OLM_Local", slot: 1 } });
    await ask({ verb: "provisionSlot", slot: { flavor: "12sp9", slot: 1, database: "OLM_Local" } });
    const lines = JSON.stringify(audit.entries());
    expect(lines).not.toMatch(/olm/i);
    expect(audit.entries().map((e) => [e.target, e.outcome])).toEqual([
      [null, "Refused"],
      [null, "malformed"],
    ]);
  });
});

describe("check 1: the name guard, attacked directly", () => {
  const ref: SlotRef = { flavor: "12sp9", slot: 1 };
  const kinds = ["database", "alias", "appPool", "service", "login"] as const;
  const refuses = (fn: () => unknown, what: string) => expect(fn, what).toThrow(GuardError);

  it("refuses every deny-listed name in every case, and with a trailing dot or space, under every kind", () => {
    for (const name of [...DENIED_DATABASES, "InnovatorServer23", "ArasInnovatorAgent_x"]) {
      for (const variant of [name, name.toUpperCase(), name.toLowerCase(), `${name}.`, `${name} `, ` ${name}`]) {
        for (const kind of kinds) {
          refuses(() => assertOwned(kind, variant, ref), `${kind} ${variant}`);
          refuses(() => assertOwned(kind, variant), `${kind} ${variant} (no slot)`);
        }
      }
    }
  });

  it("refuses look-alikes of the deny-list and of the tool's own names (the allowlist is ASCII only)", () => {
    for (const name of LOOKALIKES) for (const kind of kinds) refuses(() => assertOwned(kind, name, ref), `${kind} ${name}`);
  });

  it("refuses the tool's own names when they differ only in case: the allowlist is lower case, as derived", () => {
    for (const [kind, name] of [
      ["database", "ARASHOUSE_12SP9_01"],
      ["database", "Arashouse_12sp9_01"],
      ["alias", "AH-12SP9-01"],
      ["alias", "Ah-12sp9-01"],
      ["appPool", "AH-12SP9-01-SERVER"],
      ["service", "ArasHouseAgent_12SP9_01"],
      ["service", "arashouseagent_12sp9_01"],
      ["login", "ARASHOUSE_12SP9_01_DBO"],
    ] as const) {
      refuses(() => assertOwned(kind, name, ref), `${kind} ${name}`);
    }
  });

  it("refuses the map's InnovatorSolutions* and InnovatorServer* names, and fullwidth forms of the deny-list, by name", () => {
    for (const name of ["InnovatorSolutions23", "innovatorsolutions_copy", "InnovatorServer35", "ＯＬＭ_Local", "ｐｒｏｄ"]) {
      expect(nameDenial(name), name).toBeDefined();
    }
    expect(nameDenial("Solutions.S12-0-SP9.12.0.24090.ConvertSqlToBackup")).toBeUndefined();
  });

  it("refuses device, UNC, WSL, relative, short-name, stream, dot-dot and dotted paths, and deny-listed folders", () => {
    const slot = `${ROOT}\\slots\\12sp9\\01`;
    const paths = [
      `\\\\?\\${slot}`,
      `\\\\.\\${slot}`,
      `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\aras_installations\\slots\\12sp9\\01`,
      `\\\\?\\UNC\\localhost\\c$\\aras_installations\\slots\\12sp9\\01`,
      `\\\\localhost\\c$\\aras_installations\\slots\\12sp9\\01`,
      `//localhost/c$/aras_installations/slots/12sp9/01`,
      "/mnt/c/aras_installations/slots/12sp9/01",
      "aras_installations\\slots\\12sp9\\01",
      "C:aras_installations\\slots\\12sp9\\01",
      `${slot}\\..\\..\\..\\..\\Aras12\\Innovator`,
      `${slot}\\Innovator\\..\\..\\02`,
      `${ROOT}.\\slots\\12sp9\\01`,
      `${ROOT} \\slots\\12sp9\\01`,
      `${slot}.`,
      `${slot}\\Innovator.`,
      "C:\\ARAS_I~1\\slots\\12sp9\\01",
      "C:\\PROGRA~2\\Aras12\\Innovator",
      `${slot}\\InnovatorServerConfig.xml::$DATA`,
      `${slot}:stream`,
      `${slot}\\CON`,
      `${slot}\\nul.txt`,
      `${slot}\\x\u0000y`,
      "C:\\Program Files (x86)\\Aras12\\Innovator",
      "c:\\program files (x86)\\aras\\innovator\\server",
      "C:\\Aras28\\Innovator",
      "C:\\aras\\Innovator",
      `${slot}\\OLM_Local.mdf`,
      `${slot}\\ＯＬＭ_Local.mdf`,
      `D:\\aras_installations\\slots\\12sp9\\01`,
      `${ROOT}\\slots\\12sp9\\0１`,
      `${ROOT}\\ѕlots\\12sp9\\01`,
      `${ROOT}\\slots\\12sp9\\1`,
      `${ROOT}\\secrets\\..\\slots\\23\\01`,
    ];
    for (const p of paths) refuses(() => assertOwned("path", p, ref), p);
  });

  it("refuses a path with a junction anywhere from the root down, and a root whose real path is the captain's", () => {
    const junction = `${ROOT}\\slots\\12sp9`;
    const isReparsePoint = (p: string) => p.toLowerCase() === junction.toLowerCase();
    refuses(() => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\Innovator`, ref, { isReparsePoint }), "junction");
    refuses(() => assertValidRoot(ROOT, { realPath: () => "C:\\Program Files (x86)\\Aras12\\Innovator" }), "real path");
    refuses(() => assertValidRoot(ROOT, { realPath: () => "C:\\Aras12" }), "real path top folder");
  });
});

describe("check 1: path arguments of the slot verbs", () => {
  const evil = [
    "C:\\Program Files (x86)\\Aras12\\Innovator\\DB\\x.bak",
    `${ROOT}\\golden\\12sp9\\db\\ootb.bak`,
    `${stagingDir(LEASE, ROOT)}\\..\\..\\secrets\\x.bak`,
    `\\\\?\\${stagingDir(LEASE, ROOT)}\\restore.bak`,
    `\\\\localhost\\c$\\aras_installations\\staging\\${LEASE}\\restore.bak`,
    `${stagingDir("b".repeat(32), ROOT)}\\restore.bak`,
    `${stagingDir(LEASE, ROOT)}\\RESTOR~1.BAK`,
    `${stagingDir(LEASE, ROOT)}\\restore.bak.`,
    `${stagingDir(LEASE, ROOT)}\\OLM_Local.bak`,
  ];

  it("restoreDatabase, backupDatabase, resetDatabase and deployCode refuse every one, changing nothing", async () => {
    const before = hostState();
    for (const path of evil) {
      refused(await ask({ verb: "restoreDatabase", slot: s1, args: { file: path } }), `restore ${path}`);
      refused(await ask({ verb: "backupDatabase", slot: s1, args: { path } }), `backup ${path}`);
      // The golden's own ootb.bak is the one file a reset may restore.
      if (!path.includes("golden")) refused(await ask({ verb: "resetDatabase", slot: s1, args: { file: path, hash: "a".repeat(64) } }), `reset ${path}`);
      refused(await ask({ verb: "deployCode", slot: s1, args: { staged: path, leaseId: LEASE } }), `deploy ${path}`);
    }
    for (const subpath of ["..", "../Aras12", "C:\\Aras12", "Innovator\\..\\..", "\\\\?\\C:\\", "Innovator:stream"]) {
      refused(await ask({ verb: "deployCode", slot: s1, args: { staged: `${stagingDir(LEASE, ROOT)}\\code\\1`, leaseId: LEASE, subpath } }), `subpath ${subpath}`);
    }
    expect(hostState()).toBe(before);
    expect(system.calls.filter((c) => !/^(readFile|exists|isReparsePoint|listStaged|removeStaged|entryKind)\b/.test(c))).toEqual([]);
  });

  it("refuses an argument a verb does not take, such as a database or a command", async () => {
    for (const args of [{ database: "OLM_Local" }, { command: "whoami" }, { sql: "SELECT 1" }, { path: "C:\\" }]) {
      refused(await ask({ verb: "healthCheck", slot: s1, args }), JSON.stringify(args));
      refused(await ask({ verb: "startSlot", slot: s1, args: { agent: false, ...args } }), JSON.stringify(args));
    }
  });
});

describe("check 3: a request whose slot record disagrees with the stamp", () => {
  it("writeStamp refuses a stamp of another slot, flavor or id", async () => {
    const before = hostState();
    const stamp = { slotId: "12sp9-01", flavor: "12sp9", goldenHash: "g", lastResetAt: null };
    for (const bad of [
      { ...stamp, slotId: "12sp9-02" },
      { ...stamp, flavor: "23" },
      { ...stamp, slotId: "23-01", flavor: "23" },
      { ...stamp, slotId: "OLM_Local-01" },
      { ...stamp, slotId: "12SP9-01" },
    ]) {
      refused(await ask({ verb: "writeStamp", slot: s1, args: { stamp: bad } }), JSON.stringify(bad));
    }
    expect(hostState()).toBe(before);
  });

  it("deployCode, backupDatabase and restoreDatabase refuse a lease the stamp does not name", async () => {
    const other = "b".repeat(32);
    refused(await ask({ verb: "deployCode", slot: s1, args: { staged: `${stagingDir(other, ROOT)}\\code\\1`, leaseId: other } }), "deploy");
    refused(await ask({ verb: "backupDatabase", slot: s1, args: { path: `${stagingDir(other, ROOT)}\\x.bak` } }), "backup");
    refused(await ask({ verb: "restoreDatabase", slot: s1, args: { file: `${stagingDir(other, ROOT)}\\restore.bak` } }), "restore");
  });
});

describe("check 5: bootstrap inputs", () => {
  it("a code deploy refuses targets outside the slot's code roots, and the slot's rendered configs without allowConfig", () => {
    const rules = { subpath: "Innovator" };
    for (const files of [["../InnovatorServerConfig.xml"], ["Server/../../x"], ["C:/x"], ["\\\\?\\C:\\x"], ["Server/Innovator.xml"], ["Client/Innovator.xml"], ["Server/a~1.dll"], ["Server/bin/x.dll."]]) {
      expect(() => planDeploy(files, rules), files[0]).toThrow(GuardError);
    }
    expect(() => planDeploy(["OAuth.config"], { subpath: "OAuthServer", allowServers: true })).toThrow(/--allow-config/);
    expect(() => planDeploy(["vault.config"], { subpath: "VaultServer", allowServers: true })).toThrow(/--allow-config/);
    expect(() => planDeploy(["x.js"], { subpath: "AgentService", allowServers: true, allowConfig: true })).toThrow(GuardError);
  });

  it("a restore refuses a backup recorded under a deny-listed name unless --allow-foreign-origin", () => {
    const header = {
      sets: [{ position: 1, backupType: 1, databaseName: "x", softwareVersion: "15.0.2000" }],
      files: [
        { logicalName: "d", type: "D", sizeBytes: 1 },
        { logicalName: "l", type: "L", sizeBytes: 1 },
      ],
    };
    const target = { serverVersion: "15.0.2190.7", freeBytes: 1e12 };
    for (const name of ["OLM_Local", "olm_local_copy", "InnovatorSolutions23", "ＯＬＭ_Local", "PROD"]) {
      const named = { ...header, sets: [{ ...header.sets[0]!, databaseName: name }] };
      expect(backupProblems(named, target).join(), name).toMatch(/deny-listed/);
      expect(backupProblems(named, target, { allowForeignOrigin: true }), name).toEqual([]);
    }
  });

  it("a recipe refuses a key named like a secret at any depth, an unknown key, and an import aimed at another server", () => {
    for (const recipe of [
      { flavor: "12sp9", password: "x" },
      { flavor: "12sp9", code: [{ from: "./o", token: "x" }] },
      { flavor: "12sp9", import: [{ manifest: "m.mf", url: "http://localhost/InnovatorServer23" }] },
      { flavor: "12sp9", import: [{ manifest: "m.mf", database: "OLM_Local" }] },
      { flavor: "12sp9", restore: { from: "x.bak", secret: "y" } },
      { flavor: "OLM_Local" },
    ]) {
      expect(() => parseRecipe(recipe, "audit.json"), JSON.stringify(recipe)).toThrow();
    }
  });
});
