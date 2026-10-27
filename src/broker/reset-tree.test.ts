import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTALL_ROOT, buildScratch, slotLoginSecretName, slotNames, stampFile, type SlotRef } from "../core/names.js";
import { encodeLicence, licenceElement, licenceSecretName } from "../core/licence.js";
import { HostError } from "../host/errors.js";
import { Broker } from "./broker.js";
import { SlotLocks, provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { quiesceOnHost, registerResetVerbs, resetTreeOnHost } from "./reset-tree.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const names = slotNames(s1, ROOT);
const inSlot = (rel: string) => win32.join(names.slotDir, ...rel.split("/"));
const goldenFile = (rel: string) => win32.join(ROOT, "golden", "12sp9", "tree", ...rel.split("/"));

async function provisioned(): Promise<FakeSlotSystem> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, names, ROOT);
  system.calls.length = 0;
  return system;
}

/** What a lease leaves behind: a new file, an edited client file and config, a full Server\temp, a deployed DLL, vault files, compiled pages. */
function dirty(system: FakeSlotSystem): void {
  system.put(inSlot("Innovator/Client/added.js"), "added");
  system.put(inSlot("Innovator/Client/scripts/main.js"), "edited by the lease");
  system.put(inSlot("InnovatorServerConfig.xml"), "<Innovator/>");
  system.put(inSlot("Innovator/Server/temp/lease.tmp"), "tmp");
  system.put(inSlot("Innovator/Server/temp/deep/more.tmp"), "tmp");
  system.put(inSlot("Innovator/Server/bin/Lease.Methods.dll"), "dll");
  system.put(win32.join(names.vaultDir, "1", "AB", "file.bin"), "vault");
  system.objects.add(`ASP.NET temporary files ${names.alias}`);
  system.put(stampFile(s1, ROOT), JSON.stringify({ slotId: "12sp9-01", flavor: "12sp9", goldenHash: "x", lastResetAt: null, leaseId: "lease1" }));
}

function reset(system: FakeSlotSystem, hash = system.manifest("12sp9").manifestHash) {
  return resetTreeOnHost(system, s1, names, ROOT, hash);
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
  return system.calls.filter((c) => !/^(readFile|writeFile|isDirectory)$/.test(c));
}

describe("quiesce", () => {
  it("stops the slot, and refuses one that is not provisioned", async () => {
    const system = await provisioned();
    expect(system.serving.has("12sp9-01")).toBe(true);
    expect(await quiesceOnHost(system, s1)).toMatchObject({ ok: true, detail: expect.stringMatching(/^quiesced 12sp9-01 in \d+\.\d s$/) });
    expect(system.serving.has("12sp9-01")).toBe(false);
    expect(await failure(quiesceOnHost(system, { flavor: "12sp9", slot: 2 }))).toMatchObject({ kind: "Refused", message: "slot 12sp9-02 is not provisioned" });
  });

  it("answers Retryable when something of the slot still runs after the wait", async () => {
    const system = await provisioned();
    system.failNext("quiesce", new Error("quiesce failed (exit 1): error: the slot still runs after the wait: process Aras.Server.exe 4242"));
    expect(await failure(quiesceOnHost(system, s1))).toMatchObject({ kind: "Retryable", message: expect.stringContaining("Aras.Server.exe 4242") });
  });
});

describe("resetTree", () => {
  it("mirrors golden, clears the runtime state, renders the configs, verifies, and writes the stamp last", async () => {
    const system = await provisioned();
    dirty(system);
    await quiesceOnHost(system, s1);
    const result = await reset(system);
    expect(result.ok).toBe(true);
    expect(steps(system)).toEqual(["quiesce 12sp9-01", "resetTree 12sp9-01", "verifyTree 12sp9-01"]);
    expect(system.calls.at(-1)).toBe("writeFile");

    const hash = system.manifest("12sp9").manifestHash;
    expect(JSON.parse(system.text(stampFile(s1, ROOT))!)).toEqual({
      slotId: "12sp9-01",
      flavor: "12sp9",
      goldenHash: hash,
      lastResetAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      leaseId: null,
    });
    // What the lease added or changed is gone; golden's files are golden's again.
    expect(system.text(inSlot("Innovator/Client/added.js"))).toBeUndefined();
    expect(system.text(inSlot("Innovator/Server/bin/Lease.Methods.dll"))).toBeUndefined();
    expect(system.text(inSlot("Innovator/Client/scripts/main.js"))).toBe("main");
    expect(system.text(inSlot("Innovator/Client/jsBundles/data.json"))).toBe("{}");
    expect(system.filesUnder(inSlot("Innovator/Server/temp"))).toEqual([]);
    expect(system.filesUnder(names.vaultDir)).toEqual([]);
    expect(system.objects.has(`ASP.NET temporary files ${names.alias}`)).toBe(false);
    // The configs are the slot's again, rendered from golden's bytes, which are untouched.
    const config = system.text(inSlot("InnovatorServerConfig.xml"))!;
    expect(config).toContain(`database="arashouse_12sp9_01"`);
    expect(config).toContain(`${names.slotDir}\\Innovator\\Server\\temp\\`);
    expect(system.text(goldenFile("InnovatorServerConfig.xml"))).toContain(`database="arashouse_build_12sp9"`);

    expect(result.detail).toMatch(
      new RegExp(
        `^reset the tree of 12sp9-01 to golden ${hash.slice(0, 12)} in \\d+\\.\\d s \\(robocopy 0\\.3, clearing 0\\.1: 1 runtime, 1 vault and 1 ASP\\.NET temporary entries cleared; ` +
          `configs: 9 files, \\d+ edits; no licence key is stored for line 12, so the slot cannot log in yet; \\d+ files verified; golden [\\d.]+, mirror [\\d.]+, configs [\\d.]+, verify [\\d.]+, stamp [\\d.]+\\)$`,
      ),
    );
  });

  it("renders the line's stored <License> element again over a config the lease changed", async () => {
    const system = await provisioned();
    const values = { lic_key: "LICENCE-KEY-PLACEHOLDER-0003", act_key: "ACT-KEY-PLACEHOLDER-0003", lic_type: "Type-Placeholder", company: "Company-Placeholder" };
    await system.secrets.put(licenceSecretName("12"), encodeLicence(licenceElement(values)));
    dirty(system);
    await quiesceOnHost(system, s1);
    const result = await reset(system);
    expect(system.text(inSlot("InnovatorServerConfig.xml"))).toContain(
      `<License lic_type="Type-Placeholder" lic_key="LICENCE-KEY-PLACEHOLDER-0003" act_key="ACT-KEY-PLACEHOLDER-0003" company="Company-Placeholder"/>`,
    );
    expect(result.detail).not.toContain("cannot log in");
    for (const value of Object.values(values)) expect(JSON.stringify(result)).not.toContain(value);
  });

  it("is idempotent: a second reset of a clean slot gives the same tree", async () => {
    const system = await provisioned();
    await quiesceOnHost(system, s1);
    await reset(system);
    const before = system.filesUnder(names.slotDir).map((f) => [f, system.text(inSlot(f))]);
    await reset(system);
    const after = system.filesUnder(names.slotDir).map((f) => [f, system.text(inSlot(f))]);
    expect(after.filter(([f]) => !f!.endsWith(".arashouse-slot.json"))).toEqual(before.filter(([f]) => !f!.endsWith(".arashouse-slot.json")));
  });

  it("refuses a slot that is not quiesced or not provisioned, and changes nothing", async () => {
    const system = await provisioned();
    dirty(system);
    expect(await failure(reset(system))).toMatchObject({
      kind: "Refused",
      message: "tree reset of 12sp9-01 failed at mirror: slot 12sp9-01 is not quiesced: IIS pool ah-12sp9-01-root (Started) still running",
    });
    expect(system.text(inSlot("Innovator/Client/added.js"))).toBe("added");
    expect(JSON.parse(system.text(stampFile(s1, ROOT))!)).toMatchObject({ leaseId: "lease1" });

    const two: SlotRef = { flavor: "12sp9", slot: 2 };
    const err = await failure(resetTreeOnHost(system, two, slotNames(two, ROOT), ROOT, system.manifest("12sp9").manifestHash));
    expect(err).toMatchObject({ kind: "Refused", message: expect.stringContaining("slot 12sp9-02 is not provisioned") });
  });

  it("quarantines when the tree does not match golden after the mirror, and leaves no stamp", async () => {
    const system = await provisioned();
    dirty(system);
    await quiesceOnHost(system, s1);
    system.mirrorSkips = ["innovator\\client\\scripts\\main.js", "innovator\\client\\added.js"];
    const err = await failure(reset(system));
    expect(err.kind).toBe("Quarantine");
    expect(err.message).toMatch(/^tree reset of 12sp9-01 failed at verify: the tree does not match golden after the mirror: fast verify failed: \d+ files checked; 0 missing, 1 changed, 1 extra: /);
    expect(err.message).toContain("changed innovator/client/scripts/main.js (size)");
    expect(err.message).toContain("extra innovator/client/added.js");
    expect(system.text(stampFile(s1, ROOT))).toBeUndefined();
  });

  it("quarantines when a rendered config does not read back as written", async () => {
    const system = await provisioned();
    await quiesceOnHost(system, s1);
    const read = system.readFile.bind(system);
    system.readFile = async (path) => (path.toLowerCase() === inSlot("OAuthServer/OAuth.config").toLowerCase() && system.calls.includes("verifyTree 12sp9-01") ? new Uint8Array([1]) : read(path));
    const err = await failure(reset(system));
    expect(err).toMatchObject({ kind: "Quarantine", message: "tree reset of 12sp9-01 failed at verify: the rendered OAuthServer/OAuth.config did not read back as written" });
    expect(system.text(stampFile(s1, ROOT))).toBeUndefined();
  });

  it("answers a failed step Retryable, and the next reset finishes the job", async () => {
    const system = await provisioned();
    dirty(system);
    await quiesceOnHost(system, s1);
    system.failNext("resetTree", new Error("reset-tree failed (exit 1): error: robocopy failed (16)"));
    expect(await failure(reset(system))).toMatchObject({ kind: "Retryable", message: "tree reset of 12sp9-01 failed at mirror: reset-tree failed (exit 1): error: robocopy failed (16)" });
    expect((await reset(system)).ok).toBe(true);
    expect(system.text(inSlot("Innovator/Client/added.js"))).toBeUndefined();
  });

  it("waits for a golden that moved on or is being promoted, before any change", async () => {
    const system = await provisioned();
    dirty(system);
    await quiesceOnHost(system, s1);
    system.calls.length = 0;
    expect(await failure(reset(system, "a".repeat(64)))).toMatchObject({ kind: "Retryable", message: expect.stringContaining("not the aaaaaaaaaaaa the reset began with") });
    system.put(buildScratch("12sp9", ROOT).promotingMarker, "2026-10-28T00:00:00Z");
    expect(await failure(reset(system))).toMatchObject({ kind: "Retryable", message: expect.stringContaining("a new 12sp9 golden is being moved into place") });
    expect(steps(system)).toEqual([]);
    expect(system.text(inSlot("Innovator/Client/added.js"))).toBe("added");
  });

  it("quarantines a slot whose stored login passwords are gone, before any change, and never makes new ones", async () => {
    const system = await provisioned();
    dirty(system);
    await quiesceOnHost(system, s1);
    await system.secrets.delete(slotLoginSecretName(s1, "reg"));
    expect(await failure(reset(system))).toMatchObject({ kind: "Quarantine", message: expect.stringContaining("the stored SQL login passwords of 12sp9-01 are missing") });
    expect(await system.secrets.has(slotLoginSecretName(s1, "reg"))).toBe(false);
    expect(system.text(inSlot("Innovator/Client/added.js"))).toBe("added");
  });
});

describe("the quiesce, resetTree and writeStamp verbs", () => {
  function broker(system: FakeSlotSystem): Broker {
    const locks = new SlotLocks();
    return registerResetVerbs(registerSlotVerbs(new Broker({ root: ROOT }), system, locks), system, locks);
  }

  it("reset a slot through the broker, with the golden hash as the only argument", async () => {
    const system = await provisioned();
    const b = broker(system);
    const hash = system.manifest("12sp9").manifestHash;
    expect(await b.handle({ id: "q", verb: "quiesce", slot: s1 })).toMatchObject({ ok: true });
    expect(await b.handle({ id: "r", verb: "resetTree", slot: s1, args: { hash } })).toMatchObject({ ok: true, result: { ok: true } });
    for (const args of [undefined, {}, { hash: "short" }, { hash, path: "C:\\x" }]) {
      expect(await b.handle({ id: "x", verb: "resetTree", slot: s1, ...(args ? { args } : {}) })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    }
    expect(await b.handle({ id: "x", verb: "quiesce", slot: s1, args: { now: true } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
  });

  it("write a stamp for its own provisioned slot only", async () => {
    const system = await provisioned();
    const b = broker(system);
    const stamp = { slotId: "12sp9-01", flavor: "12sp9", goldenHash: "h", lastResetAt: "2026-10-28T10:00:00.000Z", leaseId: "0123abcd" };
    expect(await b.handle({ id: "w", verb: "writeStamp", slot: s1, args: { stamp } })).toMatchObject({ ok: true, result: { detail: "wrote the stamp of 12sp9-01" } });
    expect(JSON.parse(system.text(stampFile(s1, ROOT))!)).toEqual(stamp);
    expect(await b.handle({ id: "o", verb: "writeStamp", slot: s1, args: { stamp: { ...stamp, slotId: "12sp9-02" } } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    expect(await b.handle({ id: "n", verb: "writeStamp", slot: { flavor: "12sp9", slot: 2 }, args: { stamp: { ...stamp, slotId: "12sp9-02" } } })).toMatchObject({
      ok: false,
      error: { kind: "Refused", message: "slot 12sp9-02 is not provisioned" },
    });
    expect(system.text(stampFile({ flavor: "12sp9", slot: 2 }, ROOT))).toBeUndefined();
    expect(await b.handle({ id: "e", verb: "writeStamp", slot: s1 })).toMatchObject({ ok: false, error: { kind: "Refused" } });
  });

  it("wait for a provision or destroy of the same slot, and refuse a deny-listed slot before the system is called", async () => {
    const system = new FakeSlotSystem();
    let release!: () => void;
    const mirror = system.mirrorTree.bind(system);
    system.mirrorTree = (slot) => new Promise<void>((resolve) => (release = () => void mirror(slot).then(resolve)));
    const b = broker(system);
    const first = b.handle({ id: "p", verb: "provisionSlot", slot: s1 });
    await new Promise((r) => setTimeout(r, 10));
    expect(await b.handle({ id: "q", verb: "quiesce", slot: s1 })).toMatchObject({
      ok: false,
      error: { kind: "Retryable", message: "slot 12sp9-01 is being provisioned, destroyed, started, stopped or reset already" },
    });
    release();
    expect(await first).toMatchObject({ ok: true });
    system.calls.length = 0;
    for (const slot of [{ flavor: "OLM_Local", slot: 1 }, { flavor: "12sp9", slot: 0 }, { flavor: "prod", slot: 1 }]) {
      for (const verb of ["quiesce", "resetTree", "writeStamp"] as const) {
        expect(await b.handle({ id: "x", verb, slot })).toMatchObject({ ok: false, error: { kind: "Refused" } });
      }
    }
    expect(system.calls).toEqual([]);
  });
});
