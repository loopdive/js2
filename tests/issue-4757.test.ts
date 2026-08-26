// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const regressionSource = `
function parsePseudoBigInt(stringValue: string): string {
  let log2Base: number;
  switch (stringValue.charCodeAt(1)) {
    case 98:
    case 66:
      log2Base = 1;
      break;
    case 111:
    case 79:
      log2Base = 3;
      break;
    case 120:
    case 88:
      log2Base = 4;
      break;
    default:
      const nIndex = stringValue.length - 1;
      let nonZeroStart = 0;
      while (stringValue.charCodeAt(nonZeroStart) === 48) nonZeroStart++;
      return stringValue.slice(nonZeroStart, nIndex) || "0";
  }

  const startIndex = 2;
  const endIndex = stringValue.length - 1;
  const bitsNeeded = (endIndex - startIndex) * log2Base;
  const segments = new Uint16Array((bitsNeeded >>> 4) + (bitsNeeded & 15 ? 1 : 0));

  for (let i = endIndex - 1, bitOffset = 0; i >= startIndex; i--, bitOffset += log2Base) {
    const segment = bitOffset >>> 4;
    const digitChar = stringValue.charCodeAt(i);
    const digit =
      digitChar <= 57
        ? digitChar - 48
        : 10 + digitChar - (digitChar <= 70 ? 65 : 97);
    const shiftedDigit = digit << (bitOffset & 15);
    segments[segment] |= shiftedDigit;
    const residual = shiftedDigit >>> 16;
    if (residual) segments[segment + 1] |= residual;
  }

  let base10Value = "";
  let firstNonzeroSegment = segments.length - 1;
  let segmentsRemaining = true;
  while (segmentsRemaining) {
    let mod10 = 0;
    segmentsRemaining = false;
    for (let segment = firstNonzeroSegment; segment >= 0; segment--) {
      const newSegment = (mod10 << 16) | segments[segment];
      const segmentValue = (newSegment / 10) | 0;
      segments[segment] = segmentValue;
      mod10 = newSegment - segmentValue * 10;
      if (segmentValue && !segmentsRemaining) {
        firstNonzeroSegment = segment;
        segmentsRemaining = true;
      }
    }
    base10Value = mod10 + base10Value;
  }
  return base10Value;
}

export function test(index: number): number {
  let input = "";
  let expected = "";
  if (index === 0) {
    input = "000123n";
    expected = "123";
  } else if (index === 1) {
    input = "0b11111111111111111111n";
    expected = "1048575";
  } else if (index === 2) {
    input = "0O3777777n";
    expected = "1048575";
  } else if (index === 3) {
    input = "0xFFFFFn";
    expected = "1048575";
  } else if (index === 4) {
    input = "123456789012345678901234567890n";
    expected = "123456789012345678901234567890";
  } else {
    input = "0o143564417755415637016711617605322n";
    expected = "123456789012345678901234567890";
  }
  return parsePseudoBigInt(input) === expected ? 1 : 0;
}

export function testStore(value: number, compound: number): number {
  const segments = new Uint16Array(1);
  if (compound === 0) segments[0] = value;
  else segments[0] |= value;
  return segments[0];
}
`;

async function instantiateRegression(): Promise<Record<string, (...args: number[]) => number>> {
  const result = await compile(regressionSource, { fileName: "issue-4757-regression.ts" });
  if (!result.success) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  return instance.exports as unknown as Record<string, (...args: number[]) => number>;
}

describe("#4757 — f64-backed integer TypedArray element conversion", () => {
  it("keeps runtime-selected parsePseudoBigInt radix inputs exact", async () => {
    const exports = await instantiateRegression();
    for (const index of [0, 1, 2, 3, 4, 5]) {
      expect(exports.test(index), `regression input index ${index}`).toBe(1);
    }
  });

  it("applies Uint16Array width semantics to simple and compound stores", async () => {
    const exports = await instantiateRegression();
    expect(exports.testStore(0x11ffff, 0)).toBe(0xffff);
    expect(exports.testStore(-1, 0)).toBe(0xffff);
    expect(exports.testStore(0x10000, 1)).toBe(0);
    expect(exports.testStore(0x1ffff, 1)).toBe(0xffff);
  });
});
