// A child process for the lease tests (run with vite-node, see src/core/lease.test.ts): one `get`
// against the shared state in LW_HOME. It has its own FakeHost, provisioned for every slot the state
// holds, so the only thing the processes share is the state file and its lock. Prints the grant's
// slot as JSON on success; on failure prints the message to stderr and exits with the error's code.
import { exitCodeFor, getLease } from "../../src/core/lease.js";
import { MemorySecretStore } from "../../src/core/secret-store.js";
import { StateStore } from "../../src/core/store.js";
import { FakeHost } from "../../src/host/fake.js";

const store = new StateStore({ home: process.env.LW_HOME ?? "" });
const host = new FakeHost();
for (const slot of Object.values((await store.read()).slots)) await host.provisionSlot({ flavor: slot.flavor, slot: slot.number });

try {
  const flavor = process.env.LW_FLAVOR ?? "";
  const grant = await getLease(
    { store, host, secrets: new MemorySecretStore(), resolveUrl: async (alias) => `http://172.19.0.1/${alias}`, maxActive: 99 },
    { flavor, holder: process.env.LW_HOLDER ?? "worker" },
  );
  console.log(JSON.stringify({ slot: grant.slot }));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = exitCodeFor(err);
}
