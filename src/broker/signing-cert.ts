// The slot's own OAuth signing certificate (ticket 54, docs/reset.md). An Aras access token is a self-contained JWT
// that the OAuth server signs with `OAuthServer\App_Data\Certificates\OAuthServer.pfx` and every application checks
// against its copy of `OAuthServer.cer`; a slot copied from golden would share golden's certificate with every other
// slot of the flavor and with every earlier lease of itself, so a token issued before a reset would still be answered
// after it. Every render of a slot's configs (a provision and every reset) therefore makes a new certificate: a new
// pfx with a new random password, that password rendered into `OAuthServer\OAuth.config` (the edit list's
// `oauth_signing_password`) and kept in the host's store for the health check, and the new .cer over every copy of
// `OAuthServer.cer` golden has. A token signed before the render fails the next lease's validation.
//
// The key pair and the certificate are made on the host (`slot-steps.ps1 -Step signing-cert`); the password travels
// only on that step's stdin, and only the pfx (encrypted with it) and the public .cer come back.

import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import type { Manifest } from "../core/manifest.js";
import { goldenLayout, slotOAuthSecretName, stampFile, type SlotRef } from "../core/names.js";
import { Secret } from "../core/secret.js";
import type { SlotSystem } from "./provision.js";

/** Where the OAuth server reads its signing certificate, relative to the tree. */
export const SIGNING_PFX = "OAuthServer/App_Data/Certificates/OAuthServer.pfx";

/** Every copy of its public part an application validates tokens with: `<application>/App_Data/Certificates/OAuthServer.cer`. */
const SIGNING_CER = /(^|\/)App_Data\/Certificates\/OAuthServer\.cer$/i;

/** The signing certificate's files in a golden tree, as its manifest names them. */
export interface SigningFiles {
  readonly pfx: string;
  readonly cers: readonly string[];
}

/** The files the certificate is written to: golden's pfx and every copy of its .cer. Throws when golden has no pfx or no .cer. */
export function signingFiles(manifest: Manifest): SigningFiles {
  const pfx = manifest.files.find((f) => f.path.toLowerCase() === SIGNING_PFX.toLowerCase())?.path;
  if (pfx === undefined) throw new Error(`the ${manifest.flavor} golden has no ${SIGNING_PFX}`);
  const cers = manifest.files.filter((f) => SIGNING_CER.test(f.path)).map((f) => f.path);
  if (cers.length === 0) throw new Error(`the ${manifest.flavor} golden has no OAuthServer.cer`);
  return { pfx, cers };
}

/** A signing certificate's pfx password: 128 random bits as 32 hex characters, as long as the install's own. */
export function newSigningPassword(): Secret {
  return Secret.of(randomBytes(16).toString("hex"), "oauth-cert");
}

/** A certificate the host made: the pfx, encrypted with the password it was given, and the public part (DER). */
export interface SigningCertificate {
  readonly pfx: Uint8Array;
  readonly cer: Uint8Array;
}

/** A DER certificate starts with a SEQUENCE; the step's answer is checked before anything is written. */
function isDer(bytes: Uint8Array): boolean {
  return bytes.length > 64 && bytes[0] === 0x30;
}

/**
 * Makes the slot's new signing certificate and stores its password (`slot-<key>-<NN>-oauth`), before any file is written:
 * the caller renders `OAuth.config` with the returned password and then writes `files`.
 */
export async function newSlotSigningCertificate(
  system: SlotSystem,
  slot: SlotRef,
  manifest: Manifest,
): Promise<{ readonly password: Secret; readonly files: readonly { readonly file: string; readonly bytes: Uint8Array }[] }> {
  const where = signingFiles(manifest);
  const password = newSigningPassword();
  const cert = await system.newSigningCertificate(slot, password);
  if (cert.pfx.length === 0 || !isDer(cert.cer)) throw new Error("the host made no usable signing certificate");
  await system.secrets.put(slotOAuthSecretName(slot), password);
  return { password, files: [{ file: where.pfx, bytes: cert.pfx }, ...where.cers.map((file) => ({ file, bytes: cert.cer }))] };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The health check's view of the certificate: the pfx is there, every copy of the .cer is the same certificate, and it is
 * not golden's. Undefined when it holds, else why not. The password in `OAuth.config` is the edit list's to check.
 */
export async function signingProblem(system: SlotSystem, slot: SlotRef, root: string, manifest: Manifest): Promise<string | undefined> {
  const where = signingFiles(manifest);
  const slotDir = win32.dirname(stampFile(slot, root));
  const read = (base: string, file: string) => system.readFile(win32.join(base, ...file.split("/")));
  const pfx = await read(slotDir, where.pfx);
  if (pfx === null || pfx.length === 0) return `${where.pfx} is missing`;
  const cers = await Promise.all(where.cers.map(async (file) => ({ file, bytes: await read(slotDir, file) })));
  const missing = cers.find((c) => c.bytes === null);
  if (missing) return `${missing.file} is missing`;
  const [first, ...rest] = cers as { file: string; bytes: Uint8Array }[];
  const other = rest.find((c) => !sameBytes(c.bytes, first!.bytes));
  if (other) return `${other.file} is not the certificate of ${first!.file}`;
  const golden = await read(goldenLayout(slot.flavor, root).tree, first!.file);
  if (golden !== null && sameBytes(golden, first!.bytes)) return "the slot signs with golden's certificate, not its own (a reset makes it one)";
  return undefined;
}
