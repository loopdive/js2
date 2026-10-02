// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type FlatLayoutReader = (path: string) => string;
export const flatLayoutFixture = "tests/fixtures/issue-5883-flat-layout-relocation.json";
export const flatLayoutDrivePath = "src/codegen/promise-combinator-drive.ts";
export const flatLayoutPaths = [
  [
    "src/codegen/promise-combinator-observable-protocol.ts",
    "src/codegen/promises/promise-combinator-observable-protocol.ts",
  ],
  ["src/codegen/promise-observable-combinators.ts", "src/codegen/promises/promise-observable-combinators.ts"],
  ["src/codegen/vec-pop-body.ts", "src/codegen/vectors/vec-pop-body.ts"],
  [flatLayoutDrivePath, flatLayoutDrivePath],
] as const;
// Independent raw reader: no historical-reader imports, Git, or fallback.
export const readFlatLayoutSource: FlatLayoutReader = (path) =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const flatLayoutHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const flatLayoutBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");
interface Pin {
  sha256: string;
  gitBlob: string;
}
export interface FlatLayoutSpan {
  ordinal: number;
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
  beforeSha256: string;
  afterSha256: string;
}
export interface FlatLayoutRecord {
  beforePath: string;
  afterPath: string;
  before: Pin;
  after: Pin;
  spans: FlatLayoutSpan[];
}
export interface FlatLayoutReceipt {
  schemaVersion: number;
  kind: string;
  beforeCommit: string;
  afterCommit: null;
  afterState: string;
  offsetUnit: string;
  records: FlatLayoutRecord[];
  dependencies: (Pin & { path: string })[];
}
export function authenticateFlatLayoutRelocation(
  text = readFlatLayoutSource(flatLayoutFixture),
  reader: FlatLayoutReader = readFlatLayoutSource,
): FlatLayoutReceipt {
  if (flatLayoutHash(text) !== "a6515f071bcebda24b0a05c432c6766d76ebc31a4beb4de5bbd3124c3ee8bbad")
    throw Error("flat-layout receipt mismatch");
  const receipt = JSON.parse(text) as FlatLayoutReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "5883-flat-layout-relocation" ||
    receipt.beforeCommit !== "5b954c36e6c68ee5178a1d71780e8a836ce96746" ||
    receipt.afterCommit !== null ||
    receipt.afterState !== "uncommitted-working-source" ||
    receipt.offsetUnit !== "utf16-code-units" ||
    JSON.stringify(receipt.records.map((row) => [row.beforePath, row.afterPath])) !== JSON.stringify(flatLayoutPaths) ||
    JSON.stringify(receipt.records.map((row) => row.spans.length)) !== JSON.stringify([2, 2, 1, 1]) ||
    JSON.stringify(receipt.dependencies.map((dep) => dep.path)) !==
      JSON.stringify(flatLayoutPaths.slice(0, 3).map((pair) => pair[1]))
  ) {
    throw Error("flat-layout provenance mismatch");
  }
  const validPin = (pin: Pin) => /^[a-f0-9]{64}$/.test(pin.sha256) && /^[a-f0-9]{40}$/.test(pin.gitBlob);
  for (const row of receipt.records) {
    if (!validPin(row.before) || !validPin(row.after)) throw Error("flat-layout source pin mismatch");
    let beforeEnd = 0,
      afterEnd = 0;
    for (const [ordinal, span] of row.spans.entries()) {
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        flatLayoutHash(span.before) !== span.beforeSha256 ||
        flatLayoutHash(span.after) !== span.afterSha256 ||
        !Number.isInteger(span.beforeOffset) ||
        !Number.isInteger(span.afterOffset) ||
        span.beforeOffset < beforeEnd ||
        span.afterOffset < afterEnd
      )
        throw Error("flat-layout receipt span mismatch");
      beforeEnd = span.beforeOffset + span.before.length;
      afterEnd = span.afterOffset + span.after.length;
    }
  }
  for (const [index, dep] of receipt.dependencies.entries()) {
    if (
      !validPin(dep) ||
      dep.sha256 !== receipt.records[index]!.after.sha256 ||
      dep.gitBlob !== receipt.records[index]!.after.gitBlob
    )
      throw Error("flat-layout dependency pin mismatch");
    let source: string;
    try {
      source = reader(dep.path);
    } catch (cause) {
      throw Error("flat-layout dependency missing: " + dep.path, { cause });
    }
    if (flatLayoutHash(source) !== dep.sha256 || flatLayoutBlob(source) !== dep.gitBlob) {
      throw Error("flat-layout dependency mismatch: " + dep.path);
    }
  }
  return receipt;
}
function transform(row: FlatLayoutRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (at < 0 || source.indexOf(span[from], at + 1) >= 0) throw Error("flat-layout span missing or duplicated");
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"]) {
      throw Error("flat-layout span order or offset mismatch");
    }
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (flatLayoutHash(source) !== row[from].sha256 || flatLayoutBlob(source) !== row[from].gitBlob) {
    throw Error("flat-layout retained input mismatch");
  }
  result += source.slice(cursor);
  if (flatLayoutHash(result) !== row[to].sha256 || flatLayoutBlob(result) !== row[to].gitBlob) {
    throw Error("flat-layout reconstruction mismatch");
  }
  return result;
}
/** Explicit source is never replaced with disk bytes or normalized by an authenticator. */
export function applyFlatLayoutRelocation(
  path: string,
  source: string,
  inverse: boolean,
  text?: string,
  reader: FlatLayoutReader = readFlatLayoutSource,
): string {
  const row = authenticateFlatLayoutRelocation(text ?? reader(flatLayoutFixture), reader).records.find(
    (record) => record.afterPath === path,
  );
  if (!row) throw Error("unrecorded flat-layout source");
  const output = transform(row, source, inverse);
  if (transform(row, output, !inverse) !== source) throw Error("flat-layout reciprocal replay mismatch");
  return output;
}
/** Only the drive's default initial read receives the authenticated old-path view. */
export function readBeforeFlatLayoutDrive(path: string, reader: FlatLayoutReader = readFlatLayoutSource): string {
  const source = reader(path);
  return path === flatLayoutDrivePath ? applyFlatLayoutRelocation(path, source, true, undefined, reader) : source;
}
