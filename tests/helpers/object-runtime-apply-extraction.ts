// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const applyExtractionReceiptText = readFileSync(
  new URL("../fixtures/issue-3518-object-runtime-apply-extraction.json", import.meta.url),
  "utf8",
);
export const readApplyBuilderSource = () =>
  readFileSync(new URL("../../src/runtime/wasmgc/values/closure-apply-body.ts", import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
interface Receipt {
  schema: number;
  kind: string;
  path: string;
  builder: { path: string; commit: string; blob: string; sha256: string };
  spans: { id: string; before: string; after: string; beforeSha256: string; afterSha256: string }[];
}
export function authenticateApplyExtraction(
  text = applyExtractionReceiptText,
  builder = readApplyBuilderSource(),
): Receipt {
  if (sha(text) !== "bf239cec5740142325107965d3a5e026ca3025ea427bfc64103c73e97ff2c647")
    throw new Error("apply extraction receipt digest mismatch");
  const r = JSON.parse(text) as Receipt;
  if (
    r.schema !== 1 ||
    r.kind !== "signed-closure-apply-extraction" ||
    r.path !== "src/codegen/object-runtime.ts" ||
    r.spans.length !== 5
  )
    throw new Error("apply extraction provenance mismatch");
  if (sha(builder) !== r.builder.sha256) throw new Error("apply extraction actual builder mismatch");
  const ids = new Set<string>();
  for (const row of r.spans) {
    if (
      !row.id ||
      ids.has(row.id) ||
      !row.before ||
      !row.after ||
      row.before === row.after ||
      sha(row.before) !== row.beforeSha256 ||
      sha(row.after) !== row.afterSha256
    )
      throw new Error("apply extraction span provenance mismatch");
    ids.add(row.id);
  }
  return r;
}
/** Authenticate the actual builder; preserve all non-extraction bytes and old receipts. */
export function applyClosureApplyExtraction(
  source: string,
  inverse: boolean,
  builder = readApplyBuilderSource(),
): string {
  const r = authenticateApplyExtraction(applyExtractionReceiptText, builder);
  let end = 0;
  const spans = r.spans.map((row) => {
    const from = inverse ? row.after : row.before;
    const start = source.indexOf(from);
    if (start < 0 || source.indexOf(from, start + 1) !== -1)
      throw new Error("apply extraction span missing or duplicated: " + row.id);
    if (start < end) throw new Error("apply extraction span order mismatch");
    end = start + from.length;
    return { start, end, to: inverse ? row.before : row.after };
  });
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.to + source.slice(span.end);
  return source;
}
