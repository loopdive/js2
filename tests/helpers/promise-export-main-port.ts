// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readBeforeFlatLayoutDrive } from "./flat-layout-relocation.js";

export const promiseExportPrior = "d7de1281129ddff8d3a48902a5dcf81eaee7f8d3";
export const promiseExportMain = "422dbf01a07b58cceefc64846444485eb549d9a5";
export const promiseExportBase = "bb41a01224b8173818f4e4cde86f1fdf1905d8aa";
export const promiseExportPath = "src/codegen/promise-combinators.ts";
export const promiseExportFixture = "tests/fixtures/issue-3518-promise-export-main-port.json";
const receiptHash = "5a227bc727181737e46bb2d9b857b305805abf930ff8ba7cf563fb3f3faec63e";
export const readPromiseExportSource = readBeforeFlatLayoutDrive;
export const promiseExportHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const promiseExportBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");

interface SourcePin {
  gitBlob: string;
  sha256: string;
}
interface SourceRecord {
  path: string;
  before: SourcePin;
  after: SourcePin;
  upstream: { before: SourcePin; after: SourcePin };
  span: {
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
    beforeOffset: number;
    afterOffset: number;
    upstreamBeforeOffset: number;
    upstreamAfterOffset: number;
  };
}
interface Receipt {
  schemaVersion: number;
  priorCommit: string;
  mainCommit: string;
  mergeBase: string;
  record: SourceRecord;
  dependencies: (SourcePin & { path: string })[];
}

/** Authenticate the incoming export and the actual class-drive implementation that consumes it. */
export function authenticatePromiseExportMain(
  text = readPromiseExportSource(promiseExportFixture),
  reader = readPromiseExportSource,
): Receipt {
  if (promiseExportHash(text) !== receiptHash) throw Error("promise-export receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  const { record } = receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.priorCommit !== promiseExportPrior ||
    receipt.mainCommit !== promiseExportMain ||
    receipt.mergeBase !== promiseExportBase ||
    record.path !== promiseExportPath ||
    JSON.stringify(receipt.dependencies.map((row) => row.path)) !==
      JSON.stringify(["src/codegen/promise-class-receiver-drive.ts"])
  )
    throw Error("promise-export provenance mismatch");
  const pins = [record.before, record.after, record.upstream.before, record.upstream.after];
  if (
    pins.some((pin) => !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256)) ||
    JSON.stringify(record.before) !== JSON.stringify(record.upstream.before) ||
    JSON.stringify(record.after) !== JSON.stringify(record.upstream.after)
  )
    throw Error("promise-export source provenance mismatch");
  const { span } = record;
  const header = "function ensureSettledAnyCombinators(ctx: CodegenContext): SettledAnyCombinatorRuntime {\n";
  if (
    span.before !== "\n" + header ||
    span.after !== "\nexport " + header ||
    promiseExportHash(span.before) !== span.beforeSha256 ||
    promiseExportHash(span.after) !== span.afterSha256 ||
    !Number.isInteger(span.beforeOffset) ||
    span.beforeOffset < 0 ||
    [span.afterOffset, span.upstreamBeforeOffset, span.upstreamAfterOffset].some(
      (offset) => offset !== span.beforeOffset,
    )
  )
    throw Error("promise-export receipt span mismatch");
  for (const dependency of receipt.dependencies) {
    let source: string;
    try {
      source = reader(dependency.path);
    } catch {
      throw Error("promise-export dependency missing: " + dependency.path);
    }
    if (promiseExportHash(source) !== dependency.sha256 || promiseExportBlob(source) !== dependency.gitBlob)
      throw Error("promise-export dependency mismatch: " + dependency.path);
  }
  return receipt;
}

function transform(record: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after",
    span = record.span,
    at = source.indexOf(span[from]);
  if (at < 0 || source.indexOf(span[from], at + 1) !== -1) throw Error("promise-export span missing or duplicated");
  if (at !== span[inverse ? "afterOffset" : "beforeOffset"]) throw Error("promise-export span offset mismatch");
  if (promiseExportHash(source) !== record[from].sha256 || promiseExportBlob(source) !== record[from].gitBlob)
    throw Error("promise-export retained source mismatch");
  const result = source.slice(0, at) + span[to] + source.slice(at + span[from].length);
  if (promiseExportHash(result) !== record[to].sha256 || promiseExportBlob(result) !== record[to].gitBlob)
    throw Error("promise-export reconstruction mismatch");
  return result;
}

/** Reconstruct from the actual input span, then replay it; historical whole files are never operands. */
export function applyPromiseExportMain(
  path: string,
  source: string,
  inverse: boolean,
  text = readPromiseExportSource(promiseExportFixture),
  reader = readPromiseExportSource,
): string {
  const { record } = authenticatePromiseExportMain(text, reader);
  if (path !== record.path) throw Error("unrecorded promise-export source");
  const result = transform(record, source, inverse);
  if (transform(record, result, !inverse) !== source) throw Error("promise-export reciprocal replay mismatch");
  return result;
}

/** Call only at the preservation reader, before existing tests construct their historical mutations. */
export function beforePromiseExportMain(path: string, source: string): string {
  return path === promiseExportPath ? applyPromiseExportMain(path, source, true) : source;
}
