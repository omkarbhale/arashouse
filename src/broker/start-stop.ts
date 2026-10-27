// The broker's `startSlot` and `stopSlot` verbs (ticket 33, docs/start-stop.md). A slot's pools idle
// out on their own, so an idle slot costs near nothing; `stopSlot` takes it fully offline (its agent,
// then its pools, waiting for the worker processes to end), which is the reset's quiesce (ticket 30)
// and the operator's `disable`. `startSlot` starts the pools again, starts the agent service only when
// the caller asks for it (`get --agent`), and warms the applications with one anonymous request each,
// and the agent, when it started, with its health request (ticket 33b).
//
// Both act only on names derived from the slot record: the request carries no service, pool or path,
// and slot-steps.ps1 checks the service name again (`ArasHouseAgent_*`, never `ArasInnovatorAgent_*`)
// before it starts or stops one.

import { agentHealthUrl, agentUrl, slotId, stampFile, webAlias, type SlotRef, type SlotNames } from "../core/names.js";
import { HostError } from "../host/errors.js";
import { ProtocolError, type WireResult } from "./protocol.js";
import { Timings, errorText, seconds, type SlotSystem, type WarmAnswer } from "./provision.js";

/** `startSlot`'s arguments: whether to start the agent service as well. */
export interface StartArgs {
  readonly agent: boolean;
}

/** Refuses any argument but a boolean `agent`: a request cannot name a service, a pool or a path. */
export function parseStartArgs(args: Readonly<Record<string, unknown>>): StartArgs {
  for (const key of Object.keys(args)) {
    if (key !== "agent") throw new ProtocolError(`startSlot takes only "agent", not "${key.slice(0, 32)}"`);
  }
  if (args.agent !== undefined && typeof args.agent !== "boolean") throw new ProtocolError("startSlot's agent is true or false");
  return { agent: args.agent === true };
}

/** The slot URLs a start warms, relative to `http://localhost/<alias>/`: the client, the server and the OAuth server. */
export const WARM_PATHS: readonly string[] = ["Client/", "Server/DBList.aspx", "OAuthServer/.well-known/openid-configuration"];

/** A first request after a pool start: 2 to 15 s on `12sp9`, 37 s on a brand-new `23` slot (spike record, section 3). */
export const WARM_TIMEOUT_MS = 120_000;

/** A warm-up answers 200 to 399; the agent's health request anything below 500 (12.0's WSDL may ask for credentials). */
const isWarm = (a: WarmAnswer) => a.status !== undefined && a.status >= 200 && a.status < 400;
const agentAnswers = (a: WarmAnswer) => a.status !== undefined && a.status < 500;

function warmText(path: string, answer: WarmAnswer): string {
  const what = answer.status === undefined ? (answer.error ?? "no answer") : String(answer.status);
  return `${path} ${what} ${seconds(answer.ms)} s`;
}

async function assertProvisioned(system: SlotSystem, slot: SlotRef, root: string): Promise<void> {
  if ((await system.readFile(stampFile(slot, root))) === null) throw new HostError("Refused", `slot ${slotId(slot)} is not provisioned`);
}

/**
 * `startSlot`: the slot's pools started, its agent started when `args.agent` (refused when the slot has no agent
 * service), then each warm-up URL requested once, and the agent's health URL when it started. A warm-up that does
 * not answer 200 to 399, or an agent that does not answer below 500, makes the result `ok: false`, which the reset
 * and the lease treat as a failed start.
 */
export async function startSlotOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string, args: StartArgs): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const timings = new Timings(system);
  await assertProvisioned(system, slot, root);
  const info = await timings.run("start", () => system.start(slot, { agent: args.agent }));
  if (args.agent && info.agent === "none") {
    throw new HostError("Refused", `slot ${id} has no agent service: the ${slot.flavor} golden was built without one (rebuild it: baseline build ${slot.flavor} --replace)`);
  }
  if (args.agent && info.agent !== "running") throw new HostError("Retryable", `the agent ${names.service} of ${id} did not start`);
  const base = `http://localhost/${webAlias(slot)}/`;
  const checks = WARM_PATHS.map((path) => ({ name: path, url: base + path, ok: isWarm }));
  if (info.agent === "running") checks.push({ name: "agent", url: agentHealthUrl(slot.flavor, agentUrl(slot)), ok: agentAnswers });
  const answers = await timings.run("warm", () => Promise.all(checks.map(async (c) => [c.name, await system.warm(c.url, WARM_TIMEOUT_MS), c.ok] as const)));
  const cold = answers.filter(([, a, ok]) => !ok(a));
  const agent = info.agent === "running" ? `agent ${names.service} running on port ${info.port}` : "agent not started";
  const warm = answers.map(([path, a]) => warmText(path, a)).join(", ");
  const detail = `${cold.length === 0 ? "started" : "started but not warm:"} ${id} in ${seconds(system.now() - started)} s (${info.pools} pools; ${agent}; warm ${warm}; ${timings})`;
  return { ok: cold.length === 0, detail };
}

/** `stopSlot`: the slot's agent stopped, then its pools, and its worker processes gone. Idempotent. */
export async function stopSlotOnHost(system: SlotSystem, slot: SlotRef, root: string): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  await assertProvisioned(system, slot, root);
  let info;
  try {
    info = await system.stop(slot);
  } catch (err) {
    throw new HostError("Retryable", `stop of ${id} failed: ${errorText(err)}`, { cause: err });
  }
  const agent = info.agent === "stopped" ? "agent stopped" : "no agent";
  return { ok: true, detail: `stopped ${id} in ${seconds(system.now() - started)} s (${info.pools} pools; ${agent})` };
}
