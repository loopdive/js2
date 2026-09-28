// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./resume-main-composition.js";
import { verifyObjectRuntimeComposition } from "./object-get-key-composition.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const argumentMainReceiptPath = "tests/fixtures/issue-3518-argument-vector-main-composition.json";
export function argumentMainReceipt(reader = read) {
  const text = reader(argumentMainReceiptPath);
  if (sha(text) !== "fb85f89bc04a995cf4ea0cda3869dffa176744e479e6f6ef7b8fe98159141e1a")
    throw Error("argument main composition receipt mismatch");
  const record = JSON.parse(text) as {
    path: string;
    beforeSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
  };
  return record;
}
/** Tests-only inverse of the signed extraction; no execution-path normalization. */
export function composeArgumentMainSource(source: string, inverse: boolean, reader = read): string {
  const record = argumentMainReceipt(reader);
  const input = source;
  let end = 0;
  const spans = record.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < end || source.indexOf(from, start + 1) !== -1)
      throw Error("argument main extraction span missing, altered, duplicated or reordered");
    end = start + from.length;
    return { start, end, text: inverse ? span.before : span.after };
  });
  if (sha(input) !== (inverse ? record.afterSha256 : record.beforeSha256))
    throw Error("argument main complete input mismatch");
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? record.beforeSha256 : record.afterSha256))
    throw Error("argument main complete output mismatch");
  return source;
}

/** Reorder authenticated later layers into the historical suite's unchanged input view. */
export function readArgumentVectorObjectSource(): string {
  const current = readBeforeResumeMain("src/codegen/object-runtime.ts");
  const prior = verifyObjectRuntimeComposition(current).original;
  const earlier = composeArgumentMainSource(prior, true);
  if (composeArgumentMainSource(earlier, false) !== prior) throw Error("argument main replay mismatch");
  return replayHistoricalSymbolInput(earlier);
}
export function replayHistoricalSymbolInput(source: string, reader = read): string {
  const text = reader("tests/fixtures/issue-3518-main-object-runtime-forward.json");
  if (sha(text) !== "0fd52e36fb7e44c9ffc7f710228be16da332859fa0c22e26644d67be588528e9")
    throw Error("historical Symbol receipt mismatch");
  const record = JSON.parse(text) as {
    spans: { before: string; after: string }[];
    change: { priorCheckpointProjectedSha256: string };
  };
  if (sha(source) !== argumentMainReceipt().beforeSha256) throw Error("historical Symbol input mismatch");
  for (const span of record.spans) {
    if (source.split(span.before).length !== 2) throw Error("historical Symbol placement mismatch");
    source = source.replace(span.before, span.after);
  }
  if (sha(source) !== record.change.priorCheckpointProjectedSha256) throw Error("historical Symbol output mismatch");
  return source;
}
