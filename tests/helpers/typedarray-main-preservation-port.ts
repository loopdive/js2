// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const typedArrayMainPath = "src/codegen/expressions/calls.ts";
export const typedArrayMainDependency = "src/codegen/ta-static-from-of-spec.ts";
export const typedArrayMainFixture = "tests/fixtures/issue-3518-typedarray-main-preservation/receipt.json";
export const typedArrayMainPrior = "8a730516ced8ace5da216cbb8f5b5c54c064d421";
export const typedArrayMainCurrent = "25ee5b64b883b6d735b1072272a24d8740256e0b";
export const typedArrayMainCommit = "2b3b5d2dcb49cd2e28bceeba7569fe1312aeb51b";
const receiptSha = "81b51d14fa321ace63defb89741b0a1d0761c9e6ffcbb08edcde9e6e82e52dd2";
const sourcePins = {
  before: {
    sha256: "9c10b1a652c700eb2358b3e2f219a0626643319806824f05c5a9c20323402332",
    gitBlob: "0a6a6f87dbabdfcf5bd44a2b8b24291ff5cecc91",
    bytes: 519522,
    utf16Units: 517965,
  },
  after: {
    sha256: "bbfc57a121a6557ebcd279250bd0dd124e9eba7571cf03b20d35ec790ef1186c",
    gitBlob: "26c1c1643460d0382d24d8cedf3a6be70f253eff",
    bytes: 520725,
    utf16Units: 519164,
  },
} as const;
const dependencyPin = {
  sha256: "f3dfc889d30cb07bada46dda7f65a1601d5a91389a796f856d718544f093cbca",
  gitBlob: "6daa28466bf8271e611d2ea1715ea2c928779cad",
  bytes: 11099,
  utf16Units: 11064,
} as const;
export const typedArrayMainHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const typedArrayMainBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");
/** Raw live bytes only; no Git retrieval, historical source store, or fallback. */
export const readTypedArrayMainActualSource = (path: string): string =>
  readFileSync(new URL("../../" + path, import.meta.url), "utf8");
interface SourcePin {
  sha256: string;
  gitBlob: string;
  bytes: number;
  utf16Units: number;
}
interface SourceRecord {
  path: string;
  before: SourcePin;
  after: SourcePin;
  spans: {
    ordinal: number;
    beforeOffset: number;
    afterOffset: number;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  }[];
}
interface Receipt {
  schemaVersion: number;
  scope: string;
  priorCommit: string;
  currentCommit: string;
  sourceCommit: string;
  records: SourceRecord[];
  dependencies: (SourcePin & { path: string })[];
}
const pinFields = ["sha256", "gitBlob", "bytes", "utf16Units"] as const;
function assertSource(source: string, pin: SourcePin, detail: string): void {
  if (
    typedArrayMainHash(source) !== pin.sha256 ||
    typedArrayMainBlob(source) !== pin.gitBlob ||
    Buffer.byteLength(source) !== pin.bytes ||
    source.length !== pin.utf16Units
  )
    throw Error("typedarray-main " + detail + " source mismatch");
}

/** Fixed single-feature authority; a supplied reader still has to return the exact imported implementation. */
export function authenticateTypedArrayMainPreservation(
  text = readTypedArrayMainActualSource(typedArrayMainFixture),
  reader = readTypedArrayMainActualSource,
): Receipt {
  if (typedArrayMainHash(text) !== receiptSha) throw Error("typedarray-main receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.scope !== "preservation-only TypedArray intrinsic Call main evolution" ||
    receipt.priorCommit !== typedArrayMainPrior ||
    receipt.currentCommit !== typedArrayMainCurrent ||
    receipt.sourceCommit !== typedArrayMainCommit ||
    receipt.records.length !== 1 ||
    receipt.records[0]!.path !== typedArrayMainPath ||
    receipt.dependencies.length !== 1 ||
    receipt.dependencies[0]!.path !== typedArrayMainDependency
  )
    throw Error("typedarray-main provenance mismatch");
  const row = receipt.records[0]!,
    dependency = receipt.dependencies[0]!;
  for (const side of ["before", "after"] as const)
    for (const field of pinFields)
      if (row[side][field] !== sourcePins[side][field]) throw Error("typedarray-main source provenance mismatch");
  for (const field of pinFields)
    if (dependency[field] !== dependencyPin[field]) throw Error("typedarray-main dependency provenance mismatch");
  if (row.spans.length !== 2) throw Error("typedarray-main span population mismatch");
  for (const [index, span] of row.spans.entries())
    if (
      span.ordinal !== index ||
      span.beforeOffset !== [3438, 268847][index] ||
      span.afterOffset !== [3438, 268947][index] ||
      !span.before ||
      !span.after ||
      span.before === span.after ||
      typedArrayMainHash(span.before) !== span.beforeSha256 ||
      typedArrayMainHash(span.after) !== span.afterSha256
    )
      throw Error("typedarray-main receipt span mismatch");
  let source: string;
  try {
    source = reader(dependency.path);
  } catch {
    throw Error("typedarray-main dependency missing: " + dependency.path);
  }
  assertSource(source, dependency, "dependency " + dependency.path);
  return receipt;
}
function transform(row: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (at < 0 || source.indexOf(span[from], at + 1) !== -1)
      throw Error("typedarray-main span missing or duplicated: " + span.ordinal);
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error("typedarray-main span order or offset mismatch: " + span.ordinal);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  assertSource(source, row[from], "retained");
  result += source.slice(cursor);
  assertSource(result, row[to], "reconstructed");
  return result;
}

/** Replaces only supplied unique spans and proves complete reciprocal replay in both directions. */
export function applyTypedArrayMainPreservation(
  path: string,
  source: string,
  inverse: boolean,
  text = readTypedArrayMainActualSource(typedArrayMainFixture),
  reader = readTypedArrayMainActualSource,
): string {
  const row = authenticateTypedArrayMainPreservation(text, reader).records[0]!;
  if (path !== row.path) throw Error("unrecorded typedarray-main source");
  if (typeof source !== "string") throw Error("typedarray-main source must be text");
  if (typeof inverse !== "boolean") throw Error("typedarray-main direction must be boolean");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("typedarray-main reciprocal replay mismatch");
  return result;
}

/** Initial live input transport only; already-normalized mutation operands must bypass this function. */
export function beforeTypedArrayMainPreservation(path: string, source: string): string {
  return path === typedArrayMainPath ? applyTypedArrayMainPreservation(path, source, true) : source;
}
