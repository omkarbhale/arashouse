// Ticket 36's acceptance on the real host (test/host/e2e-cycle.ts, docs/e2e-23.md): ticket 35's lease cycle for `23`
// (Release 23, server 14.0.9.36073, libs-js engine 14.0.7), twice in a row, with the 14.x OAuth server's runtime state
// dirtied and checked as well. It provisions 23-01 and -02 (and leaves them provisioned and free), so it runs only when
// asked: ARASHOUSE_TEST_E2E=1, from WSL, with the broker installed, the 23 golden built, the line-14 licence and
// ootb-root-23 stored, `npm run build` done, and the variables of test/host/e2e-12sp9.test.ts:
//   ARASHOUSE_E2E_OUT       a folder outside the worktree for the record, the export and the scratch package
//   ARASHOUSE_E2E_ARAS_PKG  libs-js's built CLI (`dist/cli.js`)
//   ARASHOUSE_E2E_OOTB_FILE the golden backup's root password as ConvertFrom-SecureString output (Windows path), for
//                           the "does not log in with the shipped password" checks; without it they are skipped
//   ARASHOUSE_E2E_CYCLES    how many cycles (default 2)

import { describe, expect, it } from "vitest";
import { runCycle } from "./e2e-cycle.js";

const env = process.env;

if (env.ARASHOUSE_TEST_E2E === "1") {
  const cycles = Number(env.ARASHOUSE_E2E_CYCLES ?? "2");
  describe("e2e: the 23 lease cycle on this host", () => {
    it(`passes ${cycles} times in a row`, { timeout: cycles * 90 * 60_000 }, async () => {
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const records = await runCycle({
          cycle,
          flavor: "23",
          engine: "14.0.7",
          out: env.ARASHOUSE_E2E_OUT as string,
          arasPkg: env.ARASHOUSE_E2E_ARAS_PKG as string,
          ootbFile: env.ARASHOUSE_E2E_OOTB_FILE || undefined,
          oauthState: true,
          lockHolder: "worker",
        });
        expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
      }
    });
  });
} else {
  describe.skip("e2e: the 23 lease cycle on this host (set ARASHOUSE_TEST_E2E=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
