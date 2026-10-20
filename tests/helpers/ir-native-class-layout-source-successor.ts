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
interface SuccessorTransform extends Transform {
  /** `epoch`: replay the live file back to the fixed epoch; `live`: keep the live text and re-pin it, with the edits as the audit trail. */
  readonly mode: "epoch" | "live";
}
interface SuccessorEpoch {
  readonly base: string;
  readonly head: string;
  readonly transforms: readonly SuccessorTransform[];
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
  readonly successor?: SuccessorEpoch;
}
const receiptBytes = 18244;
const receiptSha256 = "3d00bc1b954591e47c6ae29da36d9356b57ae1358d26b8f35317fc4d733b7fa0";
const canonicalReceiptSha256 = "e0fe9bd8bf1f389a18cd96337d4a212e7a96654b3221a6478138dfe0e2db757c";
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
  const overrides = applySuccessor(receipt, actualReader, captured);
  for (const row of [...receipt.current, ...receipt.anchors]) {
    const text = captured.get(row.path) ?? actualReader(row.path);
    authenticate(text, overrides.get(row.path) ?? row, row.path);
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

/**
 * (#6920) The live tree seen at this record's fixed epoch: successor
 * epoch-mode paths are authenticated and replayed back, every other path is
 * the live text. B's suites compare their own replay against this view.
 */
export function createIrNativeClassLayoutSourceEpochView(
  actualRead: (path: string) => string,
): (path: string) => string {
  const rawReceipt = actualRead(irNativeClassLayoutSourceReceiptPath);
  if (
    typeof rawReceipt !== "string" ||
    Buffer.byteLength(rawReceipt) !== receiptBytes ||
    hash(rawReceipt) !== receiptSha256
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(rawReceipt);
  assertIrNativeClassLayoutSourceReceiptStructure(receipt);
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
