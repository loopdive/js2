// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

type Reader = (path: string) => string;
type Pin = { readonly bytes: number; readonly sha256: string };
type Span = {
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly currentStart: number;
  readonly currentEnd: number;
  readonly beforeText: string;
  readonly currentText: string;
};
type Entry = { readonly path: string; readonly before: Pin; readonly current: Pin; readonly spans: readonly Span[] };
type Receipt = {
  readonly schema: string;
  readonly coordinateUnit: string;
  readonly sources: readonly Entry[];
  readonly anchors: readonly { readonly path: string; readonly current: Pin }[];
  readonly caller: Entry;
};
const receiptPath = "tests/helpers/ir-source-map-validator-current-successor.json";
const receiptPin = { bytes: 41469, sha256: "0c6bf6f0bd24a2fb4ab23d44102acc38f7ad441dba056a7c13728fc1d62b9d22" };
const canonicalSha256 = "01adab2e8cf3cdcaec259e6bf3ee016a02294b5b894a5b504ca7f60d480757a8";
const sourcePaths = [
  "src/compiler/define-substitution.ts",
  "src/ir/core/async-plan.ts",
  "src/ir/core/nodes.ts",
  "src/ir/program-codec.ts",
  "src/ir/program-prepare-ir.ts",
  "src/ir/program/input-contracts.ts",
  "src/ir/program/input.ts",
  "src/ir/program/prepared-contracts.ts",
  "src/ir/program/validation.ts",
  "src/position-map.ts",
  "src/shared/contracts/ir-unit-inventory.ts",
  "src/ir/program-runtime-demands.ts",
  "src/ir/program/runtime-demands.ts",
  "src/ir/program-runtime-abi.ts",
  "src/ir/program/runtime-abi.ts",
  "src/ir/runtime-program-manifest.ts",
  "src/ir/program/runtime-manifest.ts",
  "src/ir/program-runtime-validation.ts",
  "src/ir/program/runtime-validation.ts",
  "src/ir/program-validation.ts",
] as const;
const anchorPaths = [
  "tests/helpers/ir-program-validator-relocation.ts",
  "tests/helpers/ir-source-map-schema-source-epoch.json",
  "tests/helpers/ir-program-validator-relocation.json",
] as const;
const callerPath = "tests/issue-3525-source-map-validator-proof.test.ts";
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
function fail(message: string): never {
  throw new Error("source map validator current successor: " + message);
}
function primitive(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("nonempty primitive text required");
  return value;
}
function assertPin(text: string | Buffer, pin: Pin): void {
  if (Buffer.byteLength(text) !== pin.bytes || hash(text) !== pin.sha256) fail("complete operand pin mismatch");
}
function inverse(entry: Entry, current: string): string {
  const bytes = Buffer.from(current),
    pieces: Buffer[] = [];
  let beforeCursor = 0,
    cursor = 0;
  for (const span of entry.spans) {
    if (
      ![span.beforeStart, span.beforeEnd, span.currentStart, span.currentEnd].every(Number.isSafeInteger) ||
      span.beforeStart < beforeCursor ||
      span.currentStart < cursor ||
      span.beforeEnd < span.beforeStart ||
      span.currentEnd < span.currentStart ||
      span.beforeEnd > entry.before.bytes ||
      span.currentEnd > bytes.length ||
      span.beforeStart - beforeCursor !== span.currentStart - cursor
    )
      fail("inverse coordinates mismatch");
    const old = Buffer.from(span.beforeText),
      next = Buffer.from(span.currentText);
    if (
      old.length !== span.beforeEnd - span.beforeStart ||
      next.length !== span.currentEnd - span.currentStart ||
      old.equals(next) ||
      !bytes.subarray(span.currentStart, span.currentEnd).equals(next)
    )
      fail("inverse span mismatch");
    pieces.push(bytes.subarray(cursor, span.currentStart), old);
    beforeCursor = span.beforeEnd;
    cursor = span.currentEnd;
  }
  if (entry.before.bytes - beforeCursor !== bytes.length - cursor) fail("inverse coverage mismatch");
  pieces.push(bytes.subarray(cursor));
  const before = Buffer.concat(pieces);
  assertPin(before, entry.before);
  const forward: Buffer[] = [];
  let start = 0;
  for (const span of entry.spans) {
    if (!before.subarray(span.beforeStart, span.beforeEnd).equals(Buffer.from(span.beforeText)))
      fail("forward span mismatch");
    forward.push(before.subarray(start, span.beforeStart), Buffer.from(span.currentText));
    start = span.beforeEnd;
  }
  forward.push(before.subarray(start));
  const replay = Buffer.concat(forward);
  assertPin(replay, entry.current);
  if (!replay.equals(bytes)) fail("complete forward mismatch");
  return before.toString("utf8");
}
export interface SourceMapValidatorCurrentCapture {
  readActual(path: string): string;
  readHistoricalCurrent(path: string): string;
}

/** Captures actual current operands once; the historical view is a separately authenticated inverse. */
export function captureSourceMapValidatorCurrentSuccessor(actualRead: Reader): SourceMapValidatorCurrentCapture {
  if (typeof actualRead !== "function") fail("reader required");
  const raw = primitive(actualRead(receiptPath));
  assertPin(raw, receiptPin);
  const receipt = JSON.parse(raw) as Receipt;
  if (
    hash(JSON.stringify(receipt)) !== canonicalSha256 ||
    receipt.schema !== "ir-source-map-validator-current-successor-v1" ||
    receipt.coordinateUnit !== "utf8-byte" ||
    JSON.stringify(receipt.sources.map((entry) => entry.path)) !== JSON.stringify(sourcePaths) ||
    JSON.stringify(receipt.anchors.map((entry) => entry.path)) !== JSON.stringify(anchorPaths) ||
    receipt.caller.path !== callerPath
  )
    fail("fixed DATA census mismatch");
  const actual = new Map<string, string>([[receiptPath, raw]]);
  for (const path of [...sourcePaths, ...anchorPaths, callerPath]) actual.set(path, primitive(actualRead(path)));
  const historical = new Map(actual);
  for (const entry of [...receipt.sources, receipt.caller]) {
    const text = actual.get(entry.path)!;
    assertPin(text, entry.current);
    historical.set(entry.path, inverse(entry, text));
  }
  for (const entry of receipt.anchors) assertPin(actual.get(entry.path)!, entry.current);
  const read = (values: ReadonlyMap<string, string>, path: string): string => {
    primitive(path);
    const value = values.get(path);
    if (value === undefined) fail("outside fixed capture domain");
    return value;
  };
  return Object.freeze({
    readActual: (path: string): string => read(actual, path),
    readHistoricalCurrent: (path: string): string => read(historical, path),
  });
}

/** One lazy operation snapshot; unknown primitive paths retain the actual reader's behavior once. */
export function createSourceMapValidatorCurrentSuccessorReader(actualRead: Reader): Reader {
  if (typeof actualRead !== "function") fail("reader required");
  let captured: SourceMapValidatorCurrentCapture | undefined;
  const unknown = new Map<string, string>();
  const known = new Set<string>([receiptPath, ...sourcePaths, ...anchorPaths, callerPath]);
  return (path) => {
    primitive(path);
    captured ??= captureSourceMapValidatorCurrentSuccessor(actualRead);
    if (known.has(path)) return captured.readHistoricalCurrent(path);
    if (!unknown.has(path)) unknown.set(path, primitive(actualRead(path)));
    return unknown.get(path)!;
  };
}
