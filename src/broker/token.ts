// The broker's client token. Node cannot give a named pipe a DACL that names one user (it can only
// add Everyone), so the pipe is open to every local user and the broker also checks a token: 32
// random bytes, made fresh at each start and written to `<root>\broker\client.token`, a file only
// SYSTEM, the broker account and the worker user may read (ticket 21 sets the folder's ACL). The
// Windows-side client reads it and presents it; it never crosses to WSL, an argument list or a log.
// This file is the only one that reads the token's value (test/reveal-allowlist.test.ts).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Secret } from "../core/secret.js";
import { PROTOCOL_VERSION, encodeLine } from "./protocol.js";

const TOKEN_BYTES = 32;
const TOKEN_TEXT = /^[0-9a-f]{64}$/;

/** A new token for this start of the broker. */
export function newToken(): Secret {
  return Secret.of(randomBytes(TOKEN_BYTES).toString("hex"), "broker-token");
}

/** Writes the token file; the folder's ACL (ticket 21) decides who may read it. */
export async function writeTokenFile(file: string, token: Secret): Promise<void> {
  await writeFile(file, token.reveal(), { encoding: "utf8", mode: 0o600 });
}

/** The token from its file; throws when the file is missing, unreadable or not a token. */
export async function readTokenFile(file: string): Promise<Secret> {
  const text = (await readFile(file, "utf8")).trim();
  if (!TOKEN_TEXT.test(text)) throw new Error("the broker's token file does not hold a token");
  return Secret.of(text, "broker-token");
}

/** Whether `presented` is the token, compared in constant time. */
export function tokenMatches(token: Secret, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const expected = Buffer.from(token.reveal(), "utf8");
  const given = Buffer.from(presented, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The line the client writes to the pipe: the protocol version, the token and the request. */
export function envelopeLine(token: Secret, request: unknown, limit: number): string {
  return encodeLine({ v: PROTOCOL_VERSION, token: token.reveal(), request }, limit);
}
