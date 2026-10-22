import { describe, expect, it } from "vitest";
import { FLAVOR_KEYS } from "./flavors.js";
import {
  APP_POOL_ROLES,
  DEFAULT_INSTALL_ROOT,
  MAX_SLOT,
  agentPort,
  agentServiceName,
  appPoolName,
  databaseName,
  goldenDir,
  loginName,
  slotDir,
  slotNames,
  slotNumber,
  sqlDataDir,
  stagingDir,
  vaultDir,
  webAlias,
} from "./names.js";

const ref = { flavor: "12sp9", slot: 3 } as const;

describe("derived names", () => {
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
