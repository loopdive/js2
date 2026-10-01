// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readBeforeLaterMainPreservation } from "./later-main-preservation-port.js";

export const arrayMainPrior = "90a0219f954857012e70c0ca6c2f3bc5d71397b4";
export const arrayMainUpstream = "bb41a01224b8173818f4e4cde86f1fdf1905d8aa";
export const arrayMainMergeBase = "5bfc069422c7cece3e7f19f84e7ce3e51be2269c";
export const arrayMainFixture = "tests/fixtures/issue-3518-array-main-refresh-port.json";
const receiptHash = "2d6edda6a315a29cb754ecc9c0a352ee4a25116593e1d171018a45592b997763";
export const arrayMainPaths = [
  "src/codegen/expressions/calls.ts",
  "src/codegen/object-runtime.ts",
  "src/codegen/closure-exports.ts",
] as const;
export const readArrayMainSource = readBeforeLaterMainPreservation;
export const arrayMainHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const arrayMainBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");

interface SourcePin {
  gitBlob: string;
  sha256: string;
}
interface Span {
  ordinal: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
  beforeOffset: number;
  afterOffset: number;
  upstreamBeforeOffset: number;
  upstreamAfterOffset: number;
}
interface SourceRecord {
  path: string;
  before: SourcePin;
  after: SourcePin;
  upstream: { before: SourcePin; after: SourcePin };
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  priorCommit: string;
  mainCommit: string;
  mergeBase: string;
  records: SourceRecord[];
  dependencies: (SourcePin & { path: string })[];
}

/** Pins the exact incoming deltas and the actual newly imported variadic-builtin implementation. */
export function authenticateArrayMainRefresh(
  text = readArrayMainSource(arrayMainFixture),
  reader = readArrayMainSource,
): Receipt {
  if (arrayMainHash(text) !== receiptHash) throw Error("array-main receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.priorCommit !== arrayMainPrior ||
    receipt.mainCommit !== arrayMainUpstream ||
    receipt.mergeBase !== arrayMainMergeBase ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(arrayMainPaths) ||
    JSON.stringify(receipt.dependencies.map((row) => row.path)) !==
      JSON.stringify(["src/codegen/apply-closure-variadic-builtin.ts"])
  )
    throw Error("array-main provenance mismatch");
  for (const row of receipt.records) {
    const pins = [row.before, row.after, row.upstream.before, row.upstream.after];
    if (
      pins.some((pin) => !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256)) ||
      row.spans.length === 0
    )
      throw Error("array-main source provenance mismatch");
    const ends = [0, 0, 0, 0];
    for (const [ordinal, span] of row.spans.entries()) {
      const offsets = [span.beforeOffset, span.afterOffset, span.upstreamBeforeOffset, span.upstreamAfterOffset];
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        arrayMainHash(span.before) !== span.beforeSha256 ||
        arrayMainHash(span.after) !== span.afterSha256 ||
        offsets.some((offset, index) => !Number.isInteger(offset) || offset < ends[index]!)
      )
        throw Error("array-main receipt span mismatch");
      offsets.forEach((offset, index) => {
        ends[index] = offset + (index % 2 === 0 ? span.before.length : span.after.length);
      });
    }
  }
  for (const row of receipt.dependencies) {
    let source: string;
    try {
      source = reader(row.path);
    } catch {
      throw Error("array-main dependency missing: " + row.path);
    }
    if (arrayMainHash(source) !== row.sha256 || arrayMainBlob(source) !== row.gitBlob)
      throw Error("array-main dependency mismatch: " + row.path);
  }
  return receipt;
}

function transform(row: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (at < 0 || source.indexOf(span[from], at + 1) >= 0)
      throw Error(`array-main span missing or duplicated: ${row.path}:${span.ordinal}`);
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error(`array-main span order or offset mismatch: ${row.path}:${span.ordinal}`);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (arrayMainHash(source) !== row[from].sha256 || arrayMainBlob(source) !== row[from].gitBlob)
    throw Error("array-main retained source mismatch: " + row.path);
  result += source.slice(cursor);
  if (arrayMainHash(result) !== row[to].sha256 || arrayMainBlob(result) !== row[to].gitBlob)
    throw Error("array-main reconstruction mismatch: " + row.path);
  return result;
}

/** Operates only on unique, ordered spans of actual input; complete historical files are never operands. */
export function applyArrayMainRefresh(
  path: string,
  source: string,
  inverse: boolean,
  text = readArrayMainSource(arrayMainFixture),
  reader = readArrayMainSource,
): string {
  const row = authenticateArrayMainRefresh(text, reader).records.find((candidate) => candidate.path === path);
  if (!row) throw Error("unrecorded array-main source");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("array-main reciprocal replay mismatch");
  return result;
}

/** Preservation-only view. Runtime compilation never imports this helper. */
export function beforeArrayMainRefresh(path: string, source: string): string {
  return (arrayMainPaths as readonly string[]).includes(path) ? applyArrayMainRefresh(path, source, true) : source;
}

/** Authenticate the new outer layer exactly once before the older preservation chain. */
export function readBeforeArrayMainRefresh(path: string): string {
  return beforeArrayMainRefresh(path, readArrayMainSource(path));
}
