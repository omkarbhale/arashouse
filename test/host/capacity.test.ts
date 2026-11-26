// Ticket 38's acceptance on the real host (test/host/capacity.ts, docs/capacity.md): three leases at once on the v1
// pool, busy, returned at once, and the broker killed during a lease and during a reset. It takes every slot of the
// pool in turn, so it runs only when asked, with the host to itself: ARASHOUSE_TEST_E2E=1, natively on Windows (or from WSL, through the launcher), with the broker
// installed, the v1 pool provisioned and free (ticket 37), `npm run build` done, and:
//   ARASHOUSE_E2E_OUT              a folder outside the worktree for the record, the memory samples and the packages
//   ARASHOUSE_E2E_ARAS_PKG         libs-js's built CLI (`dist/cli.js`)
//   ARASHOUSE_CAPACITY_TRIGGER_DIR test/host/kill-broker.ps1's -TriggerDir as a WSL path, with that script running
//                                  elevated; without it the broker is not killed (step 5 is not run)
//   ARASHOUSE_CAPACITY_ROUNDS      import-and-export rounds per lease while three are busy (default 2)

import { describe, expect, it } from "vitest";
import { runCapacity } from "./capacity.js";

const env = process.env;

if (env.ARASHOUSE_TEST_E2E === "1") {
  describe("capacity: three leases at once on this host", () => {
    it("passes every step", { timeout: 3 * 60 * 60_000 }, async () => {
      const records = await runCapacity({
        out: env.ARASHOUSE_E2E_OUT as string,
        arasPkg: env.ARASHOUSE_E2E_ARAS_PKG as string,
        triggerDir: env.ARASHOUSE_CAPACITY_TRIGGER_DIR || undefined,
        busyRounds: Number(env.ARASHOUSE_CAPACITY_ROUNDS ?? "2"),
      });
      expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
    });
  });
} else {
  describe.skip("capacity: three leases at once on this host (set ARASHOUSE_TEST_E2E=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
