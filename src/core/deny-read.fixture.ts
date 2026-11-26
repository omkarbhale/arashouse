// Takes a folder's read access away from this user for a test, and gives it back: `chmod 0` on Linux; on Windows,
// where a mode is not access, a deny entry for the user in the folder's ACL (`icacls /deny`), which holds even for an
// administrator.

import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { userInfo } from "node:os";

function windowsUser(): string {
  const domain = process.env.USERDOMAIN?.trim();
  const name = userInfo().username;
  return domain ? `${domain}\\${name}` : name;
}

export function denyRead(path: string): void {
  if (process.platform === "win32") execFileSync("icacls", [path, "/deny", `${windowsUser()}:(OI)(CI)(RX)`], { stdio: "ignore", windowsHide: true });
  else chmodSync(path, 0o000);
}

export function allowRead(path: string, mode = 0o700): void {
  if (process.platform === "win32") execFileSync("icacls", [path, "/remove:d", windowsUser()], { stdio: "ignore", windowsHide: true });
  else chmodSync(path, mode);
}
