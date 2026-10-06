// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type Main4bffSuccessorReader = (path: string) => string;
export const main4bffSuccessorPaths = ["src/codegen/context/types.ts", "src/codegen/object-runtime.ts"] as const;
export const main4bffSuccessorReceiptPath = "tests/helpers/historical-promise-main4bff-successor.json";
export const main4bffSuccessorReceiptHash = "c5d6dd1866cb5db4f21affcabc93e1810036d7921ff91e85a5e7dde3e74ea836";
/** The physical reader never supplies a predecessor view. */
export const readMain4bffSuccessorRaw: Main4bffSuccessorReader = (path) =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const hash = (source: string): string => createHash("sha256").update(source).digest("hex");
const blob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");
interface Pin {
  bytes: number;
  utf16Length: number;
  sha256: string;
  gitBlob: string;
}
export interface Main4bffSuccessorRecord {
  path: string;
  before: Pin;
  after: Pin;
  spans: {
    ordinal: number;
    beforeOffset: number;
    afterOffset: number;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  }[];
  retained: { beforeOffset: number; afterOffset: number; length: number; sha256: string }[];
}
export interface Main4bffSuccessorReceipt {
  schemaVersion: number;
  kind: string;
  offsetUnit: string;
  records: Main4bffSuccessorRecord[];
}
const matches = (source: string, pin: Pin): boolean =>
  source.length === pin.utf16Length &&
  Buffer.byteLength(source) === pin.bytes &&
  hash(source) === pin.sha256 &&
  blob(source) === pin.gitBlob;

/** Fresh fixed authority for every owned operation; no Git or stored whole-source operand. */
export function authenticateMain4bffSuccessorReceipt(
  text: string = readMain4bffSuccessorRaw(main4bffSuccessorReceiptPath),
): Main4bffSuccessorReceipt {
  if (typeof text !== "string" || hash(text) !== main4bffSuccessorReceiptHash)
    throw Error("main4bff successor receipt mismatch");
  const receipt = JSON.parse(text) as Main4bffSuccessorReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "5883-main4bff-reader-successor" ||
    receipt.offsetUnit !== "utf16-code-units" ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(main4bffSuccessorPaths) ||
    JSON.stringify(receipt.records.map((row) => row.spans.length)) !== JSON.stringify([1, 2])
  )
    throw Error("main4bff successor receipt provenance mismatch");
  return receipt;
}
function transform(row: Main4bffSuccessorRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  if (!matches(source, row[from])) throw Error("main4bff successor input mismatch: " + row.path);
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = inverse ? span.afterOffset : span.beforeOffset;
    if (
      at < cursor ||
      source.slice(at, at + span[from].length) !== span[from] ||
      hash(span[from]) !== (inverse ? span.afterSha256 : span.beforeSha256)
    )
      throw Error("main4bff successor span mismatch: " + row.path);
    if (inverse && (source.indexOf(span.after) !== at || source.indexOf(span.after, at + 1) !== -1))
      throw Error("main4bff successor span missing or duplicated: " + row.path);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  result += source.slice(cursor);
  if (!matches(result, row[to])) throw Error("main4bff successor output mismatch: " + row.path);
  for (const keep of row.retained) {
    const inputAt = inverse ? keep.afterOffset : keep.beforeOffset;
    const outputAt = inverse ? keep.beforeOffset : keep.afterOffset;
    const retained = source.slice(inputAt, inputAt + keep.length);
    if (hash(retained) !== keep.sha256 || retained !== result.slice(outputAt, outputAt + keep.length))
      throw Error("main4bff successor retained mismatch: " + row.path);
  }
  return result;
}
/** Explicit source is the sole operand; reader supplies only fresh receipt authority. */
export function applyMain4bffSuccessorSource(
  path: string,
  source: string,
  inverse: boolean,
  reader: Main4bffSuccessorReader = readMain4bffSuccessorRaw,
): string {
  if (!main4bffSuccessorPaths.some((p) => p === path)) throw Error("unrecorded main4bff successor source");
  if (typeof source !== "string") throw Error("main4bff successor input must be text");
  const receipt = authenticateMain4bffSuccessorReceipt(reader(main4bffSuccessorReceiptPath));
  const row = receipt.records.find((row) => row.path === path)!;
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("main4bff successor reciprocal mismatch: " + path);
  return result;
}
/** Foreign paths pass through exactly without any authority read. */
export function projectMain4bffSuccessorSource(
  path: string,
  source: string,
  reader: Main4bffSuccessorReader = readMain4bffSuccessorRaw,
): string {
  return main4bffSuccessorPaths.some((p) => p === path)
    ? applyMain4bffSuccessorSource(path, source, true, reader)
    : source;
}
/** Recapture physical input on every call, including with the same supplied reader. */
export function readMain4bffSuccessorSource(
  path: string,
  reader: Main4bffSuccessorReader = readMain4bffSuccessorRaw,
): string {
  return projectMain4bffSuccessorSource(path, reader(path), reader);
}
