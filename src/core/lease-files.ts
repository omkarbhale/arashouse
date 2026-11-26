// The CLI side's one persisted secret: a lease's password, at `<home>/leases/<lease_id>` (mode 0600,
// in a 0700 folder; on Windows the modes do nothing, and the home's ACL, the worker user's profile, keeps it
// private), so `arashouse run --lease` in a later process can hand it to its child. `get`
// writes it and `return` deletes it; nothing else is kept. Ticket 34 owns the host side of the
// per-lease password (setting it in the slot's database and forgetting it at reset).

import { chmod, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertSecretName, type SecretStore } from "./secret-store.js";
import { Secret } from "./secret.js";
import { BUSY_SHORT_MS, retryBusy } from "./lock.js";
import { writeFileAtomic } from "./store.js";

const LEASE_SECRET = /^lease-([0-9a-f]{32})$/;

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** A `SecretStore` that holds only lease passwords (`lease-<lease_id>`), one file per lease. */
export class LeaseFileStore implements SecretStore {
  /** The folder of lease files: `<home>/leases`. */
  readonly dir: string;

  constructor(home: string) {
    this.dir = join(home, "leases");
  }

  /** The file of a lease secret; any other name is refused. */
  pathOf(name: string): string {
    const match = LEASE_SECRET.exec(assertSecretName(name));
    if (!match) throw new Error("the lease-file store holds only lease passwords (lease-<lease_id>)");
    return join(this.dir, match[1]!);
  }

  async has(name: string): Promise<boolean> {
    try {
      return (await stat(this.pathOf(name))).isFile();
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async get(name: string): Promise<Secret | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathOf(name), "utf8");
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
    return text === "" ? undefined : Secret.of(text, "lease-password");
  }

  async put(name: string, secret: Secret): Promise<void> {
    const path = this.pathOf(name);
    if (secret.kind !== "lease-password") throw new Error("the lease-file store holds only lease passwords");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    await writeFileAtomic(path, secret.reveal());
  }

  async delete(name: string): Promise<boolean> {
    try {
      await retryBusy(() => unlink(this.pathOf(name)), { totalMs: BUSY_SHORT_MS });
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }
}
