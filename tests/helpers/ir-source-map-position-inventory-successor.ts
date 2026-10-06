// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const sourceMapPositionInventorySuccessorReceiptPath =
  "tests/helpers/ir-source-map-position-inventory-successor.json";
type Reader = (path: string) => string;
const receiptBytes = 2437;
const receiptSha256 = "b2afd57a2583d7a103b07ce1bcc577475023ee29f54ee433f115a6fcf43572b0";
const expected = {
  schema: "fixed-source-map-position-inventory-successor-v1",
  coordinateUnit: "utf8-byte",
  before: {
    source: {
      bytes: 588351,
      sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
      gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
    },
    dataSha256: "56532a3cda4a9a8ec083fc0ebb7d38300fe754dd8f7cc4d49c20784ae77f05e0",
    filesSha256: "fdd1e7da8bc2decab20f41771aa30b724a3ecda1929f590f286e2f530171be9c",
    fileCount: 1837,
    topLevelKeys: [
      "schema",
      "description",
      "sourceRoot",
      "tsconfig",
      "requireGitProvenance",
      "externalAssets",
      "frontendWrapper",
      "moduleExtensions",
      "layers",
      "allowedEdges",
      "externalPackages",
      "activationHistory",
      "nonModules",
      "moves",
      "evidence",
      "files",
    ],
  },
  current: {
    source: {
      bytes: 588471,
      sha256: "a2e9c7243c13ae37b293f02ae19eba03f072db30195ce0479f0926488fa3de98",
      gitBlob: "d0ff19228046a1bed50bd821194a5f2ffe2f6754",
    },
    dataSha256: "e27bdf5d6dae65b37905253ca8f4383a84eace68a9d99700ae93ed0e83ec42e5",
    filesSha256: "0618fa655d6afb12bcb7565ccfc8de5d8d89327f62d760d44fbae37408e358d5",
    fileCount: 1838,
    topLevelKeys: [
      "schema",
      "description",
      "sourceRoot",
      "tsconfig",
      "requireGitProvenance",
      "externalAssets",
      "frontendWrapper",
      "moduleExtensions",
      "layers",
      "allowedEdges",
      "externalPackages",
      "activationHistory",
      "nonModules",
      "moves",
      "evidence",
      "files",
    ],
  },
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  addedRows: [
    {
      index: 85,
      row: {
        path: "src/ir/program/source-map-position.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/errors.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/data.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
  ],
} as const;
interface RawSpan {
  readonly beforeOffset: number;
  readonly afterOffset: number;
  readonly before: string;
  readonly after: string;
}
type Receipt = typeof expected & { readonly rawSpans: readonly RawSpan[] };
function fail(detail: string): never {
  throw new Error("source map position inventory successor: " + detail);
}
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function captureData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return fail("non-JSON data");
  if (active.has(value)) return fail("cyclic data");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return fail("plain owned data required");
  active.add(value);
  try {
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1)
        return fail("array holes or extra fields");
      const copy: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) return fail("array accessor or hole");
        copy.push(captureData(descriptor.value, active));
      }
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return fail("symbol field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) return fail("accessor or hidden field");
      Object.defineProperty(copy, key, {
        value: captureData(descriptor.value, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    active.delete(value);
  }
}
function authenticate(readAuthority: Reader): Receipt {
  if (typeof readAuthority !== "function") return fail("authority reader required");
  const raw = readAuthority(sourceMapPositionInventorySuccessorReceiptPath);
  if (typeof raw !== "string") return fail("primitive authority text required");
  if (Buffer.byteLength(raw) !== receiptBytes || sha(raw) !== receiptSha256) return fail("fixed receipt pin mismatch");
  const receipt = JSON.parse(raw) as Receipt;
  const { rawSpans: _spans, ...summary } = receipt;
  if (!same(summary, expected)) return fail("fixed receipt profile/rows mismatch");
  return receipt;
}
const defaultRead: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function profile(value: Record<string, unknown>, target: Receipt["before"] | Receipt["current"]): void {
  if (
    !same(Object.keys(value), target.topLevelKeys) ||
    sha(JSON.stringify(value)) !== target.dataSha256 ||
    !Array.isArray(value.files) ||
    value.files.length !== target.fileCount ||
    sha(JSON.stringify(value.files)) !== target.filesSha256 ||
    sha(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "files")))) !==
      expected.nonFilesSha256
  )
    fail("complete policy profile mismatch");
}
function beforeSemantic(current: Record<string, unknown>, receipt: Receipt): Record<string, unknown> {
  profile(current, receipt.current);
  const files = current.files as unknown[];
  for (const added of receipt.addedRows) {
    if (
      !same(files[added.index], added.row) ||
      !same(files[added.index - 1], added.previous) ||
      !same(files[added.index + 1], added.next)
    )
      fail("fixed inserted row/order mismatch");
  }
  const before = { ...current, files: [...files] };
  for (const added of [...receipt.addedRows].reverse()) before.files.splice(added.index, 1);
  profile(before, receipt.before);
  const replay = { ...before, files: [...before.files] };
  for (const added of receipt.addedRows) replay.files.splice(added.index, 0, added.row);
  profile(replay, receipt.current);
  if (!same(replay, current)) fail("semantic reciprocal mismatch");
  return before;
}
function pin(raw: Buffer, target: Receipt["before"]["source"] | Receipt["current"]["source"]): void {
  if (
    raw.length !== target.bytes ||
    sha(raw) !== target.sha256 ||
    createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex") !== target.gitBlob
  )
    fail("complete raw source profile mismatch");
}
function beforeRaw(raw: string, receipt: Receipt): string {
  const current = Buffer.from(raw);
  pin(current, receipt.current.source);
  const inverse: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const span of receipt.rawSpans) {
    if (
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      span.beforeOffset < beforeEnd ||
      span.afterOffset < afterEnd ||
      span.beforeOffset - beforeEnd !== span.afterOffset - afterEnd
    )
      fail("raw inverse coordinates mismatch");
    const before = Buffer.from(span.before),
      after = Buffer.from(span.after);
    if (
      span.beforeOffset + before.length > receipt.before.source.bytes ||
      span.afterOffset + after.length > current.length ||
      !current.subarray(span.afterOffset, span.afterOffset + after.length).equals(after)
    )
      fail("raw inverse span mismatch");
    inverse.push(current.subarray(afterEnd, span.afterOffset), before);
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
  }
  inverse.push(current.subarray(afterEnd));
  const before = Buffer.concat(inverse);
  pin(before, receipt.before.source);
  const forward: Buffer[] = [];
  beforeEnd = 0;
  for (const span of receipt.rawSpans) {
    const old = Buffer.from(span.before);
    if (!before.subarray(span.beforeOffset, span.beforeOffset + old.length).equals(old))
      fail("raw replay span mismatch");
    forward.push(before.subarray(beforeEnd, span.beforeOffset), Buffer.from(span.after));
    beforeEnd = span.beforeOffset + old.length;
  }
  forward.push(before.subarray(beforeEnd));
  const replay = Buffer.concat(forward);
  pin(replay, receipt.current.source);
  if (!replay.equals(current)) fail("raw reciprocal mismatch");
  const semantic = beforeSemantic(JSON.parse(raw) as Record<string, unknown>, receipt);
  if (!same(JSON.parse(before.toString("utf8")), semantic)) fail("raw/semantic inverse mismatch");
  return before.toString("utf8");
}
export function captureSourceMapPositionInventoryPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  return beforeSemantic(current as Record<string, unknown>, authenticate(readAuthority));
}
export function captureSourceMapPositionInventoryPredecessorPolicySource(
  raw: string,
  readAuthority: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  return beforeRaw(raw, authenticate(readAuthority));
}
