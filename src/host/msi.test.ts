import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MSI_VALUE_PROPERTIES, MsiReadError, buildMsiProbeScript, createMsiReader, parseMsiProbeOutput } from "./msi.js";

describe("the Property table probe", () => {
  it("reads the value of ProductName, Manufacturer and ProductVersion only", () => {
    expect([...MSI_VALUE_PROPERTIES]).toEqual(["ProductName", "Manufacturer", "ProductVersion"]);
    const script = buildMsiProbeScript("C:\\Temp\\InnovatorSetup.msi");
    expect(script).toContain("$wanted = @('ProductName','Manufacturer','ProductVersion')");
    // The value column is read only inside the `$wanted -contains` branch.
    const valueReads = script.split("\n").filter((l) => l.includes("@(2)"));
    expect(valueReads).toHaveLength(1);
    expect(script.indexOf("$wanted -contains $name")).toBeLessThan(script.indexOf("@(2)"));
    expect(script).toContain("OpenDatabase");
    expect(script).not.toMatch(/Execute-Sql|Invoke-Expression|Start-Process/i);
  });

  it("quotes a path with an apostrophe", () => {
    expect(buildMsiProbeScript("C:\\Users\\O'Neil\\a.msi")).toContain("$path = 'C:\\Users\\O''Neil\\a.msi'");
  });

  it("parses names and the three values, and drops everything else", () => {
    const out = JSON.stringify({
      names: ["ProductName", "WEBALIAS", "LICENSEKEY"],
      values: { ProductName: "Aras Innovator", ProductVersion: "14.0.9", Manufacturer: "Aras Corporation", LICENSEKEY: "must not survive" },
    });
    const props = parseMsiProbeOutput(out);
    expect(props).toEqual({
      names: ["ProductName", "WEBALIAS", "LICENSEKEY"],
      productName: "Aras Innovator",
      manufacturer: "Aras Corporation",
      productVersion: "14.0.9",
    });
    expect(JSON.stringify(props)).not.toContain("must not survive");
  });

  it("accepts a single name (PowerShell unwraps one-element arrays) and rejects junk", () => {
    expect(parseMsiProbeOutput('{"names":"ONLY","values":{}}').names).toEqual(["ONLY"]);
    expect(() => parseMsiProbeOutput("not json")).toThrow(MsiReadError);
    expect(() => parseMsiProbeOutput("null")).toThrow(MsiReadError);
    expect(() => parseMsiProbeOutput('{"names":[],"values":{}}')).toThrow(/no Property table rows/);
  });
});

describe("the MSI reader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arashouse-msi-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const probeOut = JSON.stringify({ names: ["WEBALIAS"], values: { ProductVersion: "14.0.9" } });

  it("passes a Windows-drive path straight to powershell.exe, with the script encoded", async () => {
    const calls: [string, string[]][] = [];
    const reader = createMsiReader({
      run: async (file, args) => {
        calls.push([file, args]);
        return file === "wslpath" ? "C:\\Temp\\a.msi\n" : probeOut;
      },
    });
    expect(await reader("/mnt/c/Temp/a.msi")).toMatchObject({ names: ["WEBALIAS"], productVersion: "14.0.9" });
    expect(calls.map(([f]) => f)).toEqual(["wslpath", "powershell.exe"]);
    const args = calls[1]![1];
    expect(args).toContain("-NoProfile");
    expect(args).toContain("-NonInteractive");
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("$path = 'C:\\Temp\\a.msi'");
  });

  it("stages an MSI on the WSL filesystem in the Windows temp folder, then removes the copy", async () => {
    const msi = join(dir, "wsl", "a.msi");
    mkdirSync(join(dir, "wsl"));
    writeFileSync(msi, "msi bytes");
    const winTemp = join(dir, "wintemp");
    mkdirSync(winTemp);
    const wslpathArgs: string[] = [];
    let stagedDuringProbe: string | undefined;
    const reader = createMsiReader({
      windowsTemp: winTemp,
      run: async (file, args) => {
        if (file === "wslpath") {
          wslpathArgs.push(args[1]!);
          return args[1] === msi ? "\\\\wsl.localhost\\Ubuntu\\x\\a.msi" : "C:\\Temp\\staged.msi";
        }
        const staged = readdirSync(winTemp)[0]!;
        stagedDuringProbe = readFileSync(join(winTemp, staged, "InnovatorSetup.msi"), "utf8");
        return probeOut;
      },
    });
    await reader(msi);
    expect(stagedDuringProbe).toBe("msi bytes");
    expect(wslpathArgs[0]).toBe(msi);
    expect(wslpathArgs[1]!.startsWith(winTemp)).toBe(true);
    expect(readdirSync(winTemp)).toEqual([]);
    expect(existsSync(msi)).toBe(true);
  });

  it("explains a powershell failure without echoing the command line", async () => {
    const reader = createMsiReader({
      run: async (file) => {
        if (file === "wslpath") return "C:\\a.msi";
        throw Object.assign(new Error("Command failed: powershell.exe ... ENCODEDSCRIPT"), { stderr: "COMException: bad database\nmore" });
      },
    });
    let error: unknown;
    try {
      await reader("/mnt/c/a.msi");
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(MsiReadError);
    const message = (error as Error).message;
    expect(message).toMatch(/could not read the Property table of \/mnt\/c\/a\.msi: COMException: bad database$/);
    expect(message).not.toContain("ENCODEDSCRIPT");
  });

  it("says so when wslpath is unavailable", async () => {
    const reader = createMsiReader({ run: async () => Promise.reject(new Error("spawn wslpath ENOENT")) });
    await expect(reader("/x/a.msi")).rejects.toThrow(/wslpath.*is this WSL/);
  });
});
