import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, configPath, loadConfig, parseConfig } from "./config.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "arashouse-config-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the config defaults", () => {
  it("are the ticket's: three active, two resets, about one slot of RAM, 12sp9 3, 23 2, 35 2", () => {
    expect(DEFAULT_CONFIG).toEqual({
      max_active: 3,
      max_resets: 2,
      min_free_ram_mb: 2048,
      min_free_disk_gb: 10,
      slots_per_flavor: { "12sp9": 3, "23": 2, "35": 2 },
    });
  });
});

describe("loadConfig", () => {
  it("is the defaults when there is no file", async () => {
    expect(await loadConfig({ home })).toEqual(DEFAULT_CONFIG);
  });

  it("reads config.json next to the state file, under ARASHOUSE_HOME", async () => {
    expect(configPath({ env: { ARASHOUSE_HOME: home } })).toBe(join(home, "config.json"));
    await writeFile(join(home, "config.json"), JSON.stringify({ max_active: 4, slots_per_flavor: { "35": 0 } }));
    expect(await loadConfig({ env: { ARASHOUSE_HOME: home } })).toEqual({
      ...DEFAULT_CONFIG,
      max_active: 4,
      slots_per_flavor: { "12sp9": 3, "23": 2, "35": 0 },
    });
  });

  it("names the file when it is unusable", async () => {
    await writeFile(join(home, "config.json"), "{");
    await expect(loadConfig({ home })).rejects.toThrow(`the config file ${join(home, "config.json")} is unusable: not valid JSON`);
  });
});

describe("parseConfig", () => {
  it("takes every key over the defaults", () => {
    const all = { max_active: 5, max_resets: 1, min_free_ram_mb: 0, min_free_disk_gb: 50, slots_per_flavor: { "12sp9": 1, "23": 1, "35": 1 } };
    expect(parseConfig(JSON.stringify(all))).toEqual(all);
    expect(parseConfig("{}")).toEqual(DEFAULT_CONFIG);
  });

  it.each<[string, unknown, RegExp]>([
    ["an array", [], /not a JSON object/],
    ["an unknown key, so nothing else can be kept there", { sa_password: "x" }, /unknown key "sa_password"/],
    ["max_active 0", { max_active: 0 }, /max_active must be a whole number from 1 up/],
    ["a fractional max_resets", { max_resets: 1.5 }, /max_resets/],
    ["a negative RAM floor", { min_free_ram_mb: -1 }, /min_free_ram_mb/],
    ["a disk floor given as text", { min_free_disk_gb: "10" }, /min_free_disk_gb/],
    ["slots_per_flavor as a number", { slots_per_flavor: 3 }, /slots_per_flavor must be an object/],
    ["an unknown flavor", { slots_per_flavor: { "28": 1 } }, /unknown flavor "28"/],
    ["more slots than names allow", { slots_per_flavor: { "23": 100 } }, /slots_per_flavor\.23 must be a whole number from 0 to 99/],
  ])("refuses %s", (_label, raw, message) => {
    expect(() => parseConfig(JSON.stringify(raw), "/h/config.json")).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify(raw), "/h/config.json")).toThrow(message);
  });

  it("does not echo a refused value back", () => {
    const value = ["hunter", "2-config-canary"].join("");
    let message = "";
    try {
      parseConfig(JSON.stringify({ max_active: value }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("max_active");
    expect(message).not.toContain(value);
  });
});
