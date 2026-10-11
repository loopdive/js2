// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const prototypeChainReceiptPath = "tests/fixtures/issue-3518-prototype-chain-extraction.json";
export function prototypeChainReceipt(reader = read) {
  const text = reader(prototypeChainReceiptPath);
  if (sha(text) !== "a5ac528871c293892f3da9c9a89f4514fffcb208136cedec1bb2304351a68dec")
    throw new Error("prototype chain receipt mismatch");
  const receipt = JSON.parse(text) as {
    base: string;
    path: string;
    baseSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { path: string; sha256: string }[];
  };
  for (const module of receipt.modules)
    if (sha(reader(module.path)) !== module.sha256) throw new Error("prototype chain builder mismatch");
  return receipt;
}
/** Outer extraction normalization; callers still enforce every historical hash. */
export function applyPrototypeChainExtraction(source: string, inverse: boolean, reader = read): string {
  const receipt = prototypeChainReceipt(reader);
  if (sha(source) !== (inverse ? receipt.afterSha256 : receipt.baseSha256))
    throw new Error("prototype chain source mismatch");
  let previousEnd = 0;
  const replacements = receipt.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < previousEnd || source.indexOf(from, start + 1) !== -1)
      throw new Error("prototype chain extraction span missing, duplicated or reordered");
    previousEnd = start + from.length;
    return { start, end: previousEnd, text: inverse ? span.before : span.after };
  });
  for (const span of replacements.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? receipt.baseSha256 : receipt.afterSha256))
    throw new Error("prototype chain result mismatch");
  return source;
}
