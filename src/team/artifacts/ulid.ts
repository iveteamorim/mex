import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_ULID_TIME = 0xffffffffffff;

export type TeamArtifactIdPrefix =
  | "member"
  | "ws"
  | "proposal"
  | "relay"
  | "event"
  | "playbook"
  | "run";

export interface UlidGenerationOptions {
  now?: number;
  random?: Uint8Array;
}

/** Generate a collision-resistant canonical ID without relying on process state. */
export function generateArtifactId(
  prefix: TeamArtifactIdPrefix,
  options: UlidGenerationOptions = {},
): string {
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_ULID_TIME) {
    throw new RangeError("ULID time must be a non-negative 48-bit integer.");
  }

  const entropy = options.random ?? randomBytes(10);
  if (entropy.byteLength !== 10) {
    throw new RangeError("ULID entropy must contain exactly 10 bytes.");
  }

  return `${prefix}_${encodeTime(now)}${encodeEntropy(entropy)}`;
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value) && CROCKFORD_BASE32.indexOf(value[0]!) < 8;
}

export function isArtifactId(
  value: string,
  prefix: TeamArtifactIdPrefix,
): boolean {
  return value.startsWith(`${prefix}_`) && isUlid(value.slice(prefix.length + 1));
}

function encodeTime(value: number): string {
  let remaining = BigInt(value);
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD_BASE32[Number(remaining & 31n)]! + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

function encodeEntropy(value: Uint8Array): string {
  let remaining = 0n;
  for (const byte of value) remaining = (remaining << 8n) | BigInt(byte);

  let encoded = "";
  for (let index = 0; index < 16; index += 1) {
    encoded = CROCKFORD_BASE32[Number(remaining & 31n)]! + encoded;
    remaining >>= 5n;
  }
  return encoded;
}
