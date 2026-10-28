// One anonymous HTTP GET, for the WSL-side address discovery and slot probe. It never throws: a
// refusal, a reset or a timeout comes back as `error`. Redirects are not followed, so a slot that
// redirects cannot lead the probe to another host, and a body is read only when asked for, capped.

/** First call to a slot after idle: cold starts took up to 41.5 s (design 8.3). */
export const COLD_TIMEOUT_MS = 60_000;
/** A slot that has already answered in this process. */
export const WARM_TIMEOUT_MS = 5_000;

const MAX_BODY_BYTES = 64 * 1024;

export interface HttpAnswer {
  /** The HTTP status, absent when nothing answered. */
  readonly status?: number;
  /** Wall-clock milliseconds until the answer (or the failure). */
  readonly ms: number;
  /** The body, only when requested, truncated at 64 KiB. */
  readonly body?: string;
  /** Why nothing answered: a timeout or a connection error code. Never a response body. */
  readonly error?: string;
  /** Nothing answered within `timeoutMs` (as against a refused or reset connection). */
  readonly timedOut?: boolean;
}

export interface GetOptions {
  readonly timeoutMs: number;
  readonly readBody?: boolean;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function errorText(err: unknown, timeoutMs: number): string {
  if (isTimeout(err)) return `timed out after ${timeoutMs} ms`;
  const cause = err instanceof Error ? err.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `connection failed (${code})` : "connection failed";
}

async function readCapped(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8");
}

/** GET `url` with no credentials and no cookies. */
export async function anonymousGet(url: string, options: GetOptions): Promise<HttpAnswer> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (options.readBody && res.body) {
      const body = await readCapped(res.body);
      return { status: res.status, ms: elapsed(), body };
    }
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, ms: elapsed() };
  } catch (err) {
    return { ms: elapsed(), error: errorText(err, options.timeoutMs), ...(isTimeout(err) ? { timedOut: true } : {}) };
  }
}
