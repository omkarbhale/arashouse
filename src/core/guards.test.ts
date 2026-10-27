import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "./flavors.js";
import {
  DENIED_ALIASES,
  DENIED_DATABASES,
  DENIED_INSTALL_ROOTS,
  DENIED_SERVICE_PREFIXES,
  GuardError,
  assertOwned,
  assertValidRoot,
  nameDenial,
  type GuardCode,
  type OwnedKind,
} from "./guards.js";
import {
  APP_POOL_ROLES,
  DEFAULT_INSTALL_ROOT,
  MAX_SLOT,
  UTILITY_DATABASE,
  agentServiceName,
  appPoolName,
  auditLogFile,
  brokerClientScript,
  brokerTokenFile,
  databaseName,
  goldenDir,
  loginName,
  secretFile,
  secretsDir,
  slotDir,
  sqlDataDir,
  stagingDir,
  vaultDir,
  webAlias,
  type SlotRef,
} from "./names.js";

const ref: SlotRef = { flavor: "12sp9", slot: 1 };
const ROOT = DEFAULT_INSTALL_ROOT;

function refuses(code: GuardCode, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GuardError);
    expect((err as GuardError).code).toBe(code);
    return;
  }
  expect.fail(`expected a ${code} refusal`);
}

const allRefs: SlotRef[] = FLAVOR_KEYS.flatMap((flavor) =>
  Array.from({ length: MAX_SLOT }, (_, i) => ({ flavor, slot: i + 1 })),
);

function namesOf(r: SlotRef): [Exclude<OwnedKind, "root" | "path">, string][] {
  return [
    ["database", databaseName(r)],
    ["alias", webAlias(r)],
    ...APP_POOL_ROLES.map((role): [Exclude<OwnedKind, "root" | "path">, string] => ["appPool", appPoolName(r, role)]),
    ["service", agentServiceName(r)],
    ["login", loginName(r, "dbo")],
    ["login", loginName(r, "reg")],
  ];
}

describe("derived names against the allowlists and the deny-list", () => {
  it("every derived name, for every flavor and slot number, is owned and none is denied", () => {
    for (const r of allRefs) {
      for (const [kind, name] of namesOf(r)) {
        expect(nameDenial(name), name).toBeUndefined();
        expect(assertOwned(kind, name), name).toBe(name);
        expect(assertOwned(kind, name, r), name).toBe(name);
      }
    }
  });

  it("every derived path is owned and none is denied", () => {
    for (const r of allRefs) {
      for (const p of [slotDir(r), vaultDir(r), goldenDir(r.flavor), `${slotDir(r)}\\web\\Web.config`]) {
        expect(assertOwned("path", p, r), p).toBe(p);
      }
    }
    expect(assertOwned("path", stagingDir("lease-7"), ref)).toBe(stagingDir("lease-7"));
    expect(assertOwned("path", sqlDataDir(), ref)).toBe(sqlDataDir());
    expect(assertOwned("path", secretsDir(), ref)).toBe(secretsDir());
    expect(assertOwned("path", secretFile("licence-14"), ref)).toBe(secretFile("licence-14"));
    for (const p of [auditLogFile(new Date(Date.UTC(2026, 9, 27))), brokerTokenFile(), brokerClientScript()]) {
      expect(assertOwned("path", p), p).toBe(p);
    }
  });

  it("owns the utility database", () => {
    expect(assertOwned("database", UTILITY_DATABASE)).toBe(UTILITY_DATABASE);
    refuses("not-derived", () => assertOwned("database", UTILITY_DATABASE, ref));
  });
});

describe("assertOwned refuses the deny-list", () => {
  it.each(DENIED_DATABASES)("database %s, in any case and under any kind", (name) => {
    for (const variant of [name, name.toUpperCase(), name.toLowerCase()]) {
      for (const kind of ["database", "alias", "appPool", "service", "login"] as const) {
        refuses("denied", () => assertOwned(kind, variant, ref));
        refuses("denied", () => assertOwned(kind, variant));
      }
    }
  });

  it.each(DENIED_ALIASES)("alias %s, in any case", (name) => {
    for (const variant of [name, name.toUpperCase(), name.toLowerCase()]) {
      refuses("denied", () => assertOwned("alias", variant, ref));
      refuses("denied", () => assertOwned("alias", variant));
    }
  });

  it.each(DENIED_SERVICE_PREFIXES)("services starting %s", (prefix) => {
    for (const name of [`${prefix}01`, `${prefix}Aras28`, `${prefix.toLowerCase()}x`]) {
      refuses("denied", () => assertOwned("service", name, ref));
      refuses("denied", () => assertOwned("service", name));
    }
  });

  it.each(DENIED_INSTALL_ROOTS)("install root %s and anything under it", (root) => {
    refuses("denied", () => assertOwned("path", root, ref));
    refuses("denied", () => assertOwned("path", `${root}\\Server\\bin`, ref));
    refuses("denied", () => assertOwned("path", root.toUpperCase(), ref));
    refuses("denied", () => assertOwned("path", root.replaceAll("\\", "/"), ref));
    refuses("bad-root", () => assertValidRoot(root));
  });

  it("the captain's top-level Aras folders", () => {
    for (const p of ["C:\\Aras", "C:\\Aras12\\Innovator", "C:\\aras28\\Innovator\\Server"]) {
      refuses("denied", () => assertOwned("path", p, ref));
      refuses("denied", () => assertValidRoot(p));
    }
  });

  it("OLM_Local in any case, anywhere in a name or a path", () => {
    for (const name of ["OLM_Local", "olm_local", "OLM_LOCAL", "arashouse_olm_01", "ah-olm-01", "xOlMx"]) {
      for (const kind of ["database", "alias", "appPool", "service", "login"] as const) {
        refuses("denied", () => assertOwned(kind, name, ref));
      }
    }
    refuses("denied", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\OLM_Local.mdf`, ref));
    refuses("denied", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\olm`, ref));
    refuses("denied", () => assertValidRoot("C:\\olm_installs"));
  });

  it("anything matching prod, in any case", () => {
    for (const name of ["prod", "PROD_copy", "arashouse_prod_01", "ah-Production-01", "ArasHouseAgent_prod"]) {
      for (const kind of ["database", "alias", "appPool", "service", "login"] as const) {
        refuses("denied", () => assertOwned(kind, name));
      }
    }
    refuses("denied", () => assertOwned("path", `${ROOT}\\golden\\12sp9\\PROD`, ref));
  });
});

describe("assertOwned refuses names outside the allowlist or not derived from the slot", () => {
  it("names outside every allowlist", () => {
    refuses("not-allowlisted", () => assertOwned("database", "master"));
    refuses("not-allowlisted", () => assertOwned("database", "tempdb", ref));
    refuses("not-allowlisted", () => assertOwned("login", "sa"));
    refuses("not-allowlisted", () => assertOwned("login", "NT SERVICE\\ArasHouseBroker"));
    refuses("not-allowlisted", () => assertOwned("alias", "Default Web Site"));
    refuses("not-allowlisted", () => assertOwned("service", "MSSQLSERVER"));
    refuses("not-allowlisted", () => assertOwned("database", "ARASHOUSE_12SP9_01"));
    refuses("not-allowlisted", () => assertOwned("database", "arashouse_12sp9_01; drop database x"));
    refuses("not-allowlisted", () => assertOwned("database", ""));
    refuses("not-allowlisted", () => assertOwned("database", "arashouse_" + "x".repeat(200)));
    refuses("not-allowlisted", () => assertOwned("database", undefined as never));
  });

  it("a name with a different flavor than the slot record", () => {
    refuses("not-derived", () => assertOwned("database", "arashouse_23_01", ref));
    refuses("not-derived", () => assertOwned("alias", "ah-35-01", ref));
    refuses("not-derived", () => assertOwned("service", "ArasHouseAgent_23_01", ref));
    refuses("not-derived", () => assertOwned("login", "arashouse_23_01_dbo", ref));
    refuses("not-derived", () => assertOwned("appPool", "ah-23-01-server", ref));
  });

  it("a name with a different slot number than the slot record", () => {
    refuses("not-derived", () => assertOwned("database", "arashouse_12sp9_02", ref));
    refuses("not-derived", () => assertOwned("login", "arashouse_12sp9_02_reg", ref));
    refuses("not-derived", () => assertOwned("appPool", "ah-12sp9-02-server", ref));
  });

  it("a name that merely looks derived", () => {
    refuses("not-derived", () => assertOwned("database", "arashouse_12sp9_01_copy", ref));
    refuses("not-derived", () => assertOwned("appPool", "ah-12sp9-01-nosuchrole", ref));
    refuses("not-derived", () => assertOwned("database", "arashouse_extra", ref));
  });

  it("a slot record that is not a registered (flavor, number)", () => {
    refuses("bad-slot", () => assertOwned("database", "arashouse_12sp9_01", { flavor: "28" as never, slot: 1 }));
    refuses("bad-slot", () => assertOwned("database", "arashouse_12sp9_01", { flavor: "12sp9", slot: 0 }));
  });
});

describe("assertOwned on paths", () => {
  it("refuses .. segments and plain traversal", () => {
    refuses("bad-path", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\..\\02`, ref));
    refuses("bad-path", () => assertOwned("path", `${ROOT}\\slots\\..\\..\\Windows`, ref));
    refuses("bad-path", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\..`, ref));
    refuses("bad-path", () => assertOwned("path", `${ROOT}/slots/12sp9/01/../../..`, ref));
    refuses("bad-path", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\.`, ref));
  });

  it("refuses a junction segment reported by the host's reparse-point probe", () => {
    const junction = `${slotDir(ref)}\\web`;
    const probe = (p: string) => p.toLowerCase() === junction.toLowerCase();
    refuses("bad-path", () => assertOwned("path", `${junction}\\Web.config`, ref, { isReparsePoint: probe }));
    refuses("bad-path", () => assertOwned("path", junction, ref, { isReparsePoint: probe }));
    expect(assertOwned("path", slotDir(ref), ref, { isReparsePoint: probe })).toBe(slotDir(ref));
    // A junction anywhere above, including the root itself, is refused too.
    refuses("bad-path", () => assertOwned("path", slotDir(ref), ref, { isReparsePoint: (p) => p === ROOT }));
    refuses("bad-path", () => assertOwned("path", slotDir(ref), ref, { isReparsePoint: (p) => p.endsWith("\\slots") }));
  });

  it("refuses UNC, WSL, relative and device paths", () => {
    for (const p of [
      "\\\\wsl.localhost\\Ubuntu\\home\\omkarb",
      "\\\\server\\share\\slots\\12sp9\\01",
      "//wsl$/Ubuntu/home",
      "/mnt/c/aras_installations/slots/12sp9/01",
      "slots\\12sp9\\01",
      "C:slots\\12sp9\\01",
      "\\\\?\\C:\\aras_installations\\slots\\12sp9\\01",
      "",
    ]) {
      refuses("bad-path", () => assertOwned("path", p, ref));
    }
  });

  it("refuses 8.3 short names, alternate data streams, trailing dots and reserved devices", () => {
    refuses("bad-path", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\01\\PROGRA~1`, ref));
    refuses("bad-path", () => assertOwned("path", `${slotDir(ref)}\\a.txt:stream`, ref));
    refuses("bad-path", () => assertOwned("path", `${slotDir(ref)}\\web.`, ref));
    refuses("bad-path", () => assertOwned("path", `${slotDir(ref)}\\nul`, ref));
    refuses("bad-path", () => assertOwned("path", `${slotDir(ref)}\\a*b`, ref));
  });

  it("refuses paths outside the root or outside the tool's folders", () => {
    refuses("not-allowlisted", () => assertOwned("path", "C:\\Windows\\System32", ref));
    refuses("not-allowlisted", () => assertOwned("path", "D:\\aras_installations\\slots\\12sp9\\01", ref));
    refuses("not-allowlisted", () => assertOwned("path", "C:\\aras_installations_evil\\slots\\12sp9\\01", ref));
    refuses("not-allowlisted", () => assertOwned("path", ROOT, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\spike\\out`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\slots`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\slots\\12sp9`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\slots\\28\\01`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\slots\\12sp9\\1`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\vaults\\12sp9`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\golden`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\staging`, ref));
    refuses("not-allowlisted", () => assertOwned("path", `${ROOT}\\staging\\bad.id`, ref));
  });

  it("refuses another slot's or flavor's folders when given a slot record", () => {
    refuses("not-derived", () => assertOwned("path", slotDir({ flavor: "12sp9", slot: 2 }), ref));
    refuses("not-derived", () => assertOwned("path", slotDir({ flavor: "23", slot: 1 }), ref));
    refuses("not-derived", () => assertOwned("path", vaultDir({ flavor: "35", slot: 1 }), ref));
    refuses("not-derived", () => assertOwned("path", `${vaultDir({ flavor: "12sp9", slot: 2 })}\\x`, ref));
    refuses("not-derived", () => assertOwned("path", goldenDir("23"), ref));
  });

  it("honours a configured root and refuses paths under the default one", () => {
    const options = { root: "D:\\ah" };
    expect(assertOwned("path", slotDir(ref, "D:\\ah"), ref, options)).toBe(slotDir(ref, "D:\\ah"));
    expect(assertOwned("path", "d:/ah/slots/12sp9/01/web", ref, options)).toBe("D:\\ah\\slots\\12sp9\\01\\web");
    refuses("not-allowlisted", () => assertOwned("path", slotDir(ref), ref, options));
    refuses("bad-root", () => assertOwned("path", slotDir(ref), ref, { root: "C:\\Program Files\\ah" }));
  });
});

describe("the install root", () => {
  it("accepts the default and normalises it", () => {
    expect(assertValidRoot(ROOT)).toBe(ROOT);
    expect(assertValidRoot("c:/aras_installations/")).toBe(ROOT);
    expect(assertOwned("root", ROOT)).toBe(ROOT);
    expect(assertOwned("root", "c:/ARAS_INSTALLATIONS")).toBe(ROOT);
  });

  it("refuses a root under Program Files, in any form", () => {
    for (const r of [
      "C:\\Program Files\\Aras",
      "C:\\Program Files (x86)\\arashouse",
      "c:\\program files\\x",
      "C:/Program Files/x",
      "C:\\data\\Program Files\\x",
    ]) {
      refuses("bad-root", () => assertValidRoot(r));
      refuses("bad-root", () => assertOwned("root", r, undefined, { root: r }));
    }
  });

  it("refuses a root under \\Users\\", () => {
    refuses("bad-root", () => assertValidRoot("C:\\Users\\omkarb\\aras"));
    refuses("bad-root", () => assertValidRoot("C:\\users\\omkarb"));
  });

  it("refuses a root on the WSL filesystem, a UNC share, a relative path or a drive root", () => {
    for (const r of ["/home/omkarb/aras", "\\\\wsl.localhost\\Ubuntu\\aras", "\\\\server\\share", "aras", "C:\\", "C:", ""]) {
      refuses("bad-root", () => assertValidRoot(r));
    }
  });

  it("refuses a root whose real path is under Program Files or \\Users\\", () => {
    refuses("bad-root", () => assertValidRoot("C:\\aras_installations", { realPath: () => "C:\\Program Files\\x" }));
    refuses("bad-root", () => assertValidRoot("C:\\aras_installations", { realPath: () => "C:\\Users\\omkarb\\aras" }));
    refuses("denied", () => assertValidRoot("C:\\aras_installations", { realPath: () => "C:\\Aras28" }));
    expect(assertValidRoot("C:\\aras_installations", { realPath: (p) => p })).toBe(ROOT);
    refuses("bad-root", () =>
      assertOwned("path", slotDir(ref), ref, { realPath: () => "C:\\Program Files (x86)\\x" }),
    );
  });

  it("refuses a name other than the configured root", () => {
    refuses("not-allowlisted", () => assertOwned("root", "D:\\ah"));
    expect(assertOwned("root", "D:\\ah", undefined, { root: "D:\\ah" })).toBe("D:\\ah");
  });
});

describe("GuardError", () => {
  it("names the kind and subject, so a refusal is explainable without a stack", () => {
    try {
      assertOwned("database", "OLM_Local", ref);
      expect.fail("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(GuardError);
      const e = err as GuardError;
      expect([e.code, e.kind, e.subject]).toEqual(["denied", "database", "OLM_Local"]);
      expect(e.message).toContain("OLM_Local");
    }
  });
});
