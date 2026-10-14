// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const nativeNumberUndefinedInventorySuccessorReceiptPath =
  "tests/helpers/ir-native-number-undefined-inventory-successor.json";
const receiptBytes = 21476;
const receiptSha256 = "def88ffa87ea3fc238d83127d79eb540668f83bee12a424547a9d140720f1e5c";
const expected = {
  schema: "fixed-native-number-undefined-inventory-successor-v1",
  coordinateUnit: "utf8-byte",
  base: "39c255ea0fb8ae364124c087acce7335285cbc33",
  before: {
    source: {
      bytes: 633127,
      sha256: "60bfda84dda819fc45e60ebb370e06d6007001f5885f2a934f24c3c5c1757dc7",
      gitBlob: "9e3ef20082947f200844fb79f4f5476c83653e5c",
    },
    fileCount: 2001,
    dataSha256: "168eeef9253d3bdb6b8b6880adfafbf4ceb1e73f755e5121be336da06eae064c",
    filesSha256: "a9032453c2cf3b3357c640c637e856b863184d0434d45792dd4f4128fb425cc9",
    nonFilesSha256: "55a72bc549a5ebc2351631c574fe518c1457a48fd36f57550f13a3dc74917faf",
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
      bytes: 637204,
      sha256: "f1934c0f22726ed604b009bc764ac3110f251f2aefb2533fa0dca7c13f874d88",
      gitBlob: "70cc261bdce82ee1437e9beb571677069c49a0e4",
    },
    fileCount: 2016,
    dataSha256: "e56493e2ba1670320248acc370b04c48e19ed82d651985e91c23349b8d0b58f0",
    filesSha256: "e2ab5e0103848e548c08aa4ab20af8df745205d8588d503adb87d502ced67a0c",
    nonFilesSha256: "55a72bc549a5ebc2351631c574fe518c1457a48fd36f57550f13a3dc74917faf",
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
      index: 2001,
      row: {
        path: "src/ir/native-number-undefined-source.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Original checker-symbol/local dense-vector source and complete incoming/prototype-effect census remains frontend authority; migrate with source preparation, without serializing capabilities or inferring runtime absence from numeric types.",
      },
      previous: {
        path: "src/ir/native-vector-undefined-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Checker-symbol native numeric defined-value provenance retains TypeScript AST authority; migrate with source lowering, never infer runtime absence from unboxed carriers.",
      },
      next: {
        path: "src/ir/core/native-number-undefined-lowering.ts",
        state: "clean",
        layer: "ir-core",
      },
    },
    {
      index: 2002,
      row: {
        path: "src/ir/core/native-number-undefined-lowering.ts",
        state: "clean",
        layer: "ir-core",
      },
      previous: {
        path: "src/ir/native-number-undefined-source.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Original checker-symbol/local dense-vector source and complete incoming/prototype-effect census remains frontend authority; migrate with source preparation, without serializing capabilities or inferring runtime absence from numeric types.",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-body.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 2003,
      row: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-body.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/core/native-number-undefined-lowering.ts",
        state: "clean",
        layer: "ir-core",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 2004,
      row: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-body.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-producer.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 2005,
      row: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-producer.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/program/native-number-undefined-requirements.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 2006,
      row: {
        path: "src/ir/program/native-number-undefined-requirements.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-producer.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/program/native-number-undefined-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 2007,
      row: {
        path: "src/ir/program/native-number-undefined-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/native-number-undefined-requirements.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/runtime/native-number-undefined-profile.ts",
        state: "clean",
        layer: "ir-runtime",
      },
    },
    {
      index: 2008,
      row: {
        path: "src/ir/runtime/native-number-undefined-profile.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      previous: {
        path: "src/ir/program/native-number-undefined-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/backend/native-number-undefined.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate portable IR binding/proof contracts from concrete ValType/Instr carrier emission, scratch-local and memory-offset descriptors before core activation; all-import closure purity alone does not certify semantic core ownership.",
      },
    },
    {
      index: 2009,
      row: {
        path: "src/ir/backend/native-number-undefined.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate portable IR binding/proof contracts from concrete ValType/Instr carrier emission, scratch-local and memory-offset descriptors before core activation; all-import closure purity alone does not certify semantic core ownership.",
      },
      previous: {
        path: "src/ir/runtime/native-number-undefined-profile.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      next: {
        path: "src/backend/wasmgc/resources/native-number-undefined.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
    },
    {
      index: 2010,
      row: {
        path: "src/backend/wasmgc/resources/native-number-undefined.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      previous: {
        path: "src/ir/backend/native-number-undefined.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate portable IR binding/proof contracts from concrete ValType/Instr carrier emission, scratch-local and memory-offset descriptors before core activation; all-import closure purity alone does not certify semantic core ownership.",
      },
      next: {
        path: "src/backend/linear/program/native-number-undefined.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate target-specific IR tags/errors/checker types from reusable physical record operations before activation; the current source-free recipe preserves exact existing allocation geometry and requires the issued Linear pack, without asserting a clean Wasm foundation boundary.",
      },
    },
    {
      index: 2011,
      row: {
        path: "src/backend/linear/program/native-number-undefined.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate target-specific IR tags/errors/checker types from reusable physical record operations before activation; the current source-free recipe preserves exact existing allocation geometry and requires the issued Linear pack, without asserting a clean Wasm foundation boundary.",
      },
      previous: {
        path: "src/backend/wasmgc/resources/native-number-undefined.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      next: {
        path: "src/ir/program-number-undefined-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain complete independent logical/source evidence and exact whole-attempt checks while consuming genuine target-specific reservations; split physical emission orchestration from portable independently issued proof after the separate proof receiving scope. No clean ir-program activation is inferred from a source-free closure.",
      },
    },
    {
      index: 2012,
      row: {
        path: "src/ir/program-number-undefined-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain complete independent logical/source evidence and exact whole-attempt checks while consuming genuine target-specific reservations; split physical emission orchestration from portable independently issued proof after the separate proof receiving scope. No clean ir-program activation is inferred from a source-free closure.",
      },
      previous: {
        path: "src/backend/linear/program/native-number-undefined.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate target-specific IR tags/errors/checker types from reusable physical record operations before activation; the current source-free recipe preserves exact existing allocation geometry and requires the issued Linear pack, without asserting a clean Wasm foundation boundary.",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-legality.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 2013,
      row: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-legality.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/program-number-undefined-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain complete independent logical/source evidence and exact whole-attempt checks while consuming genuine target-specific reservations; split physical emission orchestration from portable independently issued proof after the separate proof receiving scope. No clean ir-program activation is inferred from a source-free closure.",
      },
      next: {
        path: "src/ir/program/native-number-undefined-allocation-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 2014,
      row: {
        path: "src/ir/program/native-number-undefined-allocation-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/native-number-undefined-legality.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/compiler/ir-native-number-undefined-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate completed native support-singleton authentication and concrete GC/Linear carrier/type/initializer/data joins from portable program presentation, retaining complete original/selected semantic evidence and opaque emission currentness. No clean compiler activation or general public dynamic ABI is inferred.",
      },
    },
    {
      index: 2015,
      row: {
        path: "src/compiler/ir-native-number-undefined-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate completed native support-singleton authentication and concrete GC/Linear carrier/type/initializer/data joins from portable program presentation, retaining complete original/selected semantic evidence and opaque emission currentness. No clean compiler activation or general public dynamic ABI is inferred.",
      },
      previous: {
        path: "src/ir/program/native-number-undefined-allocation-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: null,
    },
  ],
  rawSpans: [
    {
      beforeOffset: 633115,
      afterOffset: 633115,
      before: "",
      after:
        '    },\n    {\n      "path": "src/ir/native-number-undefined-source.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Original checker-symbol/local dense-vector source and complete incoming/prototype-effect census remains frontend authority; migrate with source preparation, without serializing capabilities or inferring runtime absence from numeric types."\n    },\n    {\n      "path": "src/ir/core/native-number-undefined-lowering.ts",\n      "state": "clean",\n      "layer": "ir-core"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-body.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-profile.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-producer.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/program/native-number-undefined-requirements.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/native-number-undefined-abi.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/runtime/native-number-undefined-profile.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/ir/backend/native-number-undefined.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate portable IR binding/proof contracts from concrete ValType/Instr carrier emission, scratch-local and memory-offset descriptors before core activation; all-import closure purity alone does not certify semantic core ownership."\n    },\n    {\n      "path": "src/backend/wasmgc/resources/native-number-undefined.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/linear/program/native-number-undefined.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate target-specific IR tags/errors/checker types from reusable physical record operations before activation; the current source-free recipe preserves exact existing allocation geometry and requires the issued Linear pack, without asserting a clean Wasm foundation boundary."\n    },\n    {\n      "path": "src/ir/program-number-undefined-resources.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain complete independent logical/source evidence and exact whole-attempt checks while consuming genuine target-specific reservations; split physical emission orchestration from portable independently issued proof after the separate proof receiving scope. No clean ir-program activation is inferred from a source-free closure."\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-legality.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/program/native-number-undefined-allocation-validation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/compiler/ir-native-number-undefined-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate completed native support-singleton authentication and concrete GC/Linear carrier/type/initializer/data joins from portable program presentation, retaining complete original/selected semantic evidence and opaque emission currentness. No clean compiler activation or general public dynamic ABI is inferred."\n',
    },
  ],
  anchors: [
    {
      path: "tests/helpers/ir-deno-post-position-main-successor.ts",
      bytes: 289068,
      sha256: "700deb486f038201c233fbefa03abc544959ce59a2f99b7a1f876355604af2e7",
      gitBlob: "5fa90eddf3b2f44a71e77480639a0ccd18ca7765",
    },
    {
      path: "tests/helpers/ir-deno-post-position-main-successor.json",
      bytes: 285722,
      sha256: "307877cb7bfcf9b8f9469aafb7f78a076154fee03af5856fe6eac36616f239df",
      gitBlob: "2618d43704ed2eeeaf5da3d778b6ff31d8682afb",
    },
  ],
  caller: {
    path: "tests/issue-4376-post-position-main-inventory-successor.test.ts",
    before: {
      bytes: 360226,
      sha256: "82ef54078b5eca0363b43a28e844564b758a682aaac57f179301396985ec9d34",
      gitBlob: "7be3a33dd8edf93caa5912bfc8bc2ef5312a37c1",
    },
    current: {
      bytes: 360428,
      sha256: "529e1d9d98cf7a97c0418350547beae8c9d598ca98dc93cc786d14abeeb23e28",
      gitBlob: "dee50f79c3770585d18c7323024fc48be9a5597a",
    },
    rawSpans: [
      {
        beforeOffset: 0,
        afterOffset: 0,
        before: "",
        after:
          'import { createIrNativeNumberUndefinedInventoryReader } from "./helpers/ir-native-number-undefined-inventory-successor.js";\n',
      },
      {
        beforeOffset: 295890,
        afterOffset: 296014,
        before: 'const read = (path: string): string => readFileSync(resolve(root, path), "utf8");\n',
        after:
          'const read = (path: string): string =>\n  createIrNativeNumberUndefinedInventoryReader((currentPath) => readFileSync(resolve(root, currentPath), "utf8"))(path);\n',
      },
    ],
  },
  physicalReadsPerOperation: 5,
  fixedCapturePaths: [
    "tests/helpers/ir-native-number-undefined-inventory-successor.json",
    "scripts/compiler-boundaries.json",
    "tests/helpers/ir-deno-post-position-main-successor.ts",
    "tests/helpers/ir-deno-post-position-main-successor.json",
    "tests/issue-4376-post-position-main-inventory-successor.test.ts",
  ],
} as const;
// Independent test-only current inventory transport; compiler authority is unchanged.
type Reader = (path: string) => string;
function fail(detail: string): never {
  throw new Error("native Number/Undefined inventory successor: " + detail);
}
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function captureData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return fail("non-JSON DATA");
  if (active.has(value)) return fail("cyclic DATA");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return fail("plain owned DATA required");
  active.add(value);
  try {
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!descriptor || !("value" in descriptor)) return fail("array length DATA");
      const length = descriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1)
        return fail("array holes or shadow fields");
      const copy: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item || !("value" in item)) return fail("array accessor or hole");
        copy.push(captureData(item.value, active));
      }
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return fail("symbol DATA field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) return fail("accessor or hidden DATA field");
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
type Profile = typeof expected.before | typeof expected.current;
interface RawPin {
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlob: string;
}
function rawPin(raw: Buffer, pin: RawPin): void {
  if (
    raw.length !== pin.bytes ||
    sha(raw) !== pin.sha256 ||
    createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex") !== pin.gitBlob
  )
    fail("complete raw source profile mismatch");
}
function profile(data: Record<string, unknown>, pin: Profile): void {
  if (
    !same(Object.keys(data), pin.topLevelKeys) ||
    !Array.isArray(data.files) ||
    data.files.length !== pin.fileCount ||
    sha(JSON.stringify(data)) !== pin.dataSha256 ||
    sha(JSON.stringify(data.files)) !== pin.filesSha256 ||
    sha(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "files")))) !==
      pin.nonFilesSha256
  )
    fail("complete policy profile mismatch");
}
function beforeSemantic(current: Record<string, unknown>): Record<string, unknown> {
  profile(current, expected.current);
  const files = current.files as unknown[];
  for (const added of expected.addedRows) {
    if (
      !same(files[added.index], added.row) ||
      !same(files[added.index - 1], added.previous) ||
      !same(files[added.index + 1] ?? null, added.next)
    )
      fail("complete added row/order/neighbor mismatch");
  }
  const before = { ...current, files: [...files] };
  for (const added of [...expected.addedRows].reverse()) before.files.splice(added.index, 1);
  profile(before, expected.before);
  const replay = { ...before, files: [...before.files] };
  for (const added of expected.addedRows) replay.files.splice(added.index, 0, captureData(added.row));
  profile(replay, expected.current);
  if (!same(replay, current)) fail("complete semantic reciprocal mismatch");
  return before;
}
interface Span {
  readonly beforeOffset: number;
  readonly afterOffset: number;
  readonly before: string;
  readonly after: string;
}
function inverseText(raw: string, beforePin: RawPin, currentPin: RawPin, spans: readonly Span[]): string {
  if (typeof raw !== "string") return fail("primitive input text required");
  const current = Buffer.from(raw);
  rawPin(current, currentPin);
  const inverse: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const span of spans) {
    const before = Buffer.from(span.before),
      after = Buffer.from(span.after);
    if (
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      span.beforeOffset < beforeEnd ||
      span.afterOffset < afterEnd ||
      span.beforeOffset - beforeEnd !== span.afterOffset - afterEnd ||
      span.beforeOffset + before.length > beforePin.bytes ||
      span.afterOffset + after.length > current.length ||
      !current.subarray(span.afterOffset, span.afterOffset + after.length).equals(after)
    )
      fail("raw inverse coordinates/span mismatch");
    inverse.push(current.subarray(afterEnd, span.afterOffset), before);
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
  }
  inverse.push(current.subarray(afterEnd));
  const before = Buffer.concat(inverse);
  rawPin(before, beforePin);
  const forward: Buffer[] = [];
  beforeEnd = 0;
  for (const span of spans) {
    const old = Buffer.from(span.before);
    if (!before.subarray(span.beforeOffset, span.beforeOffset + old.length).equals(old))
      fail("raw reciprocal span mismatch");
    forward.push(before.subarray(beforeEnd, span.beforeOffset), Buffer.from(span.after));
    beforeEnd = span.beforeOffset + old.length;
  }
  forward.push(before.subarray(beforeEnd));
  const replay = Buffer.concat(forward);
  rawPin(replay, currentPin);
  if (!replay.equals(current)) fail("complete raw reciprocal mismatch");
  return before.toString("utf8");
}
function beforeRaw(raw: string): string {
  const current = captureData(JSON.parse(raw)) as Record<string, unknown>;
  profile(current, expected.current);
  const before = inverseText(raw, expected.before.source, expected.current.source, expected.rawSpans);
  if (!same(JSON.parse(before), beforeSemantic(current))) fail("raw/DATA inverse mismatch");
  return before;
}
const defaultRead: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function capture(read: Reader): Map<string, string> {
  if (typeof read !== "function") return fail("actual primitive source reader required");
  const captured = new Map<string, string>();
  for (const path of expected.fixedCapturePaths) {
    const raw = read(path);
    if (typeof raw !== "string") return fail("primitive capture text required");
    captured.set(path, raw);
  }
  const receipt = captured.get(nativeNumberUndefinedInventorySuccessorReceiptPath)!;
  if (
    Buffer.byteLength(receipt) !== receiptBytes ||
    sha(receipt) !== receiptSha256 ||
    !same(JSON.parse(receipt), expected)
  )
    fail("fixed outer receipt pin/profile mismatch");
  for (const anchor of expected.anchors) rawPin(Buffer.from(captured.get(anchor.path)!), anchor);
  const caller = captured.get(expected.caller.path)!;
  captured.set(
    expected.caller.path,
    inverseText(caller, expected.caller.before, expected.caller.current, expected.caller.rawSpans),
  );
  captured.set("scripts/compiler-boundaries.json", beforeRaw(captured.get("scripts/compiler-boundaries.json")!));
  return captured;
}
/** One complete capture per explicit operation; mapped physical rereads and mutable authority ports never escape. */
export function createIrNativeNumberUndefinedInventoryReader(actualRead: Reader = defaultRead): Reader {
  const captured = capture(actualRead);
  return (path) => {
    if (typeof path !== "string" || !path) return fail("primitive path required");
    if (!captured.has(path)) {
      const raw = actualRead(path);
      if (typeof raw !== "string") return fail("primitive unknown source text required");
      captured.set(path, raw);
    }
    return captured.get(path)!;
  };
}
export function captureIrNativeNumberUndefinedInventoryPredecessorPolicy(
  value: unknown,
  actualRead: Reader = defaultRead,
): Record<string, unknown> {
  const data = captureData(value);
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("plain policy DATA required");
  capture(actualRead);
  return beforeSemantic(data as Record<string, unknown>);
}
export function captureIrNativeNumberUndefinedInventoryPredecessorPolicySource(
  raw: string,
  actualRead: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("primitive raw policy input required");
  capture(actualRead);
  return beforeRaw(raw);
}
