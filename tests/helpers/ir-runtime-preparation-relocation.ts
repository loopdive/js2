// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

export const runtimePreparationRelocationReceiptPath = "tests/helpers/ir-runtime-preparation-relocation.json";
export const runtimePreparationRelocationCurrentPaths = Object.freeze([
  "src/ir/intrinsic-support.ts",
  "src/ir/runtime/intrinsic-preparation.ts",
] as const);
const receiptBytes = 19505;
const receiptSha256 = "226efc69784e601980b4285fb0e562aed23f225be4d8735c233ecc6070000458";
type Reader = (path: string) => string;
interface Pin {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface Segment {
  readonly kind: "unchanged" | "module-literal";
  readonly beforeStart: number;
  readonly beforeEnd: number;
  readonly afterStart: number;
  readonly afterEnd: number;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly ordinal?: number;
  readonly beforeText?: string;
  readonly afterText?: string;
}
interface Receipt {
  readonly schema: string;
  readonly baseMain: string;
  readonly currentPaths: readonly string[];
  readonly restoredPath: string;
  readonly before: Pin;
  readonly implementation: Pin;
  readonly facade: Pin;
  readonly facadeText: string;
  readonly literalOccurrences: number;
  readonly segments: readonly Segment[];
}
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
  throw new Error("runtime preparation relocation: " + message);
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail("missing nonempty source: " + label);
  return value;
}
function assertPin(bytes: Buffer, pin: Pin, label: string): void {
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256)
    fail("complete source SHA256/length mismatch: " + label);
}
/** The immutable raw receipt is authority; parsed or reserialized replacements are refused. */
export function authenticateRuntimePreparationRelocation(text: string): Receipt {
  requireString(text, runtimePreparationRelocationReceiptPath);
  if (Buffer.byteLength(text) !== receiptBytes || sha256(text) !== receiptSha256)
    fail("immutable receipt bytes mismatch");
  const r = JSON.parse(text) as Receipt;
  if (
    r.schema !== "ir-runtime-preparation-relocation-v1" ||
    r.baseMain !== "3444df3d6d355aa745301ee248ce8f7ea2a80be7" ||
    JSON.stringify(r.currentPaths) !== JSON.stringify(runtimePreparationRelocationCurrentPaths) ||
    r.restoredPath !== runtimePreparationRelocationCurrentPaths[0] ||
    r.before.path !== r.restoredPath ||
    r.facade.path !== r.restoredPath ||
    r.implementation.path !== runtimePreparationRelocationCurrentPaths[1] ||
    r.before.bytes !== 49626 ||
    r.before.sha256 !== "03e5d583b91a7589481c80e1ca1dd5a621fee3e593f5ca9537f9c573b8925e40" ||
    r.implementation.bytes !== 49541 ||
    r.implementation.sha256 !== "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b" ||
    r.facade.bytes !== 850 ||
    r.facade.sha256 !== "584322a7384556a6f3b82dc85cc30c2213510fe70f2cd437ccbef97826156351" ||
    r.literalOccurrences !== 23 ||
    r.segments.length !== 47
  )
    fail("fixed schema/path/pin mismatch");
  assertPin(Buffer.from(r.facadeText), r.facade, "receipt facade witness");
  return r;
}
/**
 * Capture only the fixed physical pair before historical algorithms or mutants.
 * Every construction authenticates afresh; the returned reader restores one logical path.
 */
export function beforeRuntimePreparationRelocation(rawRead: Reader): Reader {
  const r = authenticateRuntimePreparationRelocation(rawRead(runtimePreparationRelocationReceiptPath));
  const facade = Buffer.from(requireString(rawRead(r.facade.path), r.facade.path));
  const implementation = Buffer.from(requireString(rawRead(r.implementation.path), r.implementation.path));
  assertPin(facade, r.facade, r.facade.path);
  assertPin(implementation, r.implementation, r.implementation.path);
  if (!facade.equals(Buffer.from(r.facadeText))) fail("facade witness mismatch");
  const beforePieces: Buffer[] = [];
  let beforeCursor = 0,
    afterCursor = 0,
    ordinal = 0;
  for (const [index, segment] of r.segments.entries()) {
    if (
      ![segment.beforeStart, segment.beforeEnd, segment.afterStart, segment.afterEnd].every(Number.isSafeInteger) ||
      segment.beforeStart !== beforeCursor ||
      segment.afterStart !== afterCursor ||
      segment.beforeEnd <= segment.beforeStart ||
      segment.afterEnd <= segment.afterStart ||
      segment.beforeEnd > r.before.bytes ||
      segment.afterEnd > implementation.length ||
      segment.kind !== (index % 2 === 0 ? "unchanged" : "module-literal")
    )
      fail("segment partition/order mismatch: " + index);
    const live = implementation.subarray(segment.afterStart, segment.afterEnd);
    if (sha256(live) !== segment.afterSha256) fail("live segment mismatch: " + index);
    let old: Buffer;
    if (segment.kind === "unchanged") {
      if (segment.ordinal !== undefined || segment.beforeText !== undefined || segment.afterText !== undefined)
        fail("unexpected unchanged segment fields");
      old = live;
    } else {
      if (
        segment.ordinal !== ordinal++ ||
        typeof segment.beforeText !== "string" ||
        typeof segment.afterText !== "string"
      )
        fail("module-literal ordinal/text mismatch");
      if (!live.equals(Buffer.from(segment.afterText))) fail("module-literal live bytes mismatch");
      old = Buffer.from(segment.beforeText);
      if (old.equals(live)) fail("module-literal must change");
    }
    if (old.length !== segment.beforeEnd - segment.beforeStart || sha256(old) !== segment.beforeSha256)
      fail("inverse segment mismatch: " + index);
    beforePieces.push(old);
    beforeCursor = segment.beforeEnd;
    afterCursor = segment.afterEnd;
  }
  if (beforeCursor !== r.before.bytes || afterCursor !== implementation.length || ordinal !== 23)
    fail("incomplete source partition");
  // The old body comes from live unchanged bytes and the fixed literal inverse,
  // never from a stored old source or a TypeScript printer.
  const restored = Buffer.concat(beforePieces);
  assertPin(restored, r.before, r.restoredPath);
  const replay = Buffer.concat(
    r.segments.map((segment) => {
      const old = restored.subarray(segment.beforeStart, segment.beforeEnd);
      if (sha256(old) !== segment.beforeSha256) fail("reciprocal old segment mismatch");
      return segment.kind === "unchanged" ? old : Buffer.from(segment.afterText!);
    }),
  );
  assertPin(replay, r.implementation, "reciprocal implementation");
  if (!replay.equals(implementation)) fail("reciprocal full bytes mismatch");
  const source = restored.toString("utf8");
  if (!Buffer.from(source).equals(restored)) fail("restored UTF8 mismatch");
  return (path) => (path === r.restoredPath ? source : rawRead(path));
}
