import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Secret } from "../core/secret.js";
import { arasHttp, parseUsers, shown, type ArasHttp } from "./aras-http.js";

const md5 = (text: string) => createHash("md5").update(text, "utf8").digest("hex");
// Built from parts, so no literal in the repo is a password a grep could match by accident.
const CURRENT = ["cur", "Root", "Pw", "77"].join("-");
const NEXT = ["next", "Lease", "Pw", "42"].join("_");
const TOKEN = ["tok", "en", "Zq81x"].join("-");

interface Seen {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

let server: Server;
let base: string;
let seen: Seen[];
/** How the fake server answers each request; the default is a token for `root` with CURRENT, and a Result for an edit. */
let respond: (req: Seen, res: ServerResponse) => void;

function defaultRespond(req: Seen, res: ServerResponse): void {
  if (req.url.endsWith("/OAuthServer/connect/token")) {
    const form = new URLSearchParams(req.body);
    const ok = form.get("username") === "root" && form.get("password") === md5(CURRENT) && form.get("database") === "arashouse_12sp9_01";
    res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { access_token: TOKEN, token_type: "Bearer" } : { error: "invalid_grant", error_description: "Authentication failed" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/xml" });
  res.end("<SOAP-ENV:Envelope><SOAP-ENV:Body><ApplyItemResponse><Result><Item type=\"User\"/></Result></ApplyItemResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>");
}

let aras: ArasHttp;

beforeEach(async () => {
  seen = [];
  respond = defaultRespond;
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (d: string) => (body += d));
    req.on("end", () => {
      const entry = { url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  aras = arasHttp({ base: (alias) => `${base}/${alias}`, timeoutMs: 5_000 });
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const secret = (value: string) => Secret.of(value, "aras-login");

describe("login", () => {
  it("is an OAuth password grant with the password's MD5 as the Aras clients send it", async () => {
    expect(await aras.login("ah-12sp9-01", "arashouse_12sp9_01", "root", secret(CURRENT))).toEqual({ ok: true, detail: "token issued" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/ah-12sp9-01/OAuthServer/connect/token");
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      grant_type: "password",
      scope: "Innovator",
      client_id: "IOMApp",
      username: "root",
      password: md5(CURRENT),
      database: "arashouse_12sp9_01",
    });
    expect(seen[0]!.body).not.toContain(CURRENT);
  });

  it("a refusal is the server's own words; a 5xx or no answer is not a refusal", async () => {
    expect(await aras.login("ah-12sp9-01", "arashouse_12sp9_01", "root", secret(NEXT))).toEqual({ ok: false, refused: true, detail: "invalid_grant: Authentication failed" });
    respond = (_req, res) => {
      res.writeHead(503);
      res.end("Service Unavailable");
    };
    expect(await aras.login("ah-12sp9-01", "arashouse_12sp9_01", "root", secret(CURRENT))).toEqual({ ok: false, refused: false, detail: "HTTP 503" });
    await new Promise((resolve) => server.close(resolve));
    expect(await aras.login("ah-12sp9-01", "arashouse_12sp9_01", "root", secret(CURRENT))).toEqual({ ok: false, refused: false, detail: "connection failed" });
    server.listen(0);
  });

  it("a server too slow to answer is timed out, not refused: no answer in the bound, or the server's own call cancelled", async () => {
    // 12sp9's token endpoint on a loaded host (ticket 38): .NET cut its call to the Innovator server off at 100 s.
    respond = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "The operation was canceled." }));
    };
    expect(await aras.login("ah-12sp9-01", "arashouse_12sp9_01", "root", secret(CURRENT))).toEqual({
      ok: false,
      refused: false,
      detail: "invalid_grant: The operation was canceled.",
      timedOut: true,
    });
    respond = () => undefined;
    const slow = arasHttp({ base: (alias) => `${base}/${alias}`, timeoutMs: 200 });
    expect(await slow.login("ah-12sp9-01", "arashouse_12sp9_01", "root", secret(CURRENT))).toEqual({ ok: false, refused: false, detail: "no answer in 0.2 s", timedOut: true });
    expect(await slow.setPasswords("ah-12sp9-01", "arashouse_12sp9_01", { user: "root", password: secret(CURRENT) }, ["root"], secret(NEXT))).toMatchObject({ ok: false, timedOut: true });
    server.closeAllConnections();
  });
});

describe("setPasswords", () => {
  it("logs in, then edits each User's password to the new one's MD5 with the token as a bearer", async () => {
    const answer = await aras.setPasswords("ah-12sp9-01", "arashouse_12sp9_01", { user: "root", password: secret(CURRENT) }, ["admin", "root"], Secret.of(NEXT, "lease-password"));
    expect(answer).toEqual({ ok: true, detail: "edited admin and root" });
    expect(seen.map((s) => s.url)).toEqual(["/ah-12sp9-01/OAuthServer/connect/token", "/ah-12sp9-01/Server/InnovatorServer.aspx", "/ah-12sp9-01/Server/InnovatorServer.aspx"]);
    for (const [i, login] of [[1, "admin"], [2, "root"]] as const) {
      const edit = seen[i]!;
      expect(edit.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(edit.headers.soapaction).toBe("ApplyItem");
      expect(edit.body).toContain(`<Item type="User" action="edit" where="[User].login_name='${login}'"><password>${md5(NEXT)}</password></Item>`);
      expect(edit.body).not.toContain(NEXT);
    }
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it("stops at a refused login, and at the first edit the server faults, naming it", async () => {
    const wrong = await aras.setPasswords("ah-12sp9-01", "arashouse_12sp9_01", { user: "root", password: secret(NEXT) }, ["admin", "root"], secret(CURRENT));
    expect(wrong).toEqual({ ok: false, refused: true, detail: "invalid_grant: Authentication failed" });
    expect(seen).toHaveLength(1);

    seen = [];
    respond = (req, res) => {
      if (req.url.endsWith("/token")) return defaultRespond(req, res);
      res.writeHead(500, { "content-type": "text/xml" });
      res.end(`<SOAP-ENV:Envelope><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>SOAP-ENV:Server</faultcode><faultstring>No items of type User found.</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`);
    };
    const faulted = await aras.setPasswords("ah-12sp9-01", "arashouse_12sp9_01", { user: "root", password: secret(CURRENT) }, ["admin", "root"], secret(NEXT));
    expect(faulted).toEqual({ ok: false, refused: true, detail: "edit of admin: No items of type User found." });
    expect(seen).toHaveLength(2);
  });

  it("refuses a login name it would have to quote", async () => {
    await expect(aras.setPasswords("ah-12sp9-01", "arashouse_12sp9_01", { user: "root", password: secret(CURRENT) }, ["admin' or 1=1 or '"], secret(NEXT))).rejects.toThrow(
      /is not a login name the edit may name/,
    );
    expect(seen).toEqual([]);
  });
});

/** A `get` result of Users as an Aras server writes one, ids upper-case hex. */
function usersResult(users: readonly [string, string][]): string {
  const items = users.map(([id, login]) => `<Item type="User" typeId="45E899CD2859442982EB22BB2DF683E5" id="${id}"><id keyed_name="${login}" type="User">${id}</id><login_name>${login}</login_name></Item>`);
  return `<SOAP-ENV:Envelope><SOAP-ENV:Body><Result>${items.join("")}</Result></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

const IDS = { root: "AD30A6D8D3B642F5A2AFED1A4B02BEFA", admin: "30B991F927274FA3829655F50C99472E", vadmin: "EB2D5AA617FB41A28F081345B8B5FECB", job: "F5AEED2324574DB9A45C0779A42680CE" };

describe("rekeyUsers", () => {
  it("lists the Users that may log in, and edits each but those kept by its id, each to a password of its own", async () => {
    respond = (req, res) => {
      if (req.url.endsWith("/token") || !req.body.includes('action="get"')) return defaultRespond(req, res);
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(usersResult([[IDS.admin, "admin"], [IDS.root, "root"], [IDS.vadmin, "vadmin"], [IDS.job, "JobAgentUser"]]));
    };
    const made: string[] = [];
    const fresh = () => {
      const value = ["fresh", made.length, "Pw"].join("-");
      made.push(value);
      return Secret.of(value, "aras-login");
    };
    const answer = await aras.rekeyUsers("ah-35-01", "arashouse_12sp9_01", { user: "root", password: secret(CURRENT) }, ["ADMIN", "root"], fresh);
    expect(answer).toEqual({ ok: true, detail: "edited vadmin, JobAgentUser", logins: ["vadmin", "JobAgentUser"] });
    expect(seen.map((s) => s.url)).toEqual(["/ah-35-01/OAuthServer/connect/token", ...Array(3).fill("/ah-35-01/Server/InnovatorServer.aspx")]);
    expect(seen[1]!.body).toContain(`<ApplyItem><Item type="User" action="get" select="login_name"><logon_enabled>1</logon_enabled></Item></ApplyItem>`);
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(made).toHaveLength(2);
    for (const [i, id] of [IDS.vadmin, IDS.job].entries()) {
      const edit = seen[i + 2]!;
      expect(edit.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(edit.body).toContain(`<Item type="User" action="edit" id="${id}"><password>${md5(made[i]!)}</password></Item>`);
      expect(edit.body).not.toContain(made[i]);
    }
    expect(JSON.stringify(answer)).not.toMatch(/fresh-/);
  });

  it("stops at a refused login, a faulted list, a list without the user logged in as, an id that is not one, and a faulted edit", async () => {
    const as = { user: "root", password: secret(CURRENT) };
    const fresh = () => secret(NEXT);
    expect(await aras.rekeyUsers("ah-12sp9-01", "arashouse_12sp9_01", { user: "root", password: secret(NEXT) }, ["root"], fresh)).toEqual({
      ok: false,
      refused: true,
      detail: "invalid_grant: Authentication failed",
    });

    let list = "";
    let editFault = false;
    respond = (req, res) => {
      if (req.url.endsWith("/token")) return defaultRespond(req, res);
      const get = req.body.includes('action="get"');
      if ((get && list === "fault") || (!get && editFault)) {
        res.writeHead(500, { "content-type": "text/xml" });
        res.end(`<SOAP-ENV:Envelope><SOAP-ENV:Body><SOAP-ENV:Fault><faultstring>Access denied</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`);
        return;
      }
      if (!get) return defaultRespond(req, res);
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(list);
    };
    list = "fault";
    expect(await aras.rekeyUsers("ah-12sp9-01", "arashouse_12sp9_01", as, ["root"], fresh)).toEqual({ ok: false, refused: true, detail: "the list of Users that may log in: Access denied" });
    list = usersResult([[IDS.vadmin, "vadmin"]]);
    expect(await aras.rekeyUsers("ah-12sp9-01", "arashouse_12sp9_01", as, ["root"], fresh)).toEqual({ ok: false, refused: false, detail: "the list of Users that may log in does not name root" });
    list = usersResult([[IDS.root, "root"], ["' or 1=1 or '", "vadmin"]]);
    seen = [];
    expect(await aras.rekeyUsers("ah-12sp9-01", "arashouse_12sp9_01", as, ["root"], fresh)).toEqual({ ok: false, refused: false, detail: "the list of Users that may log in has an id that is not one" });
    expect(seen).toHaveLength(2);
    list = usersResult([[IDS.root, "root"], [IDS.vadmin, "vadmin"]]);
    editFault = true;
    expect(await aras.rekeyUsers("ah-12sp9-01", "arashouse_12sp9_01", as, ["root"], fresh)).toEqual({ ok: false, refused: true, detail: "edit of vadmin: Access denied" });
    editFault = false;
    list = usersResult([[IDS.root, "root"]]);
    expect(await aras.rekeyUsers("ah-12sp9-01", "arashouse_12sp9_01", as, ["root"], fresh)).toEqual({ ok: true, detail: "no other User may log in", logins: [] });
  });
});

describe("parseUsers and shown", () => {
  it("reads each User's id and login name, unescaped, and skips items that are not Users", () => {
    const xml = `<Result><Item type="User" id="${IDS.root}"><login_name>root</login_name></Item><Item type="Identity" id="${IDS.admin}"><login_name>x</login_name></Item><Item id="${IDS.vadmin}" type="User"><login_name>a&amp;b&lt;c</login_name></Item><Item type="User" id="${IDS.job}"></Item></Result>`;
    expect(parseUsers(xml)).toEqual([
      { id: IDS.root, login: "root" },
      { id: IDS.vadmin, login: "a&b<c" },
    ]);
  });

  it("quotes a plain login name whole, and any other only as a printable, capped label", () => {
    expect(shown("JobAgentUser")).toBe("JobAgentUser");
    expect(shown("a&b<c")).toBe('a User named "a&b<c"');
    expect(shown("x\u0000\ny")).toBe('a User named "x??y"');
  });
});
