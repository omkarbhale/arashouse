// The broker's reset verbs for the code tree (ticket 30, docs/reset.md): `quiesce`, `resetTree` and
// `writeStamp`. The reset policy (src/core/reset.ts) calls the first two in its `quiesce` and `tree`
// steps (the database step between them is ticket 31's); `get` writes a lease into the stamp with the
// third. Every effect goes through the `SlotSystem` (provision.ts), so the order and the failure kinds
// are tested offline.
//
// `resetTree` runs on a quiesced slot only: the mirror from golden (`robocopy /MIR /XJ`, which removes
// the old stamp with everything else golden does not have), the runtime state the mirror leaves (the
// whole runtime folders emptied, the vault folder, ASP.NET's temporary files of the alias), the config
// files rendered again from golden with the edit list, the `fast` verify of the tree against the golden
// manifest with each rendered file compared with its rendering, and only then the new stamp. A reset
// that fails before the stamp leaves the slot without one, so nothing can take it for clean.

import { win32 } from "node:path";
import { goldenJson } from "../core/baseline.js";
import { ManifestError, parseManifest, summarizeDiff, type Manifest, type ManifestDiff } from "../core/manifest.js";
import { buildScratch, goldenLayout, slotId, stampFile, type SlotNames, type SlotRef } from "../core/names.js";
import { HostError, isHostError } from "../host/errors.js";
import type { Broker, VerbContext } from "./broker.js";
import { ProtocolError, parseSlotStamp, type WireResult } from "./protocol.js";
import { SlotLocks, Timings, errorText, provisionStamp, renderConfigs, seconds, storedLogins, type SlotSystem } from "./provision.js";

/** The tree reset's steps, in order. */
export const RESET_TREE_STEPS = ["golden", "mirror", "configs", "verify", "stamp"] as const;
export type ResetTreeStep = (typeof RESET_TREE_STEPS)[number];

/** How many paths of each class a failed verify names in its error. */
const DIFF_PATHS = 5;

function diffText(diff: ManifestDiff): string {
  const paths = [
    ...diff.missing.slice(0, DIFF_PATHS).map((p) => `missing ${p}`),
    ...diff.changed.slice(0, DIFF_PATHS).map((c) => `changed ${c.path} (${c.reasons.join(", ")})`),
    ...diff.extra.slice(0, DIFF_PATHS).map((p) => `extra ${p}`),
  ];
  return `${summarizeDiff(diff)}${paths.length > 0 ? `: ${paths.join("; ")}` : ""}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The flavor's golden manifest, which must carry `hash` (the golden the reset began with). */
async function goldenManifest(system: SlotSystem, slot: SlotRef, root: string, hash: string): Promise<Manifest> {
  if ((await system.readFile(buildScratch(slot.flavor, root).promotingMarker)) !== null) {
    throw new HostError("Retryable", `a new ${slot.flavor} golden is being moved into place`);
  }
  const file = goldenLayout(slot.flavor, root).manifest;
  const bytes = await system.readFile(file);
  if (bytes === null) throw new HostError("Retryable", `${file} does not exist (is the ${slot.flavor} baseline built?)`);
  let manifest: Manifest;
  try {
    manifest = parseManifest(new TextDecoder().decode(bytes));
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    throw new HostError("Retryable", `the ${slot.flavor} golden manifest is unusable: ${err.message}`);
  }
  if (manifest.flavor !== slot.flavor) throw new HostError("Refused", `${file} is the manifest of flavor ${manifest.flavor}`);
  if (manifest.manifestHash !== hash) {
    throw new HostError("Retryable", `the ${slot.flavor} golden is ${manifest.manifestHash.slice(0, 12)}, not the ${hash.slice(0, 12)} the reset began with`);
  }
  return manifest;
}

/** `quiesce`: stops the slot's pools and agent and waits for its processes to end; `Retryable` when something still runs. */
export async function quiesceOnHost(system: SlotSystem, slot: SlotRef): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  let provisioned: boolean;
  try {
    provisioned = await system.quiesce(slot);
  } catch (err) {
    throw new HostError(isHostError(err) ? err.kind : "Retryable", `quiesce of ${id} failed: ${errorText(err)}`, { cause: err });
  }
  if (!provisioned) throw new HostError("Refused", `slot ${id} is not provisioned`);
  return { ok: true, detail: `quiesced ${id} in ${seconds(system.now() - started)} s` };
}

/** `resetTree`: the slot's tree back to the golden `hash`, then a fresh stamp. Throws a `HostError` naming the step. */
export async function resetTreeOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string, hash: string): Promise<WireResult> {
  const id = slotId(slot);
  const started = system.now();
  const timings = new Timings(system);
  let step: ResetTreeStep = "golden";
  try {
    if (!(await system.isDirectory(names.slotDir))) throw new HostError("Refused", `slot ${id} is not provisioned`);
    const manifest = await timings.run(step, () => goldenManifest(system, slot, root, hash));
    // Checked before the mirror: a reset cannot go ahead without them, and it never makes new ones (the SQL logins keep theirs).
    const logins = await storedLogins(system.secrets, slot);
    if (logins === undefined) {
      throw new HostError("Quarantine", `the stored SQL login passwords of ${id} are missing; \`arashouse repair ${id} --rebuild\` makes the slot again`);
    }

    step = "mirror";
    const tree = await timings.run(step, () => system.resetTree(slot));
    if (tree.state === "not-provisioned") throw new HostError("Refused", `slot ${id} is not provisioned`);
    if (tree.state === "serving") throw new HostError("Refused", `slot ${id} is not quiesced: ${tree.serving.join(", ")} still running`);

    step = "configs";
    const configs = await timings.run(step, () => renderConfigs(system, slot, root, logins));

    step = "verify";
    const diff = await timings.run(step, async () => {
      const result = await system.verifyTree(slot, manifest, configs.files.map((f) => f.file));
      if (!result.ok) return result;
      // The rendered files, read back: each must be its rendering of golden, byte for byte.
      for (const { file, bytes } of configs.files) {
        const read = await system.readFile(win32.join(names.slotDir, ...file.split("/")));
        if (read === null || !sameBytes(read, bytes)) throw new HostError("Quarantine", `the rendered ${file} did not read back as written`);
      }
      return result;
    });
    if (!diff.ok) throw new HostError("Quarantine", `the tree does not match golden after the mirror: ${diffText(diff)}`);

    step = "stamp";
    await timings.run(step, () => system.writeFile(stampFile(slot, root), goldenJson(provisionStamp(slot, manifest.manifestHash, system.now()))));

    const cleared = `${tree.runtimeEntries} runtime, ${tree.vaultEntries} vault and ${tree.aspnetFolders} ASP.NET temporary entries cleared`;
    return {
      ok: true,
      detail:
        `reset the tree of ${id} to golden ${manifest.manifestHash.slice(0, 12)} in ${seconds(system.now() - started)} s ` +
        `(robocopy ${seconds(tree.mirrorMs)}, clearing ${seconds(tree.clearMs)}: ${cleared}; configs: ${configs.detail}; ` +
        `${diff.checked} files verified; ${timings})`,
    };
  } catch (err) {
    const kind = isHostError(err) ? err.kind : "Retryable";
    throw new HostError(kind, `tree reset of ${id} failed at ${step}: ${errorText(err)}`, { cause: err });
  }
}

/** `writeStamp`: the stamp the caller sends (a lease's, from `get`), for a provisioned slot and that slot only. */
export async function writeStampOnHost(system: SlotSystem, slot: SlotRef, names: SlotNames, root: string, value: unknown): Promise<WireResult> {
  const id = slotId(slot);
  const stamp = parseSlotStamp(value, slot);
  if (!(await system.isDirectory(names.slotDir))) throw new HostError("Refused", `slot ${id} is not provisioned`);
  await system.writeFile(stampFile(slot, root), goldenJson(stamp));
  return { ok: true, detail: `wrote the stamp of ${id}` };
}

function hashArgs(args: Readonly<Record<string, unknown>>): string {
  for (const key of Object.keys(args)) if (key !== "hash") throw new ProtocolError(`resetTree takes no "${key.slice(0, 32)}" argument`);
  if (typeof args.hash !== "string" || !/^[0-9a-f]{64}$/.test(args.hash)) throw new ProtocolError("resetTree needs the golden manifest hash");
  return args.hash;
}

function stampArgs(args: Readonly<Record<string, unknown>>): unknown {
  for (const key of Object.keys(args)) if (key !== "stamp") throw new ProtocolError(`writeStamp takes no "${key.slice(0, 32)}" argument`);
  if (args.stamp === undefined) throw new ProtocolError("writeStamp needs a stamp");
  return args.stamp;
}

/** Registers `quiesce`, `resetTree` and `writeStamp` on `broker`, under the same per-slot `locks` as provision and destroy. */
export function registerResetVerbs(broker: Broker, system: SlotSystem, locks: SlotLocks): Broker {
  return broker
    .register("quiesce", {
      target: "slot",
      run: (ctx: VerbContext) => locks.run(ctx, (slot) => quiesceOnHost(system, slot)),
    })
    .register("resetTree", {
      target: "slot",
      args: hashArgs,
      run: (ctx: VerbContext) => locks.run(ctx, (slot, names) => resetTreeOnHost(system, slot, names, ctx.root, ctx.args as string)),
    })
    .register("writeStamp", {
      target: "slot",
      args: stampArgs,
      run: (ctx: VerbContext) => locks.run(ctx, (slot, names) => writeStampOnHost(system, slot, names, ctx.root, ctx.args)),
    });
}
