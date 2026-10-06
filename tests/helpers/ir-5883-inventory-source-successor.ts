// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Fixed test-only source preservation: exact main preview -> PR5883 checkpoint -> canonical 6128dd.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Reader = (path: string) => string;
type Policy = Record<string, unknown> & { moves: unknown[]; files: unknown[] };
type SourcePin = { bytes: number; sha256: string; gitBlob: string };
type Profile = {
  source: SourcePin;
  dataSha256: string;
  topLevelKeys: string[];
  movesCount: number;
  movesSha256: string;
  filesCount: number;
  filesSha256: string;
  retainedSha256: string;
};
type Receipt = {
  before: Profile;
  current: Profile;
  additions: { field: "moves" | "files"; index: number; rows: unknown[]; previous: unknown; next: unknown }[];
  rawSpans: { beforeOffset: number; afterOffset: number; before: string; after: string }[];
};
const receiptPath = "tests/helpers/ir-5883-inventory-source-successor.json";
const receiptBytes = 8642;
const receiptSha256 = "dae4ccaa122c9b406f136d71a89e613e80d677392cc5ddd9456c90424316bba6";
const mainReceiptPath = "tests/helpers/ir-5883-main-bba74-inventory-source-successor.json";
const mainReceiptBytes = 5514;
const mainReceiptSha256 = "18c1fdee2a7d8c56ed9c1dcea6c6fe2624eec568181e4f27fdd3e924b80f1c18";
const mainSourceBytes = 590751;
const mainSourceSha256 = "491fc3c8e470a5a4c58da8e7d78cd24ab3a2cd18d7ce6bcccf279d927c0ea942";
const mainDataSha256 = "2c3a9c757d9068dc2701f269bf3df3bccf645e0046c7b05db4ac723dbc6c0ac7";
const defaultRead: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(detail: string): never {
  throw new Error("PR5883 inventory source successor: " + detail);
}

// Capture descriptors before authority IO, without evaluating accessors or coercions.
function captureData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return fail("non-JSON data");
  if (active.has(value)) return fail("cyclic data");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return fail("plain owned data required");
  active.add(value);
  try {
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1)
        return fail("array holes or extra fields");
      const copy: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          return fail("array accessor, hidden element or hole");
        copy.push(captureData(descriptor.value, active));
      }
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return fail("symbol field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) return fail("accessor or hidden field");
      Object.defineProperty(copy, key, {
        value: captureData(descriptor.value, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    active.delete(value);
  }
}

function authenticate(
  readAuthority: Reader,
  path = receiptPath,
  bytes = receiptBytes,
  digest = receiptSha256,
): Receipt {
  if (typeof readAuthority !== "function") return fail("authority reader required");
  const raw = readAuthority(path);
  if (typeof raw !== "string") return fail("primitive authority text required");
  // This pin binds every profile, literal row, neighbor, coordinate and span.
  if (Buffer.byteLength(raw) !== bytes || sha(raw) !== digest) return fail("fixed receipt pin mismatch");
  return JSON.parse(raw) as Receipt;
}
function profile(value: Policy, target: Profile): void {
  const retained = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "moves" && key !== "files"));
  if (
    !same(Object.keys(value), target.topLevelKeys) ||
    sha(JSON.stringify(value)) !== target.dataSha256 ||
    !Array.isArray(value.moves) ||
    value.moves.length !== target.movesCount ||
    sha(JSON.stringify(value.moves)) !== target.movesSha256 ||
    !Array.isArray(value.files) ||
    value.files.length !== target.filesCount ||
    sha(JSON.stringify(value.files)) !== target.filesSha256 ||
    sha(JSON.stringify(retained)) !== target.retainedSha256
  )
    fail("complete policy profile mismatch");
}
function beforeSemantic(current: Policy, receipt: Receipt): Policy {
  profile(current, receipt.current);
  for (const group of receipt.additions) {
    const rows = current[group.field];
    if (
      !same(rows.slice(group.index, group.index + group.rows.length), group.rows) ||
      !same(group.index === 0 ? null : rows[group.index - 1], group.previous) ||
      !same(rows[group.index + group.rows.length], group.next)
    )
      fail("fixed inserted row/order/neighbor mismatch");
  }
  const before = { ...current, moves: [...current.moves], files: [...current.files] };
  for (const group of [...receipt.additions].reverse()) before[group.field].splice(group.index, group.rows.length);
  profile(before, receipt.before);
  const replay = { ...before, moves: [...before.moves], files: [...before.files] };
  for (const group of receipt.additions) replay[group.field].splice(group.index, 0, ...group.rows);
  profile(replay, receipt.current);
  if (!same(replay, current)) fail("semantic reciprocal mismatch");
  return before;
}
function pin(raw: Buffer, target: SourcePin): void {
  if (
    raw.length !== target.bytes ||
    sha(raw) !== target.sha256 ||
    createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex") !== target.gitBlob
  )
    fail("complete raw source profile mismatch");
}
function beforeRaw(raw: string, receipt: Receipt): string {
  const current = Buffer.from(raw);
  pin(current, receipt.current.source);
  const inverse: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const span of receipt.rawSpans) {
    if (
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      span.before !== "" ||
      span.beforeOffset < beforeEnd ||
      span.afterOffset < afterEnd ||
      span.beforeOffset > receipt.before.source.bytes ||
      span.beforeOffset - beforeEnd !== span.afterOffset - afterEnd
    )
      fail("raw inverse coordinates mismatch");
    const added = Buffer.from(span.after);
    if (!current.subarray(span.afterOffset, span.afterOffset + added.length).equals(added))
      fail("raw inverse span mismatch");
    inverse.push(current.subarray(afterEnd, span.afterOffset));
    beforeEnd = span.beforeOffset;
    afterEnd = span.afterOffset + added.length;
  }
  inverse.push(current.subarray(afterEnd));
  const before = Buffer.concat(inverse);
  pin(before, receipt.before.source);
  const forward: Buffer[] = [];
  beforeEnd = 0;
  for (const span of receipt.rawSpans) {
    forward.push(before.subarray(beforeEnd, span.beforeOffset), Buffer.from(span.after));
    beforeEnd = span.beforeOffset;
  }
  forward.push(before.subarray(beforeEnd));
  const replay = Buffer.concat(forward);
  pin(replay, receipt.current.source);
  if (!replay.equals(current)) fail("raw reciprocal mismatch");
  if (!same(JSON.parse(before.toString("utf8")), beforeSemantic(JSON.parse(raw) as Policy, receipt)))
    fail("raw/semantic inverse mismatch");
  return before.toString("utf8");
}

function mainReceipt(readAuthority: Reader, checkpoint: Receipt): Receipt {
  const receipt = authenticate(readAuthority, mainReceiptPath, mainReceiptBytes, mainReceiptSha256);
  if (!same(receipt.before, checkpoint.current)) return fail("transition checkpoint profile mismatch");
  return receipt;
}
function checkpointRaw(raw: string, readAuthority: Reader, checkpoint: Receipt): string {
  if (Buffer.byteLength(raw) !== mainSourceBytes || sha(raw) !== mainSourceSha256) return raw;
  const result = beforeRaw(raw, mainReceipt(readAuthority, checkpoint));
  pin(Buffer.from(result), checkpoint.current.source);
  profile(JSON.parse(result) as Policy, checkpoint.current);
  return result;
}

// Initial independent-fixture acquisition only: accepts exactly checkpoint or preview.
export function capture5883InventoryCheckpointPolicySource(raw: string, readAuthority: Reader = defaultRead): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  const receipt = authenticate(readAuthority);
  const result = checkpointRaw(raw, readAuthority, receipt);
  pin(Buffer.from(result), receipt.current.source);
  profile(JSON.parse(result) as Policy, receipt.current);
  return result;
}
export function capture5883InventoryPredecessorPolicySource(raw: string, readAuthority: Reader = defaultRead): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  const receipt = authenticate(readAuthority);
  return beforeRaw(checkpointRaw(raw, readAuthority, receipt), receipt);
}
export function capture5883InventoryPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  const receipt = authenticate(readAuthority);
  const checkpoint =
    sha(JSON.stringify(current)) === mainDataSha256
      ? beforeSemantic(current as Policy, mainReceipt(readAuthority, receipt))
      : (current as Policy);
  profile(checkpoint, receipt.current);
  return beforeSemantic(checkpoint, receipt);
}
