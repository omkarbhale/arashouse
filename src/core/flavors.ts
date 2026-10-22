// The flavor registry: one data entry per Aras flavor. No other module hard-codes a flavor fact.

export const FLAVOR_KEYS = ["12sp9", "23", "35"] as const;

/** The captain's name for a flavor. */
export type FlavorKey = (typeof FLAVOR_KEYS)[number];

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
  /** The licence line the flavor draws on; ticket 09 settles whether login needs a key at all. */
  readonly licenceLine: string;
  /** The MSI inside the CD image. */
  readonly msiName: string;
  /** The shipped OOTB backups inside the CD image. */
  readonly backups: { readonly core: string; readonly coreAndSolutions: string };
  /** How many slots the v1 pool holds (the design's option 5(a)). */
  readonly defaultSlots: number;
}

export const FLAVORS: Readonly<Record<FlavorKey, Flavor>> = {
  "12sp9": {
    key: "12sp9",
    release: "12.0 SP9",
    serverBuild: "12.0.0.24090",
    libsJsEngine: "12.0",
    mediaFolder: "media/12sp9",
    licenceLine: "12",
    msiName: "InnovatorSetup.msi",
    backups: { core: "Core120.bak", coreAndSolutions: "CoreAndSolutions120.bak" },
    defaultSlots: 3,
  },
  "23": {
    key: "23",
    release: "Release 23 (14.0 SP9)",
    serverBuild: "14.0.9.36073",
    libsJsEngine: "14.0.7",
    mediaFolder: "media/23",
    licenceLine: "14",
    msiName: "InnovatorSetup.msi",
    backups: { core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" },
    defaultSlots: 2,
  },
  "35": {
    key: "35",
    release: "Release 35 (14.35)",
    // Ticket 08 and the baseline builder (ticket 24) fill this in.
    serverBuild: null,
    libsJsEngine: "14.35",
    mediaFolder: "media/35",
    licenceLine: "35",
    msiName: "InnovatorSetup.msi",
    backups: { core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" },
    defaultSlots: 2,
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
