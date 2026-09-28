// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const prototypeReceiverReceiptPath = "tests/fixtures/issue-3518-prototype-receiver-extraction.json";
export function prototypeReceiverReceipt(reader = read) {
  const text = reader(prototypeReceiverReceiptPath);
  if (sha(text) !== "a7ab142c160b9da3771644c39cfb60554828086ea18f6f3736b7207cbe4632c3")
    throw new Error("prototype receiver receipt mismatch");
  const receipt = JSON.parse(text) as {
    base: string;
    path: string;
    baseSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { path: string; sha256: string }[];
  };
  for (const module of receipt.modules)
    if (sha(reader(module.path)) !== module.sha256) throw new Error("prototype receiver builder mismatch");
  return receipt;
}
/** Outer extraction normalization; callers still enforce every historical hash. */
export function applyPrototypeReceiverExtraction(source: string, inverse: boolean, reader = read): string {
  const receipt = prototypeReceiverReceipt(reader);
  if (sha(source) !== (inverse ? receipt.afterSha256 : receipt.baseSha256))
    throw new Error("prototype receiver source mismatch");
  let previousEnd = 0;
  const replacements = receipt.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < previousEnd || source.indexOf(from, start + 1) !== -1)
      throw new Error("prototype receiver extraction span missing, duplicated or reordered");
    previousEnd = start + from.length;
    return { start, end: previousEnd, text: inverse ? span.before : span.after };
  });
  for (const span of replacements.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? receipt.baseSha256 : receipt.afterSha256))
    throw new Error("prototype receiver result mismatch");
  return source;
}

/** Historical source view only; runtime imports continue to read the live adapter. */
export function readBeforePrototypeReceiver(path: string): string {
  const source = read(path);
  return path === "src/codegen/proto-index-store.ts" ? applyPrototypeReceiverExtraction(source, true) : source;
}
