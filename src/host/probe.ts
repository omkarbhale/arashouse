// The WSL-side health probe of one slot: anonymous HTTP only, no broker. It is the final sanity
// check before `get` hands a slot out, and the WSL half of `doctor` and of the health check
// (ticket 32; the broker's own check is the Windows side). It reports booleans and timings; the only
// body content it keeps is the list of database ids.

import { assertOwned } from "../core/guards.js";
import { isFlavorKey } from "../core/flavors.js";
import type { SlotRef } from "../core/names.js";
import { HostError } from "./errors.js";
import { COLD_TIMEOUT_MS, WARM_TIMEOUT_MS, anonymousGet, type HttpAnswer } from "./http.js";
import { guarded } from "./owned.js";
import { isHostAddress } from "./url.js";

export interface ProbeOptions {
  /** Timeout for the first call to a slot in this process (a cold start); default 60 s. */
  coldTimeoutMs?: number;
  /** Timeout once the slot has answered; default 5 s. */
  warmTimeoutMs?: number;
  /** Force the choice: `false` after a reset recycled the slot's pools. Default: the process's record. */
  warm?: boolean;
}

export interface ProbeCheck {
  readonly ok: boolean;
  readonly ms: number;
  /** The HTTP status; absent when nothing answered. */
  readonly status?: number;
  /** A short reason, never a response body. */
  readonly detail: string;
}

export interface DbListCheck extends ProbeCheck {
  /** The database ids `DBList.aspx` listed (at most 20, each at most 128 characters). */
  readonly databases: readonly string[];
}

export interface SlotProbe {
  /** Every check passed. */
  readonly ok: boolean;
  readonly url: string;
  readonly database: string;
  /** Wall-clock milliseconds for the whole probe (the checks run together). */
  readonly ms: number;
  /** Whether the long first-call timeout applied. */
  readonly cold: boolean;
  /** `GET /Client/` answers (200 to 399). */
  readonly client: ProbeCheck;
  /** `GET OAuthServer/.well-known/openid-configuration` answers 200. */
  readonly oauth: ProbeCheck;
  /** `GET DBList.aspx` lists exactly this slot's one database. */
  readonly dbList: DbListCheck;
}

const MAX_IDS = 20;
const MAX_ID_LENGTH = 128;
const DB_ELEMENT = /<DB\b[^>]*?\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const ALIAS = /^ah-([a-z0-9]+)-(\d{2})$/;

/** URLs that have answered in this process: the next probe of one uses the short timeout. */
const warmUrls = new Set<string>();

/** Treats `url` (or every URL) as cold again, e.g. after a reset recycled the slot's pools. */
export function forgetWarm(url?: string): void {
  if (url === undefined) warmUrls.clear();
  else warmUrls.delete(normalise(url));
}

function normalise(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The database ids named by a `DBList.aspx` document (`<DB id="..."/>` elements). */
export function parseDbList(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(DB_ELEMENT)) ids.push(match[1] ?? match[2] ?? "");
  return ids;
}

/** Vets the URL and database before anything is contacted; returns the URL without a trailing slash. */
function vet(url: string, database: string): string {
  const refuse = (why: string) => new HostError("Refused", `cannot probe "${url}": ${why}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refuse("not a URL");
  }
  if (parsed.protocol !== "http:") throw refuse("only http is probed");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw refuse("no credentials, query or fragment");
  if (!isHostAddress(parsed.host)) throw refuse("the host is not a plain host name or address");
  const alias = /^\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
  const m = alias === undefined ? null : ALIAS.exec(alias);
  const flavor = m?.[1];
  if (alias === undefined || !m || !isFlavorKey(flavor)) throw refuse("the path is not one slot's web alias (/ah-<flavor>-<NN>)");
  const ref: SlotRef = { flavor, slot: Number(m[2]) };
  guarded(() => {
    assertOwned("alias", alias, ref);
    assertOwned("database", database, ref);
  });
  return `http://${parsed.host}/${alias}`;
}

function fromAnswer(answer: HttpAnswer, accept: (status: number) => boolean, what: string): ProbeCheck {
  if (answer.status === undefined) return { ok: false, ms: answer.ms, detail: `${what}: ${answer.error ?? "no answer"}` };
  const ok = accept(answer.status);
  return { ok, ms: answer.ms, status: answer.status, detail: ok ? `${what}: HTTP ${answer.status}` : `${what}: unexpected HTTP ${answer.status}` };
}

function dbListCheck(answer: HttpAnswer, database: string): DbListCheck {
  if (answer.status === undefined) {
    return { ok: false, ms: answer.ms, detail: `DBList.aspx: ${answer.error ?? "no answer"}`, databases: [] };
  }
  const base = { ms: answer.ms, status: answer.status };
  if (answer.status !== 200) {
    return { ...base, ok: false, detail: `DBList.aspx: unexpected HTTP ${answer.status}`, databases: [] };
  }
  const ids = parseDbList(answer.body ?? "");
  const databases = ids.slice(0, MAX_IDS).map((id) => id.slice(0, MAX_ID_LENGTH));
  if (ids.length === 1 && ids[0] === database) return { ...base, ok: true, detail: "DBList.aspx: lists this slot's database only", databases };
  if (ids.length === 1) return { ...base, ok: false, detail: "DBList.aspx: lists a database that is not this slot's", databases };
  return { ...base, ok: false, detail: `DBList.aspx: lists ${ids.length} databases, expected exactly 1`, databases };
}

/**
 * Probes one slot from WSL. `url` is `http://<host address>/<alias>` (see `slotUrl`) and `database`
 * the slot's database; both must be the pair derived for one slot, or the call is `Refused` before
 * anything is contacted. A cold slot can take 41 s to answer its first request, so the first probe of
 * a URL in this process gets the long timeout and later ones the short one.
 */
export async function probeSlot(url: string, database: string, options: ProbeOptions = {}): Promise<SlotProbe> {
  const base = vet(url, database);
  const warm = options.warm ?? warmUrls.has(base);
  const timeoutMs = warm ? (options.warmTimeoutMs ?? WARM_TIMEOUT_MS) : (options.coldTimeoutMs ?? COLD_TIMEOUT_MS);

  const started = performance.now();
  const [clientAnswer, oauthAnswer, dbAnswer] = await Promise.all([
    anonymousGet(`${base}/Client/`, { timeoutMs }),
    anonymousGet(`${base}/OAuthServer/.well-known/openid-configuration`, { timeoutMs }),
    anonymousGet(`${base}/DBList.aspx`, { timeoutMs, readBody: true }),
  ]);
  const ms = Math.round(performance.now() - started);

  if (clientAnswer.status !== undefined) warmUrls.add(base);
  const client = fromAnswer(clientAnswer, (s) => s >= 200 && s < 400, "Client/");
  const oauth = fromAnswer(oauthAnswer, (s) => s === 200, "OAuthServer discovery");
  const dbList = dbListCheck(dbAnswer, database);
  return { ok: client.ok && oauth.ok && dbList.ok, url: base, database, ms, cold: !warm, client, oauth, dbList };
}
