// The host-driver contract suite against `BrokerHost` on the real host (tickets 25 and 35). It provisions and destroys
// the slot 12sp9-98, which no pool uses, so it runs only when asked: ARASHOUSE_TEST_BROKER=1, natively on Windows (the
// pipe transport) or from WSL (interop), with the broker installed and the 12sp9 golden built. Ticket 35 ran it green (docs/e2e-12sp9.md). A bad staged path of
// `deployCode`, `restoreDatabase` or `backupDatabase` (tickets 39, 40 and 43) is refused by `BrokerHost`'s own guard
// before it reaches the broker, as FakeHost refuses it.

import { describe, it } from "vitest";
import { DEFAULT_INSTALL_ROOT, goldenLayout } from "../src/core/names.js";
import { BrokerHost, brokerTransport } from "../src/host/index.js";
import { hostContractSuite } from "./host-contract.js";

const slot = { flavor: "12sp9", slot: 98 } as const;

if (process.env.ARASHOUSE_TEST_BROKER === "1") {
  hostContractSuite("BrokerHost on this host", async () => {
    const host = new BrokerHost(brokerTransport(process.env));
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
