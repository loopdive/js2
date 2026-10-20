// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

export const irNativeNumberUndefinedSourceReceiptPath =
  "tests/helpers/ir-native-number-undefined-source-successor.json";
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
interface Transform {
  readonly path: string;
  readonly before: Pin;
  readonly current: Pin;
  readonly edits: readonly Edit[];
}
export interface IrNativeNumberUndefinedSourceReceipt {
  readonly schema: 1;
  readonly kind: "native-number-undefined-source-successor";
  readonly qualifiedClassHead: string;
  readonly finalComposition: string;
  readonly sources: readonly SourcePin[];
  readonly anchors: readonly SourcePin[];
  readonly callers: readonly SourcePin[];
  readonly transforms: readonly Transform[];
}
const receiptBytes = 32537;
const receiptSha256 = "660b59f167026c48f33f8b34e9ef785d54874a4abdb2f3348b761458a228e750";
const canonicalReceiptSha256 = "577978d510d8938ec6def95c29e863b84be43ad61caabd0a6912211a016aae85";
function fail(detail: string): never {
  throw Error(`native Number/Undefined source successor: ${detail}`);
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
export function assertIrNativeNumberUndefinedSourceReceiptStructure(
  value: unknown,
): asserts value is IrNativeNumberUndefinedSourceReceipt {
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
/** One full physical capture per explicit operation; protected historical layers consume only its private strings. */
export function createIrNativeNumberUndefinedSourceReader(actualReader: Reader): Reader {
  const receiptText = actualReader(irNativeNumberUndefinedSourceReceiptPath);
  if (
    typeof receiptText !== "string" ||
    Buffer.byteLength(receiptText) !== receiptBytes ||
    hash(receiptText) !== receiptSha256
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(receiptText);
  assertIrNativeNumberUndefinedSourceReceiptStructure(receipt);
  const captured = new Map<string, string>([[irNativeNumberUndefinedSourceReceiptPath, receiptText]]);
  for (const row of [...receipt.sources, ...receipt.anchors, ...receipt.callers]) {
    const text = actualReader(row.path);
    authenticate(text, row, row.path);
    captured.set(row.path, text);
  }
  for (const transform of receipt.transforms) {
    const current = captured.get(transform.path);
    if (current === undefined) fail("missing authenticated transform owner");
    authenticate(current, transform.current, transform.path);
    const before = replaceRanges(current, transform.edits, true);
    authenticate(before, transform.before, "historical " + transform.path);
    if (replaceRanges(before, transform.edits, false) !== current) fail("complete forward reconstruction");
    captured.set(transform.path, before);
  }
  return (path: string): string => {
    const known = captured.get(path);
    if (known !== undefined) return known;
    const text = actualReader(path);
    if (typeof text !== "string") fail("non-string passthrough " + path);
    captured.set(path, text);
    return text;
  };
}
