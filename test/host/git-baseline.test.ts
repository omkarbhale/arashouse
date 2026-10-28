// Ticket 53's proof on the real host (test/host/git-baseline-proof.ts, docs/git-baseline.md): a git baseline of a lease
// of each flavor, clean after it has served, recycled and restarted, an edit as exactly the diff, and gone after the
// reset. It takes leases of the pool, so it runs only when asked: ARASHOUSE_TEST_GIT=1, from WSL, with Git for Windows,
// a free slot of each flavor proved, the licences stored, `npm run build` done, and:
//   ARASHOUSE_HOME          the pool's state folder (the CLI's)
//   ARASHOUSE_GIT_OUT       a folder outside the worktree for the record and the overlays
//   ARASHOUSE_GIT_FLAVORS   optional: the flavors, comma-separated (default 12sp9,23,35)

import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS, isFlavorKey, type FlavorKey } from "../../src/core/flavors.js";
import { runGitProof } from "./git-baseline-proof.js";

const env = process.env;

if (env.ARASHOUSE_TEST_GIT === "1") {
  describe("the git baseline on this host", () => {
    it("commits, stays clean, shows an edit and is gone after the reset", { timeout: 3 * 60 * 60_000 }, async () => {
      const flavors = (env.ARASHOUSE_GIT_FLAVORS?.split(",").map((f) => f.trim()) ?? [...FLAVOR_KEYS]).filter(isFlavorKey) as FlavorKey[];
      const records = await runGitProof(env.ARASHOUSE_GIT_OUT as string, flavors);
      expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
    });
  });
} else {
  describe.skip("the git baseline on this host (set ARASHOUSE_TEST_GIT=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
