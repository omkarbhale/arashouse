import { describe, expect, it } from "vitest";
import { FakeHost } from "../host/fake.js";
import { slotId } from "./names.js";
import { type SlotStamp, rebuildState } from "./recovery.js";
import { RECOVERED_HOLDER, parseState, serialiseState } from "./state.js";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const LEASE = "fedcba9876543210fedcba9876543210";

const stamp = (slotId: string, extra: Partial<SlotStamp> = {}): SlotStamp => ({
  slotId,
  flavor: slotId.slice(0, slotId.lastIndexOf("-")),
  goldenHash: "g-" + slotId,
  lastResetAt: "2026-10-21T08:00:00.000Z",
  ...extra,
});

describe("rebuildState", () => {
  it("marks a slot with a lease id leased, holder unknown (recovered), and every other slot dirty", () => {
    const { state, slots, skipped } = rebuildState(
      [stamp("12sp9-01"), stamp("23-01", { leaseId: LEASE }), stamp("23-02", { leaseId: null }), stamp("35-01", { leaseId: undefined })],
      NOW,
    );
    expect(skipped).toEqual([]);
    expect(Object.values(state.slots).map((s) => [s.id, s.status])).toEqual([
      ["12sp9-01", "dirty"],
      ["23-01", "leased"],
      ["23-02", "dirty"],
      ["35-01", "dirty"],
    ]);
    expect(state.slots["23-01"]?.lease).toEqual({ lease_id: LEASE, holder: RECOVERED_HOLDER, leased_at: NOW.toISOString() });
    expect(slots.map((s) => s.slot)).toEqual(["12sp9-01", "23-01", "23-02", "35-01"]);
  });

  it("keeps what the stamp knows of the last reset", () => {
    const { state } = rebuildState([stamp("23-01")], NOW);
    expect(state.slots["23-01"]).toMatchObject({
      flavor: "23",
      number: 1,
      golden_hash: "g-23-01",
      last_reset_at: "2026-10-21T08:00:00.000Z",
      last_reset_ms: null,
    });
    expect(state.slots["23-01"]?.lease).toBeUndefined();
  });

  it("hands out nothing: no recovered slot is free", () => {
    const { state } = rebuildState([stamp("12sp9-01"), stamp("23-01", { leaseId: LEASE })], NOW);
    expect(Object.values(state.slots).some((s) => s.status === "free")).toBe(false);
  });

  it("skips and reports a stamp it cannot trust", () => {
    const { state, skipped } = rebuildState(
      [
        stamp("23-01"),
        stamp("23-01"),
        { ...stamp("23-02"), flavor: "35" },
        stamp("OLM_Local"),
        { ...stamp("99-01"), flavor: "99" },
        { ...stamp("23-03"), flavor: "bogus" },
      ],
      NOW,
    );
    expect(Object.keys(state.slots)).toEqual(["23-01"]);
    expect(skipped.map((s) => s.slotId)).toEqual(["23-01", "23-02", "OLM_Local", "99-01", "23-03"]);
  });

  it("treats a malformed lease id as dirty, not leased", () => {
    const { state, slots } = rebuildState([stamp("23-01", { leaseId: "not-a-lease" })], NOW);
    expect(state.slots["23-01"]?.status).toBe("dirty");
    expect(slots[0]?.note).toMatch(/malformed/);
  });

  it("produces a state the store would accept", () => {
    const { state } = rebuildState([stamp("12sp9-01"), stamp("23-01", { leaseId: LEASE })], NOW);
    expect(parseState(serialiseState(state))).toEqual(state);
  });

  it("rebuilds an empty pool from no stamps", () => {
    expect(rebuildState([], NOW).state.slots).toEqual({});
  });
});

describe("rebuildState from the host driver's stamps", () => {
  it("rebuilds a pool from what FakeHost reports, leased where a stamp carries a lease id", async () => {
    const host = new FakeHost();
    for (const ref of [{ flavor: "23", slot: 1 }, { flavor: "23", slot: 2 }, { flavor: "35", slot: 1 }] as const) {
      await host.provisionSlot(ref);
      await host.writeStamp(ref, {
        slotId: slotId(ref),
        flavor: ref.flavor,
        goldenHash: "golden-" + ref.flavor,
        lastResetAt: "2026-10-21T08:00:00.000Z",
        leaseId: ref.slot === 1 && ref.flavor === "23" ? LEASE : null,
      });
    }
    const listed = await host.listSlots();
    const { state, skipped } = rebuildState(
      listed.slots.flatMap((s) => (s.stamp ? [s.stamp] : [])),
      NOW,
    );
    expect(skipped).toEqual([]);
    expect(Object.values(state.slots).map((s) => [s.id, s.status])).toEqual([
      ["23-01", "leased"],
      ["23-02", "dirty"],
      ["35-01", "dirty"],
    ]);
    expect(state.slots["23-01"]?.lease?.holder).toBe(RECOVERED_HOLDER);
  });
});
