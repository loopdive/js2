// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const closureStatePath = "src/runtime/wasmgc/values/closure-layouts.ts";
export const closureStateFixture = "tests/fixtures/issue-3518-closure-state-preservation/receipt.json";
const fixtureSha = "fcba38b74541c4343282997d4b4f8fad364daa251d5f0f2f0d9552dbcadf7e8e";
const baseCommit = "8a730516ced8ace5da216cbb8f5b5c54c064d421";
const sourcePins = {
  before: {
    sha256: "f79e77c4bb0a0286c0c3462d80613f8a1c3c3ee861cab689f6fb0f1ad3dc9d7b",
    gitBlob: "d62858d3ba7c3668a47287325410dbdbc33ec67e",
    bytes: 9156,
    utf16Units: 9128,
  },
  after: {
    sha256: "7d9229c8c4a9bdae3d3105138b2c3c2685d0659e0b8f71df1b7fc2c0bc309d67",
    gitBlob: "931d2dcbf57b4c9c19160b30f82a92ab4121712e",
    bytes: 9293,
    utf16Units: 9265,
  },
} as const;
export const closureStateSha = (source: string): string => createHash("sha256").update(source).digest("hex");
export const closureStateBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");
const readReceipt = (): string => readFileSync(new URL("../../" + closureStateFixture, import.meta.url), "utf8");
interface SourcePin {
  sha256: string;
  gitBlob: string;
  bytes: number;
  utf16Units: number;
}
interface StateRecord {
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
interface StateReceipt {
  schemaVersion: number;
  scope: string;
  baseCommit: string;
  afterProvenance: { kind: string; branch: string; recordedOn: string; frozenInputReceipt: string };
  records: StateRecord[];
}

/** The after side records frozen, uncommitted feature bytes, not an invented published commit. */
export function authenticateClosureStatePreservation(text = readReceipt()): StateReceipt {
  if (closureStateSha(text) !== fixtureSha) throw Error("closure-state receipt digest mismatch");
  const receipt = JSON.parse(text) as StateReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.scope !== "preservation-only native realm state interface addition" ||
    receipt.baseCommit !== baseCommit ||
    receipt.afterProvenance.kind !== "uncommitted-working-tree" ||
    receipt.afterProvenance.branch !== "codex/3518-public-native-object-number-graph-20260930" ||
    receipt.afterProvenance.recordedOn !== "2026-09-30" ||
    receipt.afterProvenance.frozenInputReceipt !==
      ".tmp/public-native-object-number-graph/pending-preservation-3e7363bn/inputs-before.json" ||
    receipt.records.length !== 1 ||
    receipt.records[0]!.path !== closureStatePath
  )
    throw Error("closure-state provenance mismatch");
  const row = receipt.records[0]!;
  for (const side of ["before", "after"] as const)
    for (const field of ["sha256", "gitBlob", "bytes", "utf16Units"] as const)
      if (row[side][field] !== sourcePins[side][field]) throw Error("closure-state source provenance mismatch");
  const first = "  readonly domCallbackAuthorityGlobalIdx?: () => number;\n";
  const addition =
    "  /** Stable handle issued by the native realm state owner; called after all captures. */\n" +
    "  readonly realmStateInitializer?: FuncHandle;\n";
  const span = row.spans[0]!;
  if (
    row.spans.length !== 1 ||
    span.ordinal !== 0 ||
    span.beforeOffset !== 3405 ||
    span.afterOffset !== 3405 ||
    span.before !== first + "}\n" ||
    span.after !== first + addition + "}\n" ||
    closureStateSha(span.before) !== span.beforeSha256 ||
    closureStateSha(span.after) !== span.afterSha256
  )
    throw Error("closure-state receipt span mismatch");
  return receipt;
}
function assertSource(source: string, pin: SourcePin, detail: string): void {
  if (
    closureStateSha(source) !== pin.sha256 ||
    closureStateBlob(source) !== pin.gitBlob ||
    Buffer.byteLength(source) !== pin.bytes ||
    source.length !== pin.utf16Units
  )
    throw Error("closure-state " + detail + " source mismatch");
}
function transform(row: StateRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after",
    span = row.spans[0]!,
    at = source.indexOf(span[from]);
  if (at < 0 || source.indexOf(span[from], at + 1) !== -1) throw Error("closure-state span missing or duplicated");
  if (at !== span[inverse ? "afterOffset" : "beforeOffset"]) throw Error("closure-state span offset mismatch");
  assertSource(source, row[from], "retained");
  const result = source.slice(0, at) + span[to] + source.slice(at + span[from].length);
  assertSource(result, row[to], "reconstructed");
  return result;
}

/** Only the actual supplied span is replaced; complete historical blobs are comparison evidence. */
export function applyClosureStatePreservation(
  path: string,
  source: string,
  inverse: boolean,
  text = readReceipt(),
): string {
  const row = authenticateClosureStatePreservation(text).records[0]!;
  if (path !== row.path) throw Error("unrecorded closure-state source");
  if (typeof inverse !== "boolean") throw Error("closure-state direction must be boolean");
  if (typeof source !== "string") throw Error("closure-state source must be text");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("closure-state reciprocal replay mismatch");
  return result;
}

/** Initial preservation read only; later injected mutations and runtime imports never use this view. */
export function beforeClosureStatePreservation(path: string, source: string): string {
  return path === closureStatePath ? applyClosureStatePreservation(path, source, true) : source;
}
