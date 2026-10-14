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
}
const receiptBytes = 18232;
const receiptHash = "78ab11c6a40f0ac5a9728c375b3d3f1de374447908d0c9bcc85972dbc491a44f";
const receiptDataHash = "27477e4428728a0cd922fb41e018175cb4c99be988b66ed9f9f96e8cb7a99039";
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
  const rawPolicy = actualRead("scripts/compiler-boundaries.json");
  const currentData = profile(rawPolicy, receipt.current);
  captured.set("scripts/compiler-boundaries.json", rawPolicy);
  for (const row of [...receipt.callers, ...receipt.anchors]) {
    const text = actualRead(row.path);
    authenticate(text, row, row.path);
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
