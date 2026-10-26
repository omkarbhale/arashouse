// Recovery: rebuild a lost or corrupt state file from the slot stamps (`.arashouse-slot.json`).
// The stamps are read through the host driver (ticket 12) by `arashouse doctor --rebuild-state`
// (ticket 16); this file only turns what they say into a state.

import { isFlavorKey } from "./flavors.js";
import { parseSlotId } from "./names.js";
import { RECOVERED_HOLDER, type Slot, type State, emptyState, isLeaseId, newSlot } from "./state.js";

/** What a slot folder's `.arashouse-slot.json` records; structurally the host driver's `SlotStamp`. */
export interface SlotStamp {
  readonly slotId: string;
  readonly flavor: string;
  readonly goldenHash: string | null;
  readonly lastResetAt: string | null;
  /** The lease id, if the slot was leased when the stamp was last written. */
  readonly leaseId?: string | null;
}

export interface RebuildEntry {
  readonly slot: string;
  readonly status: Slot["status"];
  readonly note: string;
}

export interface RebuildResult {
  readonly state: State;
  readonly slots: readonly RebuildEntry[];
  /** Stamps that could not be used, and why. Their slots are absent from the state. */
  readonly skipped: readonly { readonly slotId: string; readonly reason: string }[];
}

/**
 * A slot whose stamp carries a lease id comes back `leased`, holder `unknown (recovered)`, lease
 * time the time of the rebuild (the stamp does not record it). Every other slot comes back `dirty`,
 * so it is reset before it is handed out. A stamp that is inconsistent (its id does not parse, its
 * flavor disagrees with its id, a duplicate id) is skipped and reported, not guessed at; a lease id
 * that is not 128 bits of hex cannot be returned with, so that slot is `dirty` too.
 */
export function rebuildState(stamps: readonly SlotStamp[], now: Date = new Date()): RebuildResult {
  const slots: Record<string, Slot> = {};
  const entries: RebuildEntry[] = [];
  const skipped: { slotId: string; reason: string }[] = [];
  for (const stamp of stamps) {
    const skip = (reason: string) => skipped.push({ slotId: String(stamp.slotId), reason });
    let ref;
    try {
      ref = parseSlotId(stamp.slotId);
    } catch {
      skip("the slot id is not <flavor>-<NN>");
      continue;
    }
    if (!isFlavorKey(stamp.flavor) || stamp.flavor !== ref.flavor) {
      skip("the stamp's flavor does not match its slot id");
      continue;
    }
    if (slots[stamp.slotId]) {
      skip("a second stamp for the same slot");
      continue;
    }
    const base = {
      ...newSlot(ref),
      golden_hash: stamp.goldenHash ?? null,
      last_reset_at: stamp.lastResetAt ?? null,
    };
    let slot: Slot;
    let note: string;
    if (stamp.leaseId === undefined || stamp.leaseId === null) {
      slot = { ...base, status: "dirty" };
      note = "no lease in the stamp: reset before it is handed out";
    } else if (isLeaseId(stamp.leaseId)) {
      slot = {
        ...base,
        status: "leased",
        lease: { lease_id: stamp.leaseId, holder: RECOVERED_HOLDER, leased_at: now.toISOString() },
      };
      note = "the stamp holds a lease id: kept leased";
    } else {
      slot = { ...base, status: "dirty" };
      note = "the stamp's lease id is malformed: treated as dirty";
    }
    slots[slot.id] = slot;
    entries.push({ slot: slot.id, status: slot.status, note });
  }
  return { state: { ...emptyState(now), slots }, slots: entries, skipped };
}
