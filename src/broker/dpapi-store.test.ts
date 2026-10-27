import { describe, expect, it } from "vitest";
import { Secret } from "../core/secret.js";
import { dpapiSecretStore, storedSecretKind, type SecretStepRunner } from "./dpapi-store.js";

/** A runner over a map, recording each request (the value only as its length). */
function runner(): { run: SecretStepRunner; blobs: Map<string, string>; seen: string[] } {
  const blobs = new Map<string, string>();
  const seen: string[] = [];
  const run: SecretStepRunner = async (step, request) => {
    const r = request as { name: string; value?: string };
    seen.push(`${step} ${r.name}${r.value === undefined ? "" : ` (${r.value.length} chars)`}`);
    switch (step) {
      case "secret-put":
        blobs.set(r.name, r.value!);
        return { stored: true };
      case "secret-get":
        return blobs.has(r.name) ? { found: true, value: blobs.get(r.name) } : { found: false };
      case "secret-delete":
        return { deleted: blobs.delete(r.name) };
    }
  };
  return { run, blobs, seen };
}

describe("the broker's DPAPI secret store", () => {
  it("round-trips a slot login password and a licence key, wrapped in their kinds", async () => {
    const r = runner();
    const store = dpapiSecretStore(r.run);
    await store.put("slot-12sp9-01-dbo", Secret.of("a-slot-password-012345", "sql-login"));
    const back = await store.get("slot-12sp9-01-dbo");
    expect(back?.kind).toBe("sql-login");
    expect(back?.reveal()).toBe("a-slot-password-012345");
    expect(await store.has("licence-12")).toBe(false);
    expect(await store.delete("slot-12sp9-01-dbo")).toBe(true);
    expect(await store.get("slot-12sp9-01-dbo")).toBeUndefined();
    expect(r.seen).toEqual(["secret-put slot-12sp9-01-dbo (22 chars)", "secret-get slot-12sp9-01-dbo", "secret-get licence-12", "secret-delete slot-12sp9-01-dbo", "secret-get slot-12sp9-01-dbo"]);
  });

  it("refuses a name it does not keep, and a secret of the wrong kind for its name", async () => {
    const store = dpapiSecretStore(runner().run);
    await expect(store.get("../sa")).rejects.toThrow(/secret name/);
    await expect(store.get("lease-0123")).rejects.toThrow(/no stored secret is named like/);
    await expect(store.put("licence-14", Secret.of("not-a-licence-0000", "sql-login"))).rejects.toThrow(/must be a licence secret/);
    expect(storedSecretKind("licence-14")).toBe("licence");
    expect(storedSecretKind("slot-35-07-reg")).toBe("sql-login");
  });
});
