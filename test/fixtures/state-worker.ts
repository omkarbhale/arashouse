// A child process for the state-store tests (run with vite-node, see src/core/store.test.ts).
// ST_HOME: the state home. ST_MODE=cycle: ST_COUNT legal transitions on slot 23-01, each in its own
// update. ST_MODE=crash: add a slot, then die by SIGKILL after the temp file is written and before
// it replaces state.json, still holding the lock.
import { StateStore } from "../../src/core/store.js";
import type { SlotStatus, TransitionRequest } from "../../src/core/state.js";

const home = process.env.ST_HOME ?? "";
const mode = process.env.ST_MODE ?? "";
const count = Number(process.env.ST_COUNT ?? "0");

function next(status: SlotStatus, pid: number): TransitionRequest {
  switch (status) {
    case "free":
      return { to: "leased", holder: `worker-${pid}` };
    case "leased":
      return { to: "dirty" };
    case "dirty":
      return { to: "resetting", pid };
    default:
      return { to: "free", golden_hash: "h", reset_ms: 1 };
  }
}

if (mode === "cycle") {
  const store = new StateStore({ home });
  for (let i = 0; i < count; i++) {
    await store.update((tx) => {
      const slot = tx.slot("23-01");
      if (!slot) throw new Error("slot 23-01 is missing");
      tx.transition(slot.id, next(slot.status, process.pid));
    });
  }
} else if (mode === "crash") {
  const store = new StateStore({
    home,
    beforeRename: () => {
      process.kill(process.pid, "SIGKILL");
    },
  });
  await store.update((tx) => {
    tx.addSlot({ flavor: "12sp9", slot: 1 });
  });
} else {
  throw new Error(`unknown ST_MODE "${mode}"`);
}
