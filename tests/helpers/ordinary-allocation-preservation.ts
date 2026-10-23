// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const allocationPrefixPath = "src/runtime/wasmgc/values/ordinary-object-storage-bodies.ts";
export const allocationPrefixReceiptPath = "tests/fixtures/issue-7139-ordinary-allocation-prefix.json";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const receiptHash = "1719bed69fde64fc3c9ee11c02aaee5c261391a911f163dec2ccc07e59c5d1c3";
interface Receipt {
  base: string;
  path: string;
  beforeSHA256: string;
  beforeGitBlob: string;
  afterSHA256: string;
  offset: number;
  before: string;
  after: string;
}
export function allocationPrefixReceipt(
  text = readFileSync(new URL("../../" + allocationPrefixReceiptPath, import.meta.url), "utf8"),
): Receipt {
  if (hash(text) !== receiptHash) throw Error("ordinary allocation receipt mismatch");
  return JSON.parse(text) as Receipt;
}
/** Exact reversible source refactor view; never used by runtime imports. */
export function applyAllocationPrefixPreservation(
  path: string,
  source: string,
  inverse: boolean,
  text?: string,
): string {
  if (path !== allocationPrefixPath) throw Error("unrecorded ordinary allocation path");
  const r = allocationPrefixReceipt(text),
    from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  if (
    hash(source) !== r[inverse ? "afterSHA256" : "beforeSHA256"] ||
    source.indexOf(r[from]) !== r.offset ||
    source.indexOf(r[from], r.offset + 1) !== -1
  )
    throw Error("ordinary allocation retained source mismatch");
  const result = source.slice(0, r.offset) + r[to] + source.slice(r.offset + r[from].length);
  if (hash(result) !== r[inverse ? "beforeSHA256" : "afterSHA256"])
    throw Error("ordinary allocation reconstructed source mismatch");
  const historical = inverse ? result : source;
  const blob = createHash("sha1")
    .update("blob " + Buffer.byteLength(historical) + "\0")
    .update(historical)
    .digest("hex");
  if (blob !== r.beforeGitBlob) throw Error("ordinary allocation Git blob mismatch");
  return result;
}
export function beforeAllocationPrefixPreservation(path: string, source: string): string {
  if (path !== allocationPrefixPath) return source;
  const before = applyAllocationPrefixPreservation(path, source, true);
  if (applyAllocationPrefixPreservation(path, before, false) !== source)
    throw Error("ordinary allocation replay mismatch");
  return before;
}
