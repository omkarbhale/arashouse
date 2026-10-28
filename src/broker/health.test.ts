import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { licenceSecretName } from "../core/licence.js";
import { DEFAULT_INSTALL_ROOT, buildScratch, ootbRootSecretName, slotNames, slotOAuthSecretName, slotRootSecretName, stampFile, type SlotRef } from "../core/names.js";
import { Secret } from "../core/secret.js";
import type { HealthCheckEntry } from "../host/driver.js";
import { HostError } from "../host/errors.js";
import { Broker } from "./broker.js";
import { HEALTH_CHECKS, healthCheckOnHost, newArasPassword, registerHealthVerb } from "./health.js";
import { SlotLocks, destroySlotOnHost, provisionSlotOnHost, registerSlotVerbs } from "./provision.js";
import { resetDatabaseOnHost } from "./reset-database.js";
import { FakeSlotSystem } from "./slot-system.fixture.js";
import { FakeAras, SHIPPED } from "../../test/fake-aras.js";

const ROOT = DEFAULT_INSTALL_ROOT;
const s1: SlotRef = { flavor: "12sp9", slot: 1 };
const names = slotNames(s1, ROOT);
const inSlot = (rel: string) => win32.join(names.slotDir, ...rel.split("/"));
const ALIAS = "ah-12sp9-01";
const stamp = (system: FakeSlotSystem) => JSON.parse(system.text(stampFile(s1, ROOT))!) as Record<string, unknown>;

/** A slot provisioned from a golden whose hash is its manifest's, as on the host, with a fake Aras server. */
async function provisioned(options: { licence?: boolean; shipped?: boolean } = {}): Promise<FakeSlotSystem & { aras: FakeAras }> {
  const system = new FakeSlotSystem() as FakeSlotSystem & { aras: FakeAras };
  system.aras = new FakeAras();
  system.goldenState = { state: "ok", hash: system.manifest("12sp9").manifestHash };
  if (options.licence) await system.secrets.put(licenceSecretName("12"), Secret.of("a-licence-key-0123", "licence"));
  if (options.shipped) await system.secrets.put(ootbRootSecretName("12sp9"), Secret.of(SHIPPED, "aras-login"));
  await provisionSlotOnHost(system, s1, names, ROOT);
  system.calls.length = 0;
  return system;
}

async function check(system: FakeSlotSystem) {
  const result = await healthCheckOnHost(system, s1, names, ROOT);
  const checks = result.checks as HealthCheckEntry[];
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  return { result, checks, byName, failed: checks.filter((c) => !c.ok).map((c) => c.name) };
}

async function failure(promise: Promise<unknown>): Promise<HostError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof HostError)) throw new Error(`expected a HostError, got ${String(err)}`);
  return err;
}

describe("healthCheck", () => {
  it("passes a freshly provisioned slot: every check named, in order, with its time, and the marker", async () => {
    const system = await provisioned();
    const { result, checks, byName } = await check(system);
    expect(result.ok).toBe(true);
    expect(checks.map((c) => c.name)).toEqual([...HEALTH_CHECKS]);
    expect(checks.every((c) => c.ok && typeof c.ms === "number" && c.ms >= 0)).toBe(true);
    expect(result.marker).toEqual({ goldenHash: system.manifest("12sp9").manifestHash, resetAt: stamp(system).lastResetAt === null ? null : expect.any(String) });
    expect(result.detail).toMatch(/^12sp9-01 is healthy \(9 checks in \d+\.\d s: stamp [\d.]+, client [\d.]+, dblist [\d.]+, oauth [\d.]+, tree [\d.]+, configs [\d.]+, marker [\d.]+, version [\d.]+, login [\d.]+\)$/);
    expect(byName.dblist?.detail).toBe("lists arashouse_12sp9_01 only");
    expect(byName.version?.detail).toBe("version 12 build 24090, the 12sp9 server build");
    // No licence: the server refuses every login, so the broker does not try.
    expect(byName.login?.detail).toBe("not checked: no licence key is stored for line 12, so 12sp9-01's server refuses every login");
    expect(system.aras.calls).toEqual([]);
    expect(system.warmed).toEqual([
      "http://localhost/ah-12sp9-01/Client/",
      "http://localhost/ah-12sp9-01/Server/DBList.aspx",
      "http://localhost/ah-12sp9-01/OAuthServer/.well-known/openid-configuration",
    ]);
  });

  it("sets root and admin to a one-time password, stores it, logs in with it, and the golden backup's password is refused", async () => {
    const system = await provisioned({ licence: true, shipped: true });
    const { result, byName } = await check(system);
    expect(result.ok).toBe(true);
    expect(byName.login?.detail).toBe(
      "root logged in with a one-time password (set with the golden backup's password); root and admin have it, the golden backup's password is refused",
    );
    const stored = await system.secrets.get(slotRootSecretName(s1));
    expect(stored?.kind).toBe("aras-login");
    expect(stored?.length).toBe(32);
    expect(system.aras.password(ALIAS, "root")).toBe(stored?.reveal());
    expect(system.aras.password(ALIAS, "admin")).toBe(stored?.reveal());
    expect(system.aras.calls).toEqual([
      `login ${ALIAS} root`,
      `login ${ALIAS} root`,
      `edit ${ALIAS} admin`,
      `edit ${ALIAS} root`,
      `login ${ALIAS} root`,
      `login ${ALIAS} root`,
    ]);
    // Nothing of a password reaches the result.
    expect(JSON.stringify(result)).not.toContain(SHIPPED);
    expect(JSON.stringify(result)).not.toContain(stored?.reveal());

    // The next check logs in with the stored one and sets a new one.
    const again = await check(system);
    expect(again.byName.login).toMatchObject({ ok: true, detail: expect.stringContaining("set with the slot's stored password") });
    expect(await system.secrets.get(slotRootSecretName(s1))).not.toBe(stored);
  });

  it("logs in with the golden backup's password again after a reset restored the database", async () => {
    const system = await provisioned({ licence: true, shipped: true });
    await check(system);
    const hash = system.manifest("12sp9").manifestHash;
    await resetDatabaseOnHost(system, s1, ROOT, { file: `${ROOT}\\golden\\12sp9\\db\\ootb.bak`, hash }, async () => undefined);
    // The restore brings back the golden's users: the fake's default password.
    system.aras.passwords.clear();
    const { byName } = await check(system);
    expect(byName.login).toMatchObject({ ok: true, detail: expect.stringContaining("set with the golden backup's password") });
  });

  it("fails the login when no password of root is known, when root is refused, or when the edit is refused", async () => {
    const unknown = await provisioned({ licence: true });
    expect((await check(unknown)).byName.login).toMatchObject({
      ok: false,
      detail: "no password of root is known: neither slot-12sp9-01-root nor ootb-root-12sp9 is stored",
    });

    const refused = await provisioned({ licence: true, shipped: true });
    refused.aras.loginAnswer = { ok: false, refused: true, detail: "invalid_grant: License Key is invalid." };
    const r = await check(refused);
    expect(r.result.ok).toBe(false);
    expect(r.byName.login?.detail).toBe("root cannot log in (invalid_grant: License Key is invalid. (with the golden backup's password))");
    expect(r.result.timedOut).toBeUndefined();
    expect(r.byName.login?.timedOut).toBeUndefined();

    const faulty = await provisioned({ licence: true, shipped: true });
    faulty.aras.editAnswer = { ok: false, refused: true, detail: "edit of admin: Access denied" };
    expect((await check(faulty)).byName.login).toMatchObject({ ok: false, detail: "the one-time password could not be set: edit of admin: Access denied" });
  });

  it("times out a login the server is too slow to answer, unlike one it refuses, and a wrong check besides is not a timeout", async () => {
    // Ticket 38's quarantines: root's login cut off after 100 to 120 s on a loaded host.
    const CANCELLED = { ok: false, refused: false, detail: "invalid_grant: The operation was canceled.", timedOut: true } as const;
    const slow = await provisioned({ licence: true, shipped: true });
    expect((await check(slow)).result.ok).toBe(true);
    slow.aras.calls.length = 0;
    slow.aras.loginAnswer = CANCELLED;
    const s = await check(slow);
    expect(s.failed).toEqual(["login"]);
    expect(s.byName.login).toMatchObject({ ok: false, timedOut: true, detail: "root's login did not answer in time (invalid_grant: The operation was canceled., with the slot's stored password)" });
    expect(s.result).toMatchObject({ ok: false, timedOut: true });
    // A slow login says nothing about the password: the next one is not tried.
    expect(slow.aras.calls).toEqual(["login ah-12sp9-01 root"]);

    // The same slow login on a slot that also has an extra file: the tree answered wrongly, so it is not a timeout.
    slow.put(inSlot("Innovator/Client/added.js"), "added by a lease");
    const mixed = await check(slow);
    expect(mixed.failed).toEqual(["tree", "login"]);
    expect(mixed.byName.login?.timedOut).toBe(true);
    expect(mixed.result.timedOut).toBeUndefined();

    // The golden backup's password not refused in time: whether it still logs in is unknown, so not a pass.
    const unsure = await provisioned({ licence: true, shipped: true });
    const login = unsure.aras.login.bind(unsure.aras);
    let logins = 0;
    unsure.aras.login = async (...args) => (++logins === 4 ? CANCELLED : login(...args));
    const u = await check(unsure);
    expect(logins).toBe(4);
    expect(u.byName.login).toMatchObject({ ok: false, timedOut: true, detail: expect.stringMatching(/^the server did not answer in time whether the golden backup's password is refused/) });
    expect(u.result.timedOut).toBe(true);
  });

  it("fails a slot whose database marker is gone, or names another golden than the stamp", async () => {
    const system = await provisioned();
    system.databaseMarkers.delete("arashouse_12sp9_01");
    const gone = await check(system);
    expect(gone.failed).toEqual(["marker"]);
    expect(gone.byName.marker?.detail).toBe("the database carries no marker");
    expect(gone.result.marker).toEqual({ goldenHash: null, resetAt: null });

    system.databaseMarkers.set("arashouse_12sp9_01", { goldenHash: "a".repeat(64), resetAt: "2026-10-28T10:00:00.000Z" });
    const other = await check(system);
    expect(other.failed).toEqual(["marker"]);
    expect(other.byName.marker?.detail).toMatch(/^the marker is golden aaaaaaaaaaaa, the stamp [0-9a-f]{12}$/);
  });

  it("fails a slot whose stamp is from another golden, names a lease or records no reset, and never sets a password on a leased slot", async () => {
    const system = await provisioned({ licence: true, shipped: true });
    const original = stamp(system);
    system.put(stampFile(s1, ROOT), JSON.stringify({ ...original, goldenHash: "b".repeat(64) }));
    const other = await check(system);
    expect(other.failed).toEqual(["stamp", "marker"]);
    expect(other.byName.stamp?.detail).toMatch(/^the stamp is from golden bbbbbbbbbbbb, not the 12sp9 golden [0-9a-f]{12}$/);

    system.put(stampFile(s1, ROOT), JSON.stringify({ ...original, leaseId: "ab".repeat(16) }));
    system.aras.calls.length = 0;
    const leased = await check(system);
    expect(leased.failed).toEqual(["stamp", "login"]);
    expect(leased.byName.login?.detail).toBe("not run: the stamp is missing or names a lease");
    expect(system.aras.calls).toEqual([]);

    system.put(stampFile(s1, ROOT), JSON.stringify({ ...original, lastResetAt: null }));
    expect((await check(system)).byName.stamp).toMatchObject({ ok: false, detail: "the stamp records no reset" });
    system.put(stampFile(s1, ROOT), "not json");
    expect((await check(system)).byName.stamp).toMatchObject({ ok: false, detail: "the stamp is unreadable" });
  });

  it("passes a slot whose client wrote its runtime files on its first start (jsBundles\\compile.log, data.json)", async () => {
    const system = await provisioned();
    system.put(inSlot("Innovator/Client/jsBundles/compile.log"), "compiled at the first request after a start");
    system.put(inSlot("Innovator/Client/jsBundles/data.json"), '{"rewritten":true}');
    expect((await check(system)).failed).toEqual([]);
  });

  it("fails a slot with an extra file in its tree, a changed file, or a config that does not hold its rendering", async () => {
    const system = await provisioned();
    system.put(inSlot("Innovator/Client/added.js"), "added by a lease");
    const extra = await check(system);
    expect(extra.failed).toEqual(["tree"]);
    expect(extra.byName.tree?.detail).toMatch(/^fast verify failed: \d+ files checked; 0 missing, 0 changed, 1 extra: extra innovator\/client\/added\.js$/);

    const clean = await provisioned();
    clean.put(inSlot("InnovatorServerConfig.xml"), clean.text(win32.join(ROOT, "golden", "12sp9", "tree", "InnovatorServerConfig.xml"))!);
    const config = await check(clean);
    expect(config.failed).toEqual(["configs"]);
    expect(config.byName.configs?.detail).toMatch(/^\d+ edits do not hold: InnovatorServerConfig\.xml /);
  });

  it("fails a slot that signs with golden's certificate, whose copies differ, or whose signing password is not stored", async () => {
    const goldenCer = (rel: string) => win32.join(ROOT, "golden", "12sp9", "tree", ...rel.split("/"));
    const cers = ["OAuthServer/App_Data/Certificates/OAuthServer.cer", "Innovator/Server/App_Data/Certificates/OAuthServer.cer", "VaultServer/App_Data/Certificates/OAuthServer.cer"];

    const own = await provisioned();
    const ok = await check(own);
    expect(ok.failed).toEqual([]);
    expect(ok.byName.configs?.detail).toBe("9 files hold their rendering; the OAuth signing certificate is the slot's own");

    const golden = await provisioned();
    for (const rel of cers) golden.put(inSlot(rel), golden.text(goldenCer(rel))!);
    const g = await check(golden);
    expect(g.failed).toEqual(["configs"]);
    expect(g.byName.configs?.detail).toBe("the slot signs with golden's certificate, not its own (a reset makes it one)");

    const mixed = await provisioned();
    mixed.put(inSlot(cers[2]!), "another certificate");
    const m = await check(mixed);
    expect(m.failed).toEqual(["configs"]);
    expect(m.byName.configs?.detail).toMatch(/^vaultserver\/app_data\/certificates\/oauthserver\.cer is not the certificate of /);

    const unstored = await provisioned();
    await unstored.secrets.delete(slotOAuthSecretName(s1));
    const u = await check(unstored);
    expect(u.failed).toEqual(["configs"]);
    expect(u.byName.configs?.detail).toBe("the password of 12sp9-01's OAuth signing certificate is not stored (a slot provisioned before ticket 54; a reset makes it one)");

    const password = await provisioned();
    password.put(inSlot("OAuthServer/OAuth.config"), password.text(goldenCer("OAuthServer/OAuth.config"))!.replace(/ah-build-12sp9/g, ALIAS));
    const p = await check(password);
    expect(p.failed).toEqual(["configs"]);
    expect(p.byName.configs?.detail).toMatch(/^2 edits do not hold: OAuthServer\/OAuth\.config \/oauth\/server\/tokenSigning\/certificate\/@password: /);
    expect(JSON.stringify(p.result)).not.toContain((await password.secrets.get(slotOAuthSecretName(s1)))!.reveal());
  });

  it("fails a slot whose server does not answer, lists other databases, or is another version; the login is not tried without a server", async () => {
    const down = await provisioned({ licence: true, shipped: true });
    down.warmAnswer = () => ({ ms: 120_000, error: "timed out after 120000 ms", timedOut: true });
    const d = await check(down);
    expect(d.failed).toEqual(["client", "dblist", "oauth", "login"]);
    expect(d.byName.client?.detail).toBe("Client/: timed out after 120000 ms");
    expect(d.byName.login?.detail).toBe("not run: the server does not answer");
    expect(down.aras.calls).toEqual([]);
    // Nothing answered in the bound: a slow server, so the result is timed out, every failed check with it.
    expect(d.result.timedOut).toBe(true);
    expect(d.checks.filter((c) => !c.ok).every((c) => c.timedOut === true)).toBe(true);

    // A server that refuses the connection answered wrongly: not timed out.
    const refusing = await provisioned({ licence: true, shipped: true });
    refusing.warmAnswer = () => ({ ms: 3, error: "connection failed (ECONNREFUSED)" });
    const rf = await check(refusing);
    expect(rf.failed).toEqual(["client", "dblist", "oauth", "login"]);
    expect(rf.result.timedOut).toBeUndefined();
    expect(rf.byName.login?.timedOut).toBeUndefined();

    const two = await provisioned();
    two.pageBody = () => `<DBList><DB id="arashouse_12sp9_01"/><DB id="OLM_Local"/></DBList>`;
    expect((await check(two)).byName.dblist).toMatchObject({ ok: false, detail: "lists 2 databases, not just arashouse_12sp9_01" });
    two.warmAnswer = (url) => (url.endsWith("openid-configuration") ? { status: 502, ms: 10 } : { status: 200, ms: 10 });
    expect((await check(two)).byName.oauth).toMatchObject({ ok: false, detail: "OAuth discovery answered HTTP 502" });

    const old = await provisioned();
    old.databaseVersion = { VersionMajor: "12", VersionMinor: "0", VersionServicePack: "SP9", VersionBuild: "99999" };
    expect((await check(old)).byName.version).toMatchObject({ ok: false, detail: "the database is version 12.0 SP9 build 99999, not the 12sp9 server build 12.0.0.24090" });
  });

  it("refuses a slot that is not provisioned, and waits while the golden is moved into place", async () => {
    const system = await provisioned();
    const two: SlotRef = { flavor: "12sp9", slot: 2 };
    expect(await failure(healthCheckOnHost(system, two, slotNames(two, ROOT), ROOT))).toMatchObject({ kind: "Refused", message: "slot 12sp9-02 is not provisioned" });
    system.put(buildScratch("12sp9", ROOT).promotingMarker, "2026-10-28T00:00:00Z");
    expect(await failure(healthCheckOnHost(system, s1, names, ROOT))).toMatchObject({ kind: "Retryable", message: expect.stringContaining("a new 12sp9 golden is being moved into place") });
  });

  it("is a broker verb with no arguments, under the slot's lock, and a destroy forgets the slot's root password", async () => {
    const system = await provisioned({ licence: true, shipped: true });
    const locks = new SlotLocks();
    const b = registerHealthVerb(registerSlotVerbs(new Broker({ root: ROOT }), system, locks), system, locks);
    expect(await b.handle({ id: "h", verb: "healthCheck", slot: s1 })).toMatchObject({ ok: true, result: { ok: true } });
    expect(await b.handle({ id: "x", verb: "healthCheck", slot: s1, args: { user: "admin" } })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    for (const slot of [{ flavor: "OLM_Local", slot: 1 }, { flavor: "12sp9", slot: 0 }]) {
      expect(await b.handle({ id: "x", verb: "healthCheck", slot })).toMatchObject({ ok: false, error: { kind: "Refused" } });
    }
    expect(await system.secrets.has(slotRootSecretName(s1))).toBe(true);
    await destroySlotOnHost(system, s1, names);
    expect(await system.secrets.has(slotRootSecretName(s1))).toBe(false);
  });
});

describe("newArasPassword", () => {
  it("is 128 random bits as 32 hex characters, a fresh one each time", () => {
    const a = newArasPassword();
    expect(a.kind).toBe("aras-login");
    expect(a.reveal()).toMatch(/^[0-9a-f]{32}$/);
    expect(a.reveal()).not.toBe(newArasPassword().reveal());
  });
});
