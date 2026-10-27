import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS, FLAVORS } from "./flavors.js";
import {
  LicenceRequiredError,
  SECRET_REQUIRED_EXIT_CODE,
  ensureLicence,
  forgetLicence,
  formatLicenceStatus,
  licenceLines,
  licenceNeeded,
  licencePrompt,
  licenceSecretName,
  licenceStatus,
  stepNeedsLicence,
} from "./licence.js";
import { redact } from "./redact.js";
import { MemorySecretStore, type HiddenPrompter } from "./secret-store.js";
import { Secret, type SecretKind } from "./secret.js";

const KEY = ["LK", "-", "ZZ12", "-", "QQ34", "-", "RR56"].join("");

function prompter(answers: string[], interactive = true) {
  const asked: string[] = [];
  const impl: HiddenPrompter = {
    interactive,
    async promptSecret(question: string, kind: SecretKind) {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("asked more often than the test expected");
      return Secret.of(answer, kind);
    },
  };
  return { impl, asked };
}

describe("licence handling in the flavor registry", () => {
  it("gives every flavor a licence line and a requirement", () => {
    for (const key of FLAVOR_KEYS) {
      expect(FLAVORS[key].licence.line).not.toBe("");
      expect(["to-install", "to-login", "never"]).toContain(FLAVORS[key].licence.required);
    }
    expect(licenceLines()).toEqual(["12", "14"]);
  });

  it("decides per step whether a key is needed", () => {
    const steps = ["install", "login", "edit-list"] as const;
    expect(steps.map((step) => licenceNeeded("to-install", step))).toEqual([true, false, true]);
    expect(steps.map((step) => licenceNeeded("to-login", step))).toEqual([false, true, true]);
    expect(steps.map((step) => licenceNeeded("never", step))).toEqual([false, false, false]);
    for (const key of FLAVOR_KEYS) expect(stepNeedsLicence(key, "install")).toBe(licenceNeeded(FLAVORS[key].licence.required, "install"));
  });
});

describe("licenceSecretName and the prompt text", () => {
  it("names the stored secret by line and refuses an unknown line", () => {
    expect(licenceSecretName("14")).toBe("licence-14");
    expect(() => licenceSecretName("../x")).toThrow(/unknown licence line/);
    expect(() => licenceSecretName("99")).toThrow(/unknown licence line/);
  });

  it("names the line in the question", () => {
    expect(licencePrompt("14")).toBe("Aras licence key for line 14 (not needed if you do not use 14.x): ");
  });
});

describe("ensureLicence", () => {
  it("asks exactly once, stores the answer machine-scope and never asks again", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([KEY]);
    const first = await ensureLicence("23", "login", { store, prompter: impl });
    expect(first?.reveal()).toBe(KEY);
    expect(asked).toEqual([licencePrompt("14")]);
    expect(await store.has("licence-14")).toBe(true);

    const again = await ensureLicence("23", "login", { store, prompter: impl });
    expect(again?.reveal()).toBe(KEY);
    expect(asked).toHaveLength(1);
  });

  it("applies one stored key to every flavor of the line", async () => {
    const store = new MemorySecretStore();
    await store.put("licence-12", Secret.of(KEY, "licence"));
    const { impl, asked } = prompter([]);
    expect((await ensureLicence("12sp9", "login", { store, prompter: impl }))?.reveal()).toBe(KEY);
    expect((await ensureLicence("12sp9", "edit-list", { store, prompter: impl }))?.reveal()).toBe(KEY);
    expect(asked).toEqual([]);
  });

  it("shares one prompt between steps that need the same key at the same time", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([KEY]);
    const results = await Promise.all([
      ensureLicence("12sp9", "login", { store, prompter: impl }),
      ensureLicence("12sp9", "edit-list", { store, prompter: impl }),
    ]);
    expect(results.map((r) => r?.reveal())).toEqual([KEY, KEY]);
    expect(asked).toHaveLength(1);
  });

  it("asks once per line, naming the line", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([KEY, KEY + "x"]);
    await ensureLicence("12sp9", "login", { store, prompter: impl });
    await ensureLicence("23", "login", { store, prompter: impl });
    expect(asked).toEqual([licencePrompt("12"), licencePrompt("14")]);
  });

  it("does not ask when the step needs no key", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([]);
    expect(await ensureLicence("12sp9", "install", { store, prompter: impl })).toBeUndefined();
    expect(asked).toEqual([]);
    expect(await store.has("licence-12")).toBe(false);
  });

  it("exits 8 without a TTY, never guesses and never asks", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([KEY], false);
    const err = await ensureLicence("23", "login", { store, prompter: impl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicenceRequiredError);
    expect((err as LicenceRequiredError).exitCode).toBe(8);
    expect(SECRET_REQUIRED_EXIT_CODE).toBe(8);
    expect((err as LicenceRequiredError).message).toContain("line 14");
    expect(asked).toEqual([]);
    expect(await store.has("licence-14")).toBe(false);
  });

  it("still returns a stored key without a TTY", async () => {
    const store = new MemorySecretStore();
    await store.put("licence-14", Secret.of(KEY, "licence"));
    const { impl } = prompter([], false);
    expect((await ensureLicence("23", "login", { store, prompter: impl }))?.reveal()).toBe(KEY);
  });

  it("exits 8 on an empty answer and stores nothing, so the next run asks again", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter(["", KEY]);
    const err = await ensureLicence("23", "login", { store, prompter: impl }).catch((e: unknown) => e);
    expect((err as LicenceRequiredError).exitCode).toBe(8);
    expect(await store.has("licence-14")).toBe(false);
    expect((await ensureLicence("23", "login", { store, prompter: impl }))?.reveal()).toBe(KEY);
    expect(asked).toHaveLength(2);
  });

  it("never puts the key in an error message, the prompt or a redacted log line", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([KEY]);
    await ensureLicence("23", "login", { store, prompter: impl });
    expect(asked.join("")).not.toContain(KEY);
    expect(redact(`got ${KEY}`)).not.toContain(KEY);
    const err = new LicenceRequiredError("14", "no-tty");
    expect(err.message).not.toContain(KEY);
  });
});

describe("forgetting and reporting", () => {
  it("forget removes the stored key, after which the tool asks again", async () => {
    const store = new MemorySecretStore();
    const { impl, asked } = prompter([KEY, KEY]);
    await ensureLicence("23", "login", { store, prompter: impl });
    expect(await forgetLicence("14", store)).toBe(true);
    expect(await forgetLicence("14", store)).toBe(false);
    await ensureLicence("23", "login", { store, prompter: impl });
    expect(asked).toHaveLength(2);
    await expect(forgetLicence("nope", store)).rejects.toThrow(/unknown licence line/);
  });

  it("reports presence as a boolean only", async () => {
    const store = new MemorySecretStore();
    await store.put("licence-14", Secret.of(KEY, "licence"));
    const status = await licenceStatus(store);
    expect(status).toEqual([
      { line: "12", present: false },
      { line: "14", present: true },
    ]);
    expect(formatLicenceStatus({ line: "14", present: true })).toBe("licence line 14: present");
    expect(JSON.stringify(status)).not.toContain(KEY);
  });
});

describe("MemorySecretStore", () => {
  it("round-trips a secret and rejects a name that is not a safe file name", async () => {
    const store = new MemorySecretStore();
    await store.put("sa", Secret.of("abcdefgh", "sql-sa"));
    expect((await store.get("sa"))?.reveal()).toBe("abcdefgh");
    expect(await store.get("absent")).toBeUndefined();
    await expect(store.put("../sa", Secret.of("abcdefgh", "sql-sa"))).rejects.toThrow(/secret name/);
    await expect(store.get("Licence-14")).rejects.toThrow(/secret name/);
  });
});
