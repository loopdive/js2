// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyPrototypeSeederExtraction } from "./prototype-seeder-extraction.js";
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const prototypeSingletonReceiptPath = "tests/fixtures/issue-3518-prototype-singleton-extraction.json";
export function prototypeSingletonReceipt(reader = read) {
  const text = reader(prototypeSingletonReceiptPath);
  if (sha(text) !== "70eb0bca92ace588d64aad1cf0b331196cae645301e8436daf38e55b96709be8")
    throw new Error("prototype singleton receipt mismatch");
  const receipt = JSON.parse(text) as {
    base: string;
    path: string;
    baseSha256: string;
    afterSha256: string;
    spans: { before: string; after: string }[];
    modules: { path: string; sha256: string }[];
  };
  for (const module of receipt.modules)
    if (sha(reader(module.path)) !== module.sha256) throw new Error("prototype singleton builder mismatch");
  return receipt;
}
/** Outer extraction normalization; callers still enforce every historical hash. */
function applyOriginalPrototypeSingletonExtraction(source: string, inverse: boolean, reader = read): string {
  const receipt = prototypeSingletonReceipt(reader);
  if (sha(source) !== (inverse ? receipt.afterSha256 : receipt.baseSha256))
    throw new Error("prototype singleton source mismatch");
  let previousEnd = 0;
  const replacements = receipt.spans.map((span) => {
    const from = inverse ? span.after : span.before;
    const start = source.indexOf(from);
    if (!from || start < previousEnd || source.indexOf(from, start + 1) !== -1)
      throw new Error("prototype singleton extraction span missing, duplicated or reordered");
    previousEnd = start + from.length;
    return { start, end: previousEnd, text: inverse ? span.before : span.after };
  });
  for (const span of replacements.reverse()) source = source.slice(0, span.start) + span.text + source.slice(span.end);
  if (sha(source) !== (inverse ? receipt.baseSha256 : receipt.afterSha256))
    throw new Error("prototype singleton result mismatch");
  return source;
}

/** Compose the later lower-seeder extraction around the unchanged singleton proof. */
export function applyPrototypeSingletonExtraction(source: string, inverse: boolean, reader = read): string {
  const path = "src/codegen/native-proto.ts";
  return inverse
    ? applyOriginalPrototypeSingletonExtraction(
        applyPrototypeSeederExtraction(path, source, true, reader),
        true,
        reader,
      )
    : applyPrototypeSeederExtraction(
        path,
        applyOriginalPrototypeSingletonExtraction(source, false, reader),
        false,
        reader,
      );
}
