// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const ownPropertyReceiptPath = "tests/fixtures/issue-3518-own-property-extraction.json";
export function ownPropertyReceipt(reader = read) {
  const text = reader(ownPropertyReceiptPath);
  if (sha(text) !== "b10bc19653336ab5117e7671a39e3419df27e8e38582cd3dfc2bd0859d44d145")
    throw new Error("own property receipt mismatch");
  const receipt = JSON.parse(text) as {
    base: string;
    path: string;
    baseSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { path: string; sha256: string }[];
  };
  for (const module of receipt.modules)
    if (sha(reader(module.path)) !== module.sha256) throw new Error("own property builder mismatch");
  return receipt;
}
/** Outer extraction normalization; callers still enforce every historical hash. */
export function applyOwnPropertyExtraction(source: string, inverse: boolean, reader = read): string {
  const receipt = ownPropertyReceipt(reader);
  if (sha(source) !== (inverse ? receipt.afterSha256 : receipt.baseSha256))
    throw new Error("own property source mismatch");
  let previousEnd = 0;
  const replacements = receipt.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < previousEnd || source.indexOf(from, start + 1) !== -1)
      throw new Error("own property extraction span missing, duplicated or reordered");
    previousEnd = start + from.length;
    return { start, end: previousEnd, text: inverse ? span.before : span.after };
  });
  for (const span of replacements.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? receipt.baseSha256 : receipt.afterSha256))
    throw new Error("own property result mismatch");
  return source;
}
