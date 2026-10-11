// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readBeforeResumeMain } from "./resume-main-composition.js";
import { applyPrototypeCompanionExtraction } from "./prototype-companion-extraction.js";
import { applyClosureApplyExtraction } from "./object-runtime-apply-extraction.js";
import { applyFnctorGuardForward } from "./object-runtime-fnctor-guard-forward.js";
import { createHash } from "node:crypto";
import { invertObjectWriteSource, replayObjectWriteSource, writeExtractionPath } from "./native-object-write-donor.js";
import {
  applyObjectRuntimeMainComposition,
  invertObjectRuntimeMainComposition,
} from "./object-runtime-main-composition.js";

export const conversionBase = "0ef8e0ea4c23829a4eba37dca6dd6822aa95265e";
export const objectRuntimePath = "src/codegen/object-runtime.ts";
export const protoIndexStorePath = "src/codegen/proto-index-store.ts";
export const protoIndexReadPath = "src/codegen/proto-index-read-bindings.ts";
export const conversionFixturePath = "tests/fixtures/issue-3518-conversion-source-composition.json";
const forwardPath = "tests/fixtures/issue-3518-to-primitive-wrapper-forward.json";
const presencePath = "tests/fixtures/issue-3518-to-primitive-presence-extraction.json";
const extractionPath = "tests/fixtures/issue-3518-to-primitive-extraction-baseline.json";
const RECEIPT_SHA = "1acca724b0809163b370921d8ad5860ee45b39f356a1ba5078515c0026ae7e35";
export const readConversionSource = readBeforeResumeMain;
type Reader = typeof readConversionSource;
export const conversionSha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Span {
  beforeStart: number;
  afterStart: number;
  before: string;
  after: string;
}
interface ForwardRow {
  path: string;
  beforeSha256: string;
  spans: Span[];
}
interface BaseRow {
  path: string;
  baseBlob: string;
  baseSha256: string;
  extractionSha256: string;
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  kind: string;
  base: string;
  extractionFixtureSha256: string;
  forwardFixtureSha256: string;
  presenceFixtureSha256: string;
  records: BaseRow[];
}
interface Presence {
  priorForwardFixtureSha256: string;
  store: ForwardRow & { afterSha256: string };
  modules: { path: string; sha256: string }[];
}
function checked<T>(path: string, digest: string, reader: Reader): T {
  const text = reader(path);
  if (conversionSha(text) !== digest) throw new Error(`conversion receipt digest mismatch: ${path}`);
  return JSON.parse(text) as T;
}

/** Existing receipts remain byte-identical; Git authenticated both base blobs at authoring. */
export function authenticateConversionComposition(reader: Reader = readConversionSource) {
  const receipt = checked<Receipt>(conversionFixturePath, RECEIPT_SHA, reader);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.base !== conversionBase ||
    receipt.kind !== "authenticated-conversion-composition-not-replacement-donor" ||
    receipt.records.map((r) => r.path).join() !== [objectRuntimePath, protoIndexStorePath].join()
  )
    throw new Error("conversion composition provenance mismatch");
  const extraction = checked<{ records: { path: string; sha256: string; text: string }[] }>(
    extractionPath,
    receipt.extractionFixtureSha256,
    reader,
  );
  const forward = checked<{ records: ForwardRow[]; extractionFixtureSha256: string }>(
    forwardPath,
    receipt.forwardFixtureSha256,
    reader,
  );
  const presence = checked<Presence>(presencePath, receipt.presenceFixtureSha256, reader);
  if (
    forward.extractionFixtureSha256 !== receipt.extractionFixtureSha256 ||
    presence.priorForwardFixtureSha256 !== receipt.forwardFixtureSha256 ||
    presence.store.path !== protoIndexStorePath
  )
    throw new Error("conversion receipt chain mismatch");
  for (const row of receipt.records) {
    const measured = extraction.records.find((r) => r.path === row.path);
    const correction = forward.records.find((r) => r.path === row.path);
    if (
      !measured ||
      !correction ||
      conversionSha(measured.text) !== row.extractionSha256 ||
      measured.sha256 !== row.extractionSha256 ||
      correction.beforeSha256 !== row.extractionSha256
    )
      throw new Error("conversion extraction provenance mismatch");
  }
  return { receipt, forward, presence };
}

/** Only declared spans are changed. Callers retain their original whole-source checks. */
export function applyConversionSpans(source: string, spans: readonly Span[], inverse: boolean): string {
  let end = 0;
  const replacements = spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < 0 || source.indexOf(from, start + 1) !== -1)
      throw new Error("conversion span missing or duplicated");
    if (start < end) throw new Error("conversion span order mismatch");
    end = start + from.length;
    return { start, end, to: inverse ? span.before : span.after };
  });
  for (const span of replacements.reverse()) source = source.slice(0, span.start) + span.to + source.slice(span.end);
  return source;
}

// This existing receipt includes empty deletion spans, so retain its authenticated
// complete-source coordinates and hashes in both directions, rather than searching for "".
function replacePresence(source: string, row: Presence["store"], inverse: boolean): string {
  if (conversionSha(source) !== (inverse ? row.afterSha256 : row.beforeSha256))
    throw new Error("changed composed presence store");
  let beforeEnd = 0;
  let afterEnd = 0;
  for (const span of row.spans) {
    const start = inverse ? span.afterStart : span.beforeStart;
    const from = inverse ? span.after : span.before;
    if (
      span.beforeStart < beforeEnd ||
      span.afterStart < afterEnd ||
      (!span.before && !span.after) ||
      source.slice(start, start + from.length) !== from
    )
      throw new Error("changed presence extraction span or order");
    beforeEnd = span.beforeStart + span.before.length;
    afterEnd = span.afterStart + span.after.length;
  }
  for (const span of [...row.spans].reverse()) {
    const start = inverse ? span.afterStart : span.beforeStart;
    source =
      source.slice(0, start) +
      (inverse ? span.before : span.after) +
      source.slice(start + (inverse ? span.after.length : span.before.length));
  }
  if (conversionSha(source) !== (inverse ? row.beforeSha256 : row.afterSha256))
    throw new Error("presence source reconstruction mismatch");
  return source;
}

export function authenticatedProtoIndexReadSource(reader: Reader = readConversionSource): string {
  const { presence } = authenticateConversionComposition(reader);
  for (const module of presence.modules)
    if (conversionSha(reader(module.path)) !== module.sha256) throw new Error("changed extracted presence module");
  return reader(protoIndexReadPath);
}

/** Historical entry for mutation controls, after authenticating and undoing the write layer. */
export function invertPreWriteConversionSource(
  path: string,
  source: string,
  reader: Reader = readConversionSource,
): string {
  const { receipt, forward, presence } = authenticateConversionComposition(reader);
  const row = receipt.records.find((r) => r.path === path);
  if (!row) throw new Error("unrecorded conversion source");
  if (path === objectRuntimePath) source = invertObjectRuntimeMainComposition(source);
  if (path === protoIndexStorePath) {
    authenticatedProtoIndexReadSource(reader);
    source = replacePresence(applyPrototypeCompanionExtraction(source, true, reader), presence.store, true);
  }
  source = applyConversionSpans(source, forward.records.find((r) => r.path === path)!.spans, true);
  return applyConversionSpans(source, row.spans, true);
}

export function invertConversionSource(path: string, source: string, reader: Reader = readConversionSource): string {
  if (path === objectRuntimePath) {
    source = applyFnctorGuardForward(applyClosureApplyExtraction(source, true), true);
    source = invertObjectWriteSource(path, source, reader(writeExtractionPath), reader);
  }
  return invertPreWriteConversionSource(path, source, reader);
}

/** Exact 0ef8 reconstruction plus reciprocal replay; no historical file is substituted. */
export function verifyConversionComposition(reader: Reader = readConversionSource) {
  const { receipt, forward, presence } = authenticateConversionComposition(reader);
  return receipt.records.map((row) => {
    const current = reader(row.path);
    const original = invertConversionSource(row.path, current, reader);
    if (conversionSha(original) !== row.baseSha256) throw new Error("conversion retained source mismatch");
    let replay = applyConversionSpans(original, row.spans, false);
    if (conversionSha(replay) !== row.extractionSha256) throw new Error("conversion extraction replay mismatch");
    replay = applyConversionSpans(replay, forward.records.find((r) => r.path === row.path)!.spans, false);
    if (row.path === protoIndexStorePath)
      replay = applyPrototypeCompanionExtraction(replacePresence(replay, presence.store, false), false, reader);
    if (row.path === objectRuntimePath)
      replay = applyClosureApplyExtraction(
        applyFnctorGuardForward(
          replayObjectWriteSource(
            row.path,
            applyObjectRuntimeMainComposition(replay, false),
            reader(writeExtractionPath),
            reader,
          ),
          false,
        ),
        false,
      );
    if (replay !== current) throw new Error("conversion forward replay mismatch");
    return { path: row.path, original, current };
  });
}
