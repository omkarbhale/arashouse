// Reads an MSI's Property table through the Windows Installer COM object, via `powershell.exe`.
// Read-only and no administrator rights. The probe script emits every property NAME but the VALUE of
// only the three named in `MSI_VALUE_PROPERTIES`; a value of anything else (a key, a password, a
// licence, a path) never leaves PowerShell, so it cannot reach a log, a report or an argument list.

import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MsiProperties, MsiReader } from "../core/media-check.js";
import { SIDE, powershellEnv, runCwd, tempDir, windowsPathOf, type Side } from "./platform.js";

const execFileAsync = promisify(execFile);

/** The only properties whose values are read. Everything else is name-only. */
export const MSI_VALUE_PROPERTIES = ["ProductName", "Manufacturer", "ProductVersion"] as const;

export class MsiReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MsiReadError";
  }
}

/** The PowerShell that opens `windowsPath` read-only and prints one JSON object. */
export function buildMsiProbeScript(windowsPath: string): string {
  const quoted = `'${windowsPath.replace(/'/g, "''")}'`;
  const wanted = MSI_VALUE_PROPERTIES.map((n) => `'${n}'`).join(",");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$path = ${quoted}`,
    `$wanted = @(${wanted})`,
    "$installer = New-Object -ComObject WindowsInstaller.Installer",
    "$db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($path, 0))",
    "$view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @('SELECT `Property`, `Value` FROM `Property`'))",
    "$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null",
    "$names = New-Object System.Collections.Generic.List[string]",
    "$values = @{}",
    "while ($true) {",
    "  $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)",
    "  if ($null -eq $record) { break }",
    "  $name = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1))",
    "  $names.Add($name)",
    "  if ($wanted -contains $name) {",
    "    $values[$name] = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(2))",
    "  }",
    "}",
    "$view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null",
    "[pscustomobject]@{ names = @($names); values = $values } | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");
}

/** Parses the probe's output, keeping only the allowed value properties and string names. */
export function parseMsiProbeOutput(stdout: string): MsiProperties {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new MsiReadError("the Windows Installer probe printed something that is not JSON");
  }
  const raw = parsed as { names?: unknown; values?: Record<string, unknown> } | null;
  if (raw === null || typeof raw !== "object") throw new MsiReadError("the Windows Installer probe printed no object");
  const names = (Array.isArray(raw.names) ? raw.names : raw.names === undefined ? [] : [raw.names]).filter(
    (n): n is string => typeof n === "string" && n !== "",
  );
  if (names.length === 0) throw new MsiReadError("the MSI has no Property table rows (is it an Aras installer?)");
  const value = (key: (typeof MSI_VALUE_PROPERTIES)[number]): string | undefined => {
    const v = raw.values?.[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  return {
    names,
    productName: value("ProductName"),
    manufacturer: value("Manufacturer"),
    productVersion: value("ProductVersion"),
  };
}

export interface MsiReaderOptions {
  /** Runs a program and returns its stdout; replaced in tests. */
  run?: (file: string, args: string[]) => Promise<string>;
  /** Milliseconds before the probe is given up on. */
  timeoutMs?: number;
  /** A local folder on a Windows drive, where an MSI on the WSL filesystem is staged; defaults to the Windows temp folder. */
  windowsTemp?: string;
  /** Which side this process is; defaults to this process's. */
  side?: Side;
}

type Run = (file: string, args: string[]) => Promise<string>;

async function defaultRun(file: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    cwd: runCwd(),
    env: powershellEnv(),
  });
  return stdout;
}

/** The Windows temp folder as this process opens it (`os.tmpdir()` natively, `/mnt/c/Users/<you>/AppData/Local/Temp` from WSL). */
export async function windowsTempDir(run: Run = (file, args) => defaultRun(file, args, 30_000), side: Side = SIDE): Promise<string> {
  try {
    return await tempDir(side, run);
  } catch (err) {
    throw new MsiReadError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The real reader: the MSI's Windows path (`wslpath -w` from WSL), then `powershell.exe -EncodedCommand` for the probe.
 * Windows Installer cannot open a database over `\\wsl.localhost\`, so an MSI on the WSL filesystem is
 * copied to the Windows temp folder first and the copy removed afterwards.
 */
export function createMsiReader(options: MsiReaderOptions = {}): MsiReader {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const side = options.side ?? SIDE;
  const run: Run = options.run ?? ((file, args) => defaultRun(file, args, timeoutMs));
  const toWindows = async (path: string): Promise<string> => {
    try {
      return await windowsPathOf(path, side, run);
    } catch (cause) {
      throw new MsiReadError(
        `cannot turn ${path} into a Windows path with wslpath (${cause instanceof Error ? cause.message : String(cause)}); is this WSL?`,
      );
    }
  };
  return async (msiPath) => {
    let windowsPath = await toWindows(msiPath);
    let staged: string | null = null;
    try {
      if (windowsPath.startsWith("\\\\")) {
        staged = await mkdtemp(join(options.windowsTemp ?? (await windowsTempDir(run, side)), "arashouse-msi-"));
        const copy = join(staged, "InnovatorSetup.msi");
        await copyFile(msiPath, copy);
        windowsPath = await toWindows(copy);
      }
      const encoded = Buffer.from(buildMsiProbeScript(windowsPath), "utf16le").toString("base64");
      let stdout: string;
      try {
        stdout = await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-OutputFormat",
          "Text",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encoded,
        ]);
      } catch (cause) {
        // Not `cause.message`: Node puts the whole command line, with the encoded script, in it.
        const stderr = (cause as { stderr?: unknown }).stderr;
        const detail =
          typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim().split("\n")[0] : "powershell.exe failed";
        throw new MsiReadError(`powershell.exe could not read the Property table of ${msiPath}: ${detail}`);
      }
      return parseMsiProbeOutput(stdout);
    } finally {
      if (staged !== null) await rm(staged, { recursive: true, force: true });
    }
  };
}
