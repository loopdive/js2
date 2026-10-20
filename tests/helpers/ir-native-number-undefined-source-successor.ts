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
interface SuccessorTransform extends Transform {
  /** `epoch`: replay the live file back to the fixed epoch; `live`: keep the live text and re-pin it, with the edits as the audit trail. */
  readonly mode: "epoch" | "live";
}
interface SuccessorEpoch {
  readonly base: string;
  readonly head: string;
  readonly transforms: readonly SuccessorTransform[];
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
  readonly successor?: SuccessorEpoch;
}
const receiptBytes = 53049;
const receiptSha256 = "6592544c685ae82f01271bae9a332fd46b88cd1359da4266f49dd7cbd0b1cf59";
const canonicalReceiptSha256 = "a0936b2966d8437b42e3b4cf40cc4b5e15d66b17abebb1ecade2f2ba9e56e685";
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
/**
 * (#6920) A successor epoch maps the live tree back to this record's fixed
 * epoch before that epoch is replayed: every transform is authenticated and
 * replayed both ways. The fixed epoch's data is never edited.
 */
function applySuccessor(
  receipt: { readonly successor?: SuccessorEpoch },
  actualReader: (path: string) => string,
  captured: Map<string, string>,
): ReadonlyMap<string, Pin> {
  const overrides = new Map<string, Pin>();
  const successor = receipt.successor;
  if (!successor) return overrides;
  for (const transform of successor.transforms) {
    const live = actualReader(transform.path);
    authenticate(live, transform.current, "live " + transform.path);
    const epoch = replaceRanges(live, transform.edits, true);
    authenticate(epoch, transform.before, "epoch " + transform.path);
    if (replaceRanges(epoch, transform.edits, false) !== live) fail("complete successor forward replay");
    if (transform.mode === "live") {
      overrides.set(transform.path, transform.current);
      captured.set(transform.path, live);
    } else captured.set(transform.path, epoch);
  }
  return overrides;
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
  const overrides = applySuccessor(receipt, actualReader, captured);
  for (const row of [...receipt.sources, ...receipt.anchors, ...receipt.callers]) {
    const text = captured.get(row.path) ?? actualReader(row.path);
    authenticate(text, overrides.get(row.path) ?? row, row.path);
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

/**
 * (#6920) The live tree seen at this record's fixed epoch: successor
 * epoch-mode paths are authenticated and replayed back, every other path is
 * the live text. B's suites compare their own replay against this view.
 */
export function createIrNativeNumberUndefinedSourceEpochView(
  actualRead: (path: string) => string,
): (path: string) => string {
  const rawReceipt = actualRead(irNativeNumberUndefinedSourceReceiptPath);
  if (
    typeof rawReceipt !== "string" ||
    Buffer.byteLength(rawReceipt) !== receiptBytes ||
    hash(rawReceipt) !== receiptSha256
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(rawReceipt);
  assertIrNativeNumberUndefinedSourceReceiptStructure(receipt);
  const epochPaths = new Map((receipt.successor?.transforms ?? []).map((t) => [t.path, t] as const));
  return (path: string): string => {
    const transform = epochPaths.get(path);
    const live = actualRead(path);
    if (!transform || transform.mode !== "epoch") return live;
    authenticate(live, transform.current, "live " + path);
    const epoch = replaceRanges(live, transform.edits, true);
    authenticate(epoch, transform.before, "epoch " + path);
    return epoch;
  };
}
