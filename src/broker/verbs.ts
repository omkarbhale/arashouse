// The verbs ticket 20 registers: `ping`, `hostInfo`, `readStamp` and `listSlots`. Each reads only
// what its target's derived names point at; none writes. The other host-driver methods arrive as
// verbs in tickets 25, 30, 31, 33, 39, 40 and 43.

import { win32 } from "node:path";
import { FLAVOR_KEYS, type FlavorKey } from "../core/flavors.js";
import type { LicenceStatus } from "../core/licence.js";
import { MAX_SLOT, STAMP_FILE_NAME, slotId, type SlotRef } from "../core/names.js";
import type { BrokerToken, HostInfo, ListedSlot, SlotStamp, SqlLoginInfo } from "../host/driver.js";
import { HostError, isHostError } from "../host/errors.js";
import { assertSlotOwned } from "../host/owned.js";
import type { Broker, VerbContext } from "./broker.js";
import type { BrokerFs } from "./fs.js";
import { ProtocolError, parseSlotStamp, type WireResult } from "./protocol.js";

/** A stamp is a few hundred bytes; anything far larger is not one. */
const MAX_STAMP_BYTES = 64 * 1024;

const SLOT_FOLDER = /^\d{2}$/;

/** What the broker reads about the machine it runs on. */
export interface BrokerSystem {
  readonly fs: BrokerFs;
  readonly brokerVersion: string;
  /** For example `Windows_NT 10.0.26100`. */
  os(): string;
  freeRamBytes(): number;
  /** The broker's SQL login as it reads itself, or null when it cannot connect (sql-probe.ts on the host). */
  sqlLogin(): Promise<SqlLoginInfo | null>;
  /** Whether each licence line has a stored licence (booleans only); absent, `hostInfo` reports none. */
  licences?(): Promise<readonly LicenceStatus[]>;
  /** The broker's own token (an administrator's or not, and whose); null when it cannot be read; absent, `brokerToken` answers null. */
  token?(): Promise<BrokerToken | null>;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

async function readStampFile(system: BrokerSystem, slot: SlotRef, slotDir: string): Promise<SlotStamp | null> {
  if (!(await system.fs.isDirectory(slotDir))) throw new HostError("Refused", `slot ${slotId(slot)} is not provisioned`);
  const text = await system.fs.readText(win32.join(slotDir, STAMP_FILE_NAME), MAX_STAMP_BYTES);
  if (text === null) return null;
  try {
    return parseSlotStamp(JSON.parse(text), slot);
  } catch (err) {
    const why = err instanceof ProtocolError ? err.message : "it is not JSON";
    throw new HostError("Quarantine", `the stamp of ${slotId(slot)} is unusable: ${why}`);
  }
}

function hostInfoDetail(info: HostInfo): string {
  return `${info.os}, ${info.freeRamMb} MB RAM free, ${info.freeDiskGb} GB free at the root, SQL ${info.sqlReachable ? "reachable" : "unreachable"}`;
}

/** Registers `ping`, `hostInfo`, `readStamp` and `listSlots` on `broker`. */
export function registerCoreVerbs(broker: Broker, system: BrokerSystem): Broker {
  return broker
    .register("ping", {
      target: "none",
      run: async () => ({ ok: true, detail: `arashouse-broker ${system.brokerVersion}` }),
    })
    .register("hostInfo", {
      target: "none",
      run: async (ctx: VerbContext): Promise<WireResult> => {
        const [freeBytes, sqlLogin, licences] = await Promise.all([system.fs.freeBytes(ctx.root), system.sqlLogin(), system.licences?.()]);
        const info: HostInfo = {
          os: system.os(),
          freeRamMb: Math.floor(system.freeRamBytes() / MB),
          freeDiskGb: Math.floor((freeBytes / GB) * 10) / 10,
          brokerVersion: system.brokerVersion,
          sqlReachable: sqlLogin !== null,
          sqlLogin,
          ...(licences ? { licences: licences.map((l) => ({ line: l.line, present: l.present })) } : {}),
        };
        return { ok: true, detail: hostInfoDetail(info), info };
      },
    })
    .register("brokerToken", {
      target: "none",
      run: async (): Promise<WireResult> => {
        const token = (await system.token?.()) ?? null;
        return { ok: true, detail: token ? token.identity : "the token could not be read", token };
      },
    })
    .register("readStamp", {
      target: "slot",
      run: async (ctx: VerbContext): Promise<WireResult> => {
        const slot = ctx.slot as SlotRef;
        const stamp = await readStampFile(system, slot, ctx.names!.slotDir);
        return { ok: true, detail: stamp ? `stamp of ${slotId(slot)}` : `no stamp for ${slotId(slot)}`, stamp };
      },
    })
    .register("listSlots", {
      target: "none",
      run: async (ctx: VerbContext): Promise<WireResult> => {
        const slotsDir = win32.join(ctx.root, "slots");
        const slots: ListedSlot[] = [];
        let skipped = 0;
        let unreadable = 0;
        const flavors = (await system.fs.listDirs(slotsDir)) ?? [];
        for (const flavor of FLAVOR_KEYS) {
          // Folder names are matched exactly; a folder that is not a registered key is not the tool's.
          if (!flavors.includes(flavor)) continue;
          for (const nn of ((await system.fs.listDirs(win32.join(slotsDir, flavor))) ?? []).sort()) {
            const number = Number(nn);
            if (!SLOT_FOLDER.test(nn) || number < 1 || number > MAX_SLOT) {
              skipped++;
              continue;
            }
            const slot: SlotRef = { flavor: flavor as FlavorKey, slot: number };
            let names;
            try {
              names = assertSlotOwned(slot, { root: ctx.root, isReparsePoint: system.fs.isReparsePoint, realPath: system.fs.realPath });
            } catch (err) {
              if (!isHostError(err, "Refused")) throw err;
              skipped++;
              continue;
            }
            let stamp: SlotStamp | null = null;
            try {
              stamp = await readStampFile(system, slot, names.slotDir);
            } catch (err) {
              if (!isHostError(err, "Quarantine")) throw err;
              unreadable++;
            }
            slots.push({ slot, stamp });
          }
        }
        const notes = [skipped > 0 ? `${skipped} folders skipped` : "", unreadable > 0 ? `${unreadable} stamps unusable` : ""].filter(Boolean);
        return { ok: true, detail: `${slots.length} slots${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`, slots };
      },
    });
}
