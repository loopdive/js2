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

export function testAssignmentResult(kind: number): number {
  if (kind === 0) {
    const values = new Uint16Array(1);
    return (values[0] = 65537);
  }
  const values = new Uint8ClampedArray(1);
  return (values[0] = 1.5);
}

export function testAssignmentStored(kind: number): number {
  if (kind === 0) {
    const values = new Uint16Array(1);
    values[0] = 65537;
    return values[0];
  }
  const values = new Uint8ClampedArray(1);
  values[0] = 1.5;
  return values[0];
}

export function testDynamicAssignmentResult(): number {
  const rhs: any = "65537";
  const values = new Uint16Array(1);
  const result: any = (values[0] = rhs);
  return result === "65537" && values[0] === 1 ? 1 : 0;
}

export function testStringAssignmentResult(): number {
  const rhs: string = "65537";
  const values = new Uint16Array(1);
  // The invalid store is intentional: TypedArray Set applies ToNumber at
  // runtime, while the assignment expression still evaluates to the string.
  // @ts-expect-error exercise the runtime conversion of a statically known RHS
  const result = (values[0] = rhs);
  return result === "65537" && values[0] === 1 ? 1 : 0;
}
`;

const standaloneAssignmentSource = `
export function uint16Result(): number {
  const values = new Uint16Array(1);
  return (values[0] = 1.5);
}

export function uint16Stored(): number {
  const values = new Uint16Array(1);
  values[0] = 1.5;
  return values[0];
}

export function clampedResult(): number {
  const values = new Uint8ClampedArray(1);
  return (values[0] = 1.5);
}

export function clampedStored(): number {
  const values = new Uint8ClampedArray(1);
  values[0] = 1.5;
  return values[0];
}

export function uint16CompoundInfinity(): number {
  const values = new Uint16Array(1);
  values[0] = 1;
  const result = (values[0] += Infinity);
  return result === Infinity && values[0] === 0 ? 1 : 0;
}

export function uint16CompoundModulo(): number {
  const values = new Uint16Array(1);
  values[0] = 1;
  const result = (values[0] += 4294967296);
  return result === 4294967297 && values[0] === 1 ? 1 : 0;
}

export function uint32CompoundModulo(): number {
  const values = new Uint32Array(1);
  values[0] = 1;
  const result = (values[0] += 4294967296);
  return result === 4294967297 && values[0] === 1 ? 1 : 0;
}

export function clampedCompoundHalfEven(): number {
  const lower = new Uint8ClampedArray(1);
  const lowerResult = (lower[0] += 1.5);
  const upper = new Uint8ClampedArray(1);
  upper[0] = 2;
  const upperResult = (upper[0] += 0.5);
  return lowerResult === 1.5 && lower[0] === 2 && upperResult === 2.5 && upper[0] === 2 ? 1 : 0;
}
`;

const bigintTypedArraySource = `
export function addResult(): bigint {
  const values = new BigInt64Array(1);
  values[0] = 9007199254740993n;
  return (values[0] += 2n);
}

export function addStored(): bigint {
  const values = new BigInt64Array(1);
  values[0] = 9007199254740993n;
  values[0] += 2n;
  return values[0];
}

export function bitwiseResult(): bigint {
  const values = new BigUint64Array(1);
  values[0] = 9007199254740993n;
  return (values[0] |= 4n);
}

export function negativeExponent(): bigint {
  const values = new BigInt64Array(1);
  values[0] = 2n;
  return (values[0] **= -1n);
}
`;

const bigintNumberRejectionSource = `
export function numericDirectStore(): bigint {
  const values = new BigInt64Array(1);
  // @ts-expect-error Number is intentionally invalid for a BigInt view
  values[0] = 1;
  return values[0];
}

export function numericCompoundStore(): bigint {
  const values = new BigInt64Array(1);
  values[0] = 1n;
  // @ts-expect-error BigInt compound arithmetic rejects a Number RHS
  values[0] += 1;
  return values[0];
}
`;

const bigintUnsignedShiftRejectionSource = `
let rhsEvaluations = 0;

function rhs(): bigint {
  rhsEvaluations++;
  return 1n;
}

export function unsignedShift(): bigint {
  const values = new BigInt64Array(1);
  values[0] = 8n;
  // @ts-expect-error BigInt deliberately has no unsigned-right-shift operator
  return (values[0] >>>= rhs());
}

export function rhsWasEvaluated(): number {
  return rhsEvaluations;
}
`;

const hostBigintStringSource = `
export function directStringStored(): bigint {
  const values = new BigInt64Array(1);
  const rhs: string = "9007199254740993";
  // The invalid static type is intentional: integer-indexed Set applies
  // ToBigInt to strings at runtime.
  // @ts-expect-error exercise the runtime ToBigInt conversion
  values[0] = rhs;
  return values[0];
}

export function directStringResult(): number {
  const values = new BigInt64Array(1);
  const rhs: string = "9007199254740993";
  // @ts-expect-error assignment evaluates to the unconverted string RHS
  const result = (values[0] = rhs);
  return result === rhs ? 1 : 0;
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

  it("returns the unconverted RHS while storing the converted element", async () => {
    const exports = await instantiateRegression();
    expect(exports.testAssignmentResult(0)).toBe(65537);
    expect(exports.testAssignmentStored(0)).toBe(1);
    expect(exports.testAssignmentResult(1)).toBe(1.5);
    expect(exports.testAssignmentStored(1)).toBe(2);
    expect(exports.testDynamicAssignmentResult()).toBe(1);
    expect(exports.testStringAssignmentResult()).toBe(1);
  });

  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("preserves %s assignment results separately from converted stores", async (_lane, target) => {
    const result = await compile(standaloneAssignmentSource, {
      fileName: "issue-4757-standalone.ts",
      ...(target === undefined ? {} : { target }),
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = target === undefined ? buildCompiledImports(result) : {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    if (target === undefined) {
      const hostImports = imports as ReturnType<typeof buildCompiledImports>;
      hostImports.setInstance?.(instance);
      hostImports.__setInstance?.(instance);
    }
    const exports = instance.exports as unknown as Record<string, () => number>;
    expect(exports.uint16Result()).toBe(1.5);
    expect(exports.uint16Stored()).toBe(1);
    expect(exports.clampedResult()).toBe(1.5);
    expect(exports.clampedStored()).toBe(2);
    expect(exports.uint16CompoundInfinity()).toBe(1);
    expect(exports.uint16CompoundModulo()).toBe(1);
    expect(exports.uint32CompoundModulo()).toBe(1);
    expect(exports.clampedCompoundHalfEven()).toBe(1);
  });

  it("keeps standalone BigInt typed-array stores and compound ops on the BigInt carrier", async () => {
    const result = await compile(bigintTypedArraySource, {
      fileName: "issue-4757-bigint.ts",
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as unknown as Record<string, () => number | bigint>;
    expect(exports.addResult()).toBe(9007199254740995n);
    expect(exports.addStored()).toBe(9007199254740995n);
    expect(exports.bitwiseResult()).toBe(9007199254740997n);
    expect(() => exports.negativeExponent()).toThrow();
  });

  it("rejects a negative BigInt typed-array exponent through the host carrier", async () => {
    const result = await compile(bigintTypedArraySource, { fileName: "issue-4757-bigint-host.ts" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    const exports = instance.exports as unknown as Record<string, () => bigint>;
    expect(() => exports.negativeExponent()).toThrow();
  });

  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("rejects Number values in %s BigInt typed-array stores", async (_lane, target) => {
    const result = await compile(bigintNumberRejectionSource, {
      fileName: "issue-4757-bigint-number.ts",
      ...(target === undefined ? {} : { target }),
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = target === undefined ? buildCompiledImports(result) : {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    if (target === undefined) {
      const hostImports = imports as ReturnType<typeof buildCompiledImports>;
      hostImports.setInstance?.(instance);
      hostImports.__setInstance?.(instance);
    }
    const exports = instance.exports as unknown as Record<string, () => bigint>;
    expect(() => exports.numericDirectStore()).toThrow();
    expect(() => exports.numericCompoundStore()).toThrow();
  });

  it.each([
    ["host", undefined],
    ["standalone", "standalone" as const],
  ])("rejects BigInt unsigned-right-shift compound assignment in %s mode", async (_lane, target) => {
    const result = await compile(bigintUnsignedShiftRejectionSource, {
      fileName: "issue-4757-bigint-unsigned-shift.ts",
      ...(target === undefined ? {} : { target }),
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = target === undefined ? buildCompiledImports(result) : {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    if (target === undefined) {
      const hostImports = imports as ReturnType<typeof buildCompiledImports>;
      hostImports.setInstance?.(instance);
      hostImports.__setInstance?.(instance);
    }
    const exports = instance.exports as unknown as Record<string, () => number | bigint>;
    expect(() => exports.unsignedShift()).toThrow();
    expect(exports.rhsWasEvaluated()).toBe(1);
  });

  it("keeps a host BigInt typed-array string store exact and returns the string RHS", async () => {
    const result = await compile(hostBigintStringSource, { fileName: "issue-4757-host-bigint-string.ts" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    const exports = instance.exports as unknown as Record<string, () => number | bigint>;
    expect(exports.directStringStored()).toBe(9007199254740993n);
    expect(exports.directStringResult()).toBe(1);
  });
});
