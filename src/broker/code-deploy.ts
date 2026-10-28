// The broker's `deployCode` verb (ticket 40, docs/code-deploy.md): a code tree the leaseholder staged under
// `staging\<lease_id>\code\<n>` overlaid onto the leased slot's tree. Every effect goes through the `SlotSystem`
// (provision.ts), so the order, the refusals and the failure kinds are tested offline.
//
// In order: the slot's stamp must name the caller's lease; the staged folder is walked without following a link
// (one link, junction or other reparse point refuses the deploy) and its `deploy.json` read; the deploy is planned
// with the rules the CLI used (src/core/code-deploy.ts) and every target checked inside the slot's tree (no
// ancestor a link or junction, no folder in a file's place); only then is the slot quiesced (its agent and pools
// stopped, ticket 30), the targets checked again, the delete list applied and the files copied, ASP.NET's temporary
// files of the alias cleared when the deploy touched `Server\bin` or `Server\dll`, and the slot started and warmed
// (ticket 33). A refusal changes nothing. A failure after the quiesce starts the slot again before it is answered.
// The staged folder is removed in every case, each link in it removed itself, never followed.
//
// The staged folder is the worker's to change while the broker reads it, so each file is copied from a handle the
// host checks is the plain, single-link file the walk found (`copyStaged`), and written through a temporary file
// renamed over the target, so a hard link in the slot's tree is replaced rather than written through.

import { win32 } from "node:path";
import {
  DEFAULT_CODE_SUBPATH,
  DEPLOY_MANIFEST,
  MAX_DEPLOY_MANIFEST_BYTES,
  checkSubpath,
  planDeploy,
  readDeployManifest,
  type DeployPlan,
} from "../core/code-deploy.js";
import { GuardError, assertValidRoot } from "../core/guards.js";
import { slotId, stagingDir, stampFile, type SlotNames, type SlotRef } from "../core/names.js";
import { isLeaseId } from "../core/state.js";
import { HostError, isHostError } from "../host/errors.js";
import type { Broker, VerbContext } from "./broker.js";
import { ProtocolError, parseSlotStamp, type WireResult } from "./protocol.js";
import { SlotLocks, Timings, errorText, seconds, type SlotSystem } from "./provision.js";
import { startSlotOnHost } from "./start-stop.js";

/** The deploy's steps, in order. */
export const DEPLOY_STEPS = ["lease", "staged", "plan", "targets", "quiesce", "delete", "copy", "compiled", "start"] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

/** `deployCode`'s arguments, as the broker checks them. */
export interface DeployCodeArgs {
  /** `<root>\staging\<lease_id>\code\<n>`. */
  readonly staged: string;
  readonly leaseId: string;
  readonly subpath: string;
  readonly allowConfig: boolean;
  readonly allowServers: boolean;
  readonly agent: boolean;
}

const ARG_KEYS = new Set(["staged", "leaseId", "subpath", "allowConfig", "allowServers", "agent"]);
const STAGED_FOLDER = /^\d{1,4}$/;

/** Refuses anything but the six arguments, each of its type. Where the staged folder is is checked against the root later. */
export function parseDeployCodeArgs(args: Readonly<Record<string, unknown>>): DeployCodeArgs {
  for (const key of Object.keys(args)) if (!ARG_KEYS.has(key)) throw new ProtocolError(`deployCode takes no "${key.slice(0, 32)}" argument`);
  const { staged, leaseId, subpath, allowConfig, allowServers, agent } = args;
  if (typeof staged !== "string") throw new ProtocolError("deployCode needs the staged folder");
  if (!isLeaseId(leaseId)) throw new ProtocolError("deployCode needs the lease id");
  const flag = (name: string, v: unknown): boolean => {
    if (v !== undefined && typeof v !== "boolean") throw new ProtocolError(`deployCode's ${name} is true or false`);
    return v === true;
  };
  let sub: string;
  try {
    sub = checkSubpath(subpath ?? DEFAULT_CODE_SUBPATH);
  } catch (err) {
    throw new ProtocolError(`deployCode's subpath is unusable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    staged,
    leaseId,
    subpath: sub,
    allowConfig: flag("allowConfig", allowConfig),
    allowServers: flag("allowServers", allowServers),
    agent: flag("agent", agent),
  };
}

/** The staged folder, canonical: exactly `<root>\staging\<lease_id>\code\<n>`, refused otherwise. */
export function stagedCodeFolder(root: string, leaseId: string, staged: string): string {
  const base = win32.join(stagingDir(leaseId, assertValidRoot(root)), "code");
  const parent = win32.dirname(staged);
  const name = win32.basename(staged);
  if (parent.toLowerCase() !== base.toLowerCase() || !STAGED_FOLDER.test(name) || staged.includes("/")) {
    throw new HostError("Refused", `refused path "${staged.slice(0, 200)}": a staged code tree is ${base}\\<n>`);
  }
  return win32.join(base, name);
}

/** Refuses a path whose folders from `from` down are not all plain folders: no link, junction or reparse point. */
async function assertPlainFolders(system: SlotSystem, from: string, to: string): Promise<void> {
  const rest = to.slice(from.length).split("\\").filter(Boolean);
  let path = from;
  for (const segment of ["", ...rest]) {
    path = segment === "" ? path : win32.join(path, segment);
    const kind = await system.entryKind(path);
    if (kind !== "dir") throw new HostError("Refused", `${path} is ${kind === "missing" ? "missing" : `not a plain folder (${kind})`}`);
  }
}

/**
 * Every target's folders inside the slot's tree are plain folders or missing, never a link, junction or file; a copy's
 * target is a plain file or missing, a delete's too. Each folder is looked at once.
 */
async function checkTargets(system: SlotSystem, slotDir: string, plan: DeployPlan): Promise<void> {
  const seen = new Map<string, string>();
  const kindOf = async (path: string) => {
    const key = path.toLowerCase();
    let kind = seen.get(key);
    if (kind === undefined) {
      kind = await system.entryKind(path);
      seen.set(key, kind);
    }
    return kind;
  };
  const check = async (target: string, what: string) => {
    const parts = target.split("/");
    let path = slotDir;
    for (const part of parts.slice(0, -1)) {
      path = win32.join(path, part);
      const kind = await kindOf(path);
      if (kind === "missing") break;
      if (kind !== "dir") throw new HostError("Refused", `${what} ${target}: ${path} is ${kind === "file" ? "a file" : `a ${kind}, not a plain folder`}`);
    }
    const kind = await kindOf(win32.join(slotDir, ...parts));
    if (kind !== "missing" && kind !== "file") throw new HostError("Refused", `${what} ${target}: it is ${kind === "dir" ? "a folder" : `a ${kind}`}, not a file`);
  };
  if ((await system.entryKind(slotDir)) !== "dir") throw new HostError("Refused", `${slotDir} is not a plain folder`);
  for (const target of plan.deletes) await check(target, "cannot delete");
  for (const { target } of plan.copies) await check(target, "cannot write");
}

/** `deployCode`: the staged tree over the leased slot's tree. Throws a `HostError` naming the step; a `Refused` one changed nothing. */
export async function deployCodeOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string, args: DeployCodeArgs): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const timings = new Timings(system);
  let step: DeployStep = "lease";
  let staged: string | undefined;
  let quiesced = false;
  try {
    staged = stagedCodeFolder(root, args.leaseId, args.staged);
    const stampBytes = await system.readFile(stampFile(slot, root));
    if (stampBytes === null) throw new HostError("Refused", `slot ${id} is not provisioned`);
    let leaseId: string | null | undefined;
    try {
      leaseId = parseSlotStamp(JSON.parse(new TextDecoder().decode(stampBytes).replace(/^﻿/, "")), slot).leaseId;
    } catch {
      throw new HostError("Refused", `the stamp of ${id} is unreadable`);
    }
    if (leaseId !== args.leaseId) throw new HostError("Refused", `slot ${id} is not leased by that lease`);

    step = "staged";
    const listing = await timings.run(step, async () => {
      await assertPlainFolders(system, win32.join(assertValidRoot(root), "staging"), staged as string);
      const found = await system.listStaged(staged as string);
      if (found.refused.length > 0) {
        throw new HostError("Refused", `the staged tree has ${found.refused.length} links, junctions or other non-files (${found.refused.slice(0, 3).join(", ")})`);
      }
      return found;
    });

    step = "plan";
    const plan = await timings.run(step, async () => {
      const paths = listing.files.map((f) => f.path);
      const manifest = paths.some((p) => p.toLowerCase() === DEPLOY_MANIFEST)
        ? readDeployManifest(await system.readStaged(win32.join(staged as string, DEPLOY_MANIFEST), MAX_DEPLOY_MANIFEST_BYTES))
        : undefined;
      return planDeploy(paths, { subpath: args.subpath, allowConfig: args.allowConfig, allowServers: args.allowServers }, manifest);
    });
    if (plan.copies.length === 0 && plan.deletes.length === 0) throw new HostError("Refused", "the staged tree deploys nothing");

    step = "targets";
    await timings.run(step, () => checkTargets(system, names.slotDir, plan));

    step = "quiesce";
    const provisioned = await timings.run(step, () => system.quiesce(slot));
    if (!provisioned) throw new HostError("Refused", `slot ${id} is not provisioned`);
    quiesced = true;
    // Nothing of the slot runs now; what its server could change before, it cannot change after.
    await checkTargets(system, names.slotDir, plan);

    step = "delete";
    let deleted = 0;
    await timings.run(step, async () => {
      for (const target of plan.deletes) if (await system.removeTreeFile(win32.join(names.slotDir, ...target.split("/")))) deleted++;
    });

    step = "copy";
    let bytes = 0;
    await timings.run(step, async () => {
      for (const { source, target } of plan.copies) {
        bytes += (await system.copyStaged(win32.join(staged as string, ...source.split("/")), win32.join(names.slotDir, ...target.split("/")))).bytes;
      }
    });

    step = "compiled";
    const cleared = plan.touchesCompiled ? await timings.run(step, () => system.clearCompiled(slot)) : 0;

    step = "start";
    quiesced = false;
    const start = await timings.run(step, () => startSlotOnHost(system, slot, names, root, { agent: args.agent }));
    const what = `${plan.copies.length} files (${bytes} bytes)${plan.deletes.length > 0 ? `, ${deleted} of ${plan.deletes.length} deletes` : ""} into ${id}\\${args.subpath.replace(/\//g, "\\")}`;
    const compiled = plan.touchesCompiled ? `; ${cleared} ASP.NET temporary folders of the alias cleared` : "";
    return {
      ok: start.ok,
      detail: `deployed ${what} in ${seconds(system.now() - started)} s${compiled}; ${start.ok ? "the slot is up" : "the slot did not come back up"}: ${start.detail} (${timings})`,
      files: plan.copies.length,
      deleted,
      compiledCleared: plan.touchesCompiled,
    };
  } catch (err) {
    let restarted = "";
    if (quiesced) {
      try {
        const start = await startSlotOnHost(system, slot, names, root, { agent: args.agent });
        restarted = start.ok ? "; the slot was started again" : `; the slot was started again but is not warm: ${start.detail}`;
      } catch (startErr) {
        restarted = `; the slot could not be started again: ${errorText(startErr)}`;
      }
    }
    const kind = err instanceof GuardError || err instanceof ProtocolError ? "Refused" : isHostError(err) ? err.kind : "Retryable";
    throw new HostError(kind, `deploy into ${id} failed at ${step}: ${errorText(err)}${restarted}`, { cause: err });
  } finally {
    if (staged !== undefined) await system.removeStaged(staged).catch(() => undefined);
  }
}

/** Registers `deployCode` on `broker`, under the same per-slot `locks` as the other slot verbs. */
export function registerDeployVerb(broker: Broker, system: SlotSystem, locks: SlotLocks): Broker {
  return broker.register("deployCode", {
    target: "slot",
    args: parseDeployCodeArgs,
    run: (ctx: VerbContext) => locks.run(ctx, (slot, names) => deployCodeOnHost(system, slot, names, ctx.root, ctx.args as DeployCodeArgs)),
  });
}
