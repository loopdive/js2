// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type Main5fEpochReader = (path: string) => string;
export const main5fEpochFixture = "tests/fixtures/issue-5883-main5f-reader-epoch.json";
export const main5fEpochReceiptHash = "c33cc1682761adb29ea8f1ca83b6682d265ab3533f6f4383e976734fc3479bcd";
export const main5fEpochPaths = [
  "src/codegen/builtin-value-read.ts",
  "src/codegen/carrier-bag-visibility.ts",
  "src/codegen/context/create-context.ts",
  "src/codegen/context/types.ts",
  "src/codegen/object-runtime.ts",
  "src/codegen/registry/error-types.ts",
  "src/ir/types.ts",
] as const;
const raw: Main5fEpochReader = (path) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const main5fEpochHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const main5fEpochBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");
interface Pin {
  bytes: number;
  utf16Length: number;
  sha256: string;
  gitBlob: string;
}
interface Span {
  ordinal: number;
  beforeOffset: number;
  afterOffset: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
}
export interface Main5fEpochRecord {
  path: string;
  role: string;
  before: Pin;
  after: Pin;
  incoming: Pin;
  equalsIncoming: boolean;
  spans: Span[];
  retained: { beforeOffset: number; afterOffset: number; length: number; sha256: string }[];
}
export interface Main5fEpochReceipt {
  schemaVersion: number;
  kind: string;
  offsetUnit: string;
  beforeCommit: string;
  incomingCommit: string;
  composedState: string;
  mergeParents: string[];
  oldReceipt: Pin & { path: string };
  semanticScope: string;
  historicalEvidence: Pin & {
    path: string;
    originalPath: string;
    commit: string;
    amendedControl: string;
    observedFailure: string;
    observedFailureScope: string;
  };
  records: Main5fEpochRecord[];
  provenance: {
    commit: string;
    parents: string[];
    subject: string;
    sourceChanges: { path: string; after: Pin | null; parents: { commit: string; pin: Pin | null }[] }[];
  }[];
}
const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const validPin = (pin: Pin): boolean =>
  integer(pin.bytes) &&
  integer(pin.utf16Length) &&
  /^[a-f0-9]{64}$/.test(pin.sha256) &&
  /^[a-f0-9]{40}$/.test(pin.gitBlob);
const matches = (source: string, pin: Pin): boolean =>
  source.length === pin.utf16Length &&
  Buffer.byteLength(source) === pin.bytes &&
  main5fEpochHash(source) === pin.sha256 &&
  main5fEpochBlob(source) === pin.gitBlob;

/** Independent authority; neither imports nor recursively calls the historical authenticator. */
export function authenticateMain5fEpoch(text = raw(main5fEpochFixture)): Main5fEpochReceipt {
  if (main5fEpochHash(text) !== main5fEpochReceiptHash) throw Error("main5f epoch receipt mismatch");
  const receipt = JSON.parse(text) as Main5fEpochReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "5883-main5f-reader-epoch" ||
    receipt.offsetUnit !== "utf16-code-units" ||
    receipt.beforeCommit !== "e0068df255d8a77d1bdb641a88ea339c7dc7c6d0" ||
    receipt.incomingCommit !== "5f953c8e05919a304d5d3b8e3811e882962a9f33" ||
    receipt.composedState !== "uncommitted-merge-composition" ||
    JSON.stringify(receipt.mergeParents) !== JSON.stringify([receipt.beforeCommit, receipt.incomingCommit]) ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(main5fEpochPaths) ||
    JSON.stringify(receipt.records.map((row) => row.spans.length)) !== JSON.stringify([2, 6, 2, 3, 13, 3, 1]) ||
    !validPin(receipt.oldReceipt) ||
    receipt.oldReceipt.path !== "tests/fixtures/issue-5883-historical-reader-successors.json" ||
    receipt.oldReceipt.sha256 !== "32c7b8d9dff6071c8f468335c9300a931ae34dae772ea5095c096b9aaa444ff7" ||
    !validPin(receipt.historicalEvidence) ||
    receipt.historicalEvidence.path !== "tests/fixtures/issue-5883-historical-reader-successors-e0068.ts.txt" ||
    receipt.historicalEvidence.commit !== receipt.beforeCommit ||
    receipt.historicalEvidence.sha256 !== "a2590728bcaccb35821443b5c000d0112faa1448bd4dca2ea1e8bc81af0bbc38" ||
    receipt.historicalEvidence.gitBlob !== "b2c037c012b08fd1d6fd847faed412ccba795829"
  )
    throw Error("main5f epoch provenance mismatch");
  for (const [index, row] of receipt.records.entries()) {
    if (
      ![row.before, row.after, row.incoming].every(validPin) ||
      row.role !== (index === 0 ? "operand" : "dependency") ||
      row.before.sha256 === row.after.sha256 ||
      row.equalsIncoming !== ![2, 3].includes(index) ||
      row.equalsIncoming !== (row.after.sha256 === row.incoming.sha256 && row.after.gitBlob === row.incoming.gitBlob) ||
      row.retained.length !== row.spans.length + 1
    )
      throw Error("main5f epoch endpoint mismatch: " + row.path);
    let beforeEnd = 0,
      afterEnd = 0;
    for (const [ordinal, span] of row.spans.entries()) {
      const keep = row.retained[ordinal]!;
      if (
        span.ordinal !== ordinal ||
        typeof span.before !== "string" ||
        typeof span.after !== "string" ||
        span.before === span.after ||
        main5fEpochHash(span.before) !== span.beforeSha256 ||
        main5fEpochHash(span.after) !== span.afterSha256 ||
        !integer(span.beforeOffset) ||
        !integer(span.afterOffset) ||
        !integer(keep.length) ||
        keep.beforeOffset !== beforeEnd ||
        keep.afterOffset !== afterEnd ||
        span.beforeOffset !== beforeEnd + keep.length ||
        span.afterOffset !== afterEnd + keep.length ||
        !/^[a-f0-9]{64}$/.test(keep.sha256)
      )
        throw Error("main5f epoch span/retained authority mismatch: " + row.path);
      beforeEnd = span.beforeOffset + span.before.length;
      afterEnd = span.afterOffset + span.after.length;
    }
    const tail = row.retained.at(-1)!;
    if (
      !integer(tail.length) ||
      tail.beforeOffset !== beforeEnd ||
      tail.afterOffset !== afterEnd ||
      beforeEnd + tail.length !== row.before.utf16Length ||
      afterEnd + tail.length !== row.after.utf16Length ||
      !/^[a-f0-9]{64}$/.test(tail.sha256)
    )
      throw Error("main5f epoch retained partition mismatch: " + row.path);
  }
  if (receipt.provenance.length !== 18 || new Set(receipt.provenance.map((p) => p.commit)).size !== 18)
    throw Error("main5f epoch producer inventory mismatch");
  for (const producer of receipt.provenance) {
    if (
      !/^[a-f0-9]{40}$/.test(producer.commit) ||
      !producer.parents.length ||
      new Set(producer.parents).size !== producer.parents.length ||
      producer.parents.some((p) => !/^[a-f0-9]{40}$/.test(p)) ||
      !producer.sourceChanges.length ||
      new Set(producer.sourceChanges.map((change) => change.path)).size !== producer.sourceChanges.length
    )
      throw Error("main5f epoch producer provenance mismatch");
    for (const change of producer.sourceChanges) {
      if (
        !main5fEpochPaths.some((path) => path === change.path) ||
        (change.after !== null && !validPin(change.after)) ||
        JSON.stringify(change.parents.map((p) => p.commit)) !== JSON.stringify(producer.parents) ||
        change.parents.some((p) => p.pin !== null && !validPin(p.pin))
      )
        throw Error("main5f epoch producer endpoint mismatch");
    }
  }
  return receipt;
}

function transform(row: Main5fEpochRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  if (!matches(source, row[from])) throw Error("main5f epoch input mismatch: " + row.path);
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = inverse ? span.afterOffset : span.beforeOffset;
    if (source.slice(at, at + span[from].length) !== span[from])
      throw Error("main5f epoch span mismatch: " + row.path + ":" + span.ordinal);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  result += source.slice(cursor);
  if (!matches(result, row[to])) throw Error("main5f epoch reconstructed endpoint mismatch: " + row.path);
  for (const keep of row.retained) {
    const inputAt = inverse ? keep.afterOffset : keep.beforeOffset;
    const outputAt = inverse ? keep.beforeOffset : keep.afterOffset;
    const input = source.slice(inputAt, inputAt + keep.length);
    if (input !== result.slice(outputAt, outputAt + keep.length) || main5fEpochHash(input) !== keep.sha256)
      throw Error("main5f epoch retained mismatch: " + row.path);
  }
  return result;
}

/** Authenticate once per operation; sources still come from the caller, never receipt snapshots. */
export function createMain5fEpochProjection(reader: Main5fEpochReader = raw, text = reader(main5fEpochFixture)) {
  const receipt = authenticateMain5fEpoch(text);
  return (path: string, source: string, inverse = true): string => {
    const row = receipt.records.find((record) => record.path === path);
    if (!row) return source;
    const result = transform(row, source, inverse);
    if (transform(row, result, !inverse) !== source) throw Error("main5f epoch reciprocal mismatch: " + path);
    return result;
  };
}

/** Explicit input is the complete operand; the supplied reader reads authority only. */
export function applyMain5fEpochSource(
  path: string,
  source: string,
  inverse: boolean,
  text?: string,
  reader: Main5fEpochReader = raw,
): string {
  if (!main5fEpochPaths.some((candidate) => candidate === path)) throw Error("unrecorded main5f epoch source");
  return createMain5fEpochProjection(reader, text ?? reader(main5fEpochFixture))(path, source, inverse);
}

/** Unchanged paths pass through without loading authority or consulting a second reader. */
export function projectMain5fEpochSource(path: string, source: string, reader: Main5fEpochReader = raw): string {
  return main5fEpochPaths.some((candidate) => candidate === path)
    ? applyMain5fEpochSource(path, source, true, undefined, reader)
    : source;
}
