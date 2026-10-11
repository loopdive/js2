// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const descriptorUndefinedReceiptPath = "tests/fixtures/issue-3518-descriptor-undefined-correction.json";
const receiptHash = "2a86a79619ace64857d59652e85f24dd132576d67a93e61dc583c00797794ce6";
export const descriptorUndefinedPaths = [
  "src/codegen/object-runtime-descriptors.ts",
  "src/runtime/wasmgc/values/ordinary-object-descriptor-data.ts",
] as const;
const read = (path: string) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
interface Span {
  before: string;
  after: string;
  beforeOffset: number;
  afterOffset: number;
}
interface Record {
  path: string;
  beforeSHA256: string;
  beforeGitBlob: string;
  afterSHA256: string;
  spans: Span[];
}
export function descriptorUndefinedReceipt(text = read(descriptorUndefinedReceiptPath)) {
  if (sha256(text) !== receiptHash) throw Error("descriptor undefined receipt mismatch");
  const receipt = JSON.parse(text) as { base: string; records: Record[] };
  if (
    receipt.base !== "65448565c7358581ca3e229fd3ce7537fae4b41f" ||
    receipt.records.length !== descriptorUndefinedPaths.length ||
    receipt.records.some((row, i) => row.path !== descriptorUndefinedPaths[i])
  )
    throw Error("descriptor undefined provenance mismatch");
  return receipt;
}
/** Only the declared forward semantic correction is removed before old validators. */
export function applyDescriptorUndefinedCorrection(
  path: string,
  source: string,
  inverse: boolean,
  receiptText?: string,
): string {
  const row = descriptorUndefinedReceipt(receiptText).records.find((record) => record.path === path);
  if (!row) throw Error("unknown descriptor undefined path");
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  if (sha256(source) !== row[inverse ? "afterSHA256" : "beforeSHA256"])
    throw Error("descriptor undefined source mismatch");
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (
      !span[from] ||
      at < cursor ||
      source.indexOf(span[from], at + 1) >= 0 ||
      at !== span[inverse ? "afterOffset" : "beforeOffset"]
    )
      throw Error("descriptor undefined span missing, duplicated or reordered");
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  result += source.slice(cursor);
  if (sha256(result) !== row[inverse ? "beforeSHA256" : "afterSHA256"])
    throw Error("descriptor undefined retained source mismatch");
  const historical = inverse ? result : source;
  const blob = createHash("sha1")
    .update("blob " + Buffer.byteLength(historical) + "\0")
    .update(historical)
    .digest("hex");
  if (blob !== row.beforeGitBlob) throw Error("descriptor undefined Git blob mismatch");
  return result;
}
export function beforeDescriptorUndefinedCorrection(path: string, source: string): string {
  if (!(descriptorUndefinedPaths as readonly string[]).includes(path)) return source;
  const historical = applyDescriptorUndefinedCorrection(path, source, true);
  if (applyDescriptorUndefinedCorrection(path, historical, false) !== source)
    throw Error("descriptor undefined replay mismatch");
  return historical;
}
