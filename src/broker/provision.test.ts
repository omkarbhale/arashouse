import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeLicence, licenceElement, licenceSecretName } from "../core/licence.js";
import { editList } from "../core/edit-lists.js";
import { serializeEditList } from "../core/edits.js";
import { DEFAULT_INSTALL_ROOT, goldenLayout, slotLoginSecretName, slotNames, stampFile, type SlotRef } from "../core/names.js";
import { Secret } from "../core/secret.js";
import { HostError } from "../host/errors.js";
import { Broker } from "./broker.js";
import { destroySlotOnHost, provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { FAKE_GOLDEN_HASH, FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const names = slotNames(s1, ROOT);

function provision(system: FakeSlotSystem, slot: SlotRef = s1) {
  return provisionSlotOnHost(system, slot, slotNames(slot, ROOT), ROOT);
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

/** The host-changing calls, without the file reads and writes. */
function steps(system: FakeSlotSystem): string[] {
  return system.calls.filter((c) => !/^(readFile|writeFile)$/.test(c));
}

describe("provisionSlot", () => {
  it("makes the slot from golden in order, and writes the stamp last", async () => {
    const system = new FakeSlotSystem();
    const result = await provision(system);
    expect(result.ok).toBe(true);
    expect(steps(system)).toEqual([
      "golden",
      "snapshotDenyList",
      "makeFolders 12sp9-01",
      "mirrorTree 12sp9-01",
      "createIis 12sp9-01",
      "createAgent 12sp9-01",
      "restoreDatabase 12sp9-01",
      "snapshotDenyList",
    ]);
    expect(system.calls.at(-2)).toBe("writeFile");
    expect(JSON.parse(system.text(stampFile(s1, ROOT))!)).toEqual({
      slotId: "12sp9-01",
      flavor: "12sp9",
      goldenHash: FAKE_GOLDEN_HASH,
      lastResetAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      leaseId: null,
    });
    expect(result.detail).toMatch(/^provisioned 12sp9-01 from golden 999999999999 in \d+\.\d s \(7 IIS applications; no agent; configs: 9 files, \d+ edits; no licence key is stored for line 12/);
    expect(result.detail).toMatch(/golden 0\.1, snapshot 0\.1, folders 0\.1, tree 0\.1, iis 0\.1, agent 0\.1, database [\d.]+, configs [\d.]+, stamp [\d.]+, deny-list 0\.1\)$/);
  });

  it("makes the slot's agent service on its reserved port when the golden has one, and points the agent at the slot", async () => {
    const system = new FakeSlotSystem();
    system.agentInstalled = true;
    const result = await provision(system);
    expect(result.detail).toContain("(7 IIS applications; agent on port 8801; configs: 9 files");
    const agentConfig = system.text(win32.join(slotNames(s1, ROOT).slotDir, "AgentService", "Aras.Server.Agent.Service.exe.config"))!;
    expect(agentConfig).toContain('<add baseAddress="http://localhost:8801/ah-12sp9-01" />');
    expect(agentConfig).toContain('<add key="InnovatorServer" value="http://localhost/ah-12sp9-01/Server/InnovatorServer.aspx" />');
  });

  it("renders the slot's names and its stored login passwords into the configs, from the golden's bytes", async () => {
    const system = new FakeSlotSystem();
    await provision(system);
    const dbo = (await system.secrets.get(slotLoginSecretName(s1, "dbo")))!;
    const reg = (await system.secrets.get(slotLoginSecretName(s1, "reg")))!;
    expect(dbo.kind).toBe("sql-login");
    expect(dbo.length).toBe(24);
    expect(system.loginSecrets.get("arashouse_12sp9_01_dbo")).toBe(dbo);
    expect(system.loginSecrets.get("arashouse_12sp9_01_reg")).toBe(reg);
    const config = system.text(win32.join(names.slotDir, "InnovatorServerConfig.xml"))!;
    expect(config).toContain(`database="arashouse_12sp9_01"`);
    expect(config).toContain(`dbo_uid="arashouse_12sp9_01_dbo"`);
    expect(config).toContain(`dbo_pwd="${dbo.reveal()}"`);
    expect(config).toContain(`regular_pwd="${reg.reveal()}"`);
    expect(config).toContain(`${names.slotDir}\\Innovator\\Server\\temp\\`);
    expect(system.text(win32.join(names.slotDir, "OAuthServer", "OAuth.config"))).not.toContain("ah-build-12sp9");
    // The golden's own copy is untouched.
    expect(system.text(win32.join(ROOT, "golden", "12sp9", "tree", "InnovatorServerConfig.xml"))).toContain(`database="arashouse_build_12sp9"`);
  });

  it("puts the stored licence key in, when the host has one for the flavor's line", async () => {
    const system = new FakeSlotSystem();
    await system.secrets.put(licenceSecretName("12"), Secret.of("LICENCE-KEY-PLACEHOLDER-0001", "licence"));
    const result = await provision(system);
    expect(system.text(win32.join(names.slotDir, "InnovatorServerConfig.xml"))).toContain(`lic_key="LICENCE-KEY-PLACEHOLDER-0001"`);
    expect(result.detail).not.toMatch(/licence/);
  });

  it("renders the whole stored <License> element, and no value of it reaches the result", async () => {
    const system = new FakeSlotSystem();
    const values = { lic_key: "LICENCE-KEY-PLACEHOLDER-0002", act_key: "ACT-KEY-PLACEHOLDER-0002", lic_type: "Type-Placeholder", company: "Company & Placeholder" };
    await system.secrets.put(licenceSecretName("12"), encodeLicence(licenceElement(values)));
    const result = await provision(system);
    expect(system.text(win32.join(names.slotDir, "InnovatorServerConfig.xml"))).toContain(
      `<License lic_type="Type-Placeholder" lic_key="LICENCE-KEY-PLACEHOLDER-0002" act_key="ACT-KEY-PLACEHOLDER-0002" company="Company &amp; Placeholder"/>`,
    );
    for (const value of Object.values(values)) expect(JSON.stringify(result)).not.toContain(value);
  });

  it("renders the whole element from a golden whose edits.json predates it (lic_key alone)", async () => {
    const system = new FakeSlotSystem();
    const current = editList("12sp9");
    const old = { ...current, edits: current.edits.filter((e) => !/\/License\/@(act_key|lic_type|company)$/.test(e.path)) };
    system.put(goldenLayout("12sp9", ROOT).edits, serializeEditList(old));
    const values = { lic_key: "LICENCE-KEY-PLACEHOLDER-0004", act_key: "ACT-KEY-PLACEHOLDER-0004", lic_type: "Type-Placeholder", company: "Company-Placeholder" };
    await system.secrets.put(licenceSecretName("12"), encodeLicence(licenceElement(values)));
    expect((await provision(system)).ok).toBe(true);
    expect(system.text(win32.join(names.slotDir, "InnovatorServerConfig.xml"))).toContain(
      `<License lic_type="Type-Placeholder" lic_key="LICENCE-KEY-PLACEHOLDER-0004" act_key="ACT-KEY-PLACEHOLDER-0004" company="Company-Placeholder"/>`,
    );
  });

  it("renders the <License> element blank, and says the slot cannot log in, without a stored licence", async () => {
    const system = new FakeSlotSystem();
    const result = await provision(system);
    expect(system.text(win32.join(names.slotDir, "InnovatorServerConfig.xml"))).toContain(`<License lic_type="" lic_key="" act_key="" company=""/>`);
    expect(result.detail).toContain("no licence key is stored for line 12, so the slot cannot log in yet");
  });

  it("refuses a slot that has a stamp, and changes nothing", async () => {
    const system = new FakeSlotSystem();
    await provision(system);
    const before = system.calls.length;
    const err = await failure(provision(system));
    expect(err).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is already provisioned" });
    expect(system.calls.slice(before)).toEqual(["readFile"]);
  });

  it("finishes a provision that stopped half way, reusing the stored passwords", async () => {
    const system = new FakeSlotSystem();
    // An earlier run made the folders, the tree and the passwords, then its broker died: no stamp.
    await system.makeFolders(s1);
    await system.mirrorTree(s1);
    const dbo = Secret.of("an-earlier-password-0123", "sql-login");
    await system.secrets.put(slotLoginSecretName(s1, "dbo"), dbo);
    expect((await provision(system)).ok).toBe(true);
    expect(await system.secrets.get(slotLoginSecretName(s1, "dbo"))).toBe(dbo);
    expect(system.loginSecrets.get("arashouse_12sp9_01_dbo")).toBe(dbo);
    expect(system.text(stampFile(s1, ROOT))).toBeDefined();
  });

  it("rolls everything back when a step fails, and keeps the step's error kind", async () => {
    const system = new FakeSlotSystem();
    system.failNext("restoreDatabase", new HostError("Quarantine", "RESTORE failed (3101)"));
    const err = await failure(provision(system));
    expect(err.kind).toBe("Quarantine");
    expect(err.message).toBe("provision of 12sp9-01 failed at database: RESTORE failed (3101); rolled back");
    expect(await system.leftovers(s1)).toEqual([]);
    expect(steps(system).slice(-9)).toEqual([
      "stop 12sp9-01",
      "removeAgent 12sp9-01",
      "removeDatabase 12sp9-01",
      "removeIis 12sp9-01",
      "removeDir",
      "removeDir",
      "removeEmptyDir",
      "present 12sp9-01",
      "snapshotDenyList",
    ]);
  });

  it("answers a plain failure Retryable, names what the rollback left, and runs every removal even after one fails", async () => {
    const system = new FakeSlotSystem();
    system.failNext("createIis");
    system.failNext("removeIis", new Error("the IIS configuration is locked"));
    const err = await failure(provision(system));
    expect(err.kind).toBe("Retryable");
    expect(err.message).toMatch(/^provision of 12sp9-01 failed at iis: createIis failed; the rollback left \(iis: the IIS configuration is locked\)$/);
    expect(steps(system)).toContain("removeAgent 12sp9-01");
    expect(await system.leftovers(s1)).toEqual([]);
  });

  it("fails and rolls back when a deny-list object changed under it", async () => {
    const system = new FakeSlotSystem();
    const snapshot = system.snapshotDenyList.bind(system);
    let n = 0;
    system.snapshotDenyList = async () => {
      const prints = await snapshot();
      return ++n === 2 ? { ...prints, "IIS pool DefaultAppPool": "changed" } : prints;
    };
    const err = await failure(provision(system));
    expect(err.kind).toBe("Quarantine");
    expect(err.message).toMatch(/failed at deny-list: the deny-list objects differ \(changed IIS pool DefaultAppPool\); rolled back$/);
    expect(await system.leftovers(s1)).toEqual([]);
  });

  it("waits for a golden that is being promoted, and refuses one that does not verify, before any change", async () => {
    const system = new FakeSlotSystem();
    system.goldenState = { state: "promoting" };
    expect(await failure(provision(system))).toMatchObject({ kind: "Retryable", message: expect.stringMatching(/being moved into place/) });
    system.goldenState = { state: "unusable", detail: "it is not built" };
    expect(await failure(provision(system))).toMatchObject({ kind: "Refused", message: "the 12sp9 golden cannot be provisioned from: it is not built" });
    expect(steps(system)).toEqual(["golden", "golden"]);
  });

  it("refuses a golden whose ootb.bak was not taken with the broker as its database's owner, before any change", async () => {
    const system = new FakeSlotSystem();
    system.put(win32.join(ROOT, "golden", "12sp9", "flavor.json"), JSON.stringify({ schema: 1, flavor: "12sp9", manifestHash: "x" }));
    const err = await failure(provision(system));
    expect(err.kind).toBe("Refused");
    expect(err.message).toBe(
      "the 12sp9 golden cannot be provisioned from: its db\\ootb.bak was taken before the build gave its database to NT SERVICE\\ArasHouseBroker, so the broker could not use or drop a slot database restored from it; rebuild it with `arashouse baseline build 12sp9 --replace`",
    );
    expect(steps(system)).toEqual(["golden"]);
  });

  it("refuses a golden edit list of another flavor", async () => {
    const system = new FakeSlotSystem();
    system.put(win32.join(ROOT, "golden", "12sp9", "edits.json"), system.text(win32.join(ROOT, "golden", "23", "edits.json"))!);
    const err = await failure(provision(system));
    expect(err.message).toMatch(/failed at configs: .*edits\.json is the edit list of flavor 23; rolled back$/);
  });
});

describe("destroySlot", () => {
  it("removes everything the provision made, in reverse, and checks the deny-list", async () => {
    const system = new FakeSlotSystem();
    await provision(system);
    system.calls.length = 0;
    const result = await destroySlotOnHost(system, s1, names);
    expect(result).toMatchObject({ ok: true, detail: expect.stringMatching(/^destroyed 12sp9-01 in [\d.]+ s \(snapshot/) });
    expect(steps(system)).toEqual([
      "snapshotDenyList",
      "stop 12sp9-01",
      "removeAgent 12sp9-01",
      "removeDatabase 12sp9-01",
      "removeIis 12sp9-01",
      "removeDir",
      "removeDir",
      "removeEmptyDir",
      "present 12sp9-01",
      "snapshotDenyList",
    ]);
    expect(await system.leftovers(s1)).toEqual([]);
  });

  it("is idempotent: a slot that is not there destroys fine", async () => {
    const system = new FakeSlotSystem();
    expect((await destroySlotOnHost(system, s1, names)).ok).toBe(true);
  });

  it("answers Retryable naming what is left, and Quarantine when a deny-list object changed", async () => {
    const system = new FakeSlotSystem();
    await provision(system);
    system.failNext("removeDatabase", new Error("50002"));
    const left = await failure(destroySlotOnHost(system, s1, names));
    expect(left.kind).toBe("Retryable");
    expect(left.message).toBe("destroy of 12sp9-01 left (database: 50002), database arashouse_12sp9_01; destroying it again removes the rest");
    expect((await destroySlotOnHost(system, s1, names)).ok).toBe(true);

    const snapshot = system.snapshotDenyList.bind(system);
    let n = 0;
    system.snapshotDenyList = async () => ((await snapshot()) && ++n === 2 ? { other: "x" } : snapshot());
    expect(await failure(destroySlotOnHost(system, s1, names))).toMatchObject({ kind: "Quarantine" });
  });
});

describe("the provisionSlot and destroySlot verbs", () => {
  function broker(system: FakeSlotSystem): Broker {
    return registerSlotVerbs(new Broker({ root: ROOT }), system);
  }

  it("run one at a time per slot", async () => {
    const system = new FakeSlotSystem();
    let release!: () => void;
    const mirror = system.mirrorTree.bind(system);
    system.mirrorTree = (slot) => (slot.slot === 1 ? new Promise<void>((resolve) => (release = () => void mirror(slot).then(resolve))) : mirror(slot));
    const b = broker(system);
    const first = b.handle({ id: "p1", verb: "provisionSlot", slot: s1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(await b.handle({ id: "d1", verb: "destroySlot", slot: s1 })).toMatchObject({
      ok: false,
      error: { kind: "Retryable", message: "slot 12sp9-01 is being provisioned, destroyed, started, stopped or reset already" },
    });
    expect(await b.handle({ id: "p2", verb: "provisionSlot", slot: { flavor: "12sp9", slot: 2 } })).toMatchObject({ ok: true });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await b.handle({ id: "d2", verb: "destroySlot", slot: s1 })).toMatchObject({ ok: true });
  });

  it("refuse a deny-listed or unregistered slot before the system is called", async () => {
    const system = new FakeSlotSystem();
    const b = broker(system);
    for (const slot of [{ flavor: "OLM_Local", slot: 1 }, { flavor: "12sp9", slot: 0 }, { flavor: "prod", slot: 1 }]) {
      expect(await b.handle({ id: "x", verb: "provisionSlot", slot })).toMatchObject({ ok: false, error: { kind: "Refused" } });
      expect(await b.handle({ id: "y", verb: "destroySlot", slot })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    }
    expect(system.calls).toEqual([]);
  });

  it("take no arguments", async () => {
    const b = broker(new FakeSlotSystem());
    expect(await b.handle({ id: "x", verb: "provisionSlot", slot: s1, args: { path: "C:\\x" } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
  });
});
