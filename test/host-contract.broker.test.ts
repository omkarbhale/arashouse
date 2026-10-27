// The host-driver contract suite against `BrokerHost` on the real host (tickets 25 and 35). It provisions and destroys
// the slot 12sp9-98, which no pool uses, so it runs only when asked: ARASHOUSE_TEST_BROKER=1, from WSL, with the
// broker installed and the 12sp9 golden built. Ticket 35 ran it green (docs/e2e-12sp9.md); the bootstrap verbs
// (`deployCode`, `restoreDatabase`, `backupDatabase`, tickets 39, 40 and 43) are not on the broker yet, so their staged
// paths are refused by `BrokerHost`'s own guard, as FakeHost refuses them.

import { describe, it } from "vitest";
import { DEFAULT_INSTALL_ROOT, goldenLayout } from "../src/core/names.js";
import { BrokerHost, interopTransport } from "../src/host/index.js";
import { hostContractSuite } from "./host-contract.js";

const slot = { flavor: "12sp9", slot: 98 } as const;

if (process.env.ARASHOUSE_TEST_BROKER === "1") {
  hostContractSuite("BrokerHost on this host", async () => {
    const host = new BrokerHost(interopTransport({ node: process.env.ARASHOUSE_WINDOWS_NODE || undefined }));
    // The golden's manifest hash, as the broker names it: a tree reset mirrors to that golden only.
    const hash = (await host.baselineVerify(slot.flavor)).goldenHash ?? "";
    return {
      host,
      root: DEFAULT_INSTALL_ROOT,
      slot,
      golden: { flavor: slot.flavor, hash },
      backup: { flavor: slot.flavor, file: goldenLayout(slot.flavor).ootbBackup, hash },
      teardown: async () => {
        await host.destroySlot(slot).catch(() => undefined);
      },
    };
  });
} else {
  describe.skip("host contract: BrokerHost on this host (set ARASHOUSE_TEST_BROKER=1)", () => {
    it("runs only on the host", () => undefined);
  });
}
