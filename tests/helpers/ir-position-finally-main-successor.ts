// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const positionFinallyMainSuccessorReceiptPath = "tests/helpers/ir-position-finally-main-successor.json";
type Reader = (path: string) => string;
const receiptBytes = 5518;
const receiptSha256 = "af42a17b8b56046ba1b145568746c253156e95a1f3522342779cf1d843a29fa2";
const expected = {
  schema: "fixed-position-finally-main-successor-v1",
  coordinateUnit: "utf8-byte",
  before: {
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
  current: {
    source: {
      bytes: 589117,
      sha256: "58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857",
      gitBlob: "e775a64483ace95ca46b0d65221cff9cf84c4500",
    },
    dataSha256: "fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368",
    filesSha256: "b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92",
    fileCount: 1840,
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
      index: 982,
      row: {
        path: "src/codegen/statements/finally-private-local.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "5267",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/statements/exceptions.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/statements/finally-ran-guard.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  deliveredMain: {
    beforeRevision: "cdc0255882d45181072342d9fd57f291aca93092",
    currentRevision: "bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1",
    before: {
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
    current: {
      source: {
        bytes: 588997,
        sha256: "69eaf95c6d675c48c2bb092603c50779309976ec0373d0370a93ed7068445828",
        gitBlob: "44a73c9b98929ae8da309cc3721a3dcf029b618a",
      },
      dataSha256: "972ca4eca855effd6e8536e67f73b25994e0162e39519ce776f6c6d6e97512a4",
      filesSha256: "cd57b430bf595951d2bebbac4ccb21c8a538180b4274cc62a8633bcb4207c73b",
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
    index: 981,
    offset: 363507,
    insertion:
      '    {\n      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
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
  throw new Error("position finally main successor: " + detail);
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
  const raw = readAuthority(positionFinallyMainSuccessorReceiptPath);
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
export function capturePositionFinallyMainPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  return beforeSemantic(current as Record<string, unknown>, authenticate(readAuthority));
}
export function capturePositionFinallyMainPredecessorPolicySource(
  raw: string,
  readAuthority: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  return beforeRaw(raw, authenticate(readAuthority));
}
