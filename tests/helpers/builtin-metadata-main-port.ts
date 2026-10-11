// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const builtinMetadataParent = "36f92e89171e7f0735e8ab59a71bd9c8757302d9";
export const builtinMetadataMain = "e765c7fb29449ffefa99784b78db766c8555c936";
export const builtinMetadataPath = "src/codegen/builtin-fn-meta.ts";
export const builtinMetadataFixture = "tests/fixtures/issue-3518-builtin-metadata-main-port.json";
const receiptHash = "711885baa5f738f6074ced7f4d538bcc9af7e16c35a0844fedb5f41c319504a7";
const sourcePins = {
  before: {
    gitBlob: "ca008873b1a7e9d85c9107876720c93890350a84",
    sha256: "433155d07adba216ef8e61e9897ffe0c3935d7fe659a2555a7bf59064340c0b2",
  },
  after: {
    gitBlob: "a898c6e57391ad2f6aee3bd694462eab721e4808",
    sha256: "61a65b087cd30897debcc79e60640656bba990ef4452dc67fd6631d9cf0c1755",
  },
} as const;
export const readBuiltinMetadataSource = (path: string): string =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
export const builtinMetadataHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const builtinMetadataBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");

interface SourcePin {
  gitBlob: string;
  sha256: string;
}
interface SourceRecord {
  path: string;
  before: SourcePin;
  after: SourcePin;
  span: {
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
    beforeOffset: number;
    afterOffset: number;
  };
}
interface Receipt {
  schemaVersion: number;
  parentCommit: string;
  mainCommit: string;
  record: SourceRecord;
}

/** Fixed metadata-table addition only; it introduced no imports or executable dependencies. */
export function authenticateBuiltinMetadataMain(text = readBuiltinMetadataSource(builtinMetadataFixture)): Receipt {
  if (builtinMetadataHash(text) !== receiptHash) throw Error("builtin-metadata receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  const { record } = receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.parentCommit !== builtinMetadataParent ||
    receipt.mainCommit !== builtinMetadataMain ||
    record.path !== builtinMetadataPath
  )
    throw Error("builtin-metadata provenance mismatch");
  for (const side of ["before", "after"] as const)
    if (record[side].gitBlob !== sourcePins[side].gitBlob || record[side].sha256 !== sourcePins[side].sha256)
      throw Error("builtin-metadata source provenance mismatch");
  const first = '  "Object.keys": { name: "keys", length: 1 },\n';
  const last = '  "Object.getOwnPropertyDescriptor": { name: "getOwnPropertyDescriptor", length: 2 },\n';
  const addition =
    "  // (#6684) One-slot closure ABI (see the builtin-value-read case); spec `.length` 2.\n" +
    '  "Object.create": { name: "create", length: 2 },\n';
  const { span } = record;
  if (
    span.before !== first + last ||
    span.after !== first + addition + last ||
    builtinMetadataHash(span.before) !== span.beforeSha256 ||
    builtinMetadataHash(span.after) !== span.afterSha256 ||
    span.beforeOffset !== 3462 ||
    span.afterOffset !== 3462
  )
    throw Error("builtin-metadata receipt span mismatch");
  return receipt;
}

function transform(record: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after",
    span = record.span,
    at = source.indexOf(span[from]);
  if (at < 0 || source.indexOf(span[from], at + 1) !== -1) throw Error("builtin-metadata span missing or duplicated");
  if (at !== span[inverse ? "afterOffset" : "beforeOffset"]) throw Error("builtin-metadata span offset mismatch");
  if (builtinMetadataHash(source) !== record[from].sha256 || builtinMetadataBlob(source) !== record[from].gitBlob)
    throw Error("builtin-metadata retained source mismatch");
  const result = source.slice(0, at) + span[to] + source.slice(at + span[from].length);
  if (builtinMetadataHash(result) !== record[to].sha256 || builtinMetadataBlob(result) !== record[to].gitBlob)
    throw Error("builtin-metadata reconstruction mismatch");
  return result;
}

/** Transform the actual source span and replay it; historical complete files are never replacement operands. */
export function applyBuiltinMetadataMain(
  path: string,
  source: string,
  inverse: boolean,
  text = readBuiltinMetadataSource(builtinMetadataFixture),
): string {
  const { record } = authenticateBuiltinMetadataMain(text);
  if (path !== record.path) throw Error("unrecorded builtin-metadata source");
  const result = transform(record, source, inverse);
  if (transform(record, result, !inverse) !== source) throw Error("builtin-metadata reciprocal replay mismatch");
  return result;
}

/** Normalize only the initial preservation read, before the older tests inject their own mutations. */
export function beforeBuiltinMetadataMain(path: string, source: string): string {
  return path === builtinMetadataPath ? applyBuiltinMetadataMain(path, source, true) : source;
}
