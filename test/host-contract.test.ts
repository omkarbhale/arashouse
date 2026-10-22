import { FakeHost } from "../src/host/index.js";
import { hostContractSuite } from "./host-contract.js";

const slot = { flavor: "12sp9", slot: 1 } as const;

hostContractSuite("FakeHost", () => {
  const host = new FakeHost();
  return {
    host,
    root: host.root,
    slot,
    golden: host.golden(slot.flavor),
    backup: host.backup(slot.flavor),
    failNext: (method) => host.injectFault({ method, kind: "fail", error: "Retryable" }),
    dirtyTree: (s) => host.dirty(s, "tree"),
  };
});
