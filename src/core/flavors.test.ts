import { describe, expect, it } from "vitest";
import { FLAVORS, FLAVOR_KEYS, RUNTIME_DIRS, getFlavor, isFlavorKey } from "./flavors.js";

describe("flavor registry", () => {
  it("has the three captain-named flavors, keyed by their own key", () => {
    expect([...FLAVOR_KEYS]).toEqual(["12sp9", "23", "35"]);
    for (const key of FLAVOR_KEYS) expect(FLAVORS[key].key).toBe(key);
  });

  it("maps each flavor to its libs-js engine, media folder and default slot count", () => {
    expect(FLAVORS["12sp9"]).toMatchObject({ libsJsEngine: "12.0", mediaFolder: "media/12sp9", defaultSlots: 3 });
    expect(FLAVORS["23"]).toMatchObject({ libsJsEngine: "14.0.7", mediaFolder: "media/23", defaultSlots: 2 });
    expect(FLAVORS["35"]).toMatchObject({ libsJsEngine: "14.35", mediaFolder: "media/35", defaultSlots: 2 });
  });

  it("carries the server build each flavor's installer was measured to install", () => {
    expect(FLAVORS["12sp9"].serverBuild).toBe("12.0.0.24090");
    expect(FLAVORS["23"].serverBuild).toBe("14.0.9.36073");
    expect(FLAVORS["35"].serverBuild).toBe("14.35.0.43890");
  });

  it("names the licence line, the MSI and the shipped backups", () => {
    expect(FLAVORS["12sp9"].backups).toEqual({ core: "Core120.bak", coreAndSolutions: "CoreAndSolutions120.bak" });
    expect(FLAVORS["23"].backups).toEqual({ core: "Core140.bak", coreAndSolutions: "CoreAndSolutions140.bak" });
    for (const key of FLAVOR_KEYS) {
      expect(FLAVORS[key].msiName).toBe("InnovatorSetup.msi");
      expect(FLAVORS[key].licence.line).not.toBe("");
    }
  });

  it("carries the MSI ProductVersion each flavor's installer must report", () => {
    expect(FLAVORS["12sp9"]).toMatchObject({ msiProductVersion: "12.0", msiVersionIdentifiesRelease: false });
    expect(FLAVORS["23"]).toMatchObject({ msiProductVersion: "14.0.9", msiVersionIdentifiesRelease: true });
    expect(FLAVORS["35"]).toMatchObject({ msiProductVersion: "14.35", msiVersionIdentifiesRelease: true });
  });

  it("recognises only registered keys", () => {
    expect(isFlavorKey("23")).toBe(true);
    expect(isFlavorKey("28")).toBe(false);
    expect(isFlavorKey(23)).toBe(false);
    expect(getFlavor("35").release).toContain("35");
    expect(() => getFlavor("sp18")).toThrow(/unknown flavor/);
  });

  it("lists the runtime directories the manifest leaves out, for every flavor", () => {
    const dirs = RUNTIME_DIRS.map((r) => r.dir);
    expect(dirs).toEqual(["Server/temp", "Server/dll", "Server/logs", "OAuthServer/App_Data"]);
    expect(RUNTIME_DIRS.find((r) => r.dir === "OAuthServer/App_Data")?.files).toEqual(["*.sqlite*", "key-*.xml"]);
    for (const key of FLAVOR_KEYS) expect(FLAVORS[key].runtimeDirs).toEqual(RUNTIME_DIRS);
  });
});
