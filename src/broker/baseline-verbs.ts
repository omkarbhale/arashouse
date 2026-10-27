// The baseline verb the broker serves: `baselineVerify` (tickets 28 and 24). It checks a flavor's
// golden folder against its own manifest (`verifyGolden`, manifest-fs.ts) at the level asked:
// `golden` (the default, before a provision or a baseline-based reset), `fast`, or `full` (every
// file's SHA-256, `arashouse baseline verify <flavor> --full`, `doctor --deep`). The broker only reads
// golden; building it is the elevated `baseline build` (docs/baselines.md), not a verb.

import { goldenLayout } from "../core/names.js";
import { ManifestError, VERIFY_LEVELS, summarizeDiff, type VerifyLevel } from "../core/manifest.js";
import type { FlavorKey } from "../core/flavors.js";
import type { Broker, VerbContext } from "./broker.js";
import { readManifest, verifyGolden } from "./manifest-fs.js";
import { ProtocolError, type WireResult } from "./protocol.js";
import type { BrokerSystem } from "./verbs.js";

function levelArgs(args: Readonly<Record<string, unknown>>): VerifyLevel {
  for (const key of Object.keys(args)) if (key !== "level") throw new ProtocolError(`baselineVerify takes no "${key.slice(0, 32)}" argument`);
  const level = args.level ?? "golden";
  if (typeof level !== "string" || !(VERIFY_LEVELS as readonly string[]).includes(level)) {
    throw new ProtocolError(`the verify level is one of ${VERIFY_LEVELS.join(", ")}`);
  }
  return level as VerifyLevel;
}

/** Registers `baselineVerify` on `broker`. */
export function registerBaselineVerbs(broker: Broker, system: BrokerSystem): Broker {
  return broker.register("baselineVerify", {
    target: "flavor",
    args: levelArgs,
    run: async (ctx: VerbContext): Promise<WireResult> => {
      const flavor = ctx.flavor as FlavorKey;
      const level = ctx.args as VerifyLevel;
      const golden = goldenLayout(flavor, ctx.root);
      try {
        const diff = await verifyGolden(system.fs.localPath(golden.dir), flavor, { level });
        // The manifest hash names the golden a reset mirrors from (ticket 30); verifyGolden has just read the manifest.
        const goldenHash = (await readManifest(system.fs.localPath(golden.manifest))).manifestHash;
        return { ok: diff.ok, level, detail: `the ${flavor} baseline ${diff.ok ? "verifies" : "does not verify"} (${level}): ${summarizeDiff(diff)}`, diff, goldenHash };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, level, detail: `the ${flavor} baseline is not built` };
        if (!(err instanceof ManifestError)) throw err;
        return { ok: false, level, detail: `the ${flavor} golden manifest is unusable: ${err.message}` };
      }
    },
  });
}
