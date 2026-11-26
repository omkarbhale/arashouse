import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseSecretName } from "./lease.js";
import { LeaseFileStore } from "./lease-files.js";
import { Secret } from "./secret.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-lease-files-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const LEASE = "0123456789abcdef0123456789abcdef";

describe("LeaseFileStore", () => {
  it("keeps a lease password in a 0600 file in a 0700 folder, and deletes it", async () => {
    const store = new LeaseFileStore(home);
    const name = leaseSecretName(LEASE);
    expect(await store.has(name)).toBe(false);
    expect(await store.get(name)).toBeUndefined();

    await store.put(name, Secret.of("pw-for-the-lease", "lease-password"));
    const file = join(home, "leases", LEASE);
    // On Windows a mode is not access: the home's ACL (the worker user's profile) keeps the file private.
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, "leases"))).mode & 0o777).toBe(0o700);
    }
    expect(await store.has(name)).toBe(true);
    expect((await store.get(name))?.reveal()).toBe("pw-for-the-lease");
    expect(await readFile(file, "utf8")).toBe("pw-for-the-lease");

    // A second process sees the same file.
    expect((await new LeaseFileStore(home).get(name))?.reveal()).toBe("pw-for-the-lease");

    expect(await store.delete(name)).toBe(true);
    expect(await store.delete(name)).toBe(false);
    expect(await readdir(join(home, "leases"))).toEqual([]);
  });

  it("holds lease passwords only", async () => {
    const store = new LeaseFileStore(home);
    await expect(store.put("licence-14", Secret.of("k", "licence"))).rejects.toThrow(/only lease passwords/);
    await expect(store.put(leaseSecretName(LEASE), Secret.of("k", "sql-sa"))).rejects.toThrow(/only lease passwords/);
    await expect(store.get("../state")).rejects.toThrow();
    expect(() => store.pathOf(`lease-${LEASE}x`)).toThrow();
  });
});
