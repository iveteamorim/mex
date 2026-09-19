import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BANDS, K, ROWS } from "../config.js";
import { bandHashes, bandHashInts } from "../fingerprint.js";
import type { Fingerprint } from "../reconcile.js";

// The persisted LSH bands were written with a Hash object per band. Any faster
// derivation must reproduce those exact values, or every existing store would
// fail its fingerprint audit and every LSH lookup would miss.
function referenceBandHashes(fingerprint: Fingerprint): string[] {
  return Array.from({ length: BANDS }, (_, band) => createHash("sha256")
    .update(JSON.stringify(fingerprint.minhash.slice(band * ROWS, band * ROWS + ROWS)))
    .digest("hex"));
}

function referenceBandHashInts(fingerprint: Fingerprint): bigint[] {
  return Array.from({ length: BANDS }, (_, band) => createHash("sha256")
    .update(JSON.stringify(fingerprint.minhash.slice(band * ROWS, band * ROWS + ROWS)))
    .digest()
    .readBigInt64BE(0));
}

function fingerprint(minhash: number[]): Fingerprint {
  return { minhash, neighbors: [], tokenCount: minhash.length };
}

describe("LSH band hashes", () => {
  const cases: Array<[string, Fingerprint]> = [
    ["all zeros", fingerprint(Array.from({ length: K }, () => 0))],
    ["all uint32 max", fingerprint(Array.from({ length: K }, () => 0xffff_ffff))],
    ["alternating extremes", fingerprint(Array.from({ length: K }, (_, index) => index % 2 === 0 ? 0 : 0xffff_ffff))],
    ...Array.from({ length: 200 }, (_, seed): [string, Fingerprint] => [
      `pseudo-random ${seed}`,
      fingerprint(Array.from({ length: K }, (_, index) => Math.imul(seed + 1, 2_654_435_761 + index * 40_503) >>> 0)),
    ]),
  ];

  it("derives exactly the int64 band hashes persisted by earlier builds", () => {
    for (const [, value] of cases) {
      expect(bandHashInts(value)).toEqual(referenceBandHashInts(value));
    }
  });

  it("derives exactly the hex band hashes persisted by earlier builds", () => {
    for (const [, value] of cases) {
      expect(bandHashes(value)).toEqual(referenceBandHashes(value));
    }
  });

  it("covers negative int64 values so sign handling is pinned", () => {
    const values = cases.flatMap(([, value]) => bandHashInts(value));
    expect(values.some((value) => value < 0n)).toBe(true);
    expect(values.some((value) => value > 0n)).toBe(true);
  });
});
