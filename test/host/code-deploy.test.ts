// Ticket 40's proof on the real host (test/host/code-deploy-proof.ts, docs/code-deploy.md): a code deploy onto a `12sp9`
// lease, its refusals, the reset that removes it, and `--atomic`. It takes leases of the pool, so it runs only when
// asked: ARASHOUSE_TEST_DEPLOY=1, natively on Windows (or from WSL, through the launcher), with the broker (with `deployCode`) installed, a free 12sp9 slot, the
// line-12 licence stored, `npm run build` done, and:
//   ARASHOUSE_HOME          the pool's state folder (the CLI's)
//   ARASHOUSE_DEPLOY_OUT    a folder outside the worktree for the record and the sources

import { describe, expect, it } from "vitest";
import { runDeployProof } from "./code-deploy-proof.js";

const env = process.env;

if (env.ARASHOUSE_TEST_DEPLOY === "1") {
  describe("the code deploy on this host", () => {
    it("deploys, refuses, resets and returns atomically", { timeout: 60 * 60_000 }, async () => {
      const records = await runDeployProof(env.ARASHOUSE_DEPLOY_OUT as string);
      expect(records.filter((r) => !r.ok).map((r) => `${r.step}: ${r.detail}`)).toEqual([]);
    });
  });
} else {
  describe.skip("the code deploy on this host (set ARASHOUSE_TEST_DEPLOY=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
