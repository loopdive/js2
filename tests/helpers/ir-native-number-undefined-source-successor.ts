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
const receiptBytes = 58470;
const receiptSha256 = "7fe3ab4bb0462990c5ad66e80e19abccc93791640e70c1165200c44fcb23bfdf";
const canonicalReceiptSha256 = "db0027b5d35fe8b22409c5d42ea871914c082bfa019b847a88cdee42eb260971";
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
/** One full physical capture per explicit operation; protected historical layers consume only its private strings. */
export function createIrNativeNumberUndefinedSourceReader(actualReader: Reader): Reader {
  const receiptText = actualReader(irNativeNumberUndefinedSourceReceiptPath);
  if (
    typeof receiptText !== "string" ||
    Buffer.byteLength(receiptText) !== receiptBytes ||
    hash(receiptText) !== receiptSha256
  )
    fail("complete receipt pin");
  if (parsedReceipt === undefined) {
    const parsed: unknown = JSON.parse(receiptText);
    assertIrNativeNumberUndefinedSourceReceiptStructure(parsed);
    parsedReceipt = parsed;
  }
  const receipt = parsedReceipt;
  const live = new Map<string, unknown>();
  for (const row of [...receipt.sources, ...receipt.anchors, ...receipt.callers])
    if (!live.has(row.path)) live.set(row.path, actualReader(row.path));
  const operands = [...live.values()];
  const captureKey = operands.every((text): text is string => typeof text === "string")
    ? [receiptSha256, ...operands].join("\0")
    : undefined;
  const verified = captureKey === undefined ? undefined : verifiedCaptures.get(captureKey);
  const captured = verified
    ? new Map(verified)
    : new Map<string, string>([[irNativeNumberUndefinedSourceReceiptPath, receiptText]]);
  if (!verified) verify(receipt, (path) => (live.has(path) ? live.get(path) : actualReader(path)) as string, captured);
  if (!verified && captureKey !== undefined) verifiedCaptures.set(captureKey, new Map(captured));
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
 * Whole-capture memo (#6920): an operation whose receipt and every required
 * operand are byte-identical to an already verified operation reuses that
 * verification's captured texts (as a fresh map). The key is the operands' exact
 * bytes, not a digest, so a hit is byte equality. Every operand is still read
 * by every operation; a changed or nonprimitive operand misses and
 * takes the full verification with its original refusal.
 */
const verifiedCaptures = new Map<string, ReadonlyMap<string, string>>();
/** The receipt is pinned by hash above, so its parse and structure are pure facts of that hash; it is never mutated. */
let parsedReceipt: IrNativeNumberUndefinedSourceReceipt | undefined;
function verify(
  receipt: IrNativeNumberUndefinedSourceReceipt,
  actualReader: Reader,
  captured: Map<string, string>,
): void {
  // A `live`-mode path that this record's own epoch also transforms is
  // replayed from its successor epoch text, never from the live text.
  const epochs = new Map<string, string>();
  const read = successorReader(receipt, actualReader);
  for (const row of [...receipt.sources, ...receipt.anchors, ...receipt.callers]) {
    const { text, pin: successorPin, epoch } = read(row.path);
    authenticate(text, successorPin ?? row, row.path);
    captured.set(row.path, text);
    epochs.set(row.path, epoch);
  }
  for (const transform of receipt.transforms) {
    const current = epochs.get(transform.path) ?? captured.get(transform.path);
    if (current === undefined) fail("missing authenticated transform owner");
    authenticate(current, transform.current, transform.path);
    const before = replaceRanges(current, transform.edits, true);
    authenticate(before, transform.before, "historical " + transform.path);
    if (replaceRanges(before, transform.edits, false) !== current) fail("complete forward reconstruction");
    captured.set(transform.path, before);
  }
}

/**
 * (#6920) The live tree seen at this record's fixed epoch. `"epoch"` (the
 * default) replays every successor-transformed path back, so the record's own
 * epoch edits apply to it; `"reader"` is what the reader captures — `live`-mode
 * helper code and data stay live, only epoch-mode paths are replayed. Every
 * other path is the live text. B's suites compare their own replay against it.
 */
export function createIrNativeNumberUndefinedSourceEpochView(
  actualRead: (path: string) => string,
  view: "epoch" | "reader" = "epoch",
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
  const read = successorReader(receipt, actualRead);
  return (path: string): string => (view === "epoch" ? read(path).epoch : read(path).text);
}
