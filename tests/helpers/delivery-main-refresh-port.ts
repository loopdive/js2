// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readBeforeArrayMainRefresh } from "./array-main-refresh-port.js";

export const deliveryMainPrior = "91d954797abe9e461032a6e7e1d374404157bfa4";
export const deliveryMainUpstream = "f2e06e122439bc5b4c5629abc6f9d76e5a23c432";
export const deliveryMainMergeBase = "359c2d63b6753e0c540b8761d13647b00e24a9a4";
export const deliveryMainFixture = "tests/fixtures/issue-3518-delivery-main-refresh-port.json";
const receiptHash = "e5d0c8de3cccd647b1f2c77aeb6a208241dcd6248781e580ce050ff8f5b39172";
export const deliveryMainPaths = ["src/codegen/expressions/calls.ts", "src/codegen/registry/imports.ts"] as const;
export const readDeliveryMainSource = readBeforeArrayMainRefresh;
export const deliveryMainHash = (source: string): string => createHash("sha256").update(source).digest("hex");
export const deliveryMainBlob = (source: string): string =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(source) + "\0")
    .update(source)
    .digest("hex");

interface SourcePin {
  gitBlob: string;
  sha256: string;
}
interface Span {
  ordinal: number;
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
  beforeOffset: number;
  afterOffset: number;
  upstreamBeforeOffset: number;
  upstreamAfterOffset: number;
}
interface SourceRecord {
  path: string;
  before: SourcePin;
  after: SourcePin;
  upstream: { before: SourcePin; after: SourcePin };
  spans: Span[];
}
interface Receipt {
  schemaVersion: number;
  priorCommit: string;
  mainCommit: string;
  mergeBase: string;
  records: SourceRecord[];
  dependencies: (SourcePin & { path: string })[];
}

/** Pins the exact incoming deltas and the actual implementation imported by the new call-site guard. */
export function authenticateDeliveryMainRefresh(
  text = readDeliveryMainSource(deliveryMainFixture),
  reader = readDeliveryMainSource,
): Receipt {
  if (deliveryMainHash(text) !== receiptHash) throw Error("delivery-main receipt mismatch");
  const receipt = JSON.parse(text) as Receipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.priorCommit !== deliveryMainPrior ||
    receipt.mainCommit !== deliveryMainUpstream ||
    receipt.mergeBase !== deliveryMainMergeBase ||
    JSON.stringify(receipt.records.map((row) => row.path)) !== JSON.stringify(deliveryMainPaths) ||
    JSON.stringify(receipt.dependencies.map((row) => row.path)) !==
      JSON.stringify(["src/codegen/object-proto-has-own-property.ts"])
  )
    throw Error("delivery-main provenance mismatch");
  for (const row of receipt.records) {
    const pins = [row.before, row.after, row.upstream.before, row.upstream.after];
    if (
      pins.some((pin) => !/^[a-f0-9]{40}$/.test(pin.gitBlob) || !/^[a-f0-9]{64}$/.test(pin.sha256)) ||
      row.spans.length === 0
    )
      throw Error("delivery-main source provenance mismatch");
    const ends = [0, 0, 0, 0];
    for (const [ordinal, span] of row.spans.entries()) {
      const offsets = [span.beforeOffset, span.afterOffset, span.upstreamBeforeOffset, span.upstreamAfterOffset];
      if (
        span.ordinal !== ordinal ||
        !span.before ||
        !span.after ||
        span.before === span.after ||
        deliveryMainHash(span.before) !== span.beforeSha256 ||
        deliveryMainHash(span.after) !== span.afterSha256 ||
        offsets.some((offset, index) => !Number.isInteger(offset) || offset < ends[index]!)
      )
        throw Error("delivery-main receipt span mismatch");
      offsets.forEach((offset, index) => {
        ends[index] = offset + (index % 2 === 0 ? span.before.length : span.after.length);
      });
    }
  }
  for (const row of receipt.dependencies) {
    let source: string;
    try {
      source = reader(row.path);
    } catch {
      throw Error("delivery-main dependency missing: " + row.path);
    }
    if (deliveryMainHash(source) !== row.sha256 || deliveryMainBlob(source) !== row.gitBlob)
      throw Error("delivery-main dependency mismatch: " + row.path);
  }
  return receipt;
}

function transform(row: SourceRecord, source: string, inverse: boolean): string {
  const from = inverse ? "after" : "before",
    to = inverse ? "before" : "after";
  let cursor = 0,
    result = "";
  for (const span of row.spans) {
    const at = source.indexOf(span[from]);
    if (at < 0 || source.indexOf(span[from], at + 1) >= 0)
      throw Error(`delivery-main span missing or duplicated: ${row.path}:${span.ordinal}`);
    if (at < cursor || at !== span[inverse ? "afterOffset" : "beforeOffset"])
      throw Error(`delivery-main span order or offset mismatch: ${row.path}:${span.ordinal}`);
    result += source.slice(cursor, at) + span[to];
    cursor = at + span[from].length;
  }
  if (deliveryMainHash(source) !== row[from].sha256 || deliveryMainBlob(source) !== row[from].gitBlob)
    throw Error("delivery-main retained source mismatch: " + row.path);
  result += source.slice(cursor);
  if (deliveryMainHash(result) !== row[to].sha256 || deliveryMainBlob(result) !== row[to].gitBlob)
    throw Error("delivery-main reconstruction mismatch: " + row.path);
  return result;
}

/** Operates only on unique, ordered spans of actual input; complete historical files are never operands. */
export function applyDeliveryMainRefresh(
  path: string,
  source: string,
  inverse: boolean,
  text = readDeliveryMainSource(deliveryMainFixture),
  reader = readDeliveryMainSource,
): string {
  const row = authenticateDeliveryMainRefresh(text, reader).records.find((candidate) => candidate.path === path);
  if (!row) throw Error("unrecorded delivery-main source");
  const result = transform(row, source, inverse);
  if (transform(row, result, !inverse) !== source) throw Error("delivery-main reciprocal replay mismatch");
  return result;
}

/** Preservation-only view. Runtime compilation never imports this helper. */
export function beforeDeliveryMainRefresh(path: string, source: string): string {
  return (deliveryMainPaths as readonly string[]).includes(path)
    ? applyDeliveryMainRefresh(path, source, true)
    : source;
}
