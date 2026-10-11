// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Test-only finite outer inverse; historical policy proofs remain unchanged.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const denoClassFieldsMainSuccessorReceiptPath = "tests/helpers/ir-deno-class-fields-main-successor.json";
type Reader = (path: string) => string;
const receiptBytes = 4285;
const receiptSha256 = "5856ce8883af5e4f57a3540277bbdbc6bc0aef71c17394d59af6ba7d3d9b0593";
const expected = {
  schema: "fixed-deno-class-fields-main-successor-v1",
  baseMain: "cdc0255882d45181072342d9fd57f291aca93092",
  coordinateUnit: "utf8-byte",
  before: {
    source: {
      bytes: 594018,
      sha256: "59752f826a8a2298966e4bbae6ec29e15a168f7e45fb58379dbb923ccd2f2694",
      gitBlob: "dfd1b16089d1d66982e0eef5d79b50f74fd6d869",
    },
    dataSha256: "07d3bc5470d5864ae6f1e7d199eed523b382119aace6366db92804a7c7c63380",
    filesSha256: "f30f8e6a86c56fc16e6c9ad768d52930b70f73beef57feffae69ad932d5bf78c",
    fileCount: 1855,
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
      bytes: 594346,
      sha256: "4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a",
      gitBlob: "e70ee1b32f53de5d5935aa0ac52987959effc64a",
    },
    dataSha256: "5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7",
    filesSha256: "fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9",
    fileCount: 1856,
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
  addedRows: [
    {
      index: 1664,
      row: {
        path: "src/codegen/classes/externref-class-fields.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/error-subclass-proto-chain.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/class-proto-toplevel-write.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  lineage: {
    beforeMain: "abb3471c46bb9e7129b28812fe16313c857cda69",
    deliveredMain: "cdc0255882d45181072342d9fd57f291aca93092",
    beforeSource: {
      bytes: 588351,
      sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
      gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
    },
    deliveredSource: {
      bytes: 588679,
      sha256: "e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e",
      gitBlob: "6066caa751c06e8726076ee622311f509bdd5f77",
    },
    index: 1647,
    beforeOffset: 542771,
    afterOffset: 542771,
    insertion:
      '    {\n      "path": "src/codegen/classes/externref-class-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
  },
} as const;
interface RawSpan {
  readonly beforeOffset: number;
  readonly afterOffset: number;
  readonly before: string;
  readonly after: string;
}
type Receipt = typeof expected & { readonly rawSpans: readonly RawSpan[] };
function fail(detail: string): never {
  throw new Error("Deno class fields main inventory successor: " + detail);
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
  const raw = readAuthority(denoClassFieldsMainSuccessorReceiptPath);
  if (typeof raw !== "string") return fail("primitive authority text required");
  if (Buffer.byteLength(raw) !== receiptBytes || sha(raw) !== receiptSha256) return fail("fixed receipt pin mismatch");
  const receipt = JSON.parse(raw) as Receipt;
  const { rawSpans: _spans, ...summary } = receipt;
  if (!same(summary, expected)) return fail("fixed receipt profile/rows mismatch");
  if (receipt.addedRows.length !== 1 || receipt.rawSpans.length !== 1) return fail("fixed one-row schema mismatch");
  return receipt;
}
const defaultRead: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function profile(value: Record<string, unknown>, target: Receipt["before"] | Receipt["current"]): void {
  if (
    !same(Object.keys(value), target.topLevelKeys) ||
    sha(JSON.stringify(value)) !== target.dataSha256 ||
    !Array.isArray(value.files) ||
    value.files.length !== target.fileCount ||
    sha(JSON.stringify(value.files)) !== target.filesSha256
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
export function captureDenoClassFieldsMainPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  return beforeSemantic(current as Record<string, unknown>, authenticate(readAuthority));
}
export function captureDenoClassFieldsMainPredecessorPolicySource(
  raw: string,
  readAuthority: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  return beforeRaw(raw, authenticate(readAuthority));
}
