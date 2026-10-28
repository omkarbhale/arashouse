// Ticket 43's proof on the real host (test/host/extract-cycle.ts, docs/extract.md): code, a database backup and a
// package taken out of a leased 12sp9 slot outlive its return and reset, and the broker refuses the backup of a slot that
// is not leased and of a deny-list name. It leases and returns a 12sp9 slot of the pool, so it runs only when asked:
// ARASHOUSE_TEST_EXTRACT=1, from WSL, with the broker of ticket 43 or later installed, a free 12sp9 slot, `npm run build`
// done, and:
//   ARASHOUSE_EXTRACT_OUT      a folder outside the worktree for the record and the extracted copies (emptied first)
//   ARASHOUSE_EXTRACT_ARAS_PKG libs-js's built CLI (`dist/cli.js`)

import { describe, expect, it } from "vitest";
import { runExtractCycle } from "./extract-cycle.js";

const env = process.env;

if (env.ARASHOUSE_TEST_EXTRACT === "1") {
  describe("extract: take code, data and a package out of a 12sp9 lease on this host", () => {
    it("keeps the copies through the return and the reset, and refuses the rest", { timeout: 60 * 60_000 }, async () => {
      const records = await runExtractCycle({
        flavor: "12sp9",
        engine: "12.0",
        out: env.ARASHOUSE_EXTRACT_OUT as string,
        arasPkg: env.ARASHOUSE_EXTRACT_ARAS_PKG as string,
      });
      expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
    });
  });
} else {
  describe.skip("extract: take code, data and a package out of a 12sp9 lease on this host (set ARASHOUSE_TEST_EXTRACT=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
