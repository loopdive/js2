// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const positionClassFieldsMainSuccessorReceiptPath = "tests/helpers/ir-position-class-fields-main-successor.json";
type Reader = (path: string) => string;
const receiptBytes = 5558;
const receiptSha256 = "27bfb98ed1ac7a08f285f698426ae0eb9c61ef5e6e433ff1d70288da5295a112";
const expected = {
  schema: "fixed-position-class-fields-main-successor-v1",
  coordinateUnit: "utf8-byte",
  before: {
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
  current: {
    source: {
      bytes: 588799,
      sha256: "3d497f1ec140ecd7056155e6e0a993801e126b93304af1a581820d779a979122",
      gitBlob: "9c248ee6471ee50973d5da74ba2d7d06e9eee92f",
    },
    dataSha256: "8c91785b4302f8f9b88641f325643e374484b54909c3bbc086c0456b5a6bdc9a",
    filesSha256: "7ede92f695b2c32bbc8cb5dea5e59a3e2f89a24bf37852f757866601ad01a62a",
    fileCount: 1839,
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
      index: 1648,
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
  deliveredMain: {
    beforeRevision: "abb3471c46bb9e7129b28812fe16313c857cda69",
    currentRevision: "cdc0255882d45181072342d9fd57f291aca93092",
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
        bytes: 588679,
        sha256: "e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e",
        gitBlob: "6066caa751c06e8726076ee622311f509bdd5f77",
      },
      dataSha256: "52245127b5852686adc2baf31be58a4af1eee857f2a2070a8a6b7cbb9636f669",
      filesSha256: "1ed6b8c66a8ecc80bfe88fe5a0f044fac2a88ee5775146f4f019caefe218a88e",
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
    index: 1647,
    offset: 542771,
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
  throw new Error("position class fields main successor: " + detail);
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
  const raw = readAuthority(positionClassFieldsMainSuccessorReceiptPath);
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
export function capturePositionClassFieldsMainPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  return beforeSemantic(current as Record<string, unknown>, authenticate(readAuthority));
}
export function capturePositionClassFieldsMainPredecessorPolicySource(
  raw: string,
  readAuthority: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  return beforeRaw(raw, authenticate(readAuthority));
}
