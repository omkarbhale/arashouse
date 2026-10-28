// What `doctor` says about host-wide settings (ticket 55). arashouse runs on the host as it is: it
// never requires, applies or offers to apply a host-wide setting. Where one would help the pool, doctor
// reports it as advice (the value seen, the value recommended, and why), never as a failure; the
// operator chooses. Pure: the caller reads the values (the broker's `hostInfo`, the WSL VM's memory).
// docs/host-tuning.md lists every setting and why the others get no advice line.

import type { ArashouseConfig } from "./config.js";

/** SQL Server's default `max server memory (MB)`: no cap. */
export const SQL_UNCAPPED_MB = 2_147_483_647;

/** The `max server memory` advised: about twice SQL Server's working set measured on the laptop (1.9 GB, ticket 44). */
export const SQL_ADVISED_MAX_MB = 4096;

/** No WSL cap is advised below this: a smaller VM would starve the WSL sessions themselves. */
export const WSL_MIN_ADVISED_MB = 4096;

export interface HostAdvice {
  /** The setting, for example `sql max server memory`. */
  readonly setting: string;
  readonly seen: string;
  readonly recommended: string;
  readonly why: string;
}

export interface HostAdviceInput {
  /** The instance's `max server memory (MB)` in use; undefined when it was not read. */
  readonly sqlMaxServerMemoryMb?: number;
  /** Free RAM on the Windows side (`hostInfo`); undefined when it was not read. */
  readonly freeRamMb?: number;
  /** The WSL VM's memory (MemTotal inside WSL, which is its cap); undefined when doctor does not run in WSL. */
  readonly wslMemoryMb?: number;
  /** How many slots are leased now. */
  readonly leased: number;
  readonly config: Pick<ArashouseConfig, "max_active" | "min_free_ram_mb">;
}

/** The advice for the host as `input` describes it; empty when no setting would help. */
export function hostAdvice(input: HostAdviceInput): HostAdvice[] {
  const advice: HostAdvice[] = [];
  const { config } = input;

  if (input.sqlMaxServerMemoryMb !== undefined && input.sqlMaxServerMemoryMb >= SQL_UNCAPPED_MB) {
    advice.push({
      setting: "sql max server memory",
      seen: `${input.sqlMaxServerMemoryMb} MB (SQL Server's default: uncapped)`,
      recommended: `${SQL_ADVISED_MAX_MB} MB`,
      why: "uncapped, SQL Server's buffer pool grows into the RAM active slots need; the setting covers the whole instance, the operator's own databases too",
    });
  }

  // Each `get` wants min_free_ram_mb free (docs/governor.md), and each lease takes about that much, so the leases still to come
  // need that much each. A smaller WSL VM gives the shortfall back to Windows.
  if (input.freeRamMb !== undefined && input.wslMemoryMb !== undefined) {
    const toCome = Math.max(0, config.max_active - input.leased);
    const needed = toCome * config.min_free_ram_mb;
    const short = needed - input.freeRamMb;
    const capGb = Math.floor((input.wslMemoryMb - short) / 1024);
    if (short > 0 && capGb * 1024 >= WSL_MIN_ADVISED_MB) {
      advice.push({
        setting: "wsl memory",
        seen: `a ${(input.wslMemoryMb / 1024).toFixed(1)} GB WSL VM, with ${input.freeRamMb} MB free on Windows`,
        recommended: `at most ${capGb} GB (\`memory=${capGb}GB\` under [wsl2] in %UserProfile%\\.wslconfig; it takes effect at \`wsl --shutdown\`, which ends every WSL session)`,
        why: `${toCome} more lease${toCome === 1 ? "" : "s"} up to max_active ${config.max_active} need about ${needed} MB free (min_free_ram_mb ${config.min_free_ram_mb} each); ${short} MB are missing`,
      });
    }
  }
  return advice;
}

/** An advice line's message: the value seen, the value recommended, and why. */
export function adviceMessage(a: HostAdvice): string {
  return `seen ${a.seen}; recommended ${a.recommended}; why: ${a.why}`;
}
