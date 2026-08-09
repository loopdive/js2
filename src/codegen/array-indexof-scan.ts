// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { FunctionContext } from "./context/types.js";

const HOT_COUNTED_PUSH_TRIP_COUNT = 1024;
const HOT_NUMERIC_INDEX_OF_UNROLL = 32;
// Four pure comparisons share one miss branch. Eight elements (two batches)
// kept the hot body compact while still amortizing its loop backedge.
const HOT_NUMERIC_INDEX_OF_BATCHED_UNROLL = 8;
const HOT_NUMERIC_INDEX_OF_BRANCH_BATCH = 4;

function batchedIndexOfBranchesEnabled(): boolean {
  return process.env.JS2WASM_ARRAY_INDEXOF_BATCHED_BRANCHES !== "0";
}

interface CountedPushProof {
  readonly tripCount: number;
  readonly call: ts.CallExpression;
  readonly arrayName: string;
}

interface IndexOfScan {
  readonly fast: boolean;
  readonly arrTypeIdx: number;
  readonly dataLocal: number;
  readonly indexLocal: number;
  readonly effectiveLengthLocal: number;
  readonly valueLocal: number;
  readonly resultLocal: number;
  readonly getOp: "array.get" | "array.get_s" | "array.get_u";
  readonly equality: readonly Instr[];
  readonly holeMap: readonly Instr[];
  readonly unroll: number;
}

// This is code-selection metadata, not a semantic proof. Keeping it outside
// FunctionContext avoids making every emitter subsystem depend on this hot-scan
// heuristic, while WeakMap keeps its lifetime compile-local.
const countedPushTripCounts = new WeakMap<FunctionContext, Map<string, number>>();

export function registerCountedPushArray(fctx: FunctionContext, proof: CountedPushProof, vecTypeIdx: number): void {
  (fctx.presizedArrayPushCalls ??= new Map()).set(proof.call, vecTypeIdx);
  const counts = countedPushTripCounts.get(fctx) ?? new Map<string, number>();
  counts.set(proof.arrayName, proof.tripCount);
  countedPushTripCounts.set(fctx, counts);
}

/** Pick a wide scan only when its code growth is amortized by a proven hot fill. */
export function countedPushIndexOfUnroll(
  fctx: FunctionContext,
  receiverName: string | undefined,
  elemType: ValType,
): number {
  const numericElements = elemType.kind === "f64" || elemType.kind === "i32";
  const tripCount = receiverName === undefined ? undefined : countedPushTripCounts.get(fctx)?.get(receiverName);
  if (!numericElements || (tripCount ?? 0) < HOT_COUNTED_PUSH_TRIP_COUNT) return 1;
  return batchedIndexOfBranchesEnabled() ? HOT_NUMERIC_INDEX_OF_BATCHED_UNROLL : HOT_NUMERIC_INDEX_OF_UNROLL;
}

/** Emit a scalar scan or a wide main loop with a scalar tail. */
export function emitArrayIndexOfScan(fctx: FunctionContext, scan: IndexOfScan): void {
  const indexInstrs = (offset: number): Instr[] => {
    const instrs: Instr[] = [{ op: "local.get", index: scan.indexLocal }];
    if (offset > 0) instrs.push({ op: "i32.const", value: offset }, { op: "i32.add" });
    return instrs;
  };
  const compareAtOffset = (offset: number, breakDepth: number): Instr[] => [
    { op: "local.get", index: scan.dataLocal },
    ...indexInstrs(offset),
    { op: scan.getOp, typeIdx: scan.arrTypeIdx },
    ...scan.holeMap,
    { op: "local.get", index: scan.valueLocal },
    ...scan.equality,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...indexInstrs(offset),
        ...(scan.fast ? [] : ([{ op: "f64.convert_i32_s" }] as Instr[])),
        { op: "local.set", index: scan.resultLocal },
        { op: "br", depth: breakDepth },
      ],
    },
  ];
  const equalityAtOffset = (offset: number): Instr[] => [
    { op: "local.get", index: scan.dataLocal },
    ...indexInstrs(offset),
    { op: scan.getOp, typeIdx: scan.arrTypeIdx },
    ...scan.holeMap,
    { op: "local.get", index: scan.valueLocal },
    ...scan.equality,
  ];
  const increment = (amount: number): Instr[] => [
    { op: "local.get", index: scan.indexLocal },
    { op: "i32.const", value: amount },
    { op: "i32.add" },
    { op: "local.set", index: scan.indexLocal },
    { op: "br", depth: 0 },
  ];
  const scalarLoop: Instr[] = [
    { op: "local.get", index: scan.indexLocal },
    { op: "local.get", index: scan.effectiveLengthLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    ...compareAtOffset(0, 2),
    ...increment(1),
  ];
  if (scan.unroll <= 1) {
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: scalarLoop }],
    });
    return;
  }

  const wideLoop: Instr[] = [
    { op: "local.get", index: scan.effectiveLengthLocal },
    { op: "local.get", index: scan.indexLocal },
    { op: "i32.sub" },
    { op: "i32.const", value: scan.unroll },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },
  ];
  const batchBranches = batchedIndexOfBranchesEnabled();
  for (let offset = 0; offset < scan.unroll; offset += HOT_NUMERIC_INDEX_OF_BRANCH_BATCH) {
    const end = Math.min(offset + HOT_NUMERIC_INDEX_OF_BRANCH_BATCH, scan.unroll);
    if (!batchBranches) {
      for (let candidate = offset; candidate < end; candidate++) {
        wideLoop.push(...compareAtOffset(candidate, 3));
      }
      continue;
    }
    for (let candidate = offset; candidate < end; candidate++) {
      wideLoop.push(...equalityAtOffset(candidate));
      if (candidate > offset) wideLoop.push({ op: "i32.or" });
    }
    // A miss takes one branch for the whole batch. A hit rechecks only that
    // side-effect-free batch in source order so duplicate values still return
    // the first matching index.
    wideLoop.push({
      op: "if",
      blockType: { kind: "empty" },
      then: Array.from({ length: end - offset }, (_, index) => compareAtOffset(offset + index, 4)).flat(),
    });
  }
  wideLoop.push(...increment(scan.unroll));

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: wideLoop }],
      },
      { op: "loop", blockType: { kind: "empty" }, body: scalarLoop },
    ],
  });
}
