// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { authenticateIrValidationPolicy, type IrValidationPolicy } from "./ir-validation-policy-evolution.js";

export const irRuntimeProgramPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-evolution.json";
const receiptSha256 = "8e2589e90fbc697dceba56e1bbe53447250a94f3bcb03d99317ad4878bc1f58c";
const beforeData = "e8d0034c26f59e042da49dfcc4af562436b562421b9e231ae78d664ab70c73e3";
const currentData = "f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11";
const edges = "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7";
const program = [
  "src/ir/program/owner.ts",
  "src/ir/program/draft-abi-lookup.ts",
  "src/ir/program/runtime-support-dependencies.ts",
];
const runtime = ["src/ir/runtime/generator-support.ts"];
const additions = [
  ...program.map((path) => ({ path, state: "clean", layer: "ir-program" })),
  ...runtime.map((path) => ({ path, state: "clean", layer: "ir-runtime" })),
];
const activations = [
  { layer: "ir-program", entries: program, minModules: 3 },
  { layer: "ir-runtime", entries: runtime, minModules: 1 },
];
interface Profile {
  source: { bytes: number; sha256: string; gitBlob: string };
  dataSha256: string;
  fileCount: number;
  filesSha256: string;
  activationCount: number;
  activationHistorySha256: string;
  layersSha256: string;
}
export interface IrRuntimeProgramPolicyReceipt {
  schema: number;
  kind: string;
  provenance: {
    reviewedBase: string;
    planSha256: string;
    immutableInputs: { path: string; bytes: number; sha256: string }[];
  };
  before: Profile;
  current: Profile;
  allowedEdgesSha256: string;
  layerDeltas: {
    index: number;
    id: string;
    beforeEntries: number;
    currentEntries: number;
    beforeMinModules: number;
    currentMinModules: number;
    roots: string[];
    additions: string[];
  }[];
  addedFiles: Record<string, string>[];
  activationAdditions: { layer: string; entries: string[]; minModules: number }[];
  census: Record<string, number>;
}
export interface MutableIrRuntimeProgramPolicy {
  layers: {
    id: string;
    status: string;
    required?: boolean;
    roots: string[];
    entries?: string[];
    minModules?: number;
  }[];
  files: Record<string, string>[];
  activationHistory: { layer: string; entries: string[]; minModules: number }[];
  allowedEdges: Record<string, string[]>;
  [key: string]: unknown;
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function fail(detail: string): never {
  throw new Error(`runtime program policy evolution: ${detail}`);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Inspect descriptors first; no caller property read or serialization precedes this capture. */
function capture(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || value === null || active.has(value)) fail("non-JSON or cyclic policy");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail("foreign prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== "string") fail("symbol policy key");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length")))
      fail("accessor or hidden policy field");
  }
  active.add(value);
  try {
    if (array) {
      const length = descriptors.length!.value as number;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)
        fail("array holes or extra fields");
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor) fail("array hole or inherited element");
        result.push(capture(descriptor.value, active));
      }
      return result;
    }
    // defineProperty also preserves a literal __proto__ key as ordinary owned data.
    const result: Record<string, unknown> = {};
    for (const key of keys as string[])
      Object.defineProperty(result, key, {
        value: capture(descriptors[key]!.value, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return result;
  } finally {
    active.delete(value);
  }
}

export function authenticateIrRuntimeProgramPolicyEvolution(
  text = readFileSync(new URL(`../../${irRuntimeProgramPolicyReceiptPath}`, import.meta.url), "utf8"),
): IrRuntimeProgramPolicyReceipt {
  if (sha(text) !== receiptSha256) fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as IrRuntimeProgramPolicyReceipt;
  if (
    receipt.schema !== 1 ||
    receipt.kind !== "c1-exact-runtime-program-policy-evolution" ||
    receipt.before.dataSha256 !== beforeData ||
    receipt.current.dataSha256 !== currentData ||
    receipt.before.fileCount !== 1765 ||
    receipt.current.fileCount !== 1769 ||
    receipt.before.activationCount !== 94 ||
    receipt.current.activationCount !== 96 ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.addedFiles, additions) ||
    !same(receipt.activationAdditions, activations) ||
    !same(
      receipt.layerDeltas.map((d) => [
        d.index,
        d.id,
        d.beforeEntries,
        d.currentEntries,
        d.beforeMinModules,
        d.currentMinModules,
        d.roots,
        d.additions,
      ]),
      [
        [9, "ir-program", 40, 43, 40, 43, ["src/ir/program"], program],
        [8, "ir-runtime", 18, 19, 18, 19, ["src/ir/runtime"], runtime],
      ],
    ) ||
    !same(receipt.census, {
      layers: 20,
      requiredProgram: 43,
      requiredRuntime: 19,
      requiredNative: 98,
      nativeFloor: 97,
      requiredAnalysis: 11,
      requiredCore: 29,
      classifiedProgram: 44,
      classifiedRuntime: 19,
      classifiedNative: 103,
    })
  )
    fail("fixed receipt population mismatch");
  // The unchanged real B guard is part of the authority, not a caller attestation.
  for (const [path, expected] of [
    [
      "tests/helpers/ir-validation-policy-evolution.ts",
      "a962c04960b945705e9ac5a354da3e96c8e0cf5543382847231dd3df9204fb40",
    ],
    [
      "tests/helpers/ir-validation-policy-evolution.json",
      "39dacc9d17fb52b6a369ed81d7498afc30b00bc06d89362bba039305aa96fa0e",
    ],
  ])
    if (sha(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")) !== expected) fail("B authority changed");
  return freeze(receipt);
}
function prove(value: unknown): { current: MutableIrRuntimeProgramPolicy; before: MutableIrRuntimeProgramPolicy } {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = authenticateIrRuntimeProgramPolicyEvolution();
  if (digest(current) !== currentData) fail("complete current policy mismatch");
  if (
    current.files.length !== 1769 ||
    current.activationHistory.length !== 96 ||
    current.layers.length !== 20 ||
    digest(current.files) !== receipt.current.filesSha256 ||
    digest(current.activationHistory) !== receipt.current.activationHistorySha256 ||
    digest(current.layers) !== receipt.current.layersSha256 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1765)) !== receipt.before.filesSha256 ||
    digest(current.activationHistory.slice(0, 94)) !== receipt.before.activationHistorySha256 ||
    !same(current.files.slice(1765), additions) ||
    !same(current.activationHistory.slice(94), activations)
  )
    fail("current inventory or suffix mismatch");
  for (const [id, required, floor, classified] of [
    ["ir-program", 43, 43, 44],
    ["ir-runtime", 19, 19, 19],
    ["native-runtime", 98, 97, 103],
    ["ir-analysis", 11, 11, 11],
    ["ir-core", 29, 29, 29],
  ] as const) {
    const rows = current.layers.filter((row) => row.id === id);
    if (
      rows.length !== 1 ||
      rows[0]!.entries?.length !== required ||
      rows[0]!.minModules !== floor ||
      current.files.filter((row) => row.layer === id).length !== classified
    )
      fail("independent layer census mismatch");
  }
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  before.files.length = 1765;
  before.activationHistory.length = 94;
  for (const delta of receipt.layerDeltas) {
    const row = before.layers[delta.index]!;
    if (
      row.id !== delta.id ||
      row.status !== "active" ||
      row.required !== true ||
      !same(row.roots, delta.roots) ||
      row.entries?.length !== delta.currentEntries ||
      row.minModules !== delta.currentMinModules ||
      !same(row.entries.slice(delta.beforeEntries), delta.additions)
    )
      fail("layer delta mismatch");
    row.entries.length = delta.beforeEntries;
    row.minModules = delta.beforeMinModules;
  }
  if (digest(before.layers) !== receipt.before.layersSha256 || digest(before) !== beforeData)
    fail("complete B inverse mismatch");
  const verified = authenticateIrValidationPolicy(before);
  const replay = capture(verified) as MutableIrRuntimeProgramPolicy;
  replay.files.push(...(capture(additions) as Record<string, string>[]));
  replay.activationHistory.push(...(capture(activations) as MutableIrRuntimeProgramPolicy["activationHistory"]));
  for (const delta of receipt.layerDeltas) {
    replay.layers[delta.index]!.entries!.push(...delta.additions);
    replay.layers[delta.index]!.minModules = delta.currentMinModules;
  }
  if (!same(replay, current) || digest(replay) !== currentData) fail("complete reciprocal replay mismatch");
  return { current, before };
}
/** A newly owned, deeply frozen current snapshot; no identity-based acceptance cache. */
export function authenticateIrRuntimeProgramPolicy(value: unknown): IrValidationPolicy {
  return freeze(prove(value).current) as IrValidationPolicy;
}
/** A fresh mutable B copy for unchanged old mutation detectors, derived only from actual C1. */
export function beforeIrRuntimeProgramPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return prove(value).before;
}

// WKS successor proof is intentionally appended after the complete immutable C1 helper.
export const wellKnownSymbolPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-well-known-symbols.json";
const wksReceiptSha256 = "5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61";
const wksData = "462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7";
const wksPrefix = { bytes: 10742, sha256: "2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d" };
const wksContract = "src/runtime/contracts/well-known-symbols.ts";
const wksOwner = "src/backend/wasmgc/resources/native-well-known-symbols.ts";
const wksFiles = [
  { path: wksContract, state: "clean", layer: "runtime-contracts" },
  { path: wksOwner, state: "clean", layer: "backend-wasmgc" },
];
const wksActivations = [
  { layer: "runtime-contracts", entries: [wksContract], minModules: 1 },
  { layer: "backend-wasmgc", entries: [wksOwner], minModules: 1 },
];
const wksLayerDeltas = [
  {
    index: 10,
    id: "runtime-contracts",
    beforeEntries: 9,
    currentEntries: 10,
    beforeMinModules: 9,
    currentMinModules: 10,
    roots: ["src/runtime/contracts"],
    additions: [wksContract],
  },
  {
    index: 11,
    id: "backend-wasmgc",
    beforeEntries: 49,
    currentEntries: 50,
    beforeMinModules: 49,
    currentMinModules: 50,
    roots: ["src/backend/wasmgc"],
    additions: [wksOwner],
  },
];
const wksTopKeys = [
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
];
const wksCensus = {
  layers: 20,
  files: 1771,
  histories: 98,
  requiredContracts: 10,
  contractsFloor: 10,
  classifiedContracts: 10,
  requiredBackend: 50,
  backendFloor: 50,
  classifiedBackend: 55,
  requiredProgram: 43,
  classifiedProgram: 44,
  requiredRuntime: 19,
  classifiedRuntime: 19,
  requiredNative: 98,
  nativeFloor: 97,
  classifiedNative: 103,
  requiredAnalysis: 11,
  requiredCore: 29,
};
export interface WellKnownSymbolPolicyReceipt extends IrRuntimeProgramPolicyReceipt {
  provenance: IrRuntimeProgramPolicyReceipt["provenance"] & { c1HelperPrefix: { bytes: number; sha256: string } };
  raw: {
    offsetUnit: "utf16-code-unit";
    spans: { role: string; beforeOffset: number; afterOffset: number; before: string; after: string }[];
  };
}
function wksFail(detail: string): never {
  throw new Error("well-known symbol policy evolution: " + detail);
}

/** One fixed root-authored receipt; alternate text is only a negative-test input. */
export function authenticateWellKnownSymbolPolicyEvolution(
  text = readFileSync(new URL(`../../${wellKnownSymbolPolicyReceiptPath}`, import.meta.url), "utf8"),
): WellKnownSymbolPolicyReceipt {
  if (typeof text !== "string" || sha(text) !== wksReceiptSha256) wksFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as WellKnownSymbolPolicyReceipt;
  const c1 = authenticateIrRuntimeProgramPolicyEvolution();
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "provenance",
      "before",
      "current",
      "allowedEdgesSha256",
      "layerDeltas",
      "addedFiles",
      "activationAdditions",
      "census",
      "raw",
    ]) ||
    receipt.schema !== 1 ||
    receipt.kind !== "wks-exact-runtime-program-policy-successor" ||
    receipt.provenance.reviewedBase !== "c7366c3c6d3eb9e4c5cff0b29b11c42e3faab4c7" ||
    receipt.provenance.planSha256 !== "803f3fcc5af93344f878b33dace6c9484d2d4aa1437e9537548c899f4204753c" ||
    !same(receipt.provenance.c1HelperPrefix, wksPrefix) ||
    !same(receipt.before, c1.current) ||
    receipt.current.dataSha256 !== wksData ||
    receipt.current.fileCount !== 1771 ||
    receipt.current.activationCount !== 98 ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.layerDeltas, wksLayerDeltas) ||
    !same(receipt.addedFiles, wksFiles) ||
    !same(receipt.activationAdditions, wksActivations) ||
    !same(receipt.census, wksCensus)
  )
    wksFail("fixed receipt population mismatch");
  const expectedInputs = [
    { path: irRuntimeProgramPolicyReceiptPath, bytes: 6804, sha256: receiptSha256 },
    ...c1.provenance.immutableInputs,
  ];
  if (
    expectedInputs.length !== 19 ||
    new Set(expectedInputs.map((pin) => pin.path)).size !== 19 ||
    !same(receipt.provenance.immutableInputs, expectedInputs)
  )
    wksFail("immutable input membership mismatch");
  for (const pin of receipt.provenance.immutableInputs) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      wksFail("immutable input changed: " + pin.path);
  }
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < wksPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, wksPrefix.bytes)).digest("hex") !== wksPrefix.sha256
  )
    wksFail("original C1 helper prefix changed");
  const roles = ["runtime-contracts-layer-tail", "backend-wasmgc-layer-tail", "activation-history-tail", "files-tail"];
  const starts = [
    '"src/runtime/contracts/native-realm-catalog.ts"',
    '"src/backend/wasmgc/resources/native-mixed-object-access.ts"',
    '    {\n      "layer": "ir-runtime",\n      "entries": ["src/ir/runtime/generator-support.ts"],\n      "minModules": 1\n    }',
    '    {\n      "path": "src/ir/runtime/generator-support.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    }',
  ];
  const beforeEnds = ['"minModules": 9', '"minModules": 49', '"nonModules"', "  ]\n}\n"];
  const afterEnds = ['"minModules": 10', '"minModules": 50', '"nonModules"', "  ]\n}\n"];
  if (receipt.raw.offsetUnit !== "utf16-code-unit" || receipt.raw.spans.length !== 4) wksFail("raw span population");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  receipt.raw.spans.forEach((span, index) => {
    if (
      span.role !== roles[index] ||
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement ||
      !span.before ||
      !span.after ||
      !span.before.startsWith(starts[index]!) ||
      !span.after.startsWith(starts[index]!) ||
      !span.before.endsWith(beforeEnds[index]!) ||
      !span.after.endsWith(afterEnds[index]!)
    )
      wksFail("raw span anchors or order");
    beforeEnd = span.beforeOffset + span.before.length;
    afterEnd = span.afterOffset + span.after.length;
    displacement += span.after.length - span.before.length;
  });
  return freeze(receipt);
}

function wksSemanticProfile(policy: MutableIrRuntimeProgramPolicy, profile: Profile): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256
  )
    wksFail("complete policy profile mismatch");
}
function proveWellKnownSymbolPolicy(value: unknown): {
  current: MutableIrRuntimeProgramPolicy;
  before: MutableIrRuntimeProgramPolicy;
} {
  // The old private capture rejects descriptors/non-JSON data before any serialization or borrowed field read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = authenticateWellKnownSymbolPolicyEvolution();
  wksSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1769)) !== receipt.before.filesSha256 ||
    digest(current.activationHistory.slice(0, 96)) !== receipt.before.activationHistorySha256 ||
    !same(current.files.slice(1769), wksFiles) ||
    !same(current.activationHistory.slice(96), wksActivations)
  )
    wksFail("ordered current prefix or suffix mismatch");
  for (const [id, entries, floor, classified] of [
    ["runtime-contracts", 10, 10, 10],
    ["backend-wasmgc", 50, 50, 55],
    ["ir-program", 43, 43, 44],
    ["ir-runtime", 19, 19, 19],
    ["native-runtime", 98, 97, 103],
    ["ir-analysis", 11, 11, 11],
    ["ir-core", 29, 29, 29],
  ] as const) {
    const rows = current.layers.filter((row) => row.id === id);
    if (
      rows.length !== 1 ||
      rows[0]!.entries?.length !== entries ||
      rows[0]!.minModules !== floor ||
      current.files.filter((row) => row.layer === id).length !== classified
    )
      wksFail("independent layer census mismatch");
  }
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  before.files.length = 1769;
  before.activationHistory.length = 96;
  for (const delta of wksLayerDeltas) {
    const layer = before.layers[delta.index]!;
    if (
      layer.id !== delta.id ||
      layer.status !== "active" ||
      layer.required !== true ||
      !same(layer.roots, delta.roots) ||
      layer.entries?.length !== delta.currentEntries ||
      layer.minModules !== delta.currentMinModules ||
      !same(layer.entries.slice(delta.beforeEntries), delta.additions)
    )
      wksFail("exact layer delta mismatch");
    layer.entries.length = delta.beforeEntries;
    layer.minModules = delta.beforeMinModules;
  }
  wksSemanticProfile(before, receipt.before);
  const genuineC1 = authenticateIrRuntimeProgramPolicy(before); // This unchanged guard really derives/authenticates B.
  const replay = capture(genuineC1) as MutableIrRuntimeProgramPolicy;
  replay.files.push(...(capture(wksFiles) as MutableIrRuntimeProgramPolicy["files"]));
  replay.activationHistory.push(...(capture(wksActivations) as MutableIrRuntimeProgramPolicy["activationHistory"]));
  for (const delta of wksLayerDeltas) {
    replay.layers[delta.index]!.entries!.push(...delta.additions);
    replay.layers[delta.index]!.minModules = delta.currentMinModules;
  }
  wksSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) wksFail("complete independent reciprocal replay mismatch");
  return { current, before };
}
/** Fresh detached deeply frozen actual WKS current data; no cached completion authority. */
export function authenticateWellKnownSymbolPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveWellKnownSymbolPolicy(value).current) as IrValidationPolicy;
}
/** Fresh mutable exact C1 data for the unchanged predecessor mutation controls. */
export function beforeWellKnownSymbolPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveWellKnownSymbolPolicy(value).before;
}
function wksRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex");
  if (bytes !== profile.source.bytes || sha(raw) !== profile.source.sha256 || blob !== profile.source.gitBlob)
    wksFail("complete raw source profile mismatch");
}
/** Fixed offsets always address the original input; slices never drift after an earlier replacement. */
function applyWellKnownSymbolRaw(raw: string, receipt: WellKnownSymbolPolicyReceipt, forward: boolean): string {
  wksRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  for (const span of receipt.raw.spans) {
    const offset = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after;
    const to = forward ? span.after : span.before;
    if (
      offset < end ||
      raw.slice(offset, offset + from.length) !== from ||
      raw.indexOf(from) !== offset ||
      raw.lastIndexOf(from) !== offset
    )
      wksFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, offset), to);
    end = offset + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  wksRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Exact current raw -> exact C1 raw, cross-checked against the genuine semantic inverse and reciprocal replay. */
export function beforeWellKnownSymbolPolicySource(raw: string): string {
  if (typeof raw !== "string") wksFail("raw input must be a primitive string");
  const receipt = authenticateWellKnownSymbolPolicyEvolution();
  const before = applyWellKnownSymbolRaw(raw, receipt, false);
  const semantic = proveWellKnownSymbolPolicy(JSON.parse(raw));
  const parsedBefore = JSON.parse(before) as MutableIrRuntimeProgramPolicy;
  wksSemanticProfile(parsedBefore, receipt.before);
  authenticateIrRuntimeProgramPolicy(parsedBefore);
  if (!same(parsedBefore, semantic.before) || applyWellKnownSymbolRaw(before, receipt, true) !== raw)
    wksFail("raw and semantic reciprocal proof disagree");
  return before;
}

// Number prerequisites are a fixed successor; the complete C1 and WKS helpers above remain immutable.
export const numberPrerequisitePolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-number-prerequisites.json";
const numberReceiptSha256 = "92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845";
const numberPrefix = {
  bytes: 23854,
  sha256: "fe575facb2aedc750760ba302ded54ab37ac223ff70e0d07f25faa804de84474",
};
const numberBeforeProfile = {
  source: {
    bytes: 565875,
    sha256: "451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59",
    gitBlob: "74dc1b073145713d122e28a0b45f34c0cc41a066",
  },
  dataSha256: "462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7",
  fileCount: 1771,
  filesSha256: "fb09eb31db052006e682dbad6dd421488a7ccc1093169ca18779e33a80ec929d",
  activationCount: 98,
  activationHistorySha256: "66367385757ebdd22d24656c46f0317f97aaf4b104a431e94c4b566753b53eac",
  layersSha256: "091f25a5fee65a0185b62916ecbdd60afabd96409fa914cf02cb17616a1f0d7c",
};
const numberCurrentProfile = {
  source: {
    bytes: 567166,
    sha256: "8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df",
    gitBlob: "0d90f336925232fd22c98c438121b93e7e5bcf52",
  },
  dataSha256: "5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21",
  fileCount: 1775,
  filesSha256: "82448a8b5bf6373b7ef203924f3ac4f0d33e69ca1df77b322812b63613fe8bec",
  activationCount: 100,
  activationHistorySha256: "f6716a46656b3e4e7292e6d6c2cfdb5681becc9fb0e688ebad01a49c48d044ab",
  layersSha256: "ab456c917964e4e4d51c7110ce854e8c8648827a72eb4e6e61e2d74dc7f08a05",
};
const numberSourceInputs = [
  {
    path: "src/runtime/wasmgc/values/bigint-to-number-body.ts",
    bytes: 9195,
    sha256: "a698e80ad9054d7dd66ed33e17798b339b3ae2c16c7b9efdd004394d52e91d80",
  },
  {
    path: "src/runtime/wasmgc/values/number-from-value-body.ts",
    bytes: 9609,
    sha256: "00376356e12a0d70976addeff7911b1ec5401375b1f4eb0d7c81450568c20b59",
  },
  {
    path: "src/backend/wasmgc/resources/native-bigint-number.ts",
    bytes: 15683,
    sha256: "ccc1c66d4fc734339cc9a192dc29f24d08483fb7a559b777a903a622b64c3cc6",
  },
  {
    path: "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    bytes: 21040,
    sha256: "210c30e3f2928952ebfceeafb8f6545930054b0c5ed9c1ec66ca2afcc41e7161",
  },
  {
    path: "tests/issue-3518-bigint-to-number-body.test.ts",
    bytes: 11598,
    sha256: "f80b9fe1701a8f289a458a5032d3d4bd0af4910d723eabe343476b4814c3f130",
  },
  {
    path: "tests/issue-3518-native-bigint-number-owner.test.ts",
    bytes: 29455,
    sha256: "b266965df90630f184a136f07c6867f99b59507f1ee11f0ca141c047e6b8f621",
  },
  {
    path: "tests/issue-3518-native-number-primitive-classifier.test.ts",
    bytes: 43687,
    sha256: "45ad86969dd28b1597eef4e8e0a53531ea4f3dc54e90e2784ca6cb01baec626d",
  },
  {
    path: "tests/issue-3518-number-from-value-body.test.ts",
    bytes: 36900,
    sha256: "2abc9c96ebd7fcda5547c8f093530d08d56796b4ab4b636b64a4d3b0ff5ae969",
  },
];
const numberLayerDeltas = [
  {
    index: 11,
    id: "backend-wasmgc",
    beforeEntries: 50,
    currentEntries: 52,
    beforeMinModules: 50,
    currentMinModules: 52,
    roots: ["src/backend/wasmgc"],
    additions: [
      "src/backend/wasmgc/resources/native-bigint-number.ts",
      "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    ],
  },
  {
    index: 12,
    id: "native-runtime",
    beforeEntries: 98,
    currentEntries: 100,
    beforeMinModules: 97,
    currentMinModules: 99,
    roots: ["src/runtime/wasmgc"],
    additions: [
      "src/runtime/wasmgc/values/bigint-to-number-body.ts",
      "src/runtime/wasmgc/values/number-from-value-body.ts",
    ],
  },
];
const numberFiles = [
  {
    path: "src/runtime/wasmgc/values/bigint-to-number-body.ts",
    state: "clean",
    layer: "native-runtime",
  },
  {
    path: "src/runtime/wasmgc/values/number-from-value-body.ts",
    state: "clean",
    layer: "native-runtime",
  },
  {
    path: "src/backend/wasmgc/resources/native-bigint-number.ts",
    state: "clean",
    layer: "backend-wasmgc",
  },
  {
    path: "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    state: "clean",
    layer: "backend-wasmgc",
  },
];
const numberActivations = [
  {
    layer: "native-runtime",
    entries: [
      "src/runtime/wasmgc/values/bigint-to-number-body.ts",
      "src/runtime/wasmgc/values/number-from-value-body.ts",
    ],
    minModules: 2,
  },
  {
    layer: "backend-wasmgc",
    entries: [
      "src/backend/wasmgc/resources/native-bigint-number.ts",
      "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    ],
    minModules: 2,
  },
];
const numberCensus = {
  layers: 20,
  files: 1775,
  histories: 100,
  requiredContracts: 10,
  contractsFloor: 10,
  classifiedContracts: 10,
  requiredBackend: 52,
  backendFloor: 52,
  classifiedBackend: 57,
  requiredProgram: 43,
  classifiedProgram: 44,
  requiredRuntime: 19,
  classifiedRuntime: 19,
  requiredNative: 100,
  nativeFloor: 99,
  classifiedNative: 105,
  requiredAnalysis: 11,
  requiredCore: 29,
};
export interface NumberPrerequisitePolicyReceipt extends IrRuntimeProgramPolicyReceipt {
  provenance: IrRuntimeProgramPolicyReceipt["provenance"] & {
    wksHelperPrefix: { bytes: number; sha256: string };
    sourceInputs: { path: string; bytes: number; sha256: string }[];
  };
  raw: WellKnownSymbolPolicyReceipt["raw"];
}
function numberFail(detail: string): never {
  throw new Error("Number prerequisite policy evolution: " + detail);
}
/** Fresh authority and all 28 complete files are checked on every public action. */
export function authenticateNumberPrerequisitePolicyEvolution(
  text = readFileSync(new URL(`../../${numberPrerequisitePolicyReceiptPath}`, import.meta.url), "utf8"),
): NumberPrerequisitePolicyReceipt {
  if (typeof text !== "string" || sha(text) !== numberReceiptSha256) numberFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as NumberPrerequisitePolicyReceipt;
  const wks = authenticateWellKnownSymbolPolicyEvolution();
  const expectedInputs = [
    { path: wellKnownSymbolPolicyReceiptPath, bytes: 9470, sha256: wksReceiptSha256 },
    ...wks.provenance.immutableInputs,
  ];
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "provenance",
      "before",
      "current",
      "allowedEdgesSha256",
      "layerDeltas",
      "addedFiles",
      "activationAdditions",
      "census",
      "raw",
    ]) ||
    receipt.schema !== 1 ||
    receipt.kind !== "number-prerequisites-exact-runtime-program-policy-successor" ||
    receipt.provenance.reviewedBase !== "345616935e6ad070f1c39f9eb360131241acbbae" ||
    receipt.provenance.planSha256 !== "ba0fa7a97e9bdb4971bda4b7fffe50fc83976bc2b49b5b77127c0931b1865c3b" ||
    !same(receipt.provenance.wksHelperPrefix, numberPrefix) ||
    !same(receipt.before, wks.current) ||
    !same(receipt.before, numberBeforeProfile) ||
    !same(receipt.current, numberCurrentProfile) ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.layerDeltas, numberLayerDeltas) ||
    !same(receipt.addedFiles, numberFiles) ||
    !same(receipt.activationAdditions, numberActivations) ||
    !same(receipt.census, numberCensus)
  )
    numberFail("fixed receipt population mismatch");
  const pins = [...expectedInputs, ...numberSourceInputs];
  if (
    expectedInputs.length !== 20 ||
    pins.length !== 28 ||
    new Set(pins.map((pin) => pin.path)).size !== 28 ||
    !same(receipt.provenance.immutableInputs, expectedInputs) ||
    !same(receipt.provenance.sourceInputs, numberSourceInputs)
  )
    numberFail("fixed full-file input membership mismatch");
  for (const pin of pins) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      numberFail("full-file input changed: " + pin.path);
  }
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  if (
    helper.length < numberPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, numberPrefix.bytes)).digest("hex") !== numberPrefix.sha256
  )
    numberFail("original WKS helper prefix changed");
  const roles = ["backend-wasmgc-layer-tail", "native-runtime-layer-tail", "activation-history-tail", "files-tail"];
  const starts = [
    '"src/backend/wasmgc/resources/native-well-known-symbols.ts"',
    '"src/runtime/wasmgc/values/mixed-object-access-bodies.ts"',
    '    {\n      "layer": "backend-wasmgc",\n      "entries": ["src/backend/wasmgc/resources/native-well-known-symbols.ts"],\n      "minModules": 1\n    }',
    '    {\n      "path": "src/backend/wasmgc/resources/native-well-known-symbols.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    }',
  ];
  const beforeEnds = ['"minModules": 50', '"minModules": 97', '"nonModules"', "  ]\n}\n"];
  const afterEnds = ['"minModules": 52', '"minModules": 99', '"nonModules"', "  ]\n}\n"];
  const offsets = [
    [12886, 12886],
    [19261, 19403],
    [65258, 65525],
    [565726, 566450],
  ];
  if (receipt.raw.offsetUnit !== "utf16-code-unit" || receipt.raw.spans.length !== 4) numberFail("raw span population");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  receipt.raw.spans.forEach((span, index) => {
    if (
      span.role !== roles[index] ||
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      !same([span.beforeOffset, span.afterOffset], offsets[index]) ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement ||
      !span.before ||
      !span.after ||
      !span.before.startsWith(starts[index]!) ||
      !span.after.startsWith(starts[index]!) ||
      !span.before.endsWith(beforeEnds[index]!) ||
      !span.after.endsWith(afterEnds[index]!)
    )
      numberFail("raw span anchors or order");
    beforeEnd = span.beforeOffset + span.before.length;
    afterEnd = span.afterOffset + span.after.length;
    displacement += span.after.length - span.before.length;
  });
  return freeze(receipt);
}
function numberSemanticProfile(policy: MutableIrRuntimeProgramPolicy, profile: Profile): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256
  )
    numberFail("complete policy profile mismatch");
}
function proveNumberPrerequisitePolicy(
  value: unknown,
  freshlyVerifiedReceipt?: NumberPrerequisitePolicyReceipt,
): {
  current: MutableIrRuntimeProgramPolicy;
  before: MutableIrRuntimeProgramPolicy;
} {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateNumberPrerequisitePolicyEvolution();
  numberSemanticProfile(current, numberCurrentProfile);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1771)) !== numberBeforeProfile.filesSha256 ||
    digest(current.activationHistory.slice(0, 98)) !== numberBeforeProfile.activationHistorySha256 ||
    !same(current.files.slice(1771), numberFiles) ||
    !same(current.activationHistory.slice(98), numberActivations)
  )
    numberFail("ordered current prefix or suffix mismatch");
  for (const [id, entries, floor, classified] of [
    ["runtime-contracts", 10, 10, 10],
    ["backend-wasmgc", 52, 52, 57],
    ["ir-program", 43, 43, 44],
    ["ir-runtime", 19, 19, 19],
    ["native-runtime", 100, 99, 105],
    ["ir-analysis", 11, 11, 11],
    ["ir-core", 29, 29, 29],
  ] as const) {
    const rows = current.layers.filter((row) => row.id === id);
    if (
      rows.length !== 1 ||
      rows[0]!.entries?.length !== entries ||
      rows[0]!.minModules !== floor ||
      current.files.filter((row) => row.layer === id).length !== classified
    )
      numberFail("independent layer census mismatch");
  }
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  before.files.length = 1771;
  before.activationHistory.length = 98;
  for (const delta of numberLayerDeltas) {
    const layer = before.layers[delta.index]!;
    if (
      layer.id !== delta.id ||
      layer.status !== "active" ||
      layer.required !== true ||
      !same(layer.roots, delta.roots) ||
      layer.entries?.length !== delta.currentEntries ||
      layer.minModules !== delta.currentMinModules ||
      !same(layer.entries.slice(delta.beforeEntries), delta.additions)
    )
      numberFail("exact layer delta mismatch");
    layer.entries.length = delta.beforeEntries;
    layer.minModules = delta.beforeMinModules;
  }
  numberSemanticProfile(before, receipt.before);
  // This unchanged guard independently derives C1 and B from the real WKS predecessor.
  const verifiedWks = authenticateWellKnownSymbolPolicy(before);
  const replay = capture(verifiedWks) as MutableIrRuntimeProgramPolicy;
  replay.files.push(...(capture(numberFiles) as MutableIrRuntimeProgramPolicy["files"]));
  replay.activationHistory.push(...(capture(numberActivations) as MutableIrRuntimeProgramPolicy["activationHistory"]));
  for (const delta of numberLayerDeltas) {
    replay.layers[delta.index]!.entries!.push(...delta.additions);
    replay.layers[delta.index]!.minModules = delta.currentMinModules;
  }
  numberSemanticProfile(replay, numberCurrentProfile);
  if (!same(replay, current)) numberFail("complete independent reciprocal replay mismatch");
  return { current, before };
}
/** Fresh detached deeply frozen Number current, with no successful-object cache. */
export function authenticateNumberPrerequisitePolicy(value: unknown): IrValidationPolicy {
  return freeze(proveNumberPrerequisitePolicy(value).current) as IrValidationPolicy;
}
/** Fresh mutable WKS derived only from actual Number current. */
export function beforeNumberPrerequisitePolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveNumberPrerequisitePolicy(value).before;
}
function numberRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex");
  if (bytes !== profile.source.bytes || sha(raw) !== profile.source.sha256 || blob !== profile.source.gitBlob)
    numberFail("complete raw source profile mismatch");
}
function applyNumberPrerequisiteRaw(raw: string, receipt: NumberPrerequisitePolicyReceipt, forward: boolean): string {
  numberRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  for (const span of receipt.raw.spans) {
    const offset = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after;
    const to = forward ? span.after : span.before;
    if (
      offset < end ||
      raw.slice(offset, offset + from.length) !== from ||
      raw.indexOf(from) !== offset ||
      raw.lastIndexOf(from) !== offset
    )
      numberFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, offset), to);
    end = offset + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  numberRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Reconstruct actual WKS bytes, compare semantic inverse, and exercise the unchanged WKS raw inverse. */
export function beforeNumberPrerequisitePolicySource(raw: string): string {
  if (typeof raw !== "string") numberFail("raw input must be a primitive string");
  const receipt = authenticateNumberPrerequisitePolicyEvolution();
  const before = applyNumberPrerequisiteRaw(raw, receipt, false);
  const semantic = proveNumberPrerequisitePolicy(JSON.parse(raw), receipt);
  const parsedBefore = JSON.parse(before) as MutableIrRuntimeProgramPolicy;
  numberSemanticProfile(parsedBefore, receipt.before);
  beforeWellKnownSymbolPolicySource(before);
  if (!same(parsedBefore, semantic.before) || applyNumberPrerequisiteRaw(before, receipt, true) !== raw)
    numberFail("raw and semantic reciprocal proof disagree");
  return before;
}
