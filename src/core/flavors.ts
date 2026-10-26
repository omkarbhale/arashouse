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

/** The runtime directories every Aras flavor shares (design 5.2 and 6.2). */
export const RUNTIME_DIRS: readonly RuntimeRule[] = [
  { dir: "Server/temp" },
  { dir: "Server/dll" },
  { dir: "Server/logs" },
  { dir: "OAuthServer/App_Data", files: ["*.sqlite*", "key-*.xml"] },
];

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
  /** The shipped OOTB backups inside the CD image. */
  readonly backups: { readonly core: string; readonly coreAndSolutions: string };
  /** How many slots the v1 pool holds (the design's option 5(a)). */
  readonly defaultSlots: number;
  /** Runtime state inside the code tree: outside the golden manifest, cleared by a reset, never flagged. */
  readonly runtimeDirs: readonly RuntimeRule[];
}

export const FLAVORS: Readonly<Record<FlavorKey, Flavor>> = {
  "12sp9": {
    key: "12sp9",
    release: "12.0 SP9",
    serverBuild: "12.0.0.24090",
    libsJsEngine: "12.0",
    mediaFolder: "media/12sp9",
    // Provisional until ticket 09 reports whether login, install or neither needs a key.
    licence: { line: "12", required: "to-install" },
    msiName: "InnovatorSetup.msi",
    backups: { core: "Core120.bak", coreAndSolutions: "CoreAndSolutions120.bak" },
    defaultSlots: 3,
    runtimeDirs: RUNTIME_DIRS,
  },
  "23": {
    key: "23",
    release: "Release 23 (14.0 SP9)",
    serverBuild: "14.0.9.36073",
    libsJsEngine: "14.0.7",
    mediaFolder: "media/23",
    // Provisional until ticket 09 reports whether login, install or neither needs a key.
    licence: { line: "14", required: "to-install" },
    msiName: "InnovatorSetup.msi",
    backups: { core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" },
    defaultSlots: 2,
    runtimeDirs: RUNTIME_DIRS,
  },
  "35": {
    key: "35",
    release: "Release 35 (14.35)",
    // Ticket 08 and the baseline builder (ticket 24) fill this in.
    serverBuild: null,
    libsJsEngine: "14.35",
    mediaFolder: "media/35",
    // Provisional until ticket 09 reports whether login, install or neither needs a key.
    licence: { line: "35", required: "to-install" },
    msiName: "InnovatorSetup.msi",
    backups: { core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" },
    defaultSlots: 2,
    runtimeDirs: RUNTIME_DIRS,
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
