// Logging in to an Aras server and changing a User's password through it, from the Windows side, where
// `localhost` is IIS. Both the baseline build's login check (ticket 24) and the per-lease credentials (ticket 34)
// use it. The login is an OAuth password grant as the Aras clients make it (`client_id` `IOMApp`, the password as
// its MD5 hex). A password is changed by an AML `edit` of the `User` item through the server, as `root`: spike 06
// found that writing an MD5 into `[USER].password` in SQL is refused, so it goes through the server or not at all.
//
// Secrets: a password reaches the server only as its MD5 hex, in a request body; the token only in the
// `Authorization` header. Neither is in a URL, an argument list, a log line or an answer's `detail`, which is the
// server's refusal (redacted, capped) or a connection error.

import { createHash } from "node:crypto";
import { redact } from "../core/redact.js";
import { Secret } from "../core/secret.js";

/** A first request to a cold slot takes up to 41 s (design 8.3); a login and an edit are a few requests. */
export const ARAS_HTTP_TIMEOUT_MS = 120_000;

/**
 * What a login or an edit answers: `ok`, or why not. `refused` is the server saying no, not a server that did not answer.
 * `timedOut` is a server too slow to answer: no answer within the bound, or the server's own call cancelled on its timeout.
 */
export type ArasAnswer =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly refused: boolean; readonly detail: string; readonly timedOut?: boolean };

export interface ArasHttpOptions {
  /** The base URL of an application alias; the default is `http://localhost/<alias>`. Tests point it at a local server. */
  readonly base?: (alias: string) => string;
  readonly timeoutMs?: number;
}

/** The password as the Aras clients send it: the lower-case MD5 hex of its UTF-8 bytes. */
function md5Hex(password: Secret): string {
  const hex = createHash("md5").update(password.reveal(), "utf8").digest("hex");
  // The MD5 logs in as well as the password does, so it is made a secret too: `redact` then replaces it.
  Secret.of(hex, password.kind);
  return hex;
}

function failure(err: unknown, timeoutMs: number): ArasAnswer {
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  return timedOut ? { ok: false, refused: false, detail: `no answer in ${timeoutMs / 1000} s`, timedOut } : { ok: false, refused: false, detail: "connection failed" };
}

/**
 * The OAuth server's answer when its own call to the Innovator server was cut off by .NET's timeout (100 s by default):
 * on a loaded host, `12sp9`'s token endpoint answered `The operation was canceled.` after 100 s (ticket 38). The server
 * did not refuse the password; it did not get to it.
 */
const CANCELLED = /^(?:The operation was canceled|A task was canceled)\.?$/;

const capped = (text: string): string => redact(text).slice(0, 300);

/** A `User` login name the edit may name: the edit is built as text, so only plain names are accepted. */
const LOGIN_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export interface ArasHttp {
  /** An OAuth password grant as `user`; the token is returned only to `setPasswords`, never to a caller. */
  login(alias: string, database: string, user: string, password: Secret): Promise<ArasAnswer>;
  /** Logged in as `as.user`, an AML `edit` of the password of each User in `logins`, in order, to `next`. */
  setPasswords(alias: string, database: string, as: { readonly user: string; readonly password: Secret }, logins: readonly string[], next: Secret): Promise<ArasAnswer>;
}

export function arasHttp(options: ArasHttpOptions = {}): ArasHttp {
  const base = options.base ?? ((alias: string) => `http://localhost/${alias}`);
  const timeoutMs = options.timeoutMs ?? ARAS_HTTP_TIMEOUT_MS;

  const grant = async (alias: string, database: string, user: string, password: Secret): Promise<{ token: Secret } | ArasAnswer> => {
    const body = new URLSearchParams({ grant_type: "password", scope: "Innovator", client_id: "IOMApp", username: user, password: md5Hex(password), database });
    try {
      const res = await fetch(`${base(alias)}/OAuthServer/connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: { access_token?: unknown; error?: unknown; error_description?: unknown } = {};
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        // Not JSON: reported by status below.
      }
      // The token is wrapped at once, so `redact` replaces it wherever it would appear.
      if (res.ok && typeof json.access_token === "string" && json.access_token.length > 0) return { token: Secret.of(json.access_token, "aras-login") };
      // The server's refusal names the cause (a missing licence, a wrong password), never the password.
      const why = typeof json.error === "string" ? `${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
      if (typeof json.error_description === "string" && CANCELLED.test(json.error_description.trim())) {
        return { ok: false, refused: false, detail: capped(why), timedOut: true };
      }
      // A 4xx is the server saying no; a 5xx or a page that is not the token endpoint's is a server not ready.
      return { ok: false, refused: res.status >= 400 && res.status < 500, detail: capped(why) };
    } catch (err) {
      return failure(err, timeoutMs);
    }
  };

  const applyItem = async (alias: string, token: Secret, item: string): Promise<ArasAnswer> => {
    const envelope = `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ApplyItem>${item}</ApplyItem></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    try {
      const res = await fetch(`${base(alias)}/Server/InnovatorServer.aspx`, {
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: "ApplyItem", authorization: `Bearer ${token.reveal()}` },
        body: envelope,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const fault = /<faultstring>([^<]{0,200})/.exec(text);
      if (fault) return { ok: false, refused: true, detail: capped(fault[1]!) };
      if (res.ok && /<Result/.test(text)) return { ok: true, detail: "edited" };
      return { ok: false, refused: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return failure(err, timeoutMs);
    }
  };

  return {
    async login(alias, database, user, password) {
      const answer = await grant(alias, database, user, password);
      return "token" in answer ? { ok: true, detail: "token issued" } : answer;
    },
    async setPasswords(alias, database, as, logins, next) {
      for (const login of logins) if (!LOGIN_NAME.test(login)) throw new Error(`"${login.slice(0, 32)}" is not a login name the edit may name`);
      const answer = await grant(alias, database, as.user, as.password);
      if (!("token" in answer)) return answer;
      const hex = md5Hex(next);
      for (const login of logins) {
        const edited = await applyItem(alias, answer.token, `<Item type="User" action="edit" where="[User].login_name='${login}'"><password>${hex}</password></Item>`);
        if (!edited.ok) return { ...edited, detail: `edit of ${login}: ${edited.detail}` };
      }
      return { ok: true, detail: `edited ${logins.join(" and ")}` };
    },
  };
}
