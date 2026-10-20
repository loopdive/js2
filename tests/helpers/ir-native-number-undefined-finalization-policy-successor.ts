// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
export const nativeNumberUndefinedFinalizationPolicyReceiptPath =
  "tests/helpers/ir-native-number-undefined-finalization-policy-successor.json";
export type FinalizationPolicyReader = (path: string) => string;
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
export interface FinalizationPolicyReceipt {
  readonly schema: 1;
  readonly kind: "native-number-undefined-finalization-policy-successor";
  readonly before: Profile;
  readonly current: Profile;
  readonly replaced: readonly {
    readonly index: number;
    readonly before: Record<string, unknown>;
    readonly current: Record<string, unknown>;
  }[];
  readonly inserted: readonly { readonly index: number; readonly row: Record<string, unknown> }[];
  readonly anchors: readonly SourcePin[];
  readonly callers: readonly SourcePin[];
  readonly transforms: readonly Transform[];
  readonly successor?: SuccessorEpoch;
}
const receiptBytes = 128408;
const receiptHash = "c26d9fe235b07eae16716a9dcbf75b380a251cd85858eccb309b311af42b33e8";
const receiptDataHash = "02f771d836bd914165bce71ec92e324ffb4e82d92be9bb130fe313f08647efd2";
function fail(detail: string): never {
  throw Error(`native finalization policy successor: ${detail}`);
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
export function assertNativeNumberUndefinedFinalizationPolicyReceipt(
  value: unknown,
): asserts value is FinalizationPolicyReceipt {
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
function profile(raw: string, expected: Profile): Record<string, unknown> & { files: Record<string, unknown>[] } {
  if (typeof raw !== "string") fail("primitive raw policy required");
  let parsed: Record<string, unknown> & { files: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    fail("complete policy profile mismatch");
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
  return parsed;
}
/**
 * (#6920) A successor epoch maps the live tree back to this record's fixed
 * epoch before that epoch is replayed: every transform is authenticated and
 * replayed both ways, and the policy's inserted rows are inverted and
 * replayed as whole DATA. The fixed epoch's data is never edited.
 */
function applySuccessor(
  receipt: { readonly successor?: SuccessorEpoch },
  actualRead: (path: string) => string,
  captured: Map<string, string>,
): ReadonlyMap<string, Pin> {
  const overrides = new Map<string, Pin>();
  const successor = receipt.successor;
  if (!successor) return overrides;
  for (const transform of successor.transforms) {
    const live = actualRead(transform.path);
    authenticate(live, transform.current, "live " + transform.path);
    const epoch = replace(live, transform.edits, true);
    authenticate(epoch, transform.before, "epoch " + transform.path);
    if (replace(epoch, transform.edits, false) !== live) fail("complete successor forward replay");
    if (transform.path === "scripts/compiler-boundaries.json" && successor.policy) {
      const liveData = profile(live, successor.policy.current);
      const epochData = profile(epoch, successor.policy.before);
      const inverseFiles = [...liveData.files];
      for (const inserted of [...successor.policy.inserted].reverse()) {
        if (JSON.stringify(inverseFiles[inserted.index]) !== JSON.stringify(inserted.row))
          fail("successor inserted row coordinates");
        inverseFiles.splice(inserted.index, 1);
      }
      if (JSON.stringify({ ...liveData, files: inverseFiles }) !== JSON.stringify(epochData))
        fail("successor whole DATA inverse");
      const forwardFiles = [...epochData.files];
      for (const inserted of successor.policy.inserted) forwardFiles.splice(inserted.index, 0, inserted.row);
      if (JSON.stringify({ ...epochData, files: forwardFiles }) !== JSON.stringify(liveData))
        fail("successor whole DATA forward");
    }
    if (transform.mode === "live") {
      overrides.set(transform.path, transform.current);
      captured.set(transform.path, live);
    } else captured.set(transform.path, epoch);
  }
  return overrides;
}
/** Each operation captures fresh physical inputs once; no shared authentication cache. */
export function createIrNativeNumberUndefinedFinalizationPolicyReader(
  actualRead: FinalizationPolicyReader,
): FinalizationPolicyReader {
  const rawReceipt = actualRead(nativeNumberUndefinedFinalizationPolicyReceiptPath);
  if (
    typeof rawReceipt !== "string" ||
    Buffer.byteLength(rawReceipt) !== receiptBytes ||
    hash(rawReceipt) !== receiptHash
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(rawReceipt);
  assertNativeNumberUndefinedFinalizationPolicyReceipt(receipt);
  const captured = new Map<string, string>([[nativeNumberUndefinedFinalizationPolicyReceiptPath, rawReceipt]]);
  const overrides = applySuccessor(receipt, actualRead, captured);
  const rawPolicy = captured.get("scripts/compiler-boundaries.json") ?? actualRead("scripts/compiler-boundaries.json");
  const currentData = profile(rawPolicy, receipt.current);
  captured.set("scripts/compiler-boundaries.json", rawPolicy);
  for (const row of [...receipt.callers, ...receipt.anchors]) {
    const text = captured.get(row.path) ?? actualRead(row.path);
    authenticate(text, overrides.get(row.path) ?? row, row.path);
    captured.set(row.path, text);
  }
  for (const transform of receipt.transforms) {
    const current = captured.get(transform.path);
    if (current === undefined) fail("missing transform owner");
    authenticate(current, transform.current, transform.path);
    const before = replace(current, transform.edits, true);
    authenticate(before, transform.before, "historical " + transform.path);
    if (replace(before, transform.edits, false) !== current) fail("complete forward replay");
    captured.set(transform.path, before);
  }
  const beforeData = profile(captured.get("scripts/compiler-boundaries.json")!, receipt.before);
  const inverseFiles = [...currentData.files];
  for (const replacement of receipt.replaced) {
    if (JSON.stringify(inverseFiles[replacement.index]) !== JSON.stringify(replacement.current))
      fail("replaced row coordinates");
    inverseFiles[replacement.index] = replacement.before;
  }
  for (const inserted of [...receipt.inserted].reverse()) {
    if (JSON.stringify(inverseFiles[inserted.index]) !== JSON.stringify(inserted.row)) fail("inserted row coordinates");
    inverseFiles.splice(inserted.index, 1);
  }
  if (JSON.stringify({ ...currentData, files: inverseFiles }) !== JSON.stringify(beforeData))
    fail("whole DATA inverse");
  const forwardFiles = [...beforeData.files];
  for (const replacement of receipt.replaced) {
    if (JSON.stringify(forwardFiles[replacement.index]) !== JSON.stringify(replacement.before))
      fail("historical replaced row coordinates");
    forwardFiles[replacement.index] = replacement.current;
  }
  for (const inserted of receipt.inserted) forwardFiles.splice(inserted.index, 0, inserted.row);
  if (JSON.stringify({ ...beforeData, files: forwardFiles }) !== JSON.stringify(currentData))
    fail("whole DATA forward");
  return (path: string): string => {
    if (typeof path !== "string" || !path) fail("primitive nonempty path required");
    if (captured.has(path)) return captured.get(path)!;
    const text = actualRead(path);
    if (typeof text !== "string") fail("nonprimitive passthrough " + path);
    captured.set(path, text);
    return text;
  };
}

/** One default API operation; malformed inputs can refuse before any physical read. */
export function createLazyIrNativeNumberUndefinedFinalizationPolicyReader(
  actualRead: FinalizationPolicyReader,
): FinalizationPolicyReader {
  let captured: FinalizationPolicyReader | undefined;
  return (path) => {
    if (typeof path !== "string" || !path) fail("primitive nonempty path required");
    captured ??= createIrNativeNumberUndefinedFinalizationPolicyReader(actualRead);
    return captured(path);
  };
}

/**
 * (#6920) The live tree seen at this record's fixed epoch: successor
 * epoch-mode paths are authenticated and replayed back, every other path is
 * the live text. B's suites compare their own replay against this view.
 */
export function createIrNativeNumberUndefinedFinalizationPolicyEpochView(
  actualRead: (path: string) => string,
): (path: string) => string {
  const rawReceipt = actualRead(nativeNumberUndefinedFinalizationPolicyReceiptPath);
  if (
    typeof rawReceipt !== "string" ||
    Buffer.byteLength(rawReceipt) !== receiptBytes ||
    hash(rawReceipt) !== receiptHash
  )
    fail("complete receipt pin");
  const receipt: unknown = JSON.parse(rawReceipt);
  assertNativeNumberUndefinedFinalizationPolicyReceipt(receipt);
  const epochPaths = new Map((receipt.successor?.transforms ?? []).map((t) => [t.path, t] as const));
  return (path: string): string => {
    const transform = epochPaths.get(path);
    const live = actualRead(path);
    if (!transform || transform.mode !== "epoch") return live;
    authenticate(live, transform.current, "live " + path);
    const epoch = replace(live, transform.edits, true);
    authenticate(epoch, transform.before, "epoch " + path);
    return epoch;
  };
}
