// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const equalityCompositionReceiptPath = "tests/fixtures/issue-3518-string-equality-source-composition.json";
export function equalityCompositionReceipt(reader = read) {
  const text = reader(equalityCompositionReceiptPath);
  if (sha(text) !== "e200c83f881c445ff02eb0fa582cefdfc323c00e98defd993763ccf1c23f648c")
    throw Error("equality composition receipt mismatch");
  const record = JSON.parse(text) as {
    path: string;
    beforeSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { path: string; sha256: string }[];
  };
  for (const module of record.modules)
    if (sha(reader(module.path)) !== module.sha256) throw Error("equality builder mismatch");
  return record;
}
/** Tests-only inverse of the signed extraction; no execution-path normalization. */
export function composeStringEqualitySource(source: string, inverse: boolean, reader = read): string {
  const record = equalityCompositionReceipt(reader);
  const input = source;
  let end = 0;
  const spans = record.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < end || source.indexOf(from, start + 1) !== -1)
      throw Error("equality extraction span missing, altered, duplicated or reordered");
    end = start + from.length;
    return { start, end, text: inverse ? span.before : span.after };
  });
  if (sha(input) !== (inverse ? record.afterSha256 : record.beforeSha256))
    throw Error("equality complete input mismatch");
  for (const span of spans.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? record.beforeSha256 : record.afterSha256))
    throw Error("equality complete output mismatch");
  return source;
}
