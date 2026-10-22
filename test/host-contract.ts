// The host-driver contract suite. Run against `FakeHost` here (host-contract.test.ts) and against
// `BrokerHost` on the real host in ticket 35: provision, reset, health, a stamp round trip, a refused
// name and a retryable fault. Import `hostContractSuite` from a `*.test.ts` file and hand it a factory.
//
// The suite holds a host to what the contract promises, nothing more: every call returns
// `{ ok, ms, detail }` or throws a `HostError`, a refusal is `Refused`, and the stamp survives a round trip.

import { afterEach, describe, expect, it } from "vitest";
import type { SlotRef } from "../src/core/names.js";
import { goldenDir, slotId, stagingDir } from "../src/core/names.js";
import {
  HostError,
  type BackupRef,
  type GoldenRef,
  type HostDriver,
  type HostMethod,
  type HostResult,
  type HostErrorKind,
} from "../src/host/index.js";

export interface ContractHarness {
  readonly host: HostDriver;
  /** The install root the host runs under. */
  readonly root: string;
  /** A slot the host can provision: absent from `listSlots` on entry. */
  readonly slot: SlotRef;
  /** The golden tree and backup the host accepts for the slot's flavor. */
  readonly golden: GoldenRef;
  readonly backup: BackupRef;
  /** Makes the next call to `method` throw `Retryable` and change nothing. Omit where a host cannot. */
  failNext?(method: HostMethod): void;
  /** Dirties the slot's tree so the next health check fails. Omit where a host cannot. */
  dirtyTree?(slot: SlotRef): void | Promise<void>;
  /** Cleans up after one test (destroys the slots it provisioned, releases the pipe). */
  teardown?(): void | Promise<void>;
}

function expectResult(result: HostResult): void {
  expect(typeof result.ok).toBe("boolean");
  expect(Number.isFinite(result.ms)).toBe(true);
  expect(result.ms).toBeGreaterThanOrEqual(0);
  expect(typeof result.detail).toBe("string");
}

async function thrownKind(call: () => Promise<unknown>): Promise<HostErrorKind | "not-a-host-error" | "none"> {
  try {
    await call();
    return "none";
  } catch (err) {
    return err instanceof HostError ? err.kind : "not-a-host-error";
  }
}

export function hostContractSuite(label: string, make: () => ContractHarness | Promise<ContractHarness>): void {
  describe(`host contract: ${label}`, () => {
    let harness: ContractHarness | undefined;
    const setup = async (): Promise<ContractHarness> => (harness = await make());

    afterEach(async () => {
      await harness?.teardown?.();
      harness = undefined;
    });

    it("answers ping and hostInfo", async () => {
      const { host } = await setup();
      expectResult(await host.ping());
      const info = await host.hostInfo();
      expectResult(info);
      expect(typeof info.info.os).toBe("string");
      expect(info.info.freeDiskGb).toBeGreaterThanOrEqual(0);
      expect(typeof info.info.sqlReachable).toBe("boolean");
    });

    it("provisions a slot, lists it and destroys it", async () => {
      const { host, slot } = await setup();
      const before = await host.listSlots();
      expect(before.slots.map((s) => slotId(s.slot))).not.toContain(slotId(slot));

      const provisioned = await host.provisionSlot(slot);
      expectResult(provisioned);
      expect(provisioned.ok).toBe(true);
      const listed = await host.listSlots();
      expect(listed.slots.map((s) => slotId(s.slot))).toContain(slotId(slot));

      expectResult(await host.destroySlot(slot));
      const after = await host.listSlots();
      expect(after.slots.map((s) => slotId(s.slot))).not.toContain(slotId(slot));
    });

    it("resets a slot to golden and reports it healthy", async () => {
      const { host, slot, golden, backup } = await setup();
      await host.provisionSlot(slot);
      expectResult(await host.quiesce(slot));
      expect((await host.resetDatabase(slot, backup)).ok).toBe(true);
      expect((await host.resetTree(slot, golden)).ok).toBe(true);
      expect((await host.startSlot(slot, { agent: false })).ok).toBe(true);

      const health = await host.healthCheck(slot);
      expectResult(health);
      expect(health.ok).toBe(true);
      expect(health.checks.length).toBeGreaterThan(0);
      for (const check of health.checks) {
        expect(typeof check.name).toBe("string");
        expect(check.ok).toBe(true);
        expect(typeof check.detail).toBe("string");
      }
      expectResult(await host.stopSlot(slot));
    });

    it("fails the health check on a dirty tree, and a reset clears it", async () => {
      const h = await setup();
      if (!h.dirtyTree) return;
      await h.host.provisionSlot(h.slot);
      await h.dirtyTree(h.slot);
      const dirty = await h.host.healthCheck(h.slot);
      expect(dirty.ok).toBe(false);
      expect(dirty.checks.some((c) => !c.ok)).toBe(true);

      await h.host.quiesce(h.slot);
      await h.host.resetTree(h.slot, h.golden);
      await h.host.resetDatabase(h.slot, h.backup);
      await h.host.startSlot(h.slot, { agent: false });
      expect((await h.host.healthCheck(h.slot)).ok).toBe(true);
    });

    it("round-trips a slot stamp", async () => {
      const { host, slot, golden } = await setup();
      await host.provisionSlot(slot);
      const read = await host.readStamp(slot);
      expectResult(read);
      expect(read.stamp).not.toBeNull();
      const stamp = read.stamp!;
      expect(stamp.slotId).toBe(slotId(slot));
      expect(stamp.flavor).toBe(slot.flavor);

      const written = { ...stamp, goldenHash: golden.hash, lastResetAt: "2026-10-22T10:00:00.000Z", leaseId: "0123abcd" };
      expectResult(await host.writeStamp(slot, written));
      const again = await host.readStamp(slot);
      expect(again.stamp).toEqual(written);

      const listed = (await host.listSlots()).slots.find((s) => slotId(s.slot) === slotId(slot));
      expect(listed?.stamp).toEqual(written);
    });

    it("refuses a stamp that belongs to another slot", async () => {
      const { host, slot } = await setup();
      await host.provisionSlot(slot);
      const stamp = (await host.readStamp(slot)).stamp!;
      const other = { ...stamp, slotId: slotId({ flavor: slot.flavor, slot: slot.slot + 1 }) };
      expect(await thrownKind(() => host.writeStamp(slot, other))).toBe("Refused");
    });

    it("refuses a slot that is not a registered flavor and number, and OLM_Local in any case", async () => {
      const { host } = await setup();
      for (const bad of [
        { flavor: "OLM_Local", slot: 1 },
        { flavor: "olm_local", slot: 1 },
        { flavor: "12sp9", slot: 0 },
        { flavor: "12sp9", slot: 100 },
        { flavor: "prod", slot: 1 },
      ]) {
        const slot = bad as unknown as SlotRef;
        expect(await thrownKind(() => host.provisionSlot(slot))).toBe("Refused");
        expect(await thrownKind(() => host.destroySlot(slot))).toBe("Refused");
        expect(await thrownKind(() => host.healthCheck(slot))).toBe("Refused");
        expect(await thrownKind(() => host.readStamp(slot))).toBe("Refused");
      }
      expect(await thrownKind(() => host.baselineVerify("OLM_Local" as never))).toBe("Refused");
    });

    it("refuses staged paths outside the lease's staging folder or on the deny-list", async () => {
      const { host, slot, root } = await setup();
      await host.provisionSlot(slot);
      const staging = stagingDir("contract-lease", root);
      for (const path of [
        "C:\\Program Files (x86)\\Aras\\Innovator\\Server",
        `${staging}\\..\\..\\slots`,
        staging,
        `${staging}\\..\\x.bak`,
        `${staging}\\OLM_Local.bak`,
        `${goldenDir(slot.flavor, root)}\\Core.bak`,
        "\\\\server\\share\\x.bak",
        "/mnt/c/aras_installations/staging/x",
        `${root}\\sqldata\\arashouse_${slot.flavor}_01.mdf`,
      ]) {
        expect(await thrownKind(() => host.deployCode(slot, path))).toBe("Refused");
        expect(await thrownKind(() => host.restoreDatabase(slot, path))).toBe("Refused");
        expect(await thrownKind(() => host.backupDatabase(slot, path))).toBe("Refused");
      }
    });

    it("refuses a call on a slot that was never provisioned", async () => {
      const { host, slot } = await setup();
      expect(await thrownKind(() => host.healthCheck(slot))).toBe("Refused");
      expect(await thrownKind(() => host.startSlot(slot, { agent: false }))).toBe("Refused");
    });

    it("surfaces a retryable fault as Retryable, changes nothing, and succeeds on the retry", async () => {
      const h = await setup();
      if (!h.failNext) return;
      await h.host.provisionSlot(h.slot);
      await h.host.quiesce(h.slot);

      const before = (await h.host.readStamp(h.slot)).stamp;
      h.failNext("resetTree");
      expect(await thrownKind(() => h.host.resetTree(h.slot, h.golden))).toBe("Retryable");
      expect((await h.host.readStamp(h.slot)).stamp).toEqual(before);
      expect((await h.host.resetTree(h.slot, h.golden)).ok).toBe(true);
    });
  });
}
