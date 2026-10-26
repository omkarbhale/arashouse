// A local HTTP server standing in for one slot, for the WSL-side address and probe tests (the
// HTTP counterpart of FakeHost; it serves no Aras code).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSlotOptions {
  /** The web alias the server answers under (the path's first segment). */
  alias: string;
  /** Database ids `DBList.aspx` lists. */
  databases?: string[];
  /** Status for every path; 200 by default. */
  status?: number;
  /** Per-path status overrides, keyed by the path after the alias (`/Client/`). */
  statuses?: Record<string, number>;
  /** Milliseconds every response is held back. Change it at any time. */
  delayMs?: number;
  /** A response body for error statuses, to prove it never reaches a probe result. */
  errorBody?: string;
}

export class FakeSlotServer {
  /** `127.0.0.1:<port>`: a host address with a port, as the tests pass it. */
  address = "";
  /** Every request path received, in order. */
  readonly requests: string[] = [];
  private server: Server | undefined;

  constructor(readonly options: FakeSlotOptions) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.address = `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? "/";
    this.requests.push(path);
    const respond = () => {
      const prefix = `/${this.options.alias}`;
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return send(res, 404, "");
      const rest = path.slice(prefix.length);
      const status = this.options.statuses?.[rest] ?? this.options.status ?? 200;
      if (status !== 200) return send(res, status, this.options.errorBody ?? "");
      if (rest === "/DBList.aspx") {
        const ids = (this.options.databases ?? []).map((d) => `<DB id="${d}" />`).join("");
        return send(res, 200, `<?xml version="1.0"?><DBList>${ids}</DBList>`);
      }
      send(res, 200, "ok");
    };
    const delay = this.options.delayMs ?? 0;
    if (delay > 0) setTimeout(respond, delay);
    else respond();
  }
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}

/** A localhost port nothing listens on (connections are refused). */
export async function closedAddress(): Promise<string> {
  const server = new FakeSlotServer({ alias: "none" });
  await server.start();
  const address = server.address;
  await server.stop();
  return address;
}
