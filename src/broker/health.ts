// The broker's `healthCheck` verb (ticket 32, docs/health.md): whether a slot may be handed out. The reset's last step
// runs it after the start (src/core/reset.ts), `get` runs it before handing out a free slot (`checkClean`), and a
// provision runs it before the slot joins the pool. Every check is named in the result, with its time; any failure makes
// the result `ok: false`, which the reset quarantines with the checks named.
//
// The checks: the stamp (present, from the flavor's golden now, a reset time, no lease); the slot's own server answers
// `Client/`, lists exactly the slot's database in `Server/DBList.aspx` and serves the OAuth discovery document; the
// tree is golden's (the `fast` manifest verify) and the eight config files hold their rendering (the edit list's verify
// mode), with the OAuth signing certificate the slot's own (ticket 54, signing-cert.ts); the database marker carries the stamp's golden hash and a reset time, and the version rows are the flavor's
// server build; and `root` logs in with a one-time password. That last check is the randomisation of ticket 31's note:
// after a restore `root` and `admin` have the golden backup's password, so the broker logs in with it (or with the
// free slot's stored random one), sets both to a new random password through the slot's server (an AML edit through ticket 34's
// `ArasHttp`; SQL cannot), keeps that one in the host's store (`slot-<key>-<NN>-root`, for the lease credentials of ticket 34), and
// logs in with it. No licence key stored for the line means no rendered config carries one and the server refuses
// every login, so the check reports that instead of logging in.

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import { editListFiles, editVars, verifyFile } from "../core/edits.js";
import { FLAVORS } from "../core/flavors.js";
import { licenceSecretName } from "../core/licence.js";
import type { Manifest, ManifestDiff } from "../core/manifest.js";
import { DATABASE_MARKER, STAMP_FILE_NAME, ootbRootSecretName, slotId, slotRootSecretName, stampFile, webAlias, type SlotNames, type SlotRef } from "../core/names.js";
import { Secret } from "../core/secret.js";
import type { HealthCheckEntry, MarkerReading, SlotStamp } from "../host/driver.js";
import { HostError } from "../host/errors.js";
import { parseDbList } from "../host/probe.js";
import { LEASE_LOGIN, LEASE_USERS } from "./lease-credentials.js";
import type { Broker, VerbContext } from "./broker.js";
import { parseSlotStamp, type WireResult } from "./protocol.js";
import { SlotLocks, configSecrets, errorText, goldenEditList, seconds, storedLogins, type SlotSystem, type WarmAnswer } from "./provision.js";
import { versionProblem } from "./reset-database.js";
import { currentGoldenManifest, diffText } from "./reset-tree.js";
import { signingFiles, signingProblem } from "./signing-cert.js";

/** The checks, in the order the result lists them. */
export const HEALTH_CHECKS = ["stamp", "client", "dblist", "oauth", "tree", "configs", "marker", "version", "login"] as const;
export type HealthCheckName = (typeof HEALTH_CHECKS)[number];

/** A first request after a pool start: 2 to 15 s on `12sp9`, 37 s on a brand-new `23` slot (spike record, section 3). */
export const HEALTH_HTTP_TIMEOUT_MS = 120_000;

/** A free slot's one-time `root` password: 128 random bits as 32 hex characters (safe in a form body and in AML). */
export function newArasPassword(): Secret {
  return Secret.of(randomBytes(16).toString("hex"), "aras-login");
}

type Outcome = { readonly ok: boolean; readonly detail: string };
type Entry = HealthCheckEntry & { readonly name: HealthCheckName; readonly ms: number };

function pass(detail: string): Outcome {
  return { ok: true, detail };
}

function fail(detail: string): Outcome {
  return { ok: false, detail };
}

function short(hash: string | null | undefined): string {
  return hash ? hash.slice(0, 12) : "none";
}

/** The tree's diff without the slot's own stamp, which golden never has: the one extra file a slot always holds. */
export function withoutStamp(diff: ManifestDiff): ManifestDiff {
  if (!diff.extra.includes(STAMP_FILE_NAME)) return diff;
  const counts = { ...diff.counts, extra: diff.counts.extra - 1 };
  const ok = diff.problems.length === 0 && counts.missing + counts.changed + counts.extra === 0;
  return { ...diff, ok, counts, extra: diff.extra.filter((p) => p !== STAMP_FILE_NAME) };
}

function answered(path: string, answer: WarmAnswer, accept: (status: number) => boolean): Outcome {
  if (answer.status === undefined) return fail(`${path}: ${answer.error ?? "no answer"}`);
  return accept(answer.status) ? pass(`${path} HTTP ${answer.status}`) : fail(`${path} answered HTTP ${answer.status}`);
}

async function readStamp(system: SlotSystem, slot: SlotRef, root: string): Promise<{ stamp: SlotStamp | null; problem?: string }> {
  const bytes = await system.readFile(stampFile(slot, root));
  if (bytes === null) return { stamp: null, problem: "the slot has no stamp" };
  try {
    return { stamp: parseSlotStamp(JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, "")), slot) };
  } catch {
    return { stamp: null, problem: "the stamp is unreadable" };
  }
}

function stampCheck(stamp: SlotStamp | null, problem: string | undefined, manifest: Manifest): Outcome {
  if (stamp === null) return fail(problem ?? "the slot has no stamp");
  if (stamp.goldenHash !== manifest.manifestHash) return fail(`the stamp is from golden ${short(stamp.goldenHash)}, not the ${manifest.flavor} golden ${short(manifest.manifestHash)}`);
  if (!stamp.lastResetAt) return fail("the stamp records no reset");
  if (stamp.leaseId) return fail("the stamp names a lease");
  return pass(`golden ${short(stamp.goldenHash)}, reset ${stamp.lastResetAt}`);
}

/**
 * The login check: `root` logs in with the free slot's stored password or the golden backup's, both users get a new
 * random password (stored first, so a password the server took is never lost), `root` logs in with it, and the backup's
 * password no longer does.
 */
async function loginCheck(system: SlotSystem, slot: SlotRef, names: SlotNames, stamp: SlotStamp | null): Promise<Outcome> {
  const id = slotId(slot);
  const line = FLAVORS[slot.flavor].licence.line;
  if (!(await system.secrets.has(licenceSecretName(line)))) {
    return pass(`not checked: no licence key is stored for line ${line}, so ${id}'s server refuses every login`);
  }
  // A one-time password is never set on a slot a lease may be using.
  if (stamp === null || stamp.leaseId) return fail("not run: the stamp is missing or names a lease");
  const stored = await system.secrets.get(slotRootSecretName(slot));
  const shipped = await system.secrets.get(ootbRootSecretName(slot.flavor));
  const candidates: [string, Secret][] = [];
  if (stored) candidates.push(["the slot's stored password", stored]);
  if (shipped) candidates.push(["the golden backup's password", shipped]);
  if (candidates.length === 0) return fail(`no password of root is known: neither ${slotRootSecretName(slot)} nor ${ootbRootSecretName(slot.flavor)} is stored`);

  const alias = webAlias(slot);
  const database = names.database;
  let current: Secret | undefined;
  let used = "";
  const refusals: string[] = [];
  for (const [what, password] of candidates) {
    const answer = await system.aras.login(alias, database, LEASE_LOGIN, password);
    if (answer.ok) {
      current = password;
      used = what;
      break;
    }
    refusals.push(`with ${what}: ${answer.detail}`);
  }
  if (current === undefined) return fail(`root cannot log in (${refusals.join("; ")})`);

  const next = newArasPassword();
  await system.secrets.put(slotRootSecretName(slot), next);
  const edited = await system.aras.setPasswords(alias, database, { user: LEASE_LOGIN, password: current }, LEASE_USERS, next);
  if (!edited.ok) return fail(`the one-time password could not be set: ${edited.detail}`);
  const again = await system.aras.login(alias, database, LEASE_LOGIN, next);
  if (!again.ok) return fail(`root cannot log in with its one-time password: ${again.detail}`);
  if (shipped) {
    const old = await system.aras.login(alias, database, LEASE_LOGIN, shipped);
    if (old.ok) return fail("the golden backup's password still logs in as root");
  }
  return pass(`root logged in with a one-time password (set with ${used}); root and admin have it, the golden backup's password is refused`);
}

/**
 * `healthCheck`: every check of the slot, each with its time; `ok` only when all pass. `Refused` for a slot that is not
 * provisioned; `Retryable` while the flavor's golden is moved into place (nothing to check against).
 */
export async function healthCheckOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  if (!(await system.isDirectory(names.slotDir))) throw new HostError("Refused", `slot ${id} is not provisioned`);
  const manifest = await currentGoldenManifest(system, slot, root);
  const timed = async (name: HealthCheckName, fn: () => Promise<Outcome>): Promise<Entry> => {
    const t = system.now();
    let outcome: Outcome;
    try {
      outcome = await fn();
    } catch (err) {
      outcome = fail(errorText(err));
    }
    return { name, ok: outcome.ok, detail: outcome.detail, ms: Math.max(0, system.now() - t) };
  };

  const read = await readStamp(system, slot, root);
  const stamp = await timed("stamp", async () => stampCheck(read.stamp, read.problem, manifest));
  const base = `http://localhost/${webAlias(slot)}/`;
  // What the marker check read, for the version check and the result.
  const db: { marker: MarkerReading | null; version: Readonly<Record<string, string>> | null } = { marker: null, version: null };

  // The server, the files and the database are independent: checked together, so the cold start overlaps the verify.
  const [http, files, database] = await Promise.all([
    Promise.all([
      timed("client", async () => answered("Client/", await system.warm(`${base}Client/`, HEALTH_HTTP_TIMEOUT_MS), (s) => s >= 200 && s < 400)),
      timed("dblist", async () => {
        const answer = await system.warm(`${base}Server/DBList.aspx`, HEALTH_HTTP_TIMEOUT_MS, true);
        const status = answered("Server/DBList.aspx", answer, (s) => s === 200);
        if (!status.ok) return status;
        const ids = parseDbList(answer.body ?? "");
        if (ids.length === 1 && ids[0] === names.database) return pass(`lists ${names.database} only`);
        return fail(ids.length === 1 ? `lists a database that is not ${names.database}` : `lists ${ids.length} databases, not just ${names.database}`);
      }),
      timed("oauth", async () => answered("OAuth discovery", await system.warm(`${base}OAuthServer/.well-known/openid-configuration`, HEALTH_HTTP_TIMEOUT_MS), (s) => s === 200)),
    ]),
    (async () => {
      const list = await goldenEditList(system, slot, root);
      const rendered = editListFiles(list);
      // The signing certificate's files are the slot's own, not golden's: the configs check holds them instead.
      const signing = signingFiles(manifest);
      const tree = await timed("tree", async () => {
        const diff = withoutStamp(await system.verifyTree(slot, manifest, [...rendered, signing.pfx, ...signing.cers]));
        return diff.ok ? pass(`${diff.checked} files match golden ${short(manifest.manifestHash)}`) : fail(diffText(diff));
      });
      const configs = await timed("configs", async () => {
        const logins = await storedLogins(system.secrets, slot);
        if (logins === undefined) return fail(`the stored SQL login passwords of ${id} are missing`);
        const { secrets, signed } = await configSecrets(system, slot, list, logins);
        if (!signed) return fail(`the password of ${id}'s OAuth signing certificate is not stored (a slot provisioned before ticket 54; a reset makes it one)`);
        const vars = editVars(slot, root);
        const differ: string[] = [];
        for (const file of rendered) {
          const bytes = await system.readFile(win32.join(names.slotDir, ...file.split("/")));
          if (bytes === null) {
            differ.push(`${file} is missing`);
            continue;
          }
          for (const o of verifyFile(file, bytes, list, vars, secrets).outcomes) if (o.status !== "ok") differ.push(`${file} ${o.path}: ${o.detail ?? o.status}`);
        }
        if (differ.length > 0) return fail(`${differ.length} edits do not hold: ${differ.slice(0, 5).join("; ")}`);
        const problem = await signingProblem(system, slot, root, manifest);
        return problem ? fail(problem) : pass(`${rendered.length} files hold their rendering; the OAuth signing certificate is the slot's own`);
      });
      return [tree, configs];
    })(),
    (async () => {
      const marker = await timed("marker", async () => {
        const reading = await system.readDatabase(slot);
        if (reading.state === "missing") return fail(`${names.database} does not exist`);
        const marker = { goldenHash: reading.marker[DATABASE_MARKER.goldenHash] ?? null, resetAt: reading.marker[DATABASE_MARKER.resetAt] ?? null };
        db.marker = marker;
        db.version = reading.version;
        if (marker.goldenHash === null) return fail("the database carries no marker");
        if (read.stamp === null) return fail(`the marker is golden ${short(marker.goldenHash)}, and there is no stamp to compare it with`);
        if (marker.goldenHash !== read.stamp.goldenHash) return fail(`the marker is golden ${short(marker.goldenHash)}, the stamp ${short(read.stamp.goldenHash)}`);
        if (marker.resetAt === null || Number.isNaN(Date.parse(marker.resetAt))) return fail("the marker records no reset time");
        return pass(`golden ${short(marker.goldenHash)}, reset ${marker.resetAt}`);
      });
      const version = await timed("version", async () => {
        const rows = db.version;
        if (rows === null) return fail("the database could not be read");
        const wrong = versionProblem(slot.flavor, rows);
        return wrong ? fail(wrong.replace("the restored database", "the database")) : pass(`version ${rows.VersionMajor ?? "?"} build ${rows.VersionBuild ?? "?"}, the ${slot.flavor} server build`);
      });
      return [marker, version];
    })(),
  ]);
  // The login needs the server up; it is not attempted when the server does not answer.
  const serving = http.every((c) => c.ok);
  const login = serving ? await timed("login", () => loginCheck(system, slot, names, read.stamp)) : { name: "login" as const, ok: false, detail: "not run: the server does not answer", ms: 0 };

  const checks: Entry[] = [stamp, ...http, ...files, ...database, login];
  const failed = checks.filter((c) => !c.ok);
  const times = checks.map((c) => `${c.name} ${seconds(c.ms)}`).join(", ");
  const total = seconds(system.now() - started);
  const detail =
    failed.length === 0
      ? `${id} is healthy (${checks.length} checks in ${total} s: ${times})`
      : `${id} failed ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")} (${total} s: ${times})`;
  return { ok: failed.length === 0, detail, checks, marker: db.marker };
}

/** Registers `healthCheck` on `broker`, under the same per-slot `locks` as the slot verbs: its login check sets a password. */
export function registerHealthVerb(broker: Broker, system: SlotSystem, locks: SlotLocks): Broker {
  return broker.register("healthCheck", {
    target: "slot",
    run: (ctx: VerbContext) => locks.run(ctx, (slot, names) => healthCheckOnHost(system, slot, names, ctx.root)),
  });
}
