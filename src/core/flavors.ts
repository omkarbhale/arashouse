// The flavor registry: one data entry per Aras flavor. No other module hard-codes a flavor fact.

export const FLAVOR_KEYS = ["12sp9", "23", "35"] as const;

/** The captain's name for a flavor. */
export type FlavorKey = (typeof FLAVOR_KEYS)[number];

/** When a step needs the flavor's licence key. */
export type LicenceRequirement = "to-install" | "to-login" | "never";

export interface Licence {
  /** The licence line: flavors on one line share one stored key ("12", "14", ...). */
  readonly line: string;
  readonly required: LicenceRequirement;
}

/**
 * A part of the code tree that holds runtime state, not baseline content. The golden manifest leaves
 * it out, `baseline verify` ignores it, and the reset clears it (ticket 30). Paths are relative to the
 * tree root, use `/`, and match case-insensitively.
 */
export interface RuntimeRule {
  /** The directory. */
  readonly dir: string;
  /**
   * Absent: everything under `dir` is runtime state. Present: only files directly in `dir` whose
   * name matches one of these globs (`*` and `?`) are.
   */
  readonly files?: readonly string[];
}

/**
 * The runtime directories every Aras flavor shares (design 5.2 and 6.2). The server sits under
 * `Innovator\Server\` in an installed tree (spike record, code follow-ups), and the client rewrites
 * `jsBundles\data.json` when it first serves (spike 06).
 */
export const RUNTIME_DIRS: readonly RuntimeRule[] = [
  { dir: "Innovator/Server/temp" },
  { dir: "Innovator/Server/dll" },
  { dir: "Innovator/Server/logs" },
  { dir: "Innovator/Client/jsBundles", files: ["data.json"] },
  { dir: "OAuthServer/App_Data", files: ["*.sqlite*", "key-*.xml"] },
];

/**
 * A Windows prerequisite a flavor's slots need on the host. `arashouse setup` checks the ones of the
 * flavors in `media/` and lists what is missing; it never installs one (ticket 21).
 */
export type HostPrerequisite =
  /** IIS with the role services the Aras installer and its applications use. */
  | "iis"
  /** .NET Framework 4.7.2 or newer: every MSI's launch condition. */
  | "netfx-4.7.2"
  /** An ASP.NET Core shared runtime of that major.minor (OAuth, Vault; the whole tree from 14.0). */
  | "aspnetcore-2.1"
  | "aspnetcore-6.0"
  | "aspnetcore-8.0"
  /** The IIS ASP.NET Core Module: V1 (`AspNetCoreModule`, the 12.0 tree) or V2 (14.x). */
  | "ancm-v1"
  | "ancm-v2"
  /** The Visual C++ 2015-2022 (14.x) x64 runtime. */
  | "vcredist-14-x64";

export interface Flavor {
  readonly key: FlavorKey;
  /** The Aras release the key stands for. */
  readonly release: string;
  /**
   * The server build. Null until the baseline builder (ticket 24) reads it from the installed
   * `Aras.Server.Core.dll`; every baseline verify (ticket 28) then checks it.
   */
  readonly serverBuild: string | null;
  /** The import-export-libs-js engine that serves this server. */
  readonly libsJsEngine: string;
  /** Repo-relative media folder, inside the main checkout. */
  readonly mediaFolder: string;
  /** The licence the flavor draws on (ticket 23 prompts for it); ticket 09 settles the line and when a key is needed. */
  readonly licence: Licence;
  /** The MSI inside the CD image. */
  readonly msiName: string;
  /**
   * The MSI's `ProductVersion` (media check, ticket 18): it must equal this or start with it and a dot.
   * It is a prefix because the 12.0 MSI reads `12.0.0` whatever the service pack.
   */
  readonly msiProductVersion: string;
  /** False when `ProductVersion` cannot tell this release from its sibling service packs (12.0 SP9). */
  readonly msiVersionIdentifiesRelease: boolean;
  /** The shipped OOTB backups inside the CD image. */
  readonly backups: { readonly core: string; readonly coreAndSolutions: string };
  /**
   * The logical file names inside the shipped `CoreAndSolutions*.bak`, and so inside the golden's `ootb.bak`, which is a
   * backup of a restore of it. A slot's restore moves them to its own files (ticket 25), and the broker's SQL login may
   * not read them from the backup (`RESTORE FILELISTONLY` needs `CREATE DATABASE`), so they are recorded here. Measured
   * with `RESTORE FILELISTONLY` on the CD backups, 2026-10-27.
   */
  readonly backupFiles: { readonly data: string; readonly log: string };
  /** How many slots the v1 pool holds (the design's option 5(a)). */
  readonly defaultSlots: number;
  /** Runtime state inside the code tree: outside the golden manifest, cleared by a reset, never flagged. */
  readonly runtimeDirs: readonly RuntimeRule[];
  /** What the host needs before a baseline of this flavor can run (spike record, section 1). */
  readonly hostPrerequisites: readonly HostPrerequisite[];
}

export const FLAVORS: Readonly<Record<FlavorKey, Flavor>> = {
  "12sp9": {
    key: "12sp9",
    release: "12.0 SP9",
    serverBuild: "12.0.0.24090",
    libsJsEngine: "12.0",
    mediaFolder: "media/12sp9",
    // A key is needed to log in, not to install; the 12.x key is refused by 14.x (spike record, section 2).
    licence: { line: "12", required: "to-login" },
    msiName: "InnovatorSetup.msi",
    msiProductVersion: "12.0",
    msiVersionIdentifiesRelease: false,
    backups: { core: "Core120.bak", coreAndSolutions: "CoreAndSolutions120.bak" },
    backupFiles: { data: "Solutions.S12-0-SP9.12.0.24090.ConvertSqlToBackup", log: "Solutions.S12-0-SP9.12.0.24090.ConvertSqlToBackup_log" },
    defaultSlots: 3,
    runtimeDirs: RUNTIME_DIRS,
    // OAuth and Vault are netcoreapp2.1 under `AspNetCoreModule` (V1); the rest is .NET Framework 4.x.
    hostPrerequisites: ["iis", "netfx-4.7.2", "aspnetcore-2.1", "ancm-v1"],
  },
  "23": {
    key: "23",
    release: "Release 23 (14.0 SP9)",
    serverBuild: "14.0.9.36073",
    libsJsEngine: "14.0.7",
    mediaFolder: "media/23",
    // A key is needed to log in, not to install (spike record, section 2).
    licence: { line: "14", required: "to-login" },
    msiName: "InnovatorSetup.msi",
    msiProductVersion: "14.0.9",
    msiVersionIdentifiesRelease: true,
    backups: { core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" },
    backupFiles: { data: "Solutions.S14-0-SP9.14.0.36073.ConvertSqlToBackup", log: "Solutions.S14-0-SP9.14.0.36073.ConvertSqlToBackup_log" },
    defaultSlots: 2,
    runtimeDirs: RUNTIME_DIRS,
    // net6.0 throughout, out of process (spike 07).
    hostPrerequisites: ["iis", "netfx-4.7.2", "aspnetcore-6.0", "ancm-v2"],
  },
  "35": {
    key: "35",
    release: "Release 35 (14.35)",
    // Read from the installed Aras.Server.Core.dll and the MSI's File table (ticket 08).
    serverBuild: "14.35.0.43890",
    libsJsEngine: "14.35",
    mediaFolder: "media/35",
    // The 14.0 key serves 14.35 (spike 08), so 35 shares line 14.
    licence: { line: "14", required: "to-login" },
    msiName: "InnovatorSetup.msi",
    msiProductVersion: "14.35",
    msiVersionIdentifiesRelease: true,
    backups: { core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" },
    backupFiles: { data: "Solutions.S14.35.0.14.35.0.43890.ConvertSqlToBackup", log: "Solutions.S14.35.0.14.35.0.43890.ConvertSqlToBackup_log" },
    defaultSlots: 2,
    runtimeDirs: RUNTIME_DIRS,
    // ASP.NET Core 8 and the VC++ 14.x runtime (spike 08, the Release 35 Installation Guide).
    hostPrerequisites: ["iis", "netfx-4.7.2", "aspnetcore-8.0", "ancm-v2", "vcredist-14-x64"],
  },
};

export function isFlavorKey(value: unknown): value is FlavorKey {
  return typeof value === "string" && (FLAVOR_KEYS as readonly string[]).includes(value);
}

/** The flavor for `key`; throws on anything that is not a registered key. */
export function getFlavor(key: string): Flavor {
  if (!isFlavorKey(key)) {
    throw new Error(`unknown flavor "${key}"; the flavors are ${FLAVOR_KEYS.join(", ")}`);
  }
  return FLAVORS[key];
}
