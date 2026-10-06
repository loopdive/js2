// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  promiseExportBlob as blob,
  promiseExportHash as hash,
  readHistoricalPromiseExportSource as read,
} from "./promise-export-main-port.js";

export const earlierPromiseFixture = "tests/fixtures/issue-3518-promise-earlier-main-port.json";
export const earlierPromisePath = "src/codegen/promise-combinators.ts";
export const earlierPromiseBase = "3316b27608d694d89396e166572e89460caa8dfe";
export const earlierPromisePrior = "d7de1281129ddff8d3a48902a5dcf81eaee7f8d3";
export const earlierPromiseCommits = [
  "82b83e1de56cfdaf28842f36377f9bc623bf695b",
  "94c00fa7b1d5526c170268c91049ff6967a09233",
  "3388cd36f46af042a522f0719b265903d9bda82e",
] as const;
const expectedParents = [
  "905dca7579fdc66e497ec3ee3b4755e389c5b52e",
  "a61c2d41b4f7fd7935e3253b0a735b11ee1ecbf3",
  "10902f7c8d505ca58d25489349229e27599d9769",
];
const expectedDependencies = [
  "src/codegen/closure-classifier.ts",
  "src/codegen/builtin-static-globals.ts",
  "src/codegen/builtin-value-read.ts",
  "src/codegen/carrier-bag-visibility.ts",
  "src/ir/try-table.ts",
  "src/codegen/async-scheduler.ts",
  "src/codegen/promise-custom-combinator.ts",
  "src/codegen/promise-combinator-drive.ts",
];
const receiptHash = "b0059718ae87d8b132aa846e2f1b81769d38dae22b703cdfd6f729d5f02e1548";
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
  parent: string;
  commit: string;
  before: SourcePin;
  after: SourcePin;
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  baseCommit: string;
  priorCommit: string;
  sourcePath: string;
  baseSource: SourcePin;
  priorSource: SourcePin;
  records: SourceRecord[];
  dependencies: (SourcePin & { path: string; commit: string })[];
}
const samePin = (left: SourcePin, right: SourcePin) => left.gitBlob === right.gitBlob && left.sha256 === right.sha256;

/** Separate historical main deltas; the original B1 donor and all original declaration hashes remain unchanged. */
export function authenticateEarlierPromiseMain(text = read(earlierPromiseFixture), reader = read): Receipt {
  if (hash(text) !== receiptHash) throw Error("earlier-promise receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.baseCommit !== earlierPromiseBase ||
    receipt.priorCommit !== earlierPromisePrior ||
    receipt.sourcePath !== earlierPromisePath ||
    JSON.stringify(receipt.records.map((record) => record.commit)) !== JSON.stringify(earlierPromiseCommits) ||
    JSON.stringify(receipt.dependencies.map((dependency) => dependency.path)) !== JSON.stringify(expectedDependencies)
  )
    throw Error("earlier-promise provenance mismatch");
  let previous = receipt.baseSource;
  for (const [index, record] of receipt.records.entries()) {
    if (
      record.path !== earlierPromisePath ||
      record.parent !== expectedParents[index] ||
      record.spans.length !== [4, 10, 14][index] ||
      !samePin(previous, record.before) ||
      [record.before, record.after].some(
        (pin) => !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256),
      )
    )
      throw Error("earlier-promise source provenance mismatch");
    let beforeEnd = 0,
      afterEnd = 0;
    for (const [ordinal, span] of record.spans.entries()) {
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        hash(span.before) !== span.beforeSha256 ||
        hash(span.after) !== span.afterSha256 ||
        !Number.isInteger(span.beforeOffset) ||
        !Number.isInteger(span.afterOffset) ||
        span.beforeOffset < beforeEnd ||
        span.afterOffset < afterEnd
      )
        throw Error("earlier-promise receipt span mismatch");
      beforeEnd = span.beforeOffset + span.before.length;
      afterEnd = span.afterOffset + span.after.length;
    }
    previous = record.after;
  }
  if (!samePin(previous, receipt.priorSource)) throw Error("earlier-promise endpoint mismatch");
  for (const dependency of receipt.dependencies) {
    if (dependency.commit !== earlierPromisePrior) throw Error("earlier-promise dependency provenance mismatch");
    let source: string;
    try {
      source = reader(dependency.path);
    } catch {
      throw Error("earlier-promise dependency missing: " + dependency.path);
    }
    if (hash(source) !== dependency.sha256 || blob(source) !== dependency.gitBlob)
      throw Error("earlier-promise dependency mismatch: " + dependency.path);
  }
  return receipt;
}

function transform(record: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let end = 0,
    result = "";
  for (const span of record.spans) {
    const at = source.indexOf(span[from]);
    if (at < 0 || source.indexOf(span[from], at + 1) !== -1)
      throw Error(`earlier-promise span missing or duplicated: ${record.commit}:${span.ordinal}`);
    if (at < end || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error(`earlier-promise span offset mismatch: ${record.commit}:${span.ordinal}`);
    result += source.slice(end, at) + span[to];
    end = at + span[from].length;
  }
  if (hash(source) !== record[from].sha256 || blob(source) !== record[from].gitBlob)
    throw Error("earlier-promise retained source mismatch: " + record.commit);
  result += source.slice(end);
  if (hash(result) !== record[to].sha256 || blob(result) !== record[to].gitBlob)
    throw Error("earlier-promise reconstruction mismatch: " + record.commit);
  return result;
}

export function applyEarlierPromiseStep(
  commit: string,
  source: string,
  inverse: boolean,
  text = read(earlierPromiseFixture),
  reader = read,
): string {
  const record = authenticateEarlierPromiseMain(text, reader).records.find((row) => row.commit === commit);
  if (!record) throw Error("unrecorded earlier-promise commit");
  const result = transform(record, source, inverse);
  if (transform(record, result, !inverse) !== source) throw Error("earlier-promise reciprocal replay mismatch");
  return result;
}

/** Compose chronological forward edges, or their reverse, using only spans from the supplied complete source. */
export function applyEarlierPromiseMain(path: string, source: string, inverse: boolean): string {
  const receipt = authenticateEarlierPromiseMain();
  if (path !== receipt.sourcePath) throw Error("unrecorded earlier-promise source");
  const order = inverse ? [...receipt.records].reverse() : receipt.records;
  const result = order.reduce((current, record) => transform(record, current, inverse), source);
  const replay = [...order].reverse().reduce((current, record) => transform(record, current, !inverse), result);
  if (replay !== source) throw Error("earlier-promise reciprocal replay mismatch");
  return result;
}

/** Apply after the separate current export inverse, before any test injects historical mutations. */
export function beforeEarlierPromiseMain(path: string, source: string): string {
  return path === earlierPromisePath ? applyEarlierPromiseMain(path, source, true) : source;
}
