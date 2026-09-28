// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyPrototypeReceiverExtraction } from "./prototype-receiver-extraction.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const prototypeReadReceiptPath = "tests/fixtures/issue-3518-prototype-read-extraction.json";
export function prototypeReadReceipt(reader = read) {
  const text = reader(prototypeReadReceiptPath);
  if (sha(text) !== "b0210ee4d135c5023a30683179a825006eff5775b620dd07e5e871ede103e90b")
    throw new Error("prototype read receipt mismatch");
  const receipt = JSON.parse(text) as {
    base: string;
    path: string;
    baseSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { path: string; sha256: string }[];
  };
  for (const module of receipt.modules)
    if (sha(reader(module.path)) !== module.sha256) throw new Error("prototype read builder mismatch");
  return receipt;
}
/** Outer extraction normalization; callers still enforce every historical hash. */
export function applyPrototypeReadExtraction(source: string, inverse: boolean, reader = read): string {
  const receipt = prototypeReadReceipt(reader);
  let previousEnd = 0;
  const replacements = receipt.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < previousEnd || source.indexOf(from, start + 1) !== -1)
      throw new Error("prototype read extraction span missing, duplicated or reordered");
    previousEnd = start + from.length;
    return { start, end: previousEnd, text: inverse ? span.before : span.after };
  });
  for (const span of replacements.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  return source;
}

/** Only the preservation view strips this later extraction; runtime reads stay raw. */
export function readBeforePrototypeRead(path: string, reader = read): string {
  const source = reader(path);
  return path === "src/codegen/proto-index-store.ts"
    ? applyPrototypeReadExtraction(applyPrototypeReceiverExtraction(source, true), true)
    : source;
}
