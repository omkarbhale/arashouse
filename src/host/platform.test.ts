import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  WSL_DISTRO_ENV,
  callerDistro,
  callerPath,
  detectSide,
  drivePathOfMount,
  isDrivePath,
  powershellEnv,
  runCwd,
  tempDir,
  toLocal,
  uncPathOf,
  windowsPathOf,
  wslPathOf,
} from "./platform.js";

describe("the side this process runs on", () => {
  it("is windows on win32, wsl under a Microsoft kernel, linux otherwise", () => {
    expect(detectSide("win32", "10.0.26100")).toBe("windows");
    expect(detectSide("linux", "6.18.33.2-microsoft-standard-WSL2")).toBe("wsl");
    expect(detectSide("linux", "6.8.0-1015-azure")).toBe("linux");
    expect(detectSide("darwin", "24.0.0")).toBe("linux");
  });
});

describe("host paths", () => {
  it("maps a Windows drive path to its WSL mount, and back", () => {
    expect(wslPathOf("C:\\aras_installations")).toBe("/mnt/c/aras_installations");
    expect(wslPathOf("D:\\a\\b\\")).toBe("/mnt/d/a/b");
    expect(wslPathOf("C:/x/y")).toBe("/mnt/c/x/y");
    expect(() => wslPathOf("\\\\server\\share")).toThrow(/not a Windows drive path/);
    expect(drivePathOfMount("/mnt/c/aras_installations/slots")).toBe("C:\\aras_installations\\slots");
    expect(drivePathOfMount("/mnt/d")).toBe("D:\\");
    expect(drivePathOfMount("/home/me/x")).toBeUndefined();
    expect(drivePathOfMount("/mnt/cd/x")).toBeUndefined();
  });

  it("opens a Windows path as itself natively, and through /mnt from WSL or Linux", () => {
    expect(toLocal("C:\\aras_installations\\staging", "windows")).toBe("C:\\aras_installations\\staging");
    expect(toLocal("C:/aras_installations/staging", "windows")).toBe("C:\\aras_installations\\staging");
    expect(toLocal("C:\\aras_installations\\staging", "wsl")).toBe("/mnt/c/aras_installations/staging");
    expect(toLocal("C:\\aras_installations", "linux")).toBe("/mnt/c/aras_installations");
    expect(() => toLocal("relative\\x", "windows")).toThrow(/not a Windows drive path/);
    expect(isDrivePath("c:\\x")).toBe(true);
    expect(isDrivePath("\\\\wsl.localhost\\Ubuntu\\x")).toBe(false);
  });

  it("names a WSL path through \\\\wsl.localhost", () => {
    expect(uncPathOf("/home/me/work/../code", "Ubuntu")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\code");
    expect(uncPathOf("/", "Ubuntu-24.04")).toBe("\\\\wsl.localhost\\Ubuntu-24.04");
    expect(() => uncPathOf("/x", "..\\evil")).toThrow(/not a WSL distribution name/);
    expect(() => uncPathOf("rel", "Ubuntu")).toThrow(/not an absolute path/);
  });

  it("reads the launcher's distribution only on Windows, and only a plain name", () => {
    expect(callerDistro({ [WSL_DISTRO_ENV]: "Ubuntu" }, "windows")).toBe("Ubuntu");
    expect(callerDistro({ [WSL_DISTRO_ENV]: "Ubuntu" }, "wsl")).toBeUndefined();
    expect(callerDistro({ [WSL_DISTRO_ENV]: "a\\b" }, "windows")).toBeUndefined();
    expect(callerDistro({}, "windows")).toBeUndefined();
  });
});

describe("a path the caller gave", () => {
  it("natively: a drive path is itself, anything else is relative to the working folder", () => {
    const o = { side: "windows" as const, cwd: "C:\\work", env: {} };
    expect(callerPath("D:\\backups\\a.bak", o)).toBe("D:\\backups\\a.bak");
    expect(callerPath("D:/backups/a.bak", o)).toBe("D:\\backups\\a.bak");
    expect(callerPath("out\\code", o)).toBe("C:\\work\\out\\code");
    expect(callerPath("..\\x", o)).toBe("C:\\x");
  });

  it("from the WSL launcher: /mnt/<d> is the drive, any other POSIX path is read through \\\\wsl.localhost", () => {
    const o = { side: "windows" as const, cwd: "\\\\wsl.localhost\\Ubuntu\\home\\me", env: { [WSL_DISTRO_ENV]: "Ubuntu" } };
    expect(callerPath("/mnt/c/Users/me/a.bak", o)).toBe("C:\\Users\\me\\a.bak");
    expect(callerPath("/home/me/out/code", o)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\out\\code");
    expect(callerPath("code", o)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\code");
    expect(callerPath("C:\\work\\x", o)).toBe("C:\\work\\x");
  });

  it("in WSL: a drive path goes through its mount, anything else from the working folder", () => {
    const o = { side: "wsl" as const, cwd: "/home/me", env: {} };
    expect(callerPath("C:\\work\\out", o)).toBe("/mnt/c/work/out");
    expect(callerPath("rel", o)).toBe("/home/me/rel");
    expect(callerPath("/abs/x", o)).toBe("/abs/x");
  });
});

describe("Windows tools from this process", () => {
  it("start Windows PowerShell without the PSModulePath a PowerShell 7 parent leaves, whatever its case", () => {
    const env = { PATH: "C:\\x", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules", psmodulepath: "y", SystemRoot: "C:\\Windows" };
    expect(powershellEnv(env)).toEqual({ PATH: "C:\\x", SystemRoot: "C:\\Windows" });
    expect(env.PSModulePath).toBeDefined();
  });

  it("start in no particular folder natively", () => {
    expect(runCwd("windows")).toBeUndefined();
  });

  it("find the Windows temp folder: os.tmpdir() natively, %TEMP% through cmd.exe from WSL", async () => {
    expect(await tempDir("windows", async () => Promise.reject(new Error("no cmd.exe")))).toBe(tmpdir());
    const calls: string[] = [];
    const run = async (file: string) => {
      calls.push(file);
      return "C:\\Users\\me\\AppData\\Local\\Temp\r\n";
    };
    expect(await tempDir("wsl", run)).toBe("/mnt/c/Users/me/AppData/Local/Temp");
    expect(calls).toEqual(["cmd.exe"]);
    await expect(tempDir("wsl", async () => "%TEMP%\r\n")).rejects.toThrow(/Windows temp folder/);
  });

  it("name a local path as Windows does: itself natively, wslpath -w from WSL", async () => {
    expect(await windowsPathOf("C:\\x\\setup-host.ps1", "windows", async () => Promise.reject(new Error("no wslpath")))).toBe("C:\\x\\setup-host.ps1");
    const run = async (file: string, args: string[]) => (file === "wslpath" && args[0] === "-w" ? `C:\\x\\${args[1]?.split("/").at(-1)}\n` : "");
    expect(await windowsPathOf("/mnt/c/x/setup-host.ps1", "wsl", run)).toBe("C:\\x\\setup-host.ps1");
  });
});
