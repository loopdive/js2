// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyOwnPropertyExtraction } from "./own-property-extraction.js";
import { readBeforePrototypeRead } from "./prototype-read-extraction.js";
import { createHash } from "node:crypto";
import { readBeforeArrayMainRefresh } from "./array-main-refresh-port.js";
import { beforeBigIntCarrierPort } from "./bigint-carrier-port.js";
import { beforeDescriptorAdapterRelocation } from "./descriptor-adapter-relocation.js";
import { beforeDeliveryMainRefresh } from "./delivery-main-refresh-port.js";

export const resumeMainPrior = "c2014e6da1fd49da71f5d3e57722f35bee73ecc0";
export const resumeMainUpstream = "bb18c35e839bc35f8294b76123e231b253405127";
export const resumeMainFixturePath = "tests/fixtures/issue-3518-resume-main-composition.json";
const fixtureSha = "caca5417a51a144f5948f3da2d92af1ee5d8f6fff175d973f14b712e1747658e";
export const resumeMainPaths = [
  "src/codegen/any-helpers.ts",
  "src/codegen/carrier-bag-visibility.ts",
  "src/codegen/closure-props.ts",
  "src/codegen/expressions/calls.ts",
  "src/codegen/generators-native-protocol.ts",
  "src/codegen/instance-props.ts",
  "src/codegen/native-strings.ts",
  "src/codegen/object-runtime.ts",
  "src/codegen/proto-index-store.ts",
  "src/codegen/registry/imports.ts",
  "src/codegen/runtime-ref-number.ts",
  "src/codegen/symbol-native.ts",
  "src/codegen/type-coercion.ts",
  "src/runtime/wasmgc/values/to-primitive-bodies.ts",
] as const;
export const resumeMainSha = (source: string) => createHash("sha256").update(source).digest("hex");
/** Peel the exact eager-body extraction before every pre-existing source receipt. */
export const readMergedSource = (path: string): string => {
  const raw = beforeDeliveryMainRefresh(path, readBeforeArrayMainRefresh(path));
  const source = path === "src/codegen/object-runtime.ts" ? applyOwnPropertyExtraction(raw, true) : raw;
  return beforeBigIntCarrierPort(path, beforeDescriptorAdapterRelocation(path, source));
};
export const resumeMainCompositionText = readMergedSource(resumeMainFixturePath);

interface SourcePin {
  gitBlob: string;
  sha256: string;
}
interface Span {
  ordinal: number;
  beforeStart: number;
  afterStart: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
}
interface Record {
  path: string;
  prior: SourcePin;
  mergedSha256: string;
  upstream: { mergeBase: SourcePin | null; main: SourcePin | null };
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  priorCommit: string;
  mainCommit: string;
  mergeBase: string;
  records: Record[];
}

/** Fixed Git-authenticated receipt. No historical complete source is a replacement operand. */
export function authenticateResumeMainComposition(text = resumeMainCompositionText): Receipt {
  if (resumeMainSha(text) !== fixtureSha) throw new Error("resume-main receipt digest mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.priorCommit !== resumeMainPrior ||
    receipt.mainCommit !== resumeMainUpstream ||
    receipt.mergeBase !== "62221769a87acdc32759c656702eede64936feb5" ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(resumeMainPaths)
  )
    throw new Error("resume-main provenance mismatch");
  for (const row of receipt.records) {
    const pins = [row.prior, row.upstream.mergeBase, row.upstream.main].filter((pin) => pin !== null);
    if (
      !/^[a-f0-9]{64}$/.test(row.mergedSha256) ||
      pins.some((pin) => !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256)) ||
      row.spans.length === 0
    )
      throw new Error("resume-main source provenance mismatch");
    let beforeEnd = 0;
    let afterEnd = 0;
    for (const [ordinal, span] of row.spans.entries()) {
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        !Number.isInteger(span.beforeStart) ||
        !Number.isInteger(span.afterStart) ||
        span.beforeStart < beforeEnd ||
        span.afterStart < afterEnd ||
        resumeMainSha(span.before) !== span.beforeSha256 ||
        resumeMainSha(span.after) !== span.afterSha256
      )
        throw new Error("resume-main receipt span mismatch");
      beforeEnd = span.beforeStart + span.before.length;
      afterEnd = span.afterStart + span.after.length;
    }
  }
  return receipt;
}

function transform(source: string, row: Record, inverse: boolean): string {
  let previousEnd = 0;
  const spans = row.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const to = inverse ? span.before : span.after;
    const start = source.indexOf(from);
    if (start < 0 || source.indexOf(from, start + 1) !== -1)
      throw new Error(`resume-main span missing or duplicated: ${row.path}:${span.ordinal}`);
    if (start < previousEnd) throw new Error(`resume-main span order mismatch: ${row.path}:${span.ordinal}`);
    previousEnd = start + from.length;
    if (start !== (inverse ? span.afterStart : span.beforeStart))
      throw new Error(`resume-main span offset mismatch: ${row.path}:${span.ordinal}`);
    return { start, end: previousEnd, to };
  });
  const inputSha = inverse ? row.mergedSha256 : row.prior.sha256;
  if (resumeMainSha(source) !== inputSha) throw new Error(`resume-main retained source mismatch: ${row.path}`);
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.to + source.slice(span.end);
  const outputSha = inverse ? row.prior.sha256 : row.mergedSha256;
  if (resumeMainSha(source) !== outputSha) throw new Error(`resume-main reconstruction mismatch: ${row.path}`);
  return source;
}

/** Current merged bytes -> exact prior bytes, or reciprocal replay, with no permissive old-source mode. */
export function applyResumeMainComposition(
  path: string,
  source: string,
  inverse: boolean,
  text = resumeMainCompositionText,
): string {
  const row = authenticateResumeMainComposition(text).records.find((candidate) => candidate.path === path);
  if (!row) throw new Error("unrecorded resume-main source");
  const result = transform(source, row, inverse);
  if (transform(result, row, !inverse) !== source) throw new Error("resume-main reciprocal replay mismatch");
  return result;
}

/** Preservation-only reader. Runtime imports and compiler executions never use this view. */
export function readBeforeResumeMain(path: string): string {
  const source = readBeforePrototypeRead(path, readMergedSource);
  return resumeMainPaths.some((candidate) => candidate === path)
    ? applyResumeMainComposition(path, source, true)
    : source;
}
