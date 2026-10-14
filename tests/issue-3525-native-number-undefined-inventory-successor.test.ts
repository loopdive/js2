import {
  createIrNativeNumberUndefinedFinalizationPolicyReader,
  createLazyIrNativeNumberUndefinedFinalizationPolicyReader,
} from "./helpers/ir-native-number-undefined-finalization-policy-successor.js";
import {
  createIrNativeNumberUndefinedOptimizationPolicyReader as originalOptimizationPolicyReader,
  createLazyIrNativeNumberUndefinedOptimizationPolicyReader as originalLazyOptimizationPolicyReader,
} from "./helpers/ir-native-number-undefined-optimization-policy-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent final2016 source/DATA and current caller custody, without historical repins.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIrNativeNumberUndefinedInventoryReader as originalCreateReader,
  captureIrNativeNumberUndefinedInventoryPredecessorPolicy as originalBeforeData,
  captureIrNativeNumberUndefinedInventoryPredecessorPolicySource as originalBeforeRaw,
  nativeNumberUndefinedInventorySuccessorReceiptPath as receiptPath,
} from "./helpers/ir-native-number-undefined-inventory-successor.js";
import {
  captureDenoPostPositionMainPredecessorPolicySource as mainRaw,
  captureDenoPostPositionMainPredecessorPolicy as mainData,
  captureDenoPostPositionDenoPredecessorPolicySource as denoRaw,
  captureDenoPostPositionDenoPredecessorPolicy as denoData,
} from "./helpers/ir-deno-post-position-main-successor.js";
const expected = {
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
} as const;
const historical = {
  main: {
    source: {
      bytes: 589117,
      sha256: "58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857",
      gitBlob: "e775a64483ace95ca46b0d65221cff9cf84c4500",
    },
    fileCount: 1840,
    dataSha256: "fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368",
    filesSha256: "b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  deno: {
    source: {
      bytes: 594346,
      sha256: "4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a",
      gitBlob: "e70ee1b32f53de5d5935aa0ac52987959effc64a",
    },
    fileCount: 1856,
    dataSha256: "5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7",
    filesSha256: "fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const insertedRows = [
  {
    path: "src/ir/native-number-undefined-source.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "frontend-ts",
    owner: "6920-session-b-native-takeover",
    nextBoundary:
      "Original checker-symbol/local dense-vector source and complete incoming/prototype-effect census remains frontend authority; migrate with source preparation, without serializing capabilities or inferring runtime absence from numeric types.",
  },
  {
    path: "src/ir/core/native-number-undefined-lowering.ts",
    state: "clean",
    layer: "ir-core",
  },
  {
    path: "src/ir/analysis/allocation-evidence/native-number-undefined-body.ts",
    state: "clean",
    layer: "ir-analysis",
  },
  {
    path: "src/ir/analysis/allocation-evidence/native-number-undefined-profile.ts",
    state: "clean",
    layer: "ir-analysis",
  },
  {
    path: "src/ir/analysis/allocation-evidence/native-number-undefined-producer.ts",
    state: "clean",
    layer: "ir-analysis",
  },
  {
    path: "src/ir/program/native-number-undefined-requirements.ts",
    state: "clean",
    layer: "ir-program",
  },
  {
    path: "src/ir/program/native-number-undefined-abi.ts",
    state: "clean",
    layer: "ir-program",
  },
  {
    path: "src/ir/runtime/native-number-undefined-profile.ts",
    state: "clean",
    layer: "ir-runtime",
  },
  {
    path: "src/ir/backend/native-number-undefined.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "ir-core",
    owner: "6920-session-b-native-takeover",
    nextBoundary:
      "Separate portable IR binding/proof contracts from concrete ValType/Instr carrier emission, scratch-local and memory-offset descriptors before core activation; all-import closure purity alone does not certify semantic core ownership.",
  },
  {
    path: "src/backend/wasmgc/resources/native-number-undefined.ts",
    state: "clean",
    layer: "backend-wasmgc",
  },
  {
    path: "src/backend/linear/program/native-number-undefined.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "wasm-physical",
    owner: "6920-session-b-native-takeover",
    nextBoundary:
      "Separate target-specific IR tags/errors/checker types from reusable physical record operations before activation; the current source-free recipe preserves exact existing allocation geometry and requires the issued Linear pack, without asserting a clean Wasm foundation boundary.",
  },
  {
    path: "src/ir/program-number-undefined-resources.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "6920-session-b-native-takeover",
    nextBoundary:
      "Retain complete independent logical/source evidence and exact whole-attempt checks while consuming genuine target-specific reservations; split physical emission orchestration from portable independently issued proof after the separate proof receiving scope. No clean ir-program activation is inferred from a source-free closure.",
  },
  {
    path: "src/ir/analysis/allocation-evidence/native-number-undefined-legality.ts",
    state: "clean",
    layer: "ir-analysis",
  },
  {
    path: "src/ir/program/native-number-undefined-allocation-validation.ts",
    state: "clean",
    layer: "ir-program",
  },
  {
    path: "src/compiler/ir-native-number-undefined-presentation.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "compiler",
    owner: "6920-session-b-native-takeover",
    nextBoundary:
      "Separate completed native support-singleton authentication and concrete GC/Linear carrier/type/initializer/data joins from portable program presentation, retaining complete original/selected semantic evidence and opaque emission currentness. No clean compiler activation or general public dynamic ABI is inferred.",
  },
] as const;
const historicalAnchors = [
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
] as const;
const fixedPaths = [
  "tests/helpers/ir-native-number-undefined-inventory-successor.json",
  "scripts/compiler-boundaries.json",
  "tests/helpers/ir-deno-post-position-main-successor.ts",
  "tests/helpers/ir-deno-post-position-main-successor.json",
  "tests/issue-4376-post-position-main-inventory-successor.test.ts",
] as const;
const callerPin = {
  bytes: 360428,
  sha256: "529e1d9d98cf7a97c0418350547beae8c9d598ca98dc93cc786d14abeeb23e28",
  gitBlob: "dee50f79c3770585d18c7323024fc48be9a5597a",
} as const;
const priorCallerPin = {
  bytes: 360226,
  sha256: "82ef54078b5eca0363b43a28e844564b758a682aaac57f179301396985ec9d34",
  gitBlob: "7be3a33dd8edf93caa5912bfc8bc2ef5312a37c1",
} as const;
const helperPin = {
  bytes: 30399,
  sha256: "52d31a9c7fd7ce39e0cc66c6c17ac0d52c62bdba5021eabb11878c621179233d",
} as const;
const receiptPin = {
  bytes: 21476,
  sha256: "def88ffa87ea3fc238d83127d79eb540668f83bee12a424547a9d140720f1e5c",
} as const;
const callerPath = "tests/issue-4376-post-position-main-inventory-successor.test.ts";
const policyInsertion =
  '    },\n    {\n      "path": "src/ir/native-number-undefined-source.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Original checker-symbol/local dense-vector source and complete incoming/prototype-effect census remains frontend authority; migrate with source preparation, without serializing capabilities or inferring runtime absence from numeric types."\n    },\n    {\n      "path": "src/ir/core/native-number-undefined-lowering.ts",\n      "state": "clean",\n      "layer": "ir-core"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-body.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-profile.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-producer.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/program/native-number-undefined-requirements.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/native-number-undefined-abi.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/runtime/native-number-undefined-profile.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/ir/backend/native-number-undefined.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate portable IR binding/proof contracts from concrete ValType/Instr carrier emission, scratch-local and memory-offset descriptors before core activation; all-import closure purity alone does not certify semantic core ownership."\n    },\n    {\n      "path": "src/backend/wasmgc/resources/native-number-undefined.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/linear/program/native-number-undefined.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate target-specific IR tags/errors/checker types from reusable physical record operations before activation; the current source-free recipe preserves exact existing allocation geometry and requires the issued Linear pack, without asserting a clean Wasm foundation boundary."\n    },\n    {\n      "path": "src/ir/program-number-undefined-resources.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain complete independent logical/source evidence and exact whole-attempt checks while consuming genuine target-specific reservations; split physical emission orchestration from portable independently issued proof after the separate proof receiving scope. No clean ir-program activation is inferred from a source-free closure."\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-number-undefined-legality.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/program/native-number-undefined-allocation-validation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/compiler/ir-native-number-undefined-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate completed native support-singleton authentication and concrete GC/Linear carrier/type/initializer/data joins from portable program presentation, retaining complete original/selected semantic evidence and opaque emission currentness. No clean compiler activation or general public dynamic ABI is inferred."\n';
const callerImport =
  'import { createIrNativeNumberUndefinedInventoryReader } from "./helpers/ir-native-number-undefined-inventory-successor.js";\n';
const callerBinding =
  'const read = (path: string): string =>\n  createIrNativeNumberUndefinedInventoryReader((currentPath) => readFileSync(resolve(root, currentPath), "utf8"))(path);\n';
const priorCallerBinding = 'const read = (path: string): string => readFileSync(resolve(root, path), "utf8");\n';
const policyInsertionOffset = 633115;
type Policy = Record<string, unknown> & { files: Record<string, unknown>[] };
const root = resolve(import.meta.dirname, "..");
const actualDisk = (path: string): string => readFileSync(resolve(root, path), "utf8");
const physicalDisk = actualDisk;
const createIrNativeNumberUndefinedOptimizationPolicyReader = (supplied: (path: string) => string) =>
  originalOptimizationPolicyReader(
    supplied === actualDisk ? createIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk) : supplied,
  );
const createLazyIrNativeNumberUndefinedOptimizationPolicyReader = (supplied: (path: string) => string) =>
  originalLazyOptimizationPolicyReader(
    supplied === actualDisk ? createLazyIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk) : supplied,
  );
const disk = (path: string): string => createIrNativeNumberUndefinedOptimizationPolicyReader(actualDisk)(path);
type Reader = (path: string) => string;
const defaultInput = (supplied: Reader | undefined): Reader =>
  supplied === undefined ? createLazyIrNativeNumberUndefinedOptimizationPolicyReader(actualDisk) : supplied;
const createReader = (supplied?: Reader) => originalCreateReader(defaultInput(supplied));
const beforeData = (value: unknown, supplied?: Reader) => originalBeforeData(value, defaultInput(supplied));
const beforeRaw = (raw: string, supplied?: Reader) => originalBeforeRaw(raw, defaultInput(supplied));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const blob = (value: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest("hex");
function pin(raw: string, target: { bytes: number; sha256: string; gitBlob?: string }): void {
  expect(Buffer.byteLength(raw)).toBe(target.bytes);
  expect(hash(raw)).toBe(target.sha256);
  if (target.gitBlob) expect(blob(raw)).toBe(target.gitBlob);
}
function profile(
  raw: string,
  target: typeof expected.before | typeof expected.current | typeof historical.main | typeof historical.deno,
): Policy {
  pin(raw, target.source);
  const data = JSON.parse(raw) as Policy;
  expect(Object.keys(data)).toEqual(target.topLevelKeys);
  expect(data.files).toHaveLength(target.fileCount);
  expect(hash(JSON.stringify(data))).toBe(target.dataSha256);
  expect(hash(JSON.stringify(data.files))).toBe(target.filesSha256);
  expect(hash(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "files"))))).toBe(
    target.nonFilesSha256,
  );
  return data;
}
function snapshot(): Map<string, string> {
  return new Map(fixedPaths.map((path) => [path, disk(path)]));
}
const reader =
  (values: Map<string, string>) =>
  (path: string): string =>
    values.get(path) ?? disk(path);
function freshData(): Policy {
  return JSON.parse(disk("scripts/compiler-boundaries.json")) as Policy;
}
afterEach(async () => {
  await yieldTurn();
});

describe("actual2016 native Number/Undefined inventory continuation", () => {
  it("pins actual complete helper, receipt, caller, policy and unchanged historical authority", () => {
    pin(disk("tests/helpers/ir-native-number-undefined-inventory-successor.ts"), helperPin);
    pin(disk(receiptPath), receiptPin);
    pin(disk(callerPath), callerPin);
    for (const anchor of historicalAnchors) pin(disk(anchor.path), anchor);
    const current = profile(disk("scripts/compiler-boundaries.json"), expected.current);
    expect(current.files.slice(2001)).toEqual(insertedRows);
    expect(current.files).toHaveLength(2016);
    const receipt = JSON.parse(disk(receiptPath));
    expect(receipt.physicalReadsPerOperation).toBe(5);
    expect(receipt.fixedCapturePaths).toEqual(fixedPaths);
    expect(receipt.before).toEqual(expected.before);
    expect(receipt.current).toEqual(expected.current);
  });
  it("independently inverts and replays the entire raw policy and complete fifteen-row DATA", () => {
    const raw = disk("scripts/compiler-boundaries.json"),
      bytes = Buffer.from(raw);
    expect(
      bytes.subarray(policyInsertionOffset, policyInsertionOffset + Buffer.byteLength(policyInsertion)).toString(),
    ).toBe(policyInsertion);
    const before = Buffer.concat([
      bytes.subarray(0, policyInsertionOffset),
      bytes.subarray(policyInsertionOffset + Buffer.byteLength(policyInsertion)),
    ]).toString();
    const previous = profile(before, expected.before),
      current = profile(raw, expected.current);
    expect(
      Buffer.concat([
        Buffer.from(before).subarray(0, policyInsertionOffset),
        Buffer.from(policyInsertion),
        Buffer.from(before).subarray(policyInsertionOffset),
      ]).toString(),
    ).toBe(raw);
    const semantic = { ...current, files: current.files.slice(0, 2001) };
    expect(semantic).toEqual(previous);
    expect({ ...previous, files: [...previous.files, ...insertedRows] }).toEqual(current);
    expect(beforeData(current)).toEqual(previous);
    expect(beforeRaw(raw)).toBe(before);
  });
  it("authenticates the complete current caller and restores only import plus initial input binding", () => {
    const current = disk(callerPath);
    expect(current.startsWith(callerImport)).toBe(true);
    expect(current.split(callerBinding)).toHaveLength(2);
    const restored = current.slice(callerImport.length).replace(callerBinding, priorCallerBinding);
    pin(restored, priorCallerPin);
    expect(callerImport + restored.replace(priorCallerBinding, callerBinding)).toBe(current);
    expect(createReader()(callerPath)).toBe(restored);
    // Complete raw equality also preserves all historical callbacks/literals/default counters.
  });
  it.each(["main", "deno"] as const)("composes actual raw and DATA through unchanged %s endpoints", (route) => {
    const current = disk("scripts/compiler-boundaries.json"),
      transport = createReader();
    const before = transport("scripts/compiler-boundaries.json");
    profile(before, expected.before);
    const raw = route === "main" ? mainRaw(before, transport) : denoRaw(before, transport);
    const data = route === "main" ? mainData(JSON.parse(before), transport) : denoData(JSON.parse(before), transport);
    expect(data).toEqual(profile(raw, historical[route]));
    expect(beforeRaw(current)).toBe(before);
    expect(beforeData(JSON.parse(current))).toEqual(JSON.parse(before));
    // Their untouched defaults still authenticate the original historical receipt.
    expect(route === "main" ? mainRaw(before) : denoRaw(before)).toBe(raw);
    expect(route === "main" ? mainData(JSON.parse(before)) : denoData(JSON.parse(before))).toEqual(data);
  });
  it("uses exactly five fresh physical captures, zero mapped rereads and one unknown read per operation", () => {
    const seen: string[] = [];
    const read = (path: string) => {
      seen.push(path);
      return path === "unknown-control" ? "original" : disk(path);
    };
    const first = createReader(read);
    expect(seen).toEqual(fixedPaths);
    for (const path of fixedPaths) {
      first(path);
      first(path);
    }
    expect(seen).toEqual(fixedPaths);
    expect(first("unknown-control")).toBe("original");
    expect(first("unknown-control")).toBe("original");
    expect(seen).toEqual([...fixedPaths, "unknown-control"]);
    const second = createReader(read);
    second("scripts/compiler-boundaries.json");
    expect(seen).toEqual([...fixedPaths, "unknown-control", ...fixedPaths]);
  });
  it.each(fixedPaths)("refuses fresh warm capture drift in %s and succeeds after restoration", (path) => {
    const values = snapshot(),
      actual = reader(values),
      prior = values.get(path)!;
    const first = createReader(actual);
    first("scripts/compiler-boundaries.json");
    values.set(path, prior + " ");
    expect(() => createReader(actual)).toThrow();
    // An existing captured view is immutable; a new operation must observe current authority.
    expect(first("scripts/compiler-boundaries.json")).toBe(beforeRaw(disk("scripts/compiler-boundaries.json")));
    values.set(path, prior);
    expect(createReader(actual)("scripts/compiler-boundaries.json")).toBe(first("scripts/compiler-boundaries.json"));
  });
  it.each([receiptPath, callerPath])(
    "refuses actual owned disk drift in %s after warm success, then restores",
    (path) => {
      const absolute = resolve(root, path),
        original = actualDisk(path);
      createReader();
      try {
        writeFileSync(absolute, original + " ");
        expect(() => createReader()).toThrow();
      } finally {
        writeFileSync(absolute, original);
      }
      expect(createReader()("scripts/compiler-boundaries.json")).toBe(
        beforeRaw(disk("scripts/compiler-boundaries.json")),
      );
    },
  );
  it.each(fixedPaths)("refuses missing/nonprimitive physical capture %s", (path) => {
    const values = snapshot();
    let conversions = 0;
    const fake = {
      toString() {
        conversions++;
        return values.get(path);
      },
    };
    expect(() => createReader((name) => (name === path ? (fake as unknown as string) : values.get(name)!))).toThrow();
    expect(conversions).toBe(0);
  });
  it.each(
    insertedRows.flatMap((row, offset) =>
      ["path", "omission", "order", "state", "extra", "debt"].map((kind) => ({
        path: row.path,
        index: 2001 + offset,
        kind,
      })),
    ),
  )("refuses current row $path $kind corruption", ({ index, kind }) => {
    const data = freshData();
    if (kind === "omission") data.files.splice(index, 1);
    else if (kind === "order")
      [data.files[index - 1], data.files[index]] = [data.files[index]!, data.files[index - 1]!];
    else if (kind === "path") data.files[index]!.path = "src/forged.ts";
    else if (kind === "state") data.files[index]!.state = "forged";
    else if (kind === "extra") data.files[index]!.injected = true;
    else data.files[index]!.nextBoundary = "foreign grant";
    expect(() => beforeData(data)).toThrow();
  });
  it.each(expected.current.topLevelKeys.filter((key) => key !== "files"))(
    "refuses kernel/non-files change to %s",
    (key) => {
      const data = freshData();
      data[key] = null;
      expect(() => beforeData(data)).toThrow();
    },
  );
  it.each([0, 1000, 2000])("refuses unchanged kernel row %s drift", (index) => {
    const data = freshData();
    data.files[index]!.path = "src/forged-kernel.ts";
    expect(() => beforeData(data)).toThrow();
  });
  it.each(["whitespace", "bom", "missingByte", "formatting", "insertionTruncate", "kernelByte"])(
    "refuses complete raw %s drift",
    (kind) => {
      const raw = disk("scripts/compiler-boundaries.json");
      const mutant =
        kind === "whitespace"
          ? raw + " "
          : kind === "bom"
            ? "\ufeff" + raw
            : kind === "missingByte"
              ? raw.slice(1)
              : kind === "formatting"
                ? raw.replace("  ", "\t")
                : kind === "kernelByte"
                  ? raw.replace('"description"', '"descriptioN"')
                  : raw.slice(0, policyInsertionOffset) + raw.slice(policyInsertionOffset + 1);
      expect(() => beforeRaw(mutant)).toThrow();
    },
  );
  it.each([
    "rootGetter",
    "rowGetter",
    "nestedGetter",
    "symbol",
    "hole",
    "arrayShadow",
    "prototype",
    "cycle",
    "nonFinite",
    "undefined",
    "toJSON",
    "hidden",
  ])("refuses descriptor DATA %s without executing getters", (kind) => {
    const data = freshData();
    let reads = 0;
    const getter = {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        throw Error("getter executed");
      },
    };
    if (kind === "rootGetter") Object.defineProperty(data, "files", getter);
    else if (kind === "rowGetter") Object.defineProperty(data.files[2001]!, "path", getter);
    else if (kind === "nestedGetter") Object.defineProperty(data.files, "2001", getter);
    else if (kind === "symbol") Object.defineProperty(data, Symbol("foreign"), { value: true });
    else if (kind === "hole") Reflect.deleteProperty(data.files, "2001");
    else if (kind === "arrayShadow") Object.defineProperty(data.files, "foreign", { value: true });
    else if (kind === "prototype") Object.setPrototypeOf(data.files[2001]!, { foreign: true });
    else if (kind === "cycle") data.foreign = data;
    else if (kind === "nonFinite") data.foreign = NaN;
    else if (kind === "undefined") data.foreign = undefined;
    else if (kind === "toJSON")
      data.toJSON = () => {
        reads++;
        return {};
      };
    else Object.defineProperty(data, "foreign", { value: true, enumerable: false });
    expect(() => beforeData(data)).toThrow();
    expect(reads).toBe(0);
  });
  it.each(["schema", "profile", "row", "span", "caller", "anchor", "capturePath", "counter"])(
    "refuses outer receipt %s repin",
    (kind) => {
      const values = snapshot(),
        receipt = JSON.parse(values.get(receiptPath)!);
      if (kind === "schema") receipt.schema += "-forged";
      else if (kind === "profile") receipt.current.fileCount++;
      else if (kind === "row") receipt.addedRows[0].row.state = "forged";
      else if (kind === "span") receipt.rawSpans[0].afterOffset++;
      else if (kind === "caller") receipt.caller.current.sha256 = "0".repeat(64);
      else if (kind === "anchor") receipt.anchors[0].sha256 = "0".repeat(64);
      else if (kind === "counter") receipt.physicalReadsPerOperation = 0;
      else receipt.fixedCapturePaths[0] = "foreign";
      values.set(receiptPath, JSON.stringify(receipt));
      expect(() => createReader(reader(values))).toThrow();
    },
  );
});
