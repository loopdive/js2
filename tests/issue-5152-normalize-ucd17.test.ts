// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5152 — Unicode 17 String.prototype.normalize emitted-Wasm conformance.
 *
 * The corpus is numeric Unicode scalar data generated from the pinned official
 * NormalizationTest.txt source. This test never asks host ICU to normalize a
 * string: one standalone module accepts and returns UTF-16 code units through
 * numeric exports, then every comparison is made by this harness.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NORMALIZE_UCD17_ASSIGNED_PRIVATE_USE_SCALAR_COUNT,
  NORMALIZE_UCD17_ASSIGNED_SCALAR_COUNT,
  NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES,
  NORMALIZE_UCD17_ASSIGNED_SURROGATE_CODE_POINT_COUNT,
  NORMALIZE_UCD17_CELL_OFFSETS,
  NORMALIZE_UCD17_CORPUS_FORMAT,
  NORMALIZE_UCD17_CORPUS_PAYLOAD_SHA256,
  NORMALIZE_UCD17_LONE_SURROGATE_CODE_UNIT_COUNT,
  NORMALIZE_UCD17_LINE_NUMBERS,
  NORMALIZE_UCD17_NORMALIZATION_TEST_SHA256,
  NORMALIZE_UCD17_PART1_C1_SCALAR_COUNT,
  NORMALIZE_UCD17_PART1_C1_SCALARS,
  NORMALIZE_UCD17_RELATION_COUNT,
  NORMALIZE_UCD17_ROW_COUNT,
  NORMALIZE_UCD17_RULE2_SCALAR_COUNT,
  NORMALIZE_UCD17_UNICODE_VERSION,
  NORMALIZE_UCD17_VALUES,
} from "./fixtures/normalize-ucd17-conformance.js";
import { compile } from "../src/index.js";

const NORMALIZATION_TEST_UCD17_SHA256 = "5019ffd530751a741900c849c0e010332f142a3612234639bd200b82138a87db";
const CELLS_PER_ROW = 5;
const RELATIONS_PER_ROW = 20;
const UCD_ROW_CHUNK_SIZE = 128;
const NORMALIZE_MODE_COUNT = 4;

const ADAPTER_CONTROL_SOURCE = `
  let input = "";
  let output = "";

  export function resetInput(): void {
    input = "";
    output = "";
  }

  export function appendUnit(unit: number): void {
    input = input + String.fromCharCode(unit);
  }

  export function run(): void {
    output = input.normalize("NFC");
  }

  export function outputLength(): number {
    return output.length;
  }

  export function outputUnit(index: number): number {
    return output.charCodeAt(index);
  }
`;

// Keep the form literals in the compiled program. The numeric mode crosses
// only the test boundary; it never asks a host string helper to normalize.
const UCD_ADAPTER_SOURCE = `
  let input = "";
  let output = "";

  export function resetInput(): void {
    input = "";
    output = "";
  }

  export function appendUnit(unit: number): void {
    input = input + String.fromCharCode(unit);
  }

  export function run(mode: number): void {
    if (mode === 0) output = input.normalize("NFC");
    else if (mode === 1) output = input.normalize("NFD");
    else if (mode === 2) output = input.normalize("NFKC");
    else output = input.normalize("NFKD");
  }

  export function outputLength(): number {
    return output.length;
  }

  export function outputUnit(index: number): number {
    return output.charCodeAt(index);
  }
`;

interface NormalizeAdapterExports {
  resetInput(): void;
  appendUnit(unit: number): void;
  run(mode?: number): void;
  outputLength(): number;
  outputUnit(index: number): number;
}

interface FormRelation {
  readonly mode: number;
  readonly form: "NFC" | "NFD" | "NFKC" | "NFKD";
  readonly expectedColumn: number;
  readonly sourceColumns: readonly number[];
}

const UCD_RELATIONS: readonly FormRelation[] = [
  { mode: 0, form: "NFC", expectedColumn: 1, sourceColumns: [0, 1, 2] },
  { mode: 0, form: "NFC", expectedColumn: 3, sourceColumns: [3, 4] },
  { mode: 1, form: "NFD", expectedColumn: 2, sourceColumns: [0, 1, 2] },
  { mode: 1, form: "NFD", expectedColumn: 4, sourceColumns: [3, 4] },
  { mode: 2, form: "NFKC", expectedColumn: 3, sourceColumns: [0, 1, 2, 3, 4] },
  { mode: 3, form: "NFKD", expectedColumn: 4, sourceColumns: [0, 1, 2, 3, 4] },
];

async function instantiateAdapter(source: string, fileName: string): Promise<NormalizeAdapterExports> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as NormalizeAdapterExports;
}

let ucdAdapterPromise: Promise<NormalizeAdapterExports> | undefined;

function getUcdAdapter(): Promise<NormalizeAdapterExports> {
  return (ucdAdapterPromise ??= instantiateAdapter(UCD_ADAPTER_SOURCE, "issue-5152-normalize-ucd17-adapter.ts"));
}

function corpusPayloadDigest(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: NORMALIZE_UCD17_CORPUS_FORMAT,
        lineNumbers: NORMALIZE_UCD17_LINE_NUMBERS,
        cellOffsets: NORMALIZE_UCD17_CELL_OFFSETS,
        values: NORMALIZE_UCD17_VALUES,
        part1Scalars: NORMALIZE_UCD17_PART1_C1_SCALARS,
        assignedScalarRanges: NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES,
        assignedScalarCount: NORMALIZE_UCD17_ASSIGNED_SCALAR_COUNT,
        assignedPrivateUseScalarCount: NORMALIZE_UCD17_ASSIGNED_PRIVATE_USE_SCALAR_COUNT,
        assignedSurrogateCodePointCount: NORMALIZE_UCD17_ASSIGNED_SURROGATE_CODE_POINT_COUNT,
        rule2ScalarCount: NORMALIZE_UCD17_RULE2_SCALAR_COUNT,
      }),
    )
    .digest("hex");
}

function checkCorpusShape(): void {
  expect(NORMALIZE_UCD17_UNICODE_VERSION).toBe("17.0.0");
  expect(NORMALIZE_UCD17_NORMALIZATION_TEST_SHA256).toBe(NORMALIZATION_TEST_UCD17_SHA256);
  expect(NORMALIZE_UCD17_ROW_COUNT).toBe(20_034);
  expect(NORMALIZE_UCD17_LINE_NUMBERS).toHaveLength(NORMALIZE_UCD17_ROW_COUNT);
  expect(NORMALIZE_UCD17_CELL_OFFSETS).toHaveLength(NORMALIZE_UCD17_ROW_COUNT * CELLS_PER_ROW + 1);
  expect(NORMALIZE_UCD17_CELL_OFFSETS[0]).toBe(0);
  expect(NORMALIZE_UCD17_CELL_OFFSETS.at(-1)).toBe(NORMALIZE_UCD17_VALUES.length);
  expect(NORMALIZE_UCD17_PART1_C1_SCALAR_COUNT).toBe(NORMALIZE_UCD17_PART1_C1_SCALARS.length);
  expect(NORMALIZE_UCD17_RELATION_COUNT).toBe(NORMALIZE_UCD17_ROW_COUNT * RELATIONS_PER_ROW);
  expect(NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES.length % 2).toBe(0);
  expect(NORMALIZE_UCD17_ASSIGNED_SCALAR_COUNT).toBeGreaterThan(NORMALIZE_UCD17_PART1_C1_SCALAR_COUNT);
  expect(NORMALIZE_UCD17_RULE2_SCALAR_COUNT).toBe(
    NORMALIZE_UCD17_ASSIGNED_SCALAR_COUNT - NORMALIZE_UCD17_PART1_C1_SCALAR_COUNT,
  );
  expect(NORMALIZE_UCD17_ASSIGNED_PRIVATE_USE_SCALAR_COUNT).toBeGreaterThan(0);
  expect(NORMALIZE_UCD17_ASSIGNED_SURROGATE_CODE_POINT_COUNT).toBe(0x800);
  expect(NORMALIZE_UCD17_LONE_SURROGATE_CODE_UNIT_COUNT).toBe(0x800);
  expect(corpusPayloadDigest()).toBe(NORMALIZE_UCD17_CORPUS_PAYLOAD_SHA256);

  for (let index = 1; index < NORMALIZE_UCD17_CELL_OFFSETS.length; index++) {
    expect(NORMALIZE_UCD17_CELL_OFFSETS[index], `cell offset ${index}`).toBeGreaterThanOrEqual(
      NORMALIZE_UCD17_CELL_OFFSETS[index - 1]!,
    );
  }

  let assignedScalarCount = 0;
  let previousEnd = -1;
  for (let index = 0; index < NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES.length; index += 2) {
    const start = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES[index]!;
    const end = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES[index + 1]!;
    expect(start, `assigned range ${index / 2} start`).toBeGreaterThan(previousEnd);
    expect(end, `assigned range ${index / 2} end`).toBeGreaterThanOrEqual(start);
    expect(end < 0xd800 || start > 0xdfff, `assigned range ${index / 2} excludes surrogates`).toBe(true);
    assignedScalarCount += end - start + 1;
    previousEnd = end;
  }
  expect(assignedScalarCount).toBe(NORMALIZE_UCD17_ASSIGNED_SCALAR_COUNT);

  let previousPart1 = -1;
  for (const scalar of NORMALIZE_UCD17_PART1_C1_SCALARS) {
    expect(scalar).toBeGreaterThan(previousPart1);
    expect(scalarIsAssigned(scalar)).toBe(true);
    previousPart1 = scalar;
  }
}

function scalarIsAssigned(scalar: number): boolean {
  let low = 0;
  let high = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES[middle * 2]!;
    const end = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES[middle * 2 + 1]!;
    if (scalar < start) high = middle - 1;
    else if (scalar > end) low = middle + 1;
    else return true;
  }
  return false;
}

function cellRange(row: number, column: number): readonly [number, number] {
  if (row < 0 || row >= NORMALIZE_UCD17_ROW_COUNT || column < 0 || column >= CELLS_PER_ROW) {
    throw new Error(`UCD corpus cell out of range: row=${row}, column=${column}`);
  }
  const cell = row * CELLS_PER_ROW + column;
  return [NORMALIZE_UCD17_CELL_OFFSETS[cell]!, NORMALIZE_UCD17_CELL_OFFSETS[cell + 1]!];
}

function appendScalarAsUtf16(adapter: NormalizeAdapterExports, scalar: number): void {
  if (!Number.isInteger(scalar) || scalar < 0 || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
    throw new Error(`fixture contains non-scalar U+${scalar.toString(16).toUpperCase()}`);
  }
  if (scalar <= 0xffff) {
    adapter.appendUnit(scalar);
    return;
  }
  const pair = scalar - 0x10000;
  adapter.appendUnit(0xd800 + (pair >> 10));
  adapter.appendUnit(0xdc00 + (pair & 0x3ff));
}

function appendCell(adapter: NormalizeAdapterExports, row: number, column: number): void {
  const [start, end] = cellRange(row, column);
  for (let index = start; index < end; index++) appendScalarAsUtf16(adapter, NORMALIZE_UCD17_VALUES[index]!);
}

function expectedUtf16Length(row: number, column: number): number {
  const [start, end] = cellRange(row, column);
  let length = 0;
  for (let index = start; index < end; index++) length += NORMALIZE_UCD17_VALUES[index]! <= 0xffff ? 1 : 2;
  return length;
}

function assertOutputMatchesCell(adapter: NormalizeAdapterExports, row: number, column: number, detail: string): void {
  const expectedLength = expectedUtf16Length(row, column);
  const actualLength = adapter.outputLength();
  if (actualLength !== expectedLength) {
    throw new Error(`${detail}: expected UTF-16 length ${expectedLength}, got ${actualLength}`);
  }

  const [start, end] = cellRange(row, column);
  let outputIndex = 0;
  for (let index = start; index < end; index++) {
    const scalar = NORMALIZE_UCD17_VALUES[index]!;
    const units =
      scalar <= 0xffff ? [scalar] : [0xd800 + ((scalar - 0x10000) >> 10), 0xdc00 + ((scalar - 0x10000) & 0x3ff)];
    for (const expected of units) {
      const actual = adapter.outputUnit(outputIndex);
      if (actual !== expected) {
        throw new Error(
          `${detail}: UTF-16 unit ${outputIndex} expected U+${expected.toString(16).toUpperCase()}, got U+${actual
            .toString(16)
            .toUpperCase()}`,
        );
      }
      outputIndex++;
    }
  }
}

function assertOutputMatchesScalar(adapter: NormalizeAdapterExports, scalar: number, detail: string): void {
  const expectedUnits =
    scalar <= 0xffff ? [scalar] : [0xd800 + ((scalar - 0x10000) >> 10), 0xdc00 + ((scalar - 0x10000) & 0x3ff)];
  const actualLength = adapter.outputLength();
  if (actualLength !== expectedUnits.length) {
    throw new Error(`${detail}: expected UTF-16 length ${expectedUnits.length}, got ${actualLength}`);
  }
  for (let index = 0; index < expectedUnits.length; index++) {
    const actual = adapter.outputUnit(index);
    const expected = expectedUnits[index]!;
    if (actual !== expected) {
      throw new Error(
        `${detail}: UTF-16 unit ${index} expected U+${expected.toString(16).toUpperCase()}, got U+${actual
          .toString(16)
          .toUpperCase()}`,
      );
    }
  }
}

function normalizeAndCompare(
  adapter: NormalizeAdapterExports,
  row: number,
  sourceColumn: number,
  expectedColumn: number,
  relation: FormRelation,
): void {
  adapter.resetInput();
  appendCell(adapter, row, sourceColumn);
  adapter.run(relation.mode);
  const line = NORMALIZE_UCD17_LINE_NUMBERS[row]!;
  assertOutputMatchesCell(
    adapter,
    row,
    expectedColumn,
    `NormalizationTest.txt:${line} ${relation.form} c${sourceColumn + 1} → c${expectedColumn + 1}`,
  );
}

describe("#5152 Unicode 17 emitted-Wasm normalize corpus", () => {
  it("supports numeric UTF-16 ingress/egress with mutable native-string globals and no imports", async () => {
    const adapter = await instantiateAdapter(ADAPTER_CONTROL_SOURCE, "issue-5152-normalize-adapter-control.ts");
    adapter.resetInput();
    // An unpaired leading surrogate is a CCC-0 WTF-16 barrier; the middle
    // decomposed Latin sequence still composes, then the trailing surrogate is retained.
    for (const unit of [0xd800, 0x65, 0x0301, 0xdc00]) adapter.appendUnit(unit);
    adapter.run();
    expect(adapter.outputLength()).toBe(3);
    expect([0, 1, 2].map((index) => adapter.outputUnit(index))).toEqual([0xd800, 0x00e9, 0xdc00]);
  });

  it(
    "runs every official NormalizationTest.txt relation through one import-free Wasm instance",
    { timeout: 600_000 },
    async () => {
      checkCorpusShape();
      const adapter = await getUcdAdapter();
      let relations = 0;

      for (let rowStart = 0; rowStart < NORMALIZE_UCD17_ROW_COUNT; rowStart += UCD_ROW_CHUNK_SIZE) {
        const rowEnd = Math.min(rowStart + UCD_ROW_CHUNK_SIZE, NORMALIZE_UCD17_ROW_COUNT);
        for (let row = rowStart; row < rowEnd; row++) {
          for (const relation of UCD_RELATIONS) {
            for (const sourceColumn of relation.sourceColumns) {
              normalizeAndCompare(adapter, row, sourceColumn, relation.expectedColumn, relation);
              relations++;
            }
          }
        }
      }

      expect(relations).toBe(NORMALIZE_UCD17_RELATION_COUNT);
    },
  );

  it(
    "satisfies UAX #15 Rule 2 for every assigned non-surrogate scalar absent from Part 1",
    { timeout: 900_000 },
    async () => {
      checkCorpusShape();
      const adapter = await getUcdAdapter();
      let part1Index = 0;
      let rule2Scalars = 0;
      let relations = 0;

      for (let rangeIndex = 0; rangeIndex < NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES.length; rangeIndex += 2) {
        const start = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES[rangeIndex]!;
        const end = NORMALIZE_UCD17_ASSIGNED_SCALAR_RANGES[rangeIndex + 1]!;
        for (let scalar = start; scalar <= end; scalar++) {
          while (
            part1Index < NORMALIZE_UCD17_PART1_C1_SCALARS.length &&
            NORMALIZE_UCD17_PART1_C1_SCALARS[part1Index]! < scalar
          ) {
            part1Index++;
          }
          if (NORMALIZE_UCD17_PART1_C1_SCALARS[part1Index] === scalar) continue;
          rule2Scalars++;
          for (let mode = 0; mode < NORMALIZE_MODE_COUNT; mode++) {
            adapter.resetInput();
            appendScalarAsUtf16(adapter, scalar);
            adapter.run(mode);
            assertOutputMatchesScalar(adapter, scalar, `Rule 2 U+${scalar.toString(16).toUpperCase()} mode ${mode}`);
            relations++;
          }
        }
      }

      expect(rule2Scalars).toBe(NORMALIZE_UCD17_RULE2_SCALAR_COUNT);
      expect(relations).toBe(NORMALIZE_UCD17_RULE2_SCALAR_COUNT * NORMALIZE_MODE_COUNT);
    },
  );

  it(
    "retains all assigned lone surrogate code units in all four normalization forms",
    { timeout: 600_000 },
    async () => {
      checkCorpusShape();
      const adapter = await getUcdAdapter();
      let relations = 0;
      for (let unit = 0xd800; unit <= 0xdfff; unit++) {
        for (let mode = 0; mode < NORMALIZE_MODE_COUNT; mode++) {
          adapter.resetInput();
          adapter.appendUnit(unit);
          adapter.run(mode);
          if (adapter.outputLength() !== 1 || adapter.outputUnit(0) !== unit) {
            throw new Error(`lone surrogate U+${unit.toString(16).toUpperCase()} changed in mode ${mode}`);
          }
          relations++;
        }
      }
      expect(relations).toBe(NORMALIZE_UCD17_LONE_SURROGATE_CODE_UNIT_COUNT * NORMALIZE_MODE_COUNT);
    },
  );
});
