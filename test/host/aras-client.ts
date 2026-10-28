// A small Aras client for the host e2e (tickets 35 and 36), from WSL, as a leaseholder's tools reach a slot: an OAuth
// password or refresh-token grant, AML through `InnovatorServer.aspx`, and a file upload to the slot's vault. The
// password and the tokens are Secrets, so `redact` replaces them anywhere they would appear; only the server's own
// words come back.

import { createHash, randomBytes } from "node:crypto";
import { redact } from "../../src/core/redact.js";
import { Secret } from "../../src/core/secret.js";

const TIMEOUT_MS = 180_000;

/** A login's answer; `refreshToken` only when the grant asked for `offline_access` and the server issued one. */
export type Login = { readonly ok: true; readonly token: Secret; readonly refreshToken?: Secret } | { readonly ok: false; readonly detail: string };

/** An Aras item id: 32 upper-case hex digits. */
export function newItemId(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

/** Text for an XML element's content. */
export function xmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface AmlAnswer {
  readonly ok: boolean;
  /** The whole response body, for a caller that reads items out of it; redacted. */
  readonly body: string;
  /** The fault string when the server answered a fault. */
  readonly fault?: string;
}

export class ArasClient {
  constructor(
    readonly url: string,
    readonly database: string,
  ) {}

  /**
   * An OAuth password grant as the Aras clients make it (`IOMApp`, the password as its MD5 hex). `scope` adds to
   * `Innovator`: `offline_access` asks for a refresh token, which 14.x's OAuth server keeps in its SQLite file.
   */
  async login(user: string, password: Secret, scope = ""): Promise<Login> {
    const md5 = Secret.of(createHash("md5").update(password.reveal(), "utf8").digest("hex"), "aras-login");
    return this.grant({ grant_type: "password", scope: `Innovator${scope ? ` ${scope}` : ""}`, client_id: "IOMApp", username: user, password: md5.reveal(), database: this.database });
  }

  /** An OAuth refresh-token grant: a new access token for a refresh token an earlier login was issued. */
  async refresh(refreshToken: Secret): Promise<Login> {
    return this.grant({ grant_type: "refresh_token", client_id: "IOMApp", refresh_token: refreshToken.reveal() });
  }

  private async grant(fields: Record<string, string>): Promise<Login> {
    const body = new URLSearchParams(fields);
    let res: Response;
    try {
      res = await fetch(`${this.url}/OAuthServer/connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      return { ok: false, detail: `no answer: ${(err as Error).message}` };
    }
    const text = await res.text();
    let json: { access_token?: unknown; refresh_token?: unknown; error?: unknown; error_description?: unknown } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // Not JSON: reported by status.
    }
    if (res.ok && typeof json.access_token === "string" && json.access_token.length > 0) {
      const refreshToken = typeof json.refresh_token === "string" && json.refresh_token.length > 0 ? Secret.of(json.refresh_token, "aras-login") : undefined;
      return { ok: true, token: Secret.of(json.access_token, "aras-login"), ...(refreshToken ? { refreshToken } : {}) };
    }
    const why = typeof json.error === "string" ? `${json.error}${typeof json.error_description === "string" ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
    return { ok: false, detail: redact(why).slice(0, 300) };
  }

  /** `ApplyItem` of `aml` (one `<Item>` or an `<AML>`), with the token as a bearer. */
  async apply(token: Secret, aml: string): Promise<AmlAnswer> {
    const envelope = `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ApplyItem>${aml}</ApplyItem></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    const res = await fetch(`${this.url}/Server/InnovatorServer.aspx`, {
      method: "POST",
      headers: { "content-type": "text/xml; charset=utf-8", SOAPAction: "ApplyItem", authorization: `Bearer ${token.reveal()}`, DATABASE: this.database },
      body: envelope,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return answer(res.status, await res.text());
  }

  /**
   * Adds a File with its content to the vault `vaultId`, as the 12.0 IOM's upload does: one multipart POST to the
   * vault server with the AML as `XMLdata` and the file as a part named by the File's id.
   */
  async upload(token: Secret, vaultId: string, fileName: string, content: Buffer): Promise<AmlAnswer & { readonly id: string }> {
    const id = newItemId();
    const aml =
      `<Item type="File" action="add" id="${id}"><filename>${xmlText(fileName)}</filename><file_size>${content.length}</file_size>` +
      `<Relationships><Item type="Located" action="add"><related_id>${vaultId}</related_id></Item></Relationships></Item>`;
    const envelope = `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ApplyItem>${aml}</ApplyItem></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    const form = new FormData();
    form.append("XMLdata", envelope);
    form.append(id, new Blob([content]), fileName);
    const res = await fetch(`${this.url}/Vault/VaultServer.aspx`, {
      method: "POST",
      headers: { SOAPACTION: "ApplyItem", authorization: `Bearer ${token.reveal()}`, DATABASE: this.database },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ...answer(res.status, await res.text()), id };
  }
}

function answer(status: number, text: string): AmlAnswer {
  const body = redact(text);
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(body);
  if (fault) return { ok: false, body, fault: fault[1]!.replace(/\s+/g, " ").slice(0, 400) };
  if (status >= 200 && status < 300 && /<Result/.test(body)) return { ok: true, body };
  return { ok: false, body, fault: `HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 400)}` };
}

/** Whether a fault is the server's "no items found" answer to a `get`. */
export function isNoItems(answer: AmlAnswer): boolean {
  return !answer.ok && /No items of type/i.test(answer.fault ?? "");
}
