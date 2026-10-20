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
 * (#6920) Reads through the successor epoch, lazily, in the caller's own read
 * order: a path the successor transforms is authenticated against its live
 * pin and replayed back to this record's fixed epoch (both directions), or
 * accepted as already at the epoch when an outer reader replayed it first.
 * `live`-mode paths (helper code and data) keep their live text and are
 * re-pinned by the successor; the fixed epoch's data is never edited.
 */
function successorReader(
  receipt: { readonly successor?: SuccessorEpoch },
  actualRead: (path: string) => string,
): (path: string) => { readonly text: string; readonly pin?: Pin; readonly epoch: string } {
  const transforms = new Map((receipt.successor?.transforms ?? []).map((t) => [t.path, t] as const));

  return (path) => {
    const live = actualRead(path);
    const transform = transforms.get(path);
    if (!transform) return { text: live, epoch: live };
    if (typeof live !== "string") fail(`non-string source ${path}`);
    const actual = pin(live);
    if (
      actual.bytes === transform.before.bytes &&
      actual.sha256 === transform.before.sha256 &&
      actual.gitBlob === transform.before.gitBlob
    )
      return { text: live, pin: transform.before, epoch: live };
    authenticate(live, transform.current, path);
    const epoch = replaceRanges(live, transform.edits, true);
    authenticate(epoch, transform.before, "epoch " + path);
    if (replaceRanges(epoch, transform.edits, false) !== live) fail("complete successor forward replay");
    return transform.mode === "live"
      ? { text: live, pin: transform.current, epoch }
      : { text: epoch, pin: transform.before, epoch };
  };
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
  if (parsedReceipt === undefined) {
    const parsed: unknown = JSON.parse(receiptText);
    assertIrNativeClassLayoutSourceReceiptStructure(parsed);
    parsedReceipt = parsed;
  }
  const receipt = parsedReceipt;
  const live = new Map<string, unknown>();
  for (const row of [...receipt.current, ...receipt.anchors])
    if (!live.has(row.path)) live.set(row.path, actualReader(row.path));
  const operands = [...live.values()];
  const captureKey = operands.every((text): text is string => typeof text === "string")
    ? [receiptSha256, ...operands].join("\0")
    : undefined;
  const verified = captureKey === undefined ? undefined : verifiedCaptures.get(captureKey);
  const captured = verified
    ? new Map(verified)
    : new Map<string, string>([[irNativeClassLayoutSourceReceiptPath, receiptText]]);
  if (!verified) verify(receipt, (path) => (live.has(path) ? live.get(path) : actualReader(path)) as string, captured);
  if (!verified && captureKey !== undefined) verifiedCaptures.set(captureKey, new Map(captured));
  return (path: string): string => {
    const known = captured.get(path);
    if (known !== undefined) return known;
    const result = actualReader(path);
    if (typeof result !== "string") fail(`non-string passthrough ${path}`);
    captured.set(path, result);
    return result;
  };
}
/**
 * Whole-capture memo (#6920): an operation whose receipt and every required
 * operand are byte-identical to an already verified operation reuses that
 * verification's captured texts (as a fresh map). The key is the operands' exact
 * bytes, not a digest, so a hit is byte equality. Every operand is still read
 * by every operation; a changed or nonprimitive operand misses and
 * takes the full verification with its original refusal.
 */
const verifiedCaptures = new Map<string, ReadonlyMap<string, string>>();
/** The receipt is pinned by hash above, so its parse and structure are pure facts of that hash; it is never mutated. */
let parsedReceipt: IrNativeClassLayoutSourceReceipt | undefined;
function verify(receipt: IrNativeClassLayoutSourceReceipt, actualReader: Reader, captured: Map<string, string>): void {
  // A `live`-mode path that this record's own epoch also transforms is
  // replayed from its successor epoch text, never from the live text.
  const epochs = new Map<string, string>();
  const read = successorReader(receipt, actualReader);
  for (const row of [...receipt.current, ...receipt.anchors]) {
    const { text, pin: successorPin, epoch } = read(row.path);
    authenticate(text, successorPin ?? row, row.path);
    captured.set(row.path, text);
    epochs.set(row.path, epoch);
  }
  const current = epochs.get(irNativeClassLayoutSourcePath) ?? captured.get(irNativeClassLayoutSourcePath)!;
  const before = replaceRanges(current, receipt.edits, true);
  authenticate(before, receipt.before, "historical class layouts");
  const forward = replaceRanges(before, receipt.edits, false);
  if (forward !== current) fail("complete forward reconstruction");
  captured.set(irNativeClassLayoutSourcePath, before);
}

/** Standalone reads also create a fresh complete operation, including passthrough. */
export function readBeforeIrNativeClassLayoutSource(path: string, actualReader: Reader): string {
  return createIrNativeClassLayoutSourceReader(actualReader)(path);
}

/**
 * (#6920) The live tree seen at this record's fixed epoch. `"epoch"` (the
 * default) replays every successor-transformed path back, so the record's own
 * epoch edits apply to it; `"reader"` is what the reader captures — `live`-mode
 * helper code and data stay live, only epoch-mode paths are replayed. Every
 * other path is the live text. B's suites compare their own replay against it.
 */
export function createIrNativeClassLayoutSourceEpochView(
  actualRead: (path: string) => string,
  view: "epoch" | "reader" = "epoch",
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
  const read = successorReader(receipt, actualRead);
  return (path: string): string => (view === "epoch" ? read(path).epoch : read(path).text);
}
