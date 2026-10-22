import { describe, expect, it } from "vitest";
import {
  type Slot,
  type SlotStatus,
  type State,
  type TransitionRequest,
  IllegalTransitionError,
  SLOT_STATUSES,
  StateCorruptError,
  TRANSITIONS,
  canTransition,
  emptyState,
  isLeaseId,
  newLeaseId,
  newSlot,
  parseState,
  serialiseState,
  transitionSlot,
} from "./state.js";

const NOW = new Date("2026-10-22T10:00:00.000Z");
const LEASE = "0123456789abcdef0123456789abcdef";
const ctx = { now: NOW, newLeaseId: () => LEASE };

/** A request that satisfies whatever `to` needs. */
function request(to: SlotStatus): TransitionRequest {
  switch (to) {
    case "free":
      return { to, golden_hash: "g1", reset_ms: 1234.4 };
    case "leased":
      return { to, holder: "task-7" };
    case "resetting":
      return { to, pid: 4242 };
    case "quarantined":
      return { to, reason: "database restore failed" };
    default:
      return { to };
  }
}

/** A slot in `status`, with the fields that status carries. */
function slotIn(status: SlotStatus): Slot {
  const base = { ...newSlot({ flavor: "23", slot: 2 }), golden_hash: "g0", last_reset_at: "2026-10-21T09:00:00.000Z", last_reset_ms: 900 };
  switch (status) {
    case "leased":
      return { ...base, status, lease: { lease_id: LEASE, holder: "someone", leased_at: "2026-10-22T09:00:00.000Z" } };
    case "resetting":
      return { ...base, status, reset: { started_at: "2026-10-22T09:30:00.000Z", pid: 99, attempt: 1 } };
    case "quarantined":
      return { ...base, status, quarantine_reason: "earlier failure" };
    default:
      return { ...base, status };
  }
}

describe("the status table", () => {
  const legal = SLOT_STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
  const illegal = SLOT_STATUSES.flatMap((from) =>
    SLOT_STATUSES.filter((to) => !TRANSITIONS[from].includes(to)).map((to) => [from, to] as const),
  );

  it("covers every status", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...SLOT_STATUSES].sort());
  });

  it.each(legal)("allows %s -> %s", (from, to) => {
    const next = transitionSlot(slotIn(from), request(to), ctx);
    expect(next.status).toBe(to);
    expect(next.id).toBe("23-02");
  });

  it.each(illegal)("throws on %s -> %s", (from, to) => {
    expect(() => transitionSlot(slotIn(from), request(to), ctx)).toThrow(IllegalTransitionError);
  });

  it("refuses the moves that would skip a reset", () => {
    expect(canTransition("free", "resetting")).toBe(false);
    expect(canTransition("leased", "free")).toBe(false);
    expect(canTransition("dirty", "free")).toBe(false);
    expect(canTransition("dirty", "leased")).toBe(false);
    expect(canTransition("resetting", "leased")).toBe(false);
    expect(canTransition("quarantined", "free")).toBe(false);
    expect(canTransition("quarantined", "leased")).toBe(false);
    expect(canTransition("disabled", "free")).toBe(false);
  });

  it("hands out only free slots", () => {
    const leasable = SLOT_STATUSES.filter((s) => canTransition(s, "leased"));
    expect(leasable).toEqual(["free"]);
  });

  it("names the slot and both statuses in the error", () => {
    expect(() => transitionSlot(slotIn("free"), request("resetting"), ctx)).toThrow("23-02: free -> resetting");
  });
});

describe("what a transition records", () => {
  it("leases with a random 128-bit hex id, the holder and the time, and no expiry", () => {
    const leased = transitionSlot(slotIn("free"), { to: "leased", holder: "task-7", bootstrap: { recipe: "demo", restore: true } }, ctx);
    expect(leased.lease).toEqual({
      lease_id: LEASE,
      holder: "task-7",
      leased_at: NOW.toISOString(),
      bootstrap: { recipe: "demo", restore: true },
    });
    expect(Object.keys(leased.lease ?? {})).not.toContain("expires_at");
    const a = newLeaseId();
    expect(isLeaseId(a)).toBe(true);
    expect(a).not.toBe(newLeaseId());
    expect(a).toHaveLength(32);
  });

  it("drops the lease on return and keeps nothing of it", () => {
    const dirty = transitionSlot(slotIn("leased"), { to: "dirty" }, ctx);
    expect(dirty.lease).toBeUndefined();
  });

  it("counts reset attempts until the slot is clean", () => {
    const first = transitionSlot(slotIn("dirty"), { to: "resetting", pid: 11 }, ctx);
    expect(first.reset).toEqual({ started_at: NOW.toISOString(), pid: 11, attempt: 1 });
    const interrupted = transitionSlot(first, { to: "dirty" }, ctx);
    expect(interrupted.reset?.attempt).toBe(1);
    const second = transitionSlot(interrupted, { to: "resetting", pid: 12 }, ctx);
    expect(second.reset?.attempt).toBe(2);
    const free = transitionSlot(second, { to: "free", golden_hash: "g2", reset_ms: 4999.6 }, ctx);
    expect(free).toMatchObject({ status: "free", golden_hash: "g2", last_reset_at: NOW.toISOString(), last_reset_ms: 5000 });
    expect(free.reset).toBeUndefined();
    const again = transitionSlot(transitionSlot(transitionSlot(free, { to: "leased", holder: "h" }, ctx), { to: "dirty" }, ctx), { to: "resetting", pid: 13 }, ctx);
    expect(again.reset?.attempt).toBe(1);
  });

  it("keeps the reason while quarantined and clears it on repair", () => {
    const q = transitionSlot(slotIn("resetting"), { to: "quarantined", reason: "restore failed" }, ctx);
    expect(q.quarantine_reason).toBe("restore failed");
    const repaired = transitionSlot(q, { to: "provisioning" }, ctx);
    expect(repaired).toMatchObject({ status: "provisioning", golden_hash: null, last_reset_at: null, last_reset_ms: null });
    expect(repaired.quarantine_reason).toBeUndefined();
    expect(repaired.reset).toBeUndefined();
  });

  it.each<[string, TransitionRequest]>([
    ["a free without a golden hash", { to: "free", golden_hash: "", reset_ms: 1 }],
    ["a free with a negative reset time", { to: "free", golden_hash: "g", reset_ms: -1 }],
    ["a lease without a holder", { to: "leased", holder: " " }],
    ["a quarantine without a reason", { to: "quarantined", reason: "" }],
    ["a reset without a pid", { to: "resetting", pid: 0 }],
  ])("refuses %s", (_label, req) => {
    const from: SlotStatus = req.to === "free" ? "resetting" : req.to === "leased" ? "free" : req.to === "resetting" ? "dirty" : "dirty";
    expect(() => transitionSlot(slotIn(from), req, ctx)).toThrow();
  });

  it("does not change its input", () => {
    const before = slotIn("free");
    const snapshot = JSON.stringify(before);
    transitionSlot(before, { to: "leased", holder: "h" }, ctx);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

function stateWith(...slots: Slot[]): State {
  return { ...emptyState(NOW), revision: 3, slots: Object.fromEntries(slots.map((s) => [s.id, s])) };
}

describe("the state file bytes", () => {
  it("round-trips every status", () => {
    const slots = SLOT_STATUSES.map((status, i) => ({ ...slotIn(status), id: `23-0${i + 1}`, number: i + 1 }));
    const state = stateWith(...slots);
    expect(parseState(serialiseState(state))).toEqual(state);
  });

  it("round-trips the lease, with its bootstrap", () => {
    const leased = transitionSlot(slotIn("free"), { to: "leased", holder: "h", bootstrap: { recipe: "r", steps: 3 } }, ctx);
    const back = parseState(serialiseState(stateWith(leased)));
    expect(back.slots["23-02"]?.lease).toEqual(leased.lease);
  });

  it("holds no password, key or token: only the fixed fields are written", () => {
    // Assembled from parts so this file holds no secret-shaped literal.
    const canary = ["hunter", "2-canary-", "pw"].join("");
    const leased = transitionSlot(slotIn("free"), { to: "leased", holder: "task-7" }, ctx);
    const tainted = {
      ...leased,
      aras_password: canary,
      lease: { ...leased.lease, password: canary, token: canary, licence_key: canary },
    } as unknown as Slot;
    const bytes = serialiseState(stateWith(tainted));
    expect(bytes).not.toContain(canary);
    expect(bytes).not.toMatch(/password|token|licen[cs]e|secret/i);
    expect(bytes).toContain(LEASE);
  });

  it.each(["password", "aras_password", "token", "licence_key", "lic_key", "secret", "api_key", "secret_hash", "salt"])(
    "refuses a bootstrap key named %s",
    (key) => {
      expect(() => transitionSlot(slotIn("free"), { to: "leased", holder: "h", bootstrap: { [key]: "x" } }, ctx)).toThrow(/secret/);
    },
  );

  it("refuses a bootstrap value that is not a scalar", () => {
    const bad = { recipe: { nested: true } } as never;
    expect(() => transitionSlot(slotIn("free"), { to: "leased", holder: "h", bootstrap: bad }, ctx)).toThrow();
  });
});

describe("parseState refuses a damaged file", () => {
  const good = () => JSON.parse(serialiseState(stateWith(slotIn("leased")))) as Record<string, any>;
  const parse = (raw: unknown) => parseState(JSON.stringify(raw), "/h/state.json");

  it.each([
    ["not JSON", "{"],
    ["empty", ""],
    ["a truncated file", serialiseState(stateWith(slotIn("free"))).slice(0, 40)],
    ["an array", "[]"],
  ])("%s", (_label, text) => {
    expect(() => parseState(text, "/h/state.json")).toThrow(StateCorruptError);
  });

  it("names the file and the rebuild command", () => {
    expect(() => parseState("{", "/h/state.json")).toThrow(/\/h\/state\.json.*doctor --rebuild-state/);
  });

  it.each<[string, (s: Record<string, any>) => void]>([
    ["a wrong version", (s) => (s.version = 2)],
    ["a negative revision", (s) => (s.revision = -1)],
    ["slots that are not a list", (s) => (s.slots = {})],
    ["an unknown status", (s) => (s.slots[0].status = "leasing")],
    ["a flavor that disagrees with the id", (s) => (s.slots[0].flavor = "35")],
    ["a leased slot with no lease", (s) => delete s.slots[0].lease],
    ["a lease on a slot that is not leased", (s) => (s.slots[0].status = "free")],
    ["a lease id that is not 128 bits of hex", (s) => (s.slots[0].lease.lease_id = "abc")],
    ["a duplicate slot", (s) => s.slots.push(structuredClone(s.slots[0]))],
    ["a quarantined slot with no reason", (s) => ((s.slots[0].status = "quarantined"), delete s.slots[0].lease)],
    ["a resetting slot with no reset record", (s) => ((s.slots[0].status = "resetting"), delete s.slots[0].lease)],
    ["a secret-named bootstrap key", (s) => (s.slots[0].lease.bootstrap = { ["pass" + "word"]: "x" })],
  ])("%s", (_label, damage) => {
    const raw = good();
    damage(raw);
    expect(() => parse(raw)).toThrow(StateCorruptError);
  });

  it("accepts the undamaged file", () => {
    expect(() => parse(good())).not.toThrow();
  });
});
