// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

export const irNativeClassLayoutSourceReceiptPath = "tests/helpers/ir-native-class-layout-source-successor.json";
export const irNativeClassLayoutSourcePath = "src/ir/program/class-layouts.ts";
type Reader = (path: string) => string;
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface SourcePin extends Pin {
  readonly path: string;
}
interface Edit {
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly beforeText: string;
  readonly currentStart: number;
  readonly currentEnd: number;
  readonly currentText: string;
}
export interface IrNativeClassLayoutSourceReceipt {
  readonly schema: 1;
  readonly kind: "native-class-layout-source-successor";
  readonly base: string;
  readonly currentHead: string;
  readonly path: typeof irNativeClassLayoutSourcePath;
  readonly before: Pin;
  readonly current: readonly SourcePin[];
  readonly anchors: readonly SourcePin[];
  readonly edits: readonly Edit[];
}
const receiptBytes = 12174;
const receiptSha256 = "5adc5506d732c4c9c2e9170557c9a084c8f6dd3dd72929b120aa7d1bdf658045";
const canonicalReceiptSha256 = "f897d27f9f03813b894b06efde96da04dab6f746ae8424ff12835bbc33136997";
function fail(detail: string): never {
  throw Error(`native class source successor: ${detail}`);
}
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function pin(text: string): Pin {
  const bytes = Buffer.byteLength(text);
  return {
    bytes,
    sha256: hash(text),
    gitBlob: createHash("sha1").update(`blob ${bytes}\0`).update(text).digest("hex"),
  };
}
/** Copy closed DATA through descriptors before any property read or serialization. */
function copyData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value) fail("receipt is not closed DATA");
  if (active.has(value)) fail("receipt DATA cycle");
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) &&
    !(!array && Object.getPrototypeOf(value) === null)
  )
    fail("receipt DATA prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) fail("receipt DATA symbol");
  active.add(value);
  let result: unknown;
  if (array) {
    const length = descriptors.length?.value as unknown;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || keys.length !== (length as number) + 1)
      fail("receipt DATA array population");
    const items: unknown[] = [];
    for (let i = 0; i < (length as number); i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("receipt DATA array descriptor");
      items.push(copyData(descriptor.value, active));
    }
    result = items;
  } else {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) fail("receipt DATA descriptor");
      record[key] = copyData(descriptor.value, active);
    }
    result = record;
  }
  active.delete(value);
  return result;
}
/** Diagnostics accept no caller repin; the entire fixed DATA population is authenticated. */
export function assertIrNativeClassLayoutSourceReceiptStructure(
  value: unknown,
): asserts value is IrNativeClassLayoutSourceReceipt {
  const copy = copyData(value);
  if (hash(JSON.stringify(copy)) !== canonicalReceiptSha256) fail("fixed receipt DATA population");
}
function authenticate(text: unknown, expected: Pin, label: string): asserts text is string {
  if (typeof text !== "string") fail(`non-string source ${label}`);
  const actual = pin(text);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.gitBlob !== expected.gitBlob)
    fail(`complete source pin ${label}`);
}
function replaceRanges(source: string, edits: readonly Edit[], inverse: boolean): string {
  let bytes = Buffer.from(source);
  for (const edit of [...edits].reverse()) {
    const start = inverse ? edit.currentStart : edit.beforeStart;
    const end = inverse ? edit.currentEnd : edit.beforeEnd;
    const from = inverse ? edit.currentText : edit.beforeText;
    const to = inverse ? edit.beforeText : edit.currentText;
    if (bytes.subarray(start, end).toString("utf8") !== from) fail("bounded source span");
    bytes = Buffer.concat([bytes.subarray(0, start), Buffer.from(to), bytes.subarray(end)]);
  }
  return bytes.toString("utf8");
}
/** One explicit operation owns this fresh authenticated snapshot; no capture survives into the next operation. */
export function createIrNativeClassLayoutSourceReader(actualReader: Reader): Reader {
  const receiptText = actualReader(irNativeClassLayoutSourceReceiptPath);
  if (
    typeof receiptText !== "string" ||
    Buffer.byteLength(receiptText) !== receiptBytes ||
    hash(receiptText) !== receiptSha256
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(receiptText);
  assertIrNativeClassLayoutSourceReceiptStructure(receipt);
  const captured = new Map<string, string>([[irNativeClassLayoutSourceReceiptPath, receiptText]]);
  for (const row of [...receipt.current, ...receipt.anchors]) {
    const text = actualReader(row.path);
    authenticate(text, row, row.path);
    captured.set(row.path, text);
  }
  const current = captured.get(irNativeClassLayoutSourcePath)!;
  const before = replaceRanges(current, receipt.edits, true);
  authenticate(before, receipt.before, "historical class layouts");
  const forward = replaceRanges(before, receipt.edits, false);
  if (forward !== current) fail("complete forward reconstruction");
  captured.set(irNativeClassLayoutSourcePath, before);
  return (path: string): string => {
    const known = captured.get(path);
    if (known !== undefined) return known;
    const result = actualReader(path);
    if (typeof result !== "string") fail(`non-string passthrough ${path}`);
    captured.set(path, result);
    return result;
  };
}

/** Standalone reads also create a fresh complete operation, including passthrough. */
export function readBeforeIrNativeClassLayoutSource(path: string, actualReader: Reader): string {
  return createIrNativeClassLayoutSourceReader(actualReader)(path);
}
