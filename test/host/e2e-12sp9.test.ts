// Ticket 35's acceptance on the real host (test/host/e2e-cycle.ts, docs/e2e-12sp9.md): the whole lease cycle for
// `12sp9`, twice in a row. It provisions 12sp9-01 and -02 (and leaves them provisioned and free), so it runs only when
// asked: ARASHOUSE_TEST_E2E=1, from WSL, with the broker installed, the 12sp9 golden built, the line-12 licence and
// ootb-root-12sp9 stored, `npm run build` done, and:
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
  describe("e2e: the 12sp9 lease cycle on this host", () => {
    it(`passes ${cycles} times in a row`, { timeout: cycles * 90 * 60_000 }, async () => {
      for (let cycle = 1; cycle <= cycles; cycle++) {
        const records = await runCycle({
          cycle,
          flavor: "12sp9",
          engine: "12.0",
          out: env.ARASHOUSE_E2E_OUT as string,
          arasPkg: env.ARASHOUSE_E2E_ARAS_PKG as string,
          ootbFile: env.ARASHOUSE_E2E_OOTB_FILE || undefined,
        });
        expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
      }
    });
  });
} else {
  describe.skip("e2e: the 12sp9 lease cycle on this host (set ARASHOUSE_TEST_E2E=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
