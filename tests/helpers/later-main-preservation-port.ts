// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeTypedArrayMainPreservation } from "./typedarray-main-preservation-port.js";

export const laterMainPrior = "d7de1281129ddff8d3a48902a5dcf81eaee7f8d3";
export const laterMainCurrent = "8a730516ced8ace5da216cbb8f5b5c54c064d421";
export const laterMainUpstream = "f6ff83a26cbfe116fbb990169ed0ff64c38a5543";
export const laterMainFixture = "tests/fixtures/issue-3518-later-main-preservation/receipt.json";
const receiptHash = "1db8b018682040ff4d5a248b364b126c5ed6743543e40e26a72c4cfee1b5d1ea";
export const laterMainPaths = [
  "src/codegen/expressions/calls.ts",
  "src/codegen/object-runtime.ts",
  "src/codegen/closure-exports.ts",
  "src/codegen/apply-closure-variadic-builtin.ts",
] as const;
export const laterMainCommits = [
  "0f136faea13c8e6b794caa98697be2cee6bd7a17",
  "ec6c0161605bfd70b91aba4112b6108d8604cf09",
  "6f8018cdb8c4cd388dd6182647f64d1f8ea9360f",
  "937afecabddcec09394a6379a46866a17fde6be1",
  "7283f26fd9bbcef77ce74a556654910efe314a26",
  "d71b6e53ab23ac25bc810efd83c6a8ea1a6493ee",
  "854b5d2aba919ea97ba007f2846a3c4b1c124151",
  "a38c8db1b098dc4bf50cf2b023bbffeb6ba5f248",
  "167878f0fc62a6a54b6ffef4a62d63f555b29050",
  "31237a90fb8461617dd1314843989e27de83c0dc",
] as const;
export const laterMainDependencies = [
  "src/codegen/builtin-ctor-value-invoke.ts",
  "src/codegen/generator-function-dynamic.ts",
  "src/codegen/promise-finally-invoke.ts",
  "src/codegen/promise-species-then.ts",
  "src/codegen/expressions/standalone-dynamic-import.ts",
  "src/codegen/object-runtime-proxy-chain.ts",
  "src/codegen/string-wrapper-dynamic-length.ts",
  "src/codegen/builtin-fn-meta.ts",
] as const;

/** Raw input stays independent of all historical readers; no Git or source fallback. */
export const readLaterMainActualSource = (path: string): string =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
/** Normalize the reviewed later main feature only at the initial live-file boundary. */
export const readLaterMainPreservationInput = (path: string): string =>
  beforeTypedArrayMainPreservation(path, readLaterMainActualSource(path));
export const laterMainHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const laterMainBlob = (source: string): string =>
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
}
interface SourceRecord {
  path: string;
  before: SourcePin;
  after: SourcePin;
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  priorCommit: string;
  currentCommit: string;
  upstreamCommit: string;
  records: SourceRecord[];
  sourceCommits: { commit: string; path: string; subject: string }[];
  dependencies: (SourcePin & { path: string })[];
}

/** The fixed receipt describes ten published changes; it never grants arbitrary receipt authority. */
export function authenticateLaterMainPreservation(
  text = readLaterMainActualSource(laterMainFixture),
  reader = readLaterMainActualSource,
): Receipt {
  if (laterMainHash(text) !== receiptHash) throw Error("later-main receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.priorCommit !== laterMainPrior ||
    receipt.currentCommit !== laterMainCurrent ||
    receipt.upstreamCommit !== laterMainUpstream ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(laterMainPaths) ||
    JSON.stringify(receipt.records.map((row) => row.spans.length)) !== JSON.stringify([11, 14, 5, 2]) ||
    JSON.stringify(receipt.sourceCommits.map((row) => row.commit)) !== JSON.stringify(laterMainCommits) ||
    JSON.stringify(receipt.dependencies.map((row) => row.path)) !== JSON.stringify(laterMainDependencies)
  )
    throw Error("later-main provenance mismatch");
  for (const row of receipt.records) {
    if (
      [row.before, row.after].some((pin) => !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256))
    )
      throw Error("later-main source provenance mismatch");
    const ends = [0, 0];
    for (const [ordinal, span] of row.spans.entries()) {
      const offsets = [span.beforeOffset, span.afterOffset];
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        laterMainHash(span.before) !== span.beforeSha256 ||
        laterMainHash(span.after) !== span.afterSha256 ||
        offsets.some((offset, index) => !Number.isInteger(offset) || offset < ends[index]!)
      )
        throw Error("later-main receipt span mismatch");
      offsets.forEach((offset, index) => {
        ends[index] = offset + (index === 0 ? span.before.length : span.after.length);
      });
    }
  }
  for (const row of receipt.dependencies) {
    let source: string;
    try {
      source = reader(row.path);
    } catch {
      throw Error("later-main dependency missing: " + row.path);
    }
    if (laterMainHash(source) !== row.sha256 || laterMainBlob(source) !== row.gitBlob)
      throw Error("later-main dependency mismatch: " + row.path);
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
      throw Error(`later-main span missing or duplicated: ${row.path}:${span.ordinal}`);
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error(`later-main span order or offset mismatch: ${row.path}:${span.ordinal}`);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (laterMainHash(source) !== row[from].sha256 || laterMainBlob(source) !== row[from].gitBlob)
    throw Error("later-main retained source mismatch: " + row.path);
  result += source.slice(cursor);
  if (laterMainHash(result) !== row[to].sha256 || laterMainBlob(result) !== row[to].gitBlob)
    throw Error("later-main reconstruction mismatch: " + row.path);
  return result;
}

/** Only unique, ordered actual spans are operands; complete historical files are never substituted. */
export function applyLaterMainPreservation(
  path: string,
  source: string,
  inverse: boolean,
  text = readLaterMainActualSource(laterMainFixture),
  reader = readLaterMainActualSource,
): string {
  const row = authenticateLaterMainPreservation(text, reader).records.find((candidate) => candidate.path === path);
  if (!row) throw Error("unrecorded later-main source");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("later-main reciprocal replay mismatch");
  return result;
}

/** Initial read only. Older mutation controls operate directly on the resulting historical view. */
export function beforeLaterMainPreservation(path: string, source: string): string {
  return (laterMainPaths as readonly string[]).includes(path) ? applyLaterMainPreservation(path, source, true) : source;
}

export function readBeforeLaterMainPreservation(path: string): string {
  return beforeLaterMainPreservation(path, readLaterMainPreservationInput(path));
}
