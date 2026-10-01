// Small, dependency-free cryptography helpers shared by the credential store
// and the OAuth authorization server.
//
// Every secret this server hands out is random and opaque; nothing is signed
// with a key, so there is no key material to manage, rotate or leak. Storage
// keeps only SHA-256 digests — `mcp-auth.json` is safe to back up precisely
// because it contains nothing a reader could replay.

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** URL-safe base64 without padding (RFC 7636 §A, RFC 4648 §5). */
export function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random URL-safe string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

/**
 * Credential ids of a fixed, unambiguous alphabet. Hex rather than base64url
 * because the approval code is typed by hand off the Settings page, where
 * `0`/`O` and `1`/`l` confusion is the whole failure mode.
 */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Human-typable approval code, e.g. `a3f9-1c07`. */
export function randomApprovalCode(): string {
  const raw = randomHex(4);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type PkceMethod = "S256" | "plain";

/**
 * RFC 7636 verification. `S256` is required for confidential-free public
 * clients (which is every MCP client today); `plain` is accepted only because
 * the spec lists it, and `plain` is refused outright unless the client
 * explicitly asked for it.
 */
export function verifyPkce(
  challenge: string,
  challengeMethod: string | undefined,
  verifier: string,
): boolean {
  const method: PkceMethod = challengeMethod === "plain" ? "plain" : "S256";
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  if (method === "plain") return safeEqual(challenge, verifier);
  return safeEqual(challenge, base64UrlEncode(createHash("sha256").update(verifier).digest()));
}

/** OAuth client ids are shown in the consent UI, so keep them readable. */
export function randomClientId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 24; i++) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

export function randomId(): string {
  return base64UrlEncode(randomBytes(12));
}
