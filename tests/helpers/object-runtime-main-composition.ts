// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const objectRuntimeMainCompositionText = readFileSync(
  new URL("../fixtures/issue-3518-object-runtime-main-composition.json", import.meta.url),
  "utf8",
);
const RECEIPT_SHA = "ed26456f914cc37c9f42c3da0d03b2501007acdea6d1f71a85fb1c8863e8e383";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Source {
  commit: string;
  blob: string;
  sha256: string;
}
interface Span {
  ordinal: number;
  baseStartLine: number;
  baseEndLine: number;
  mainStartLine: number;
  mainEndLine: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
}
interface Receipt {
  schemaVersion: number;
  kind: string;
  path: string;
  base: Source;
  main: Source;
  integration: Source;
  spans: Span[];
}

/** The three full-source hashes and Git blobs were checked against fixed signed commits. */
export function authenticateObjectRuntimeMainComposition(text = objectRuntimeMainCompositionText): Receipt {
  if (sha(text) !== RECEIPT_SHA) throw new Error("main composition receipt digest mismatch");
  const r = JSON.parse(text) as Receipt;
  if (
    r.schemaVersion !== 1 ||
    r.kind !== "signed-main-forward-composition-not-replacement-donor" ||
    r.path !== "src/codegen/object-runtime.ts" ||
    r.base.commit !== "750fb7e7365692b315179dc909b57fa1407d4527" ||
    r.main.commit !== "35e040c08ed10f793faf26bb0f0eac55be662627" ||
    r.integration.commit !== "20dd4850644dc3b42802d31fa15ddbc3ee0a4800" ||
    r.spans.length !== 19
  )
    throw new Error("main composition provenance mismatch");
  let baseEnd = 0;
  let mainEnd = 0;
  for (const [ordinal, span] of r.spans.entries()) {
    if (
      span.ordinal !== ordinal ||
      span.baseStartLine <= baseEnd ||
      span.mainStartLine <= mainEnd ||
      span.baseEndLine < span.baseStartLine ||
      span.mainEndLine < span.mainStartLine ||
      !span.before ||
      !span.after ||
      span.before === span.after ||
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256
    )
      throw new Error("main composition span provenance mismatch");
    baseEnd = span.baseEndLine;
    mainEnd = span.mainEndLine;
  }
  return r;
}

/** Change only declared spans; the caller's original full-source checks remain required. */
export function applyObjectRuntimeMainComposition(source: string, inverse: boolean): string {
  const r = authenticateObjectRuntimeMainComposition();
  let previousEnd = 0;
  const spans = r.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (start < 0 || source.indexOf(from, start + 1) !== -1)
      throw new Error(`main composition span missing or duplicated: ${span.ordinal}`);
    if (start < previousEnd) throw new Error(`main composition span order mismatch: ${span.ordinal}`);
    previousEnd = start + from.length;
    return { start, end: previousEnd, to: inverse ? span.before : span.after };
  });
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.to + source.slice(span.end);
  return source;
}

export function invertObjectRuntimeMainComposition(source: string): string {
  return applyObjectRuntimeMainComposition(source, true);
}

/** Reconstruct the entire signed integration source, then reproduce the actual joined bytes. */
export function verifyObjectRuntimeMainComposition(source: string): string {
  const r = authenticateObjectRuntimeMainComposition();
  const integration = invertObjectRuntimeMainComposition(source);
  if (sha(integration) !== r.integration.sha256) throw new Error("main composition retained source mismatch");
  if (applyObjectRuntimeMainComposition(integration, false) !== source)
    throw new Error("main composition forward replay mismatch");
  return integration;
}
