// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Explicit physical-source domains: never infer an epoch from arbitrary caller data.
export type Inventory4bffView = "union-to-d" | "union-to-incoming" | "main-to-incoming";
export type Inventory4bffReader = (path: string) => string;
export const inventory4bffViewsReceiptPath = "tests/helpers/ir-5883-main-4bff-inventory-views.json";
const receiptBytes = 21555;
const receiptSha256 = "2b11315b63f58739bb17506a16ab6290ff7fc276c85b506ce8c0d73e8cfec136";
interface Profile {
  bytes: number;
  sha256: string;
  gitBlob: string;
  dataSha256: string;
  filesSha256: string;
  fileCount: number;
}
interface Removal {
  field: "files" | "moves";
  index: number;
  row: Record<string, unknown>;
}
interface Span {
  sourceOffset: number;
  targetOffset: number;
  source: string;
  target: string;
}
interface Recipe {
  from: string;
  to: string;
  removals: Removal[];
  spans: Span[];
}
interface Receipt {
  profiles: Record<string, Profile>;
  views: Record<Inventory4bffView, Recipe>;
}
function fail(detail: string): never {
  throw new Error("5883 4bff inventory views: " + detail);
}
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
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
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) return fail("array accessor or hole");
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

function capturePolicy(value: unknown): Record<string, unknown> {
  const copy = captureData(value);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return fail("plain policy object required");
  return copy as Record<string, unknown>;
}
function validateView(view: Inventory4bffView): void {
  if (view !== "union-to-d" && view !== "union-to-incoming" && view !== "main-to-incoming") fail("unknown named view");
}
const defaultRead: Inventory4bffReader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function authenticate(readAuthority: Inventory4bffReader): Receipt {
  if (typeof readAuthority !== "function") return fail("authority reader required");
  const raw = readAuthority(inventory4bffViewsReceiptPath);
  if (typeof raw !== "string" || Buffer.byteLength(raw) !== receiptBytes || sha(raw) !== receiptSha256)
    return fail("fixed receipt pin mismatch");
  return JSON.parse(raw) as Receipt;
}
function profile(value: Record<string, unknown>, target: Profile): void {
  if (
    sha(JSON.stringify(value)) !== target.dataSha256 ||
    !Array.isArray(value.files) ||
    value.files.length !== target.fileCount ||
    sha(JSON.stringify(value.files)) !== target.filesSha256
  )
    fail("complete policy profile mismatch");
}
function pin(raw: Buffer, target: Profile): void {
  if (
    raw.length !== target.bytes ||
    sha(raw) !== target.sha256 ||
    createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex") !== target.gitBlob
  )
    fail("complete raw source profile mismatch");
}
function projectData(current: Record<string, unknown>, receipt: Receipt, recipe: Recipe): Record<string, unknown> {
  profile(current, receipt.profiles[recipe.from]!);
  const target = capturePolicy(current);
  for (const removal of [...recipe.removals].reverse()) {
    const rows = target[removal.field];
    if (!Array.isArray(rows) || !same(rows[removal.index], removal.row)) return fail("fixed removal mismatch");
    rows.splice(removal.index, 1);
  }
  profile(target, receipt.profiles[recipe.to]!);
  const replay = capturePolicy(target);
  for (const removal of recipe.removals) {
    const rows = replay[removal.field];
    if (!Array.isArray(rows)) return fail("fixed replay field mismatch");
    rows.splice(removal.index, 0, captureData(removal.row));
  }
  profile(replay, receipt.profiles[recipe.from]!);
  if (!same(replay, current)) return fail("semantic reciprocal mismatch");
  return target;
}
function projectRaw(raw: string, currentData: Record<string, unknown>, receipt: Receipt, recipe: Recipe): string {
  const current = Buffer.from(raw);
  pin(current, receipt.profiles[recipe.from]!);
  const output: Buffer[] = [];
  let sourceEnd = 0,
    targetEnd = 0;
  for (const span of recipe.spans) {
    const source = Buffer.from(span.source),
      target = Buffer.from(span.target);
    if (
      !Number.isSafeInteger(span.sourceOffset) ||
      !Number.isSafeInteger(span.targetOffset) ||
      span.sourceOffset < sourceEnd ||
      span.targetOffset < targetEnd ||
      span.sourceOffset - sourceEnd !== span.targetOffset - targetEnd ||
      span.sourceOffset + source.length > current.length ||
      !current.subarray(span.sourceOffset, span.sourceOffset + source.length).equals(source)
    )
      return fail("raw inverse coordinates/span mismatch");
    output.push(current.subarray(sourceEnd, span.sourceOffset), target);
    sourceEnd = span.sourceOffset + source.length;
    targetEnd = span.targetOffset + target.length;
  }
  output.push(current.subarray(sourceEnd));
  const target = Buffer.concat(output);
  pin(target, receipt.profiles[recipe.to]!);
  const forward: Buffer[] = [];
  targetEnd = 0;
  for (const span of recipe.spans) {
    const old = Buffer.from(span.target);
    if (!target.subarray(span.targetOffset, span.targetOffset + old.length).equals(old))
      return fail("raw replay span mismatch");
    forward.push(target.subarray(targetEnd, span.targetOffset), Buffer.from(span.source));
    targetEnd = span.targetOffset + old.length;
  }
  forward.push(target.subarray(targetEnd));
  const replay = Buffer.concat(forward);
  pin(replay, receipt.profiles[recipe.from]!);
  if (!replay.equals(current)) return fail("raw reciprocal mismatch");
  const text = target.toString("utf8");
  if (!same(JSON.parse(text), projectData(currentData, receipt, recipe))) return fail("raw/semantic inverse mismatch");
  return text;
}
export function capture5883Main4bffInventoryView(
  value: unknown,
  view: Inventory4bffView,
  readAuthority: Inventory4bffReader = defaultRead,
): Record<string, unknown> {
  validateView(view);
  const current = capturePolicy(value); // Shape validation precedes any authority I/O.
  const receipt = authenticate(readAuthority);
  return projectData(current, receipt, receipt.views[view]);
}
export function capture5883Main4bffInventoryViewSource(
  raw: string,
  view: Inventory4bffView,
  readAuthority: Inventory4bffReader = defaultRead,
): string {
  validateView(view);
  if (typeof raw !== "string") return fail("primitive raw string required");
  const current = capturePolicy(JSON.parse(raw)); // Invalid JSON/shape cannot trigger authority reads.
  const receipt = authenticate(readAuthority);
  return projectRaw(raw, current, receipt, receipt.views[view]);
}
