// A fake of the slots' Aras servers for the per-lease credential tests (ticket 34): each slot's users have a password,
// a login with the right one answers ok, and an edit as a logged-in user changes them. Its Users that may log in are
// the golden's (`vadmin` and `authadmin` besides `root` and `admin`, ticket 57) unless a test says otherwise. It keeps
// the passwords as text, which only test code may do (test/reveal-allowlist.test.ts scans `src/` only).

import type { ArasAnswer, ArasHttp, RekeyAnswer } from "../src/broker/aras-http.js";
import type { Secret } from "../src/core/secret.js";

/** The password every slot's users have before anything sets one, standing for the golden's shipped password. */
export const SHIPPED = "shipped-golden-password";

export class FakeAras implements ArasHttp {
  /** Passwords by `<alias> <login>`. */
  readonly passwords = new Map<string, string>();
  /** Every call, as `login <alias> <user>`, `edit <alias> <login>` or `list <alias>`. */
  readonly calls: string[] = [];
  /** The Users that may log in, on every slot. */
  logonUsers: string[] = ["root", "admin", "vadmin", "authadmin"];
  /** Makes the next edit answer this instead. */
  editAnswer: ArasAnswer | undefined;
  /** Makes every login answer this instead (a server that does not answer). */
  loginAnswer: ArasAnswer | undefined;

  password(alias: string, login: string): string {
    return this.passwords.get(`${alias} ${login}`) ?? SHIPPED;
  }

  set(alias: string, login: string, password: string): void {
    this.passwords.set(`${alias} ${login}`, password);
  }

  /** Whether `user` of the slot at `alias` logs in with `password`. */
  logsIn(alias: string, user: string, password: string): boolean {
    return this.password(alias, user) === password;
  }

  async login(alias: string, _database: string, user: string, password: Secret): Promise<ArasAnswer> {
    this.calls.push(`login ${alias} ${user}`);
    if (this.loginAnswer) return this.loginAnswer;
    return this.logsIn(alias, user, password.reveal()) ? { ok: true, detail: "token issued" } : { ok: false, refused: true, detail: "invalid_grant: Authentication failed" };
  }

  async setPasswords(alias: string, database: string, as: { readonly user: string; readonly password: Secret }, logins: readonly string[], next: Secret): Promise<ArasAnswer> {
    const login = await this.login(alias, database, as.user, as.password);
    if (!login.ok) return login;
    for (const name of logins) {
      this.calls.push(`edit ${alias} ${name}`);
      if (this.editAnswer) {
        const answer = this.editAnswer;
        this.editAnswer = undefined;
        if (!answer.ok) return answer;
      }
      this.set(alias, name, next.reveal());
    }
    return { ok: true, detail: `edited ${logins.join(" and ")}` };
  }

  async rekeyUsers(alias: string, database: string, as: { readonly user: string; readonly password: Secret }, keep: readonly string[], fresh: () => Secret): Promise<RekeyAnswer> {
    const login = await this.login(alias, database, as.user, as.password);
    if (!login.ok) return login;
    this.calls.push(`list ${alias}`);
    const kept = new Set(keep.map((k) => k.toLowerCase()));
    const logins: string[] = [];
    for (const name of this.logonUsers.filter((u) => !kept.has(u.toLowerCase()))) {
      this.calls.push(`edit ${alias} ${name}`);
      if (this.editAnswer) {
        const answer = this.editAnswer;
        this.editAnswer = undefined;
        if (!answer.ok) return answer;
      }
      this.set(alias, name, fresh().reveal());
      logins.push(name);
    }
    return { ok: true, detail: `edited ${logins.join(", ")}`, logins };
  }
}
