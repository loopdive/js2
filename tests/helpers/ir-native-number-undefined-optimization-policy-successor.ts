// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
export const nativeNumberUndefinedOptimizationPolicyReceiptPath =
  "tests/helpers/ir-native-number-undefined-optimization-policy-successor.json";
export type OptimizationPolicyReader = (path: string) => string;
interface Pin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
interface SourcePin extends Pin {
  readonly path: string;
}
interface Profile {
  readonly source: Pin;
  readonly count: number;
  readonly data: string;
  readonly files: string;
  readonly nonFiles: string;
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
  readonly policy?: {
    readonly before: Profile;
    readonly current: Profile;
    readonly inserted: readonly { readonly index: number; readonly row: Record<string, unknown> }[];
  };
}
export interface OptimizationPolicyReceipt {
  readonly schema: 1;
  readonly kind: "native-number-undefined-optimization-policy-successor";
  readonly before: Profile;
  readonly current: Profile;
  readonly inserted: readonly { readonly index: number; readonly row: Record<string, unknown> }[];
  readonly anchors: readonly SourcePin[];
  readonly callers: readonly SourcePin[];
  readonly transforms: readonly Transform[];
  readonly successor?: SuccessorEpoch;
}
const receiptBytes = 49903;
const receiptHash = "bd98c1cf03d0cfa702ca395a917f7bcbd73dd16dd898671023422f75eaad0ddd";
const receiptDataHash = "2dd47d8d89506d19815fabe1b3229d2b5b20e17e6023521e53425116af0741c8";
function fail(detail: string): never {
  throw Error(`native optimization policy successor: ${detail}`);
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
/** Closed descriptor DATA: this validation never reads an accessor. */
function data(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") fail("closed DATA required");
  if (active.has(value)) fail("DATA cycle");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array))
    fail("DATA prototype");
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== "string")) fail("DATA symbol");
  active.add(value);
  let copy: unknown;
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) fail("DATA array population");
    const items: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("DATA array descriptor");
      items.push(data(descriptor.value, active));
    }
    copy = items;
  } else {
    const record: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || !descriptor.enumerable) fail("DATA descriptor");
      record[key] = data(descriptor.value, active);
    }
    copy = record;
  }
  active.delete(value);
  return copy;
}
/** A diagnostic view cannot replace any fixed receipt or caller pin. */
export function assertNativeNumberUndefinedOptimizationPolicyReceipt(
  value: unknown,
): asserts value is OptimizationPolicyReceipt {
  if (hash(JSON.stringify(data(value))) !== receiptDataHash) fail("fixed receipt DATA population");
}
function authenticate(text: unknown, expected: Pin, path: string): asserts text is string {
  if (typeof text !== "string") fail(`nonprimitive ${path}`);
  const actual = pin(text);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.gitBlob !== expected.gitBlob)
    fail(`complete source pin ${path}`);
}
function replace(text: string, edits: readonly Edit[], inverse: boolean): string {
  let bytes = Buffer.from(text);
  for (const edit of [...edits].reverse()) {
    const start = inverse ? edit.currentStart : edit.beforeStart,
      end = inverse ? edit.currentEnd : edit.beforeEnd;
    const from = inverse ? edit.currentText : edit.beforeText,
      to = inverse ? edit.beforeText : edit.currentText;
    if (start < 0 || end < start || end > bytes.length || bytes.subarray(start, end).toString("utf8") !== from)
      fail("bounded raw span");
    bytes = Buffer.concat([bytes.subarray(0, start), Buffer.from(to), bytes.subarray(end)]);
  }
  return bytes.toString("utf8");
}
/**
 * Content-keyed memo of pure verifications (#6920): identical bytes verify
 * identically, so a text already verified against the same profile is not
 * re-hashed; changed bytes never hit. Nothing approved is shared — every hit
 * re-parses its own text, and the memo holds verdicts, not approvals of paths.
 */
const verifiedProfiles = new Set<string>();
function profile(raw: string, expected: Profile): Record<string, unknown> & { files: Record<string, unknown>[] } {
  if (typeof raw !== "string") fail("primitive raw policy required");
  let parsed: Record<string, unknown> & { files: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    fail("complete policy profile mismatch");
  }
  const verdict = `${hash(raw)}:${expected.data}:${expected.files}:${expected.nonFiles}:${expected.count}`;
  if (verifiedProfiles.has(verdict)) {
    const actual = pin(raw);
    if (
      actual.bytes !== expected.source.bytes ||
      actual.sha256 !== expected.source.sha256 ||
      actual.gitBlob !== expected.source.gitBlob
    )
      fail("complete raw source profile mismatch");
    return parsed;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.files) ||
    parsed.files.length !== expected.count ||
    hash(JSON.stringify(parsed)) !== expected.data ||
    hash(JSON.stringify(parsed.files)) !== expected.files ||
    hash(JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "files")))) !==
      expected.nonFiles
  )
    fail("complete policy profile mismatch");
  const actual = pin(raw);
  if (
    actual.bytes !== expected.source.bytes ||
    actual.sha256 !== expected.source.sha256 ||
    actual.gitBlob !== expected.source.gitBlob
  )
    fail("complete raw source profile mismatch");
  verifiedProfiles.add(verdict);
  return parsed;
}
/**
 * (#6920) Reads through the successor epoch, lazily, in the caller's own read
 * order: a path the successor transforms is authenticated against its live
 * pin and replayed back to this record's fixed epoch (both directions), or
 * accepted as already at the epoch when an outer reader replayed it first.
 * `live`-mode paths (helper code and data) keep their live text and are
 * re-pinned by the successor; the fixed epoch's data is never edited.
 */
/** Live-text → verified epoch text, content-keyed like `verifiedProfiles`. */
const successorReplays = new Map<string, string>();
/** Pinned-receipt transform replays (receipt hash + path + current pin → verified before text). */
const epochReplays = new Map<string, string>();
function successorReader(
  receipt: { readonly successor?: SuccessorEpoch },
  actualRead: (path: string) => string,
): (path: string) => { readonly text: string; readonly pin?: Pin; readonly epoch: string } {
  const transforms = new Map((receipt.successor?.transforms ?? []).map((t) => [t.path, t] as const));
  const policy = receipt.successor?.policy;
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
    const memo = `${transform.before.sha256}:${actual.sha256}`;
    const replayed = successorReplays.get(memo);
    if (replayed !== undefined)
      return transform.mode === "live"
        ? { text: live, pin: transform.current, epoch: replayed }
        : { text: replayed, pin: transform.before, epoch: replayed };
    const epoch = replace(live, transform.edits, true);
    authenticate(epoch, transform.before, "epoch " + path);
    if (replace(epoch, transform.edits, false) !== live) fail("complete successor forward replay");
    if (path === "scripts/compiler-boundaries.json" && policy) {
      const liveData = profile(live, policy.current);
      const epochData = profile(epoch, policy.before);
      const inverseFiles = [...liveData.files];
      for (const inserted of [...policy.inserted].reverse()) {
        if (JSON.stringify(inverseFiles[inserted.index]) !== JSON.stringify(inserted.row))
          fail("successor inserted row coordinates");
        inverseFiles.splice(inserted.index, 1);
      }
      if (JSON.stringify({ ...liveData, files: inverseFiles }) !== JSON.stringify(epochData))
        fail("successor whole DATA inverse");
      const forwardFiles = [...epochData.files];
      for (const inserted of policy.inserted) forwardFiles.splice(inserted.index, 0, inserted.row);
      if (JSON.stringify({ ...epochData, files: forwardFiles }) !== JSON.stringify(liveData))
        fail("successor whole DATA forward");
    }
    successorReplays.set(memo, epoch);
    return transform.mode === "live"
      ? { text: live, pin: transform.current, epoch }
      : { text: epoch, pin: transform.before, epoch };
  };
}
/** Each operation captures fresh physical inputs once; no shared authentication cache. */
export function createIrNativeNumberUndefinedOptimizationPolicyReader(
  actualRead: OptimizationPolicyReader,
): OptimizationPolicyReader {
  const rawReceipt = actualRead(nativeNumberUndefinedOptimizationPolicyReceiptPath);
  if (
    typeof rawReceipt !== "string" ||
    Buffer.byteLength(rawReceipt) !== receiptBytes ||
    hash(rawReceipt) !== receiptHash
  )
    fail("complete receipt pin");
  if (parsedReceipt === undefined) {
    const parsed: unknown = JSON.parse(rawReceipt);
    assertNativeNumberUndefinedOptimizationPolicyReceipt(parsed);
    parsedReceipt = parsed;
  }
  const receipt = parsedReceipt;
  const live = new Map<string, unknown>();
  for (const path of [
    "scripts/compiler-boundaries.json",
    ...[...receipt.callers, ...receipt.anchors].map((row) => row.path),
  ])
    if (!live.has(path)) live.set(path, actualRead(path));
  const operands = [...live.values()];
  const captureKey = operands.every((text): text is string => typeof text === "string")
    ? [receiptHash, ...operands].join("\0")
    : undefined;
  const verified = captureKey === undefined ? undefined : verifiedCaptures.get(captureKey);
  const captured = verified
    ? new Map(verified)
    : new Map<string, string>([[nativeNumberUndefinedOptimizationPolicyReceiptPath, rawReceipt]]);
  if (!verified) verify(receipt, (path) => (live.has(path) ? live.get(path) : actualRead(path)) as string, captured);
  if (!verified && captureKey !== undefined) verifiedCaptures.set(captureKey, new Map(captured));
  return (path: string): string => {
    if (typeof path !== "string" || !path) fail("primitive nonempty path required");
    if (captured.has(path)) return captured.get(path)!;
    const text = actualRead(path);
    if (typeof text !== "string") fail("nonprimitive passthrough " + path);
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
let parsedReceipt: OptimizationPolicyReceipt | undefined;
function verify(
  receipt: OptimizationPolicyReceipt,
  actualRead: (path: string) => string,
  captured: Map<string, string>,
): void {
  // A `live`-mode path that this record's own epoch also transforms is
  // replayed from its successor epoch text, never from the live text.
  const epochs = new Map<string, string>();
  const read = successorReader(receipt, actualRead);
  const rawPolicy = read("scripts/compiler-boundaries.json").text;
  const currentData = profile(rawPolicy, receipt.current);
  captured.set("scripts/compiler-boundaries.json", rawPolicy);
  for (const row of [...receipt.callers, ...receipt.anchors]) {
    const { text, pin: successorPin, epoch } = read(row.path);
    authenticate(text, successorPin ?? row, row.path);
    captured.set(row.path, text);
    epochs.set(row.path, epoch);
  }
  for (const transform of receipt.transforms) {
    const current = epochs.get(transform.path) ?? captured.get(transform.path);
    if (current === undefined) fail("missing transform owner");
    authenticate(current, transform.current, transform.path);
    const memo = `${receiptHash}:${transform.path}:${transform.current.sha256}`;
    let before = epochReplays.get(memo);
    if (before === undefined) {
      before = replace(current, transform.edits, true);
      authenticate(before, transform.before, "historical " + transform.path);
      if (replace(before, transform.edits, false) !== current) fail("complete forward replay");
      epochReplays.set(memo, before);
    }
    captured.set(transform.path, before);
  }
  const beforeData = profile(captured.get("scripts/compiler-boundaries.json")!, receipt.before);
  const inverseFiles = [...currentData.files];
  for (const inserted of [...receipt.inserted].reverse()) {
    if (JSON.stringify(inverseFiles[inserted.index]) !== JSON.stringify(inserted.row)) fail("inserted row coordinates");
    inverseFiles.splice(inserted.index, 1);
  }
  if (JSON.stringify({ ...currentData, files: inverseFiles }) !== JSON.stringify(beforeData))
    fail("whole DATA inverse");
  const forwardFiles = [...beforeData.files];
  for (const inserted of receipt.inserted) forwardFiles.splice(inserted.index, 0, inserted.row);
  if (JSON.stringify({ ...beforeData, files: forwardFiles }) !== JSON.stringify(currentData))
    fail("whole DATA forward");
}

/** One default API operation; malformed inputs can refuse before any physical read. */
export function createLazyIrNativeNumberUndefinedOptimizationPolicyReader(
  actualRead: OptimizationPolicyReader,
): OptimizationPolicyReader {
  let captured: OptimizationPolicyReader | undefined;
  return (path) => {
    if (typeof path !== "string" || !path) fail("primitive nonempty path required");
    captured ??= createIrNativeNumberUndefinedOptimizationPolicyReader(actualRead);
    return captured(path);
  };
}

/**
 * (#6920) The live tree seen at this record's fixed epoch. `"epoch"` (the
 * default) replays every successor-transformed path back, so the record's own
 * epoch edits apply to it; `"reader"` is what the reader captures — `live`-mode
 * helper code and data stay live, only epoch-mode paths are replayed. Every
 * other path is the live text. B's suites compare their own replay against it.
 */
export function createIrNativeNumberUndefinedOptimizationPolicyEpochView(
  actualRead: (path: string) => string,
  view: "epoch" | "reader" = "epoch",
): (path: string) => string {
  const rawReceipt = actualRead(nativeNumberUndefinedOptimizationPolicyReceiptPath);
  if (
    typeof rawReceipt !== "string" ||
    Buffer.byteLength(rawReceipt) !== receiptBytes ||
    hash(rawReceipt) !== receiptHash
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(rawReceipt);
  assertNativeNumberUndefinedOptimizationPolicyReceipt(receipt);
  const read = successorReader(receipt, actualRead);
  return (path: string): string => (view === "epoch" ? read(path).epoch : read(path).text);
}
