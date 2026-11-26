import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXPECTED_SIDS, homeAccess, homeAclScript } from "./home-access.js";

const dir = mkdtempSync(join(tmpdir(), "arashouse-home-access-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("who can open the state home", () => {
  it("is nobody for a home not made yet", async () => {
    expect(await homeAccess(join(dir, "absent"))).toEqual({ home: join(dir, "absent"), others: [], missing: true });
  });

  it.skipIf(process.platform === "win32")("off Windows, is the mode's group and others", async () => {
    await chmod(dir, 0o700);
    expect((await homeAccess(dir)).others).toEqual([]);
    await chmod(dir, 0o750);
    expect((await homeAccess(dir)).others).toEqual(["its group or others (mode 0750)"]);
    await chmod(dir, 0o700);
  });

  it("on Windows, asks for the ACL by SID and names what is left beyond the user, SYSTEM and the administrators", async () => {
    let asked = "";
    const access = await homeAccess(dir, {
      platform: "win32",
      run: async (script) => {
        asked = script;
        return "BUILTIN\\Users\r\nNT AUTHORITY\\Authenticated Users\r\n";
      },
    });
    expect(access.others).toEqual(["BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users"]);
    expect(asked).toContain("Get-Acl -LiteralPath $path");
    for (const sid of EXPECTED_SIDS) expect(asked).toContain(`'${sid}'`);
    expect(homeAclScript("C:\\it's\\here")).toContain("$path = 'C:\\it''s\\here'");
  });

  // The real ACL, set here: the user's, SYSTEM's and the administrators' only (as %LOCALAPPDATA% is), then also the Users'.
  it.skipIf(process.platform !== "win32")("on Windows, reads the real ACL: the user's alone, then one granted to Users", async () => {
    const home = join(dir, "acl-home");
    mkdirSync(home);
    const me = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${userInfo().username}`;
    const icacls = (...args: string[]) => execFileSync("icacls", [home, ...args], { stdio: "ignore", windowsHide: true });
    icacls("/inheritance:r", "/grant:r", `${me}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F");
    expect((await homeAccess(home)).others).toEqual([]);
    icacls("/grant", "*S-1-5-32-545:(OI)(CI)RX");
    expect((await homeAccess(home)).others).toEqual([expect.stringMatching(/\\Users$/)]);
  });
});
