// Ticket 41's acceptance on the real host (test/host/e2e-import.ts, docs/import.md): `get --import` onto a lease of each
// flavor, an atomic failure, and the password grep. It takes and returns leases of the installed pool, so it runs only
// when asked: ARASHOUSE_TEST_IMPORT=1, from WSL, with the broker installed, the flavors' slots provisioned and free,
// `npm run build` done, and:
//   ARASHOUSE_E2E_OUT       a folder outside the worktree for the record, the packages and the exports
//   ARASHOUSE_E2E_ARAS_PKG  libs-js's built CLI (`dist/cli.js` of a checkout, whose fixtures/ give the scratch packages)
//   ARASHOUSE_IMPORT_FLAVORS the flavors, comma-separated (default 12sp9,23,35)

import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS, type FlavorKey } from "../../src/core/flavors.js";
import { runImportProof } from "./e2e-import.js";

const env = process.env;

if (env.ARASHOUSE_TEST_IMPORT === "1") {
  const flavors = (env.ARASHOUSE_IMPORT_FLAVORS ?? FLAVOR_KEYS.join(",")).split(",") as FlavorKey[];
  describe("e2e: get --import on this host", () => {
    for (const flavor of flavors) {
      it(`imports onto a ${flavor} lease, atomically`, { timeout: 60 * 60_000 }, async () => {
        const records = await runImportProof({ flavor, out: env.ARASHOUSE_E2E_OUT as string, arasPkg: env.ARASHOUSE_E2E_ARAS_PKG as string });
        expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
      });
    }
  });
} else {
  describe.skip("e2e: get --import on this host (set ARASHOUSE_TEST_IMPORT=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
