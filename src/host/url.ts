// The slot URL as seen from WSL. Aras runs on the Windows host; WSL reaches it at the default
// gateway (`http://172.19.0.1/12sp9` today) or, in mirrored networking mode, at `localhost`. The
// address changes when WSL restarts, so it is found once per process and never stored in the state
// file. Pure HTTP from WSL: no broker.

import { execFile } from "node:child_process";
import { assertOwned } from "../core/guards.js";
import { HostError } from "./errors.js";
import { COLD_TIMEOUT_MS, anonymousGet } from "./http.js";
import { guarded } from "./owned.js";

/** Environment variable that fixes the host address (host or IPv4, optional `:port`); it is not probed. */
export const HOST_ADDR_ENV = "ARASHOUSE_HOST_ADDR";

/** Tried after the gateway: works when WSL runs in mirrored networking mode. */
export const LOOPBACK_ADDRESS = "localhost";

const HOST_ADDRESS = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for a bare host name or IPv4 address with an optional port: no scheme, path or credentials. */
export function isHostAddress(text: string): boolean {
  return HOST_ADDRESS.test(text);
}

/** The gateway in `ip route` output (`default via 172.19.0.1 dev eth0 ...`), or undefined. */
export function parseDefaultGateway(routeOutput: string): string | undefined {
  const match = /^default\s+via\s+(\S+)/m.exec(routeOutput);
  const gateway = match?.[1];
  return gateway !== undefined && IPV4.test(gateway) ? gateway : undefined;
}

/** `http://<address>/<alias>`: what a lease hands to a worker. The alias must be one the tool owns. */
export function slotUrl(address: string, alias: string): string {
  if (!isHostAddress(address)) throw new HostError("Refused", `"${address}" is not a host address`);
  guarded(() => assertOwned("alias", alias));
  return `http://${address}/${alias}`;
}

function readDefaultGateway(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("ip", ["route", "show", "default"], { timeout: 5_000, encoding: "utf8" }, (err, stdout) => {
      resolve(err ? undefined : parseDefaultGateway(stdout));
    });
  });
}

export interface HostAddressOptions {
  /** Environment to read `ARASHOUSE_HOST_ADDR` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The WSL default gateway; defaults to reading `ip route`. */
  gateway?: () => Promise<string | undefined> | string | undefined;
  /** The mirrored-mode candidate; defaults to `localhost`. */
  loopback?: string;
  /** How long each candidate may take to answer; defaults to the cold-start timeout. */
  timeoutMs?: number;
}

let cached: string | undefined;

/** Forgets the discovered address (tests; or after the caller knows WSL restarted). */
export function resetHostAddressCache(): void {
  cached = undefined;
}

/**
 * The address WSL uses for the Windows host. `ARASHOUSE_HOST_ADDR` wins and is not probed. Otherwise
 * the default gateway is tried first, then `localhost`, each with an anonymous `GET /<alias>/Client/`;
 * the first that answers (any status but 404, so a slot that is broken still shows where it is) is
 * kept for the rest of the process. `alias` is the web alias of any slot the tool owns.
 */
export async function hostAddress(alias: string, options: HostAddressOptions = {}): Promise<string> {
  guarded(() => assertOwned("alias", alias));
  const override = (options.env ?? process.env)[HOST_ADDR_ENV]?.trim();
  if (override) {
    if (!isHostAddress(override)) {
      throw new HostError("Refused", `${HOST_ADDR_ENV} must be a host name or IPv4 address, optionally with :port`);
    }
    return override;
  }
  if (cached !== undefined) return cached;

  const gateway = await (options.gateway ?? readDefaultGateway)();
  const candidates = [gateway, options.loopback ?? LOOPBACK_ADDRESS].filter(
    (c, i, all): c is string => c !== undefined && isHostAddress(c) && all.indexOf(c) === i,
  );
  for (const address of candidates) {
    const answer = await anonymousGet(`${slotUrl(address, alias)}/Client/`, {
      timeoutMs: options.timeoutMs ?? COLD_TIMEOUT_MS,
    });
    if (answer.status !== undefined && answer.status !== 404) {
      cached = address;
      return address;
    }
  }
  throw new HostError(
    "Unreachable",
    `no host address answered GET /${alias}/Client/ (tried ${candidates.join(", ")}); set ${HOST_ADDR_ENV} if the host is elsewhere`,
  );
}
