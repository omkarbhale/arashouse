import { describe, expect, it } from "vitest";
import { FakeAras } from "../../test/fake-aras.js";
import { DEFAULT_INSTALL_ROOT, slotNames, slotRootSecretName, type SlotRef } from "../core/names.js";
import { Secret } from "../core/secret.js";
import { HostError } from "../host/errors.js";
import { MemoryAudit } from "./audit.js";
import { Broker } from "./broker.js";
import { LEASE_USERS, parseLeaseCredentialArgs, setLeaseCredentialsOnHost } from "./lease-credentials.js";
import { destroySlotOnHost, provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const names = slotNames(s1, ROOT);
const ALIAS = "ah-12sp9-01";
// Built from parts, so the literal is in no source file a grep could match by accident.
const FREE = ["free", "Slot", "Root", "Pw", "x1"].join("-");
const LEASE = ["lease", "Pw", "Q9zR2wT7vY4k"].join("_");

/** A provisioned slot whose `root` has a random password the reset stored, as a free slot has (ticket 32). */
async function freeSlot(): Promise<{ system: FakeSlotSystem; aras: FakeAras }> {
  const system = new FakeSlotSystem();
  await provisionSlotOnHost(system, s1, names, ROOT);
  const aras = new FakeAras();
  system.aras = aras;
  for (const login of LEASE_USERS) aras.set(ALIAS, login, FREE);
  await system.secrets.put(slotRootSecretName(s1), Secret.of(FREE, "aras-login"));
  return { system, aras };
}

const set = (system: FakeSlotSystem, password = LEASE) => setLeaseCredentialsOnHost(system, s1, ROOT, { password: Secret.of(password, "lease-password") });

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

describe("setLeaseCredentials", () => {
  it("logs in as root with the stored password, gives root and admin the lease's, proves it, and forgets the old one", async () => {
    const { system, aras } = await freeSlot();
    const result = await set(system);
    expect(result).toEqual({ ok: true, detail: expect.stringMatching(/^lease credentials set for admin and root of 12sp9-01 in [\d.]+ s$/) });
    expect(aras.calls).toEqual([`login ${ALIAS} root`, `edit ${ALIAS} admin`, `edit ${ALIAS} root`, `login ${ALIAS} root`]);
    for (const login of LEASE_USERS) {
      expect(aras.logsIn(ALIAS, login, LEASE)).toBe(true);
      expect(aras.logsIn(ALIAS, login, FREE)).toBe(false);
    }
    expect(await system.secrets.has(slotRootSecretName(s1))).toBe(false);
    expect(result.detail).not.toContain(LEASE);
  });

  it("a second lease on the same slot needs a reset in between: the stored password is gone", async () => {
    const { system } = await freeSlot();
    await set(system);
    const err = await failure(set(system, "another-lease-password-123"));
    expect(err.kind).toBe("Retryable");
    expect(err.message).toBe("12sp9-01 has no stored root password: it has not been reset since it was provisioned or last leased");
  });

  it("refuses a slot that is not provisioned", async () => {
    const err = await failure(set(new FakeSlotSystem()));
    expect(err).toMatchObject({ kind: "Refused", message: "slot 12sp9-01 is not provisioned" });
  });

  it("quarantines a slot whose server refuses the stored password, and keeps that password", async () => {
    const { system, aras } = await freeSlot();
    aras.set(ALIAS, "root", "someone-changed-it");
    const err = await failure(set(system));
    expect(err.kind).toBe("Quarantine");
    expect(err.message).toBe("12sp9-01: the password edit as root was refused: invalid_grant: Authentication failed");
    expect(aras.calls).toEqual([`login ${ALIAS} root`]);
    expect(await system.secrets.has(slotRootSecretName(s1))).toBe(true);
  });

  it("quarantines a slot whose edit is refused, and one whose new password does not log in", async () => {
    const refused = await freeSlot();
    refused.aras.editAnswer = { ok: false, refused: true, detail: "Not a single item" };
    expect(await failure(set(refused.system))).toMatchObject({ kind: "Quarantine", message: "12sp9-01: the password edit as root was refused: Not a single item" });

    const unproven = await freeSlot();
    unproven.aras.login = async (alias, database, user, password) =>
      unproven.aras.calls.length > 0 ? { ok: false, refused: true, detail: "invalid_grant" } : FakeAras.prototype.login.call(unproven.aras, alias, database, user, password);
    expect((await failure(set(unproven.system))).kind).toBe("Quarantine");
    expect(await unproven.system.secrets.has(slotRootSecretName(s1))).toBe(true);
  });

  it("is Retryable while the server does not answer", async () => {
    const { system, aras } = await freeSlot();
    aras.loginAnswer = { ok: false, refused: false, detail: "no answer in 120 s" };
    expect(await failure(set(system))).toMatchObject({ kind: "Retryable", message: "12sp9-01: the password edit as root did not complete: no answer in 120 s" });
  });

  it("a destroy forgets the slot's stored root password", async () => {
    const { system } = await freeSlot();
    await destroySlotOnHost(system, s1, names);
    expect(await system.leftovers(s1)).toEqual([]);
  });
});

describe("its arguments", () => {
  it("take only a URL-safe password of 16 to 128 characters, never quoted in an error", () => {
    expect(parseLeaseCredentialArgs({ password: LEASE }).password.reveal()).toBe(LEASE);
    const short = ["sh", "ort", "pw"].join("");
    const long = "x".repeat(129);
    for (const args of [{}, { password: 7 }, { password: short }, { password: `${LEASE} x` }, { password: long }]) {
      expect(() => parseLeaseCredentialArgs(args)).toThrow(/needs the lease's password/);
    }
    expect(() => parseLeaseCredentialArgs({ password: LEASE, user: "sa" })).toThrow('setLeaseCredentials takes only "password", not "user"');
    try {
      parseLeaseCredentialArgs({ password: `${LEASE}!` });
    } catch (err) {
      expect((err as Error).message).not.toContain(LEASE);
    }
  });
});

describe("through the broker", () => {
  it("the password reaches neither the audit log nor the answer", async () => {
    const { system, aras } = await freeSlot();
    const audit = new MemoryAudit();
    const broker = registerSlotVerbs(new Broker({ root: ROOT, audit }), system);
    const response = await broker.handle({ id: "r1", verb: "setLeaseCredentials", slot: s1, args: { password: LEASE } });
    expect(response).toMatchObject({ id: "r1", ok: true, result: { ok: true } });
    expect(aras.logsIn(ALIAS, "root", LEASE)).toBe(true);
    const lines = audit.lines;
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ verb: "setLeaseCredentials", target: "12sp9-01", outcome: "ok" });
    expect(lines.join("\n") + JSON.stringify(response)).not.toContain(LEASE);
    expect(lines.join("\n")).not.toContain(FREE);
  });

  it("a malformed password is Refused without the value in the answer", async () => {
    const { system } = await freeSlot();
    const broker = registerSlotVerbs(new Broker({ root: ROOT }), system);
    const bad = `${LEASE} and more`;
    const response = await broker.handle({ id: "r2", verb: "setLeaseCredentials", slot: s1, args: { password: bad } });
    expect(response).toMatchObject({ ok: false, error: { kind: "Refused" } });
    expect(JSON.stringify(response)).not.toContain(LEASE);
  });
});
