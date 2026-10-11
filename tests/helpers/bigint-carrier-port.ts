// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const bigintPortBase = "f52f6ae020d6d5ddb07e69a3b18811a5b4f86c24";
export const bigintPortFixture = "tests/fixtures/issue-3518-bigint-carrier-port.json";
const receiptHash = "4b6214afe2ccf68e3c45e3cd8e2497d22cd71ce4fc32c5cf572acad150be7a43";
export const bigintPortPaths = [
  "src/codegen/bigint-wide.ts",
  "src/codegen/registry/imports.ts",
  "src/codegen/object-runtime-enumeration.ts",
  "src/runtime/wasmgc/values/object-same-value-body.ts",
] as const;
export const readBigIntPortSource = (path: string): string =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const bigintPortHash = (source: string) => createHash("sha256").update(source).digest("hex");
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
interface Receipt {
  base: string;
  records: Record[];
  modules: { path: string; sha256: string }[];
}
export function authenticateBigIntCarrierPort(
  text = readBigIntPortSource(bigintPortFixture),
  reader = readBigIntPortSource,
): Receipt {
  if (bigintPortHash(text) !== receiptHash) throw Error("BigInt carrier receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.base !== bigintPortBase ||
    JSON.stringify(receipt.records.map((r) => r.path)) !== JSON.stringify(bigintPortPaths)
  )
    throw Error("BigInt carrier provenance mismatch");
  if (
    JSON.stringify(receipt.modules.map((r) => r.path)) !==
    JSON.stringify([
      "src/runtime/wasmgc/values/bigint-carrier-layouts.ts",
      "src/runtime/wasmgc/values/bigint-carrier-body.ts",
    ])
  )
    throw Error("BigInt carrier module population mismatch");
  for (const row of receipt.modules)
    if (bigintPortHash(reader(row.path)) !== row.sha256) throw Error("BigInt carrier relocated module mismatch");
  return receipt;
}
function transform(row: Record, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (!span[from] || at < 0 || source.indexOf(span[from], at + 1) >= 0)
      throw Error("BigInt carrier span missing or duplicated");
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error("BigInt carrier span order or offset mismatch");
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (bigintPortHash(source) !== row[inverse ? "afterSHA256" : "beforeSHA256"])
    throw Error("BigInt carrier retained source mismatch");
  result += source.slice(cursor);
  if (bigintPortHash(result) !== row[inverse ? "beforeSHA256" : "afterSHA256"])
    throw Error("BigInt carrier reconstruction mismatch");
  const historical = inverse ? result : source;
  const blob = createHash("sha1")
    .update("blob " + Buffer.byteLength(historical) + "\0")
    .update(historical)
    .digest("hex");
  if (blob !== row.beforeGitBlob) throw Error("BigInt carrier donor Git blob mismatch");
  return result;
}
export function applyBigIntCarrierPort(
  path: string,
  source: string,
  inverse: boolean,
  text = readBigIntPortSource(bigintPortFixture),
  reader = readBigIntPortSource,
): string {
  const row = authenticateBigIntCarrierPort(text, reader).records.find((r) => r.path === path);
  if (!row) throw Error("unrecorded BigInt carrier source");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("BigInt carrier reciprocal replay mismatch");
  return result;
}
/** Preservation-only view of actual current bytes. Runtime compilation never imports this helper. */
export function beforeBigIntCarrierPort(path: string, source: string): string {
  return (bigintPortPaths as readonly string[]).includes(path) ? applyBigIntCarrierPort(path, source, true) : source;
}
