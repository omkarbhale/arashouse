import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "./flavors.js";
import {
  APP_POOL_ROLES,
  DEFAULT_INSTALL_ROOT,
  MAX_SLOT,
  agentPort,
  agentServiceName,
  appPoolName,
  auditLogFile,
  brokerClientScript,
  brokerDir,
  brokerTokenFile,
  buildNames,
  databaseName,
  goldenDir,
  isSecretName,
  loginName,
  logsDir,
  parseSlotId,
  secretFile,
  secretsDir,
  slotDir,
  slotId,
  slotNames,
  slotNumber,
  sqlDataDir,
  databaseFiles,
  stagingDir,
  stampFile,
  vaultDir,
  webAlias,
} from "./names.js";

const ref = { flavor: "12sp9", slot: 3 } as const;

describe("derived names", () => {
  it("names a slot by `<key>-<NN>`", () => {
    expect(slotId(ref)).toBe("12sp9-03");
    expect(slotId({ flavor: "23", slot: 12 })).toBe("23-12");
    expect(() => slotId({ flavor: "23", slot: 0 })).toThrow();
  });

  it("builds every name from (flavor, NN)", () => {
    expect(databaseName(ref)).toBe("arashouse_12sp9_03");
    expect(webAlias(ref)).toBe("ah-12sp9-03");
    expect(appPoolName(ref, "server")).toBe("ah-12sp9-03-server");
    expect(agentServiceName(ref)).toBe("ArasHouseAgent_12sp9_03");
    expect(loginName(ref, "dbo")).toBe("arashouse_12sp9_03_dbo");
    expect(loginName(ref, "reg")).toBe("arashouse_12sp9_03_reg");
    expect(databaseName({ flavor: "35", slot: 12 })).toBe("arashouse_35_12");
  });

  it("builds the folders under the install root with Windows separators", () => {
    expect(DEFAULT_INSTALL_ROOT).toBe("C:\\aras_installations");
    expect(slotDir(ref)).toBe("C:\\aras_installations\\slots\\12sp9\\03");
    expect(vaultDir(ref)).toBe("C:\\aras_installations\\vaults\\12sp9-03");
    expect(goldenDir("23")).toBe("C:\\aras_installations\\golden\\23");
    expect(stagingDir("lease-1")).toBe("C:\\aras_installations\\staging\\lease-1");
    expect(sqlDataDir()).toBe("C:\\aras_installations\\sqldata");
    expect(slotDir(ref, "D:\\ah")).toBe("D:\\ah\\slots\\12sp9\\03");
  });

  it("puts a database's two files under sqldata (ticket 22), and only the tool's databases", () => {
    expect(databaseFiles(databaseName(ref))).toEqual({
      data: "C:\\aras_installations\\sqldata\\arashouse_12sp9_03.mdf",
      log: "C:\\aras_installations\\sqldata\\arashouse_12sp9_03_log.ldf",
    });
    expect(databaseFiles("arashouse_admin", "D:\\ah").data).toBe("D:\\ah\\sqldata\\arashouse_admin.mdf");
    for (const bad of ["OLM_Local", "arashouse_x;y", "arashouse_..\\x"]) expect(() => databaseFiles(bad)).toThrow(/not one of the tool's database names/);
  });

  it("names a flavor's baseline install (ticket 24), which its golden config files still name", () => {
    expect(buildNames("23")).toEqual({
      alias: "ah-build-23",
      database: "arashouse_build_23",
      dir: "C:\\aras_installations\\golden-build\\23",
      agentPort: 8734,
    });
    expect(buildNames("12sp9", "D:\\ah").dir).toBe("D:\\ah\\golden-build\\12sp9");
    expect(() => buildNames("olm" as never)).toThrow(/unknown flavor/);
  });

  it("zero-pads the slot number and refuses anything outside 1 to 99", () => {
    expect(slotNumber(1)).toBe("01");
    expect(slotNumber(MAX_SLOT)).toBe("99");
    for (const bad of [0, 100, -1, 1.5, Number.NaN]) expect(() => slotNumber(bad)).toThrow(/slot number/);
  });

  it("refuses an unknown flavor and an unknown role", () => {
    expect(() => databaseName({ flavor: "28" as never, slot: 1 })).toThrow(/unknown flavor/);
    expect(() => appPoolName(ref, "admin" as never)).toThrow(/role/);
    expect(() => loginName(ref, "sa" as never)).toThrow(/role/);
  });

  it("refuses a lease id that could escape the staging folder", () => {
    for (const bad of ["", "..", "a/b", "a\\b", "a.b", "-x", "x".repeat(65)]) {
      expect(() => stagingDir(bad)).toThrow(/lease id/);
    }
  });

  it("gives every slot its own agent port in a reserved block that avoids 8734-8736", () => {
    const ports: number[] = [];
    for (const flavor of FLAVOR_KEYS) for (let slot = 1; slot <= MAX_SLOT; slot++) ports.push(agentPort({ flavor, slot }));
    expect(new Set(ports).size).toBe(ports.length);
    expect(Math.min(...ports)).toBe(8801);
    expect(ports.some((p) => p >= 8734 && p <= 8736)).toBe(false);
    expect(agentPort({ flavor: "12sp9", slot: 1 })).toBe(8801);
    expect(agentPort({ flavor: "23", slot: 2 })).toBe(8902);
  });

  it("collects a slot's names in one record", () => {
    const names = slotNames({ flavor: "23", slot: 2 });
    expect(names.database).toBe("arashouse_23_02");
    expect(Object.keys(names.appPools)).toEqual([...APP_POOL_ROLES]);
    expect(names.logins).toEqual({ dbo: "arashouse_23_02_dbo", reg: "arashouse_23_02_reg" });
    expect(names.slotDir).toBe("C:\\aras_installations\\slots\\23\\02");
  });
});

describe("secret storage names", () => {
  it("puts stored secrets under <root>\\secrets as <name>.bin", () => {
    expect(secretsDir()).toBe("C:\\aras_installations\\secrets");
    expect(secretFile("licence-14")).toBe("C:\\aras_installations\\secrets\\licence-14.bin");
    expect(secretFile("sa", "D:\\ah")).toBe("D:\\ah\\secrets\\sa.bin");
  });

  it("accepts only lower-case letters, digits and '-' in a secret name", () => {
    for (const ok of ["sa", "licence-14", "a".repeat(64)]) expect(isSecretName(ok)).toBe(true);
    for (const bad of ["", "-x", "Licence-14", "a.b", "a\\b", "a/b", "..", "a b", "a".repeat(65), 14, undefined]) {
      expect(isSecretName(bad)).toBe(false);
      if (typeof bad === "string") expect(() => secretFile(bad)).toThrow(/secret name/);
    }
  });
});

describe("broker names", () => {
  it("puts the audit log under <root>\\logs, one file per UTC day", () => {
    expect(logsDir()).toBe("C:\\aras_installations\\logs");
    expect(auditLogFile(new Date("2026-10-27T23:59:59Z"))).toBe("C:\\aras_installations\\logs\\broker-20261027.log");
    expect(auditLogFile(new Date("2026-10-28T00:00:00Z"), "D:\\ah")).toBe("D:\\ah\\logs\\broker-20261028.log");
    expect(() => auditLogFile(new Date(Number.NaN))).toThrow(/valid date/);
  });

  it("puts the slot stamp in the slot folder", () => {
    expect(stampFile(ref)).toBe("C:\\aras_installations\\slots\\12sp9\\03\\.arashouse-slot.json");
  });

  it("puts the broker's code and client token under <root>\\broker", () => {
    expect(brokerDir()).toBe("C:\\aras_installations\\broker");
    expect(brokerClientScript()).toBe("C:\\aras_installations\\broker\\app\\broker\\client.js");
    expect(brokerTokenFile("D:\\ah")).toBe("D:\\ah\\broker\\client.token");
  });
});

describe("slot ids", () => {
  it("renders <key>-<NN> and parses it back", () => {
    expect(slotId({ flavor: "23", slot: 2 })).toBe("23-02");
    expect(parseSlotId("12sp9-03")).toEqual({ flavor: "12sp9", slot: 3 });
    for (const flavor of FLAVOR_KEYS) {
      for (const slot of [1, 9, 10, MAX_SLOT]) {
        expect(parseSlotId(slotId({ flavor, slot }))).toEqual({ flavor, slot });
      }
    }
  });

  it.each(["", "23", "23-2", "23-002", "23-00", "99-01", "23-01 ", "../23-01", "OLM_Local"])("refuses %j", (id) => {
    expect(() => parseSlotId(id)).toThrow();
  });
});
