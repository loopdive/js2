// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { authenticateIrValidationPolicy, type IrValidationPolicy } from "./ir-validation-policy-evolution.js";
import {
  captureC1HistoricalAuthority,
  type C1HistoricalCapture,
  type C1HistoricalLogicalPath,
} from "./ir-c1-historical-authority.js";

const historicalPolicyOperandPaths: readonly string[] = [
  "tests/issue-3518-runtime-program-relocation.test.ts",
  "tests/issue-3518-program-data-contract-seam.test.ts",
  "tests/issue-3518-program-ownership-runtime-seam.test.ts",
  "tests/issue-3518-program-pre-a-evolution.test.ts",
  "tests/issue-3518-program-initial-graph-evolution.test.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
];
function readHistoricalPolicyInput(path: string, authority: C1HistoricalCapture): Buffer {
  if (historicalPolicyOperandPaths.includes(path))
    return Buffer.from(authority.readHistorical(path as C1HistoricalLogicalPath), "utf8");
  return readFileSync(new URL(`../../${path}`, import.meta.url));
}

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
    return Object.fromEntries(keys.map((key) => [key, capture(descriptors[key as string]!.value, active)]));
  } finally {
    active.delete(value);
  }
}

export function authenticateIrRuntimeProgramPolicyEvolution(
  text = readFileSync(new URL(`../../${irRuntimeProgramPolicyReceiptPath}`, import.meta.url), "utf8"),
): IrRuntimeProgramPolicyReceipt {
  if (sha(text) !== receiptSha256) fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as IrRuntimeProgramPolicyReceipt;
  captureC1HistoricalAuthority();
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
  const historicalAuthority = captureC1HistoricalAuthority();
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
    const bytes = readHistoricalPolicyInput(pin.path, historicalAuthority);
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      wksFail("immutable input changed: " + pin.path);
  }
  const helper = Buffer.from(
    historicalAuthority.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts"),
    "utf8",
  );
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
  const historicalAuthority = captureC1HistoricalAuthority();
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
    const bytes = readHistoricalPolicyInput(pin.path, historicalAuthority);
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      numberFail("full-file input changed: " + pin.path);
  }
  const helper = Buffer.from(
    historicalAuthority.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts"),
    "utf8",
  );
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

// C2a: one fixed runtime-preparation successor; historical guards above are unchanged.
export const runtimePreparationPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-runtime-preparation.json";
const preparationReceiptSha256 = "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca";
const preparationBeforeProfile = {
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
const preparationCurrentProfile = {
  source: {
    bytes: 567465,
    sha256: "92d653aff02d823339071f24721b803d88da4f31bdbd721859b0ac48b6c9c7f7",
    gitBlob: "70b280c7cf2a56cbd5cbfa88b484b57414d2ef7c",
  },
  dataSha256: "28ae111b7b9f0f6eda144d5d57beaf76fd5c7617b474846d39409a56cc196e08",
  fileCount: 1776,
  filesSha256: "ca4d9d7d5c999a4e742abd7773d847f1652ca8fe995a491a594fca1e5cf37a1a",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
};
const preparationPrefix = {
  bytes: 40368,
  sha256: "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",
};
const preparationNumberReceipt = {
  path: "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
  bytes: 12726,
  sha256: "92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845",
};
const preparationSourceInputs = [
  {
    path: "src/ir/intrinsic-support.ts",
    bytes: 850,
    sha256: "584322a7384556a6f3b82dc85cc30c2213510fe70f2cd437ccbef97826156351",
  },
  {
    path: "src/ir/runtime/intrinsic-preparation.ts",
    bytes: 49541,
    sha256: "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b",
  },
  {
    path: "tests/helpers/ir-runtime-preparation-relocation.json",
    bytes: 19505,
    sha256: "226efc69784e601980b4285fb0e562aed23f225be4d8735c233ecc6070000458",
  },
  {
    path: "tests/helpers/ir-runtime-preparation-relocation.ts",
    bytes: 7007,
    sha256: "8adf44a0f063d8b7fb7ed413a37e693c2c3e420b5a52cf6f9161cfceb9a901df",
  },
];
const preparationLayer = {
  index: 8,
  id: "ir-runtime",
  beforeEntries: 19,
  currentEntries: 20,
  beforeMinModules: 19,
  currentMinModules: 20,
  beforeClassified: 19,
  currentClassified: 20,
};
const preparationFile = {
  path: "src/ir/runtime/intrinsic-preparation.ts",
  state: "clean",
  layer: "ir-runtime",
};
const preparationActivation = {
  layer: "ir-runtime",
  entries: ["src/ir/runtime/intrinsic-preparation.ts"],
  minModules: 1,
};
const preparationRawPins = [
  {
    role: "runtime-layer-tail",
    beforeOffset: 6444,
    afterOffset: 6444,
    beforeSha256: "30d6b3d2844adec2c20019162f41b792554a8318ffaf593562dfe64a9b2984db",
    afterSha256: "0fb91016dca1d3ba652a1e1c1622f4a486292e82384be2e46a08a01dfc86d058",
  },
  {
    role: "activation-history-tail",
    beforeOffset: 65731,
    afterOffset: 65782,
    beforeSha256: "0e51cdca0a46e556233d7346ebbcbe9d8c6013789926f4392698734146ecc610",
    afterSha256: "a014b410b320473b7b40780c7b6b88ecd10c39bdbdfaf1fffb89af040add274f",
  },
  {
    role: "files-tail",
    beforeOffset: 566806,
    afterOffset: 566983,
    beforeSha256: "690dc5485a5f7cabaf4cc1cbdca969dfafd96a79976728b6e4a1eacbddfb244c",
    afterSha256: "5b58f77c2d14008613ef192e5ed99eda9e3c4d414e6f8b9cb7f2a9e9e0ccfd4c",
  },
];
interface RuntimePreparationPolicyReceipt {
  schema: string;
  baseMain: string;
  before: Profile;
  current: Profile;
  allowedEdgesSha256: string;
  helperPrefix: { bytes: number; sha256: string };
  numberReceipt: { path: string; bytes: number; sha256: string };
  sourceInputs: { path: string; bytes: number; sha256: string }[];
  runtimeLayer: typeof preparationLayer;
  fileAppend: typeof preparationFile;
  activationAppend: typeof preparationActivation;
  raw: {
    offsetUnit: string;
    spans: {
      role: string;
      beforeOffset: number;
      afterOffset: number;
      before: string;
      after: string;
      beforeSha256: string;
      afterSha256: string;
    }[];
  };
}
function preparationFail(detail: string): never {
  throw new Error("runtime preparation policy evolution: " + detail);
}
/** Bind the root's exact receipt, complete sources and original helper prefix afresh. */
export function authenticateRuntimePreparationPolicyEvolution(
  text = readFileSync(new URL(`../../${runtimePreparationPolicyReceiptPath}`, import.meta.url), "utf8"),
): RuntimePreparationPolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") !== 6239 || sha(text) !== preparationReceiptSha256)
    preparationFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as RuntimePreparationPolicyReceipt;
  const historicalAuthority = captureC1HistoricalAuthority();
  if (
    !same(Object.keys(receipt), [
      "schema",
      "baseMain",
      "before",
      "current",
      "allowedEdgesSha256",
      "helperPrefix",
      "numberReceipt",
      "sourceInputs",
      "runtimeLayer",
      "fileAppend",
      "activationAppend",
      "raw",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-runtime-preparation-v1" ||
    receipt.baseMain !== "3444df3d6d355aa745301ee248ce8f7ea2a80be7" ||
    !same(receipt.before, preparationBeforeProfile) ||
    !same(receipt.current, preparationCurrentProfile) ||
    receipt.allowedEdgesSha256 !== edges ||
    !same(receipt.helperPrefix, preparationPrefix) ||
    !same(receipt.numberReceipt, preparationNumberReceipt) ||
    !same(receipt.sourceInputs, preparationSourceInputs) ||
    !same(receipt.runtimeLayer, preparationLayer) ||
    !same(receipt.fileAppend, preparationFile) ||
    !same(receipt.activationAppend, preparationActivation) ||
    receipt.raw.offsetUnit !== "utf16-code-unit" ||
    receipt.raw.spans.length !== 3
  )
    preparationFail("fixed receipt population mismatch");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  receipt.raw.spans.forEach((span, index) => {
    const { before, after, ...pin } = span;
    if (
      !same(pin, preparationRawPins[index]) ||
      !before ||
      !after ||
      sha(before) !== span.beforeSha256 ||
      sha(after) !== span.afterSha256 ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement
    )
      preparationFail("raw span anchors or order");
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
    displacement += after.length - before.length;
  });
  for (const pin of [preparationNumberReceipt, ...preparationSourceInputs]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      preparationFail("full-file input changed: " + pin.path);
  }
  const helper = Buffer.from(
    historicalAuthority.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts"),
    "utf8",
  );
  if (
    helper.length < preparationPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, preparationPrefix.bytes)).digest("hex") !== preparationPrefix.sha256
  )
    preparationFail("original Number helper prefix changed");
  const number = authenticateNumberPrerequisitePolicyEvolution();
  if (!same(number.current, preparationBeforeProfile)) preparationFail("Number predecessor authority mismatch");
  return freeze(receipt);
}
function preparationSemanticProfile(policy: MutableIrRuntimeProgramPolicy, profile: Profile): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256
  )
    preparationFail("complete policy profile mismatch");
}
function proveRuntimePreparationPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: RuntimePreparationPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; before: MutableIrRuntimeProgramPolicy } {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateRuntimePreparationPolicyEvolution();
  preparationSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1775)) !== preparationBeforeProfile.filesSha256 ||
    digest(current.activationHistory.slice(0, 100)) !== preparationBeforeProfile.activationHistorySha256 ||
    !same(current.files.slice(1775), [preparationFile]) ||
    !same(current.activationHistory.slice(100), [preparationActivation]) ||
    current.files.filter((row) => row.layer === "ir-runtime").length !== 20
  )
    preparationFail("ordered current prefix or suffix mismatch");
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  const layer = before.layers[8]!;
  if (
    layer.id !== "ir-runtime" ||
    layer.status !== "active" ||
    layer.required !== true ||
    !same(layer.roots, ["src/ir/runtime"]) ||
    layer.entries?.length !== 20 ||
    layer.minModules !== 20 ||
    !same(layer.entries.slice(19), [preparationFile.path])
  )
    preparationFail("exact layer delta mismatch");
  before.files.length = 1775;
  before.activationHistory.length = 100;
  layer.entries.length = 19;
  layer.minModules = 19;
  preparationSemanticProfile(before, receipt.before);
  // This unchanged guard independently proves Number -> WKS -> C1 -> B.
  const verifiedNumber = authenticateNumberPrerequisitePolicy(before);
  const replay = capture(verifiedNumber) as MutableIrRuntimeProgramPolicy;
  replay.files.push(capture(preparationFile) as MutableIrRuntimeProgramPolicy["files"][number]);
  replay.activationHistory.push(
    capture(preparationActivation) as MutableIrRuntimeProgramPolicy["activationHistory"][number],
  );
  replay.layers[8]!.entries!.push(preparationFile.path);
  replay.layers[8]!.minModules = 20;
  preparationSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) preparationFail("complete independent reciprocal replay mismatch");
  return { current, before };
}
/** Fresh detached frozen C2a current; prior policy stages are not accepted here. */
export function authenticateRuntimePreparationPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveRuntimePreparationPolicy(value).current) as IrValidationPolicy;
}
/** Derive a fresh mutable Number predecessor without substituting caller mutations. */
export function beforeRuntimePreparationPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveRuntimePreparationPolicy(value).before;
}
function preparationRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw, "utf8");
  const blob = createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex");
  if (bytes !== profile.source.bytes || sha(raw) !== profile.source.sha256 || blob !== profile.source.gitBlob)
    preparationFail("complete raw source profile mismatch");
}
function applyRuntimePreparationRaw(raw: string, receipt: RuntimePreparationPolicyReceipt, forward: boolean): string {
  preparationRawProfile(raw, forward ? receipt.before : receipt.current);
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
      preparationFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, offset), to);
    end = offset + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  preparationRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Exact three-span inverse, semantic agreement and unchanged Number raw proof. */
export function beforeRuntimePreparationPolicySource(raw: string): string {
  if (typeof raw !== "string") preparationFail("raw input must be a primitive string");
  const receipt = authenticateRuntimePreparationPolicyEvolution();
  const before = applyRuntimePreparationRaw(raw, receipt, false);
  const semantic = proveRuntimePreparationPolicy(JSON.parse(raw), receipt);
  const parsedBefore = JSON.parse(before) as MutableIrRuntimeProgramPolicy;
  preparationSemanticProfile(parsedBefore, receipt.before);
  beforeNumberPrerequisitePolicySource(before);
  if (!same(parsedBefore, semantic.before) || applyRuntimePreparationRaw(before, receipt, true) !== raw)
    preparationFail("raw and semantic reciprocal proof disagree");
  return before;
}

// Exact external-main inventory successor; all preceding policy proofs stay unchanged.
export const dynamicCodePolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-dynamic-code.json";
const dynamicReceiptSha256 = "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f";
const dynamicBeforeProfile = { ...preparationCurrentProfile, allowedEdgesSha256: edges };
const dynamicCurrentProfile = {
  source: {
    bytes: 567908,
    sha256: "5c1c4a16928b421c112eb81180a315d31e116ff442a40375e8c6efb4f220c685",
    gitBlob: "59bdd78821afa174b9273c100a03ec79713249b4",
  },
  dataSha256: "65b382b173594abd15ffdef1a51f96daf017f4d91bd60e47f6308da434ab97b3",
  fileCount: 1778,
  filesSha256: "c306548d8e3f44695a102d10ef8a9503860e39ef6168719f88f874f616563f54",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
  allowedEdgesSha256: edges,
};
const dynamicPrefix = {
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  bytes: 53693,
  sha256: "dd8399e266770753fca08984c4ba33cba9e1486d3243571d988416569cbc981a",
};
const dynamicC2aReceipt = {
  path: runtimePreparationPolicyReceiptPath,
  bytes: 6239,
  sha256: "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca",
};
interface DynamicInventoryAddition {
  fileIndex: number;
  beforeIndex: number;
  row: Record<string, string>;
  previous: Record<string, string>;
  next: Record<string, string>;
  sourcePin: { path: string; bytes: number; sha256: string };
  // All offsets explicitly use UTF-16 code units, as in the unchanged C2a raw proof.
  rawSpan: {
    beforeOffset: number;
    afterOffset: number;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  };
}
// Literal reviewed authority, never selected or populated from a supplied receipt.
const dynamicAdditions: DynamicInventoryAddition[] = [
  {
    fileIndex: 202,
    beforeIndex: 202,
    row: {
      path: "src/codegen/array-method-arg-order.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "backend-wasmgc",
      owner: "3518-coordinator",
      nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
    },
    previous: {
      path: "src/codegen/array-literal-any-carrier.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "backend-wasmgc",
      owner: "3518-coordinator",
      nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
    },
    next: {
      path: "src/codegen/array-method-host.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "backend-wasmgc",
      owner: "3518-coordinator",
      nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
    },
    sourcePin: {
      path: "src/codegen/array-method-arg-order.ts",
      bytes: 6032,
      sha256: "9a4527970fd0fd12f7f0fc7210e92a63f64872b143c4d5bc5931ea0f8be03f0b",
    },
    rawSpan: {
      beforeOffset: 109891,
      afterOffset: 109891,
      before:
        '    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
      after:
        '    {\n      "path": "src/codegen/array-method-arg-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
      beforeSha256: "4cf17df2ddb36ff6c0a270a0c0f4542cccca6806d155c1f8720027ed04030a22",
      afterSha256: "c1c44f40e1731fe2ae2adef0e0ee5d357fcdf8388d9f311bf2ca20982ccf2cb1",
    },
  },
  {
    fileIndex: 1404,
    beforeIndex: 1403,
    row: {
      path: "src/runtime/dynamic-code-policy.ts",
      state: "unmigrated",
      layer: "legacy-host",
    },
    previous: {
      path: "src/runtime/dom-capability-adapter.ts",
      state: "unmigrated",
      layer: "legacy-host",
    },
    next: {
      path: "src/runtime/dynamic-function-import.ts",
      state: "unmigrated",
      layer: "legacy-host",
    },
    sourcePin: {
      path: "src/runtime/dynamic-code-policy.ts",
      bytes: 3863,
      sha256: "afad7fbda3469347671a99f6564de57d45e135c0dee989da5b6f0c1d249ad5af",
    },
    rawSpan: {
      beforeOffset: 488814,
      afterOffset: 489134,
      before:
        '    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
      after:
        '    {\n      "path": "src/runtime/dynamic-code-policy.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
      beforeSha256: "8705064bdfb67310ae65cb3203cc2d97840244bcf27f229d71e2f3707e5ed240",
      afterSha256: "254eeb01645faa832948ed42ca47120523a67c845ac23da752f1d129971fced1",
    },
  },
];
interface DynamicCodePolicyReceipt {
  schema: string;
  kind: string;
  checkpoint: string;
  incomingMain: string;
  before: Profile & { allowedEdgesSha256: string };
  current: Profile & { allowedEdgesSha256: string };
  helperPrefix: typeof dynamicPrefix;
  c2aReceipt: typeof dynamicC2aReceipt;
  additions: DynamicInventoryAddition[];
}
function dynamicFail(detail: string): never {
  throw new Error("dynamic code inventory policy evolution: " + detail);
}
/** Authenticate immutable successor authority on every action, never from a cached success. */
export function authenticateDynamicCodePolicyEvolution(
  text = readFileSync(new URL(`../../${dynamicCodePolicyReceiptPath}`, import.meta.url), "utf8"),
): DynamicCodePolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 6159 || sha(text) !== dynamicReceiptSha256)
    dynamicFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as DynamicCodePolicyReceipt;
  const historicalAuthority = captureC1HistoricalAuthority();
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "checkpoint",
      "incomingMain",
      "before",
      "current",
      "helperPrefix",
      "c2aReceipt",
      "additions",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-dynamic-code-v1" ||
    receipt.kind !== "external-main-inventory-successor" ||
    receipt.checkpoint !== "b7699b35670290296b43cd83f8bb0146873e2b36" ||
    receipt.incomingMain !== "9ba8f119a715a4fac719d82014f48baa43f4433d" ||
    !same(receipt.before, dynamicBeforeProfile) ||
    !same(receipt.current, dynamicCurrentProfile) ||
    !same(receipt.helperPrefix, dynamicPrefix) ||
    !same(receipt.c2aReceipt, dynamicC2aReceipt) ||
    !same(receipt.additions, dynamicAdditions) ||
    receipt.additions.length !== 2
  )
    dynamicFail("fixed receipt population mismatch");
  let beforeEnd = -1,
    afterEnd = -1,
    displacement = 0;
  for (const [index, addition] of receipt.additions.entries()) {
    const span = addition.rawSpan;
    if (
      !same(Object.keys(addition), ["fileIndex", "beforeIndex", "row", "previous", "next", "sourcePin", "rawSpan"]) ||
      addition.fileIndex !== addition.beforeIndex + index ||
      !span.before ||
      !span.after ||
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256 ||
      span.beforeOffset <= beforeEnd ||
      span.afterOffset <= afterEnd ||
      span.afterOffset !== span.beforeOffset + displacement ||
      span.after.length - span.before.length !== (index === 0 ? 320 : 123)
    )
      dynamicFail("fixed addition membership, raw anchors or order mismatch");
    beforeEnd = span.beforeOffset + span.before.length;
    afterEnd = span.afterOffset + span.after.length;
    displacement += span.after.length - span.before.length;
  }
  const helper = Buffer.from(
    historicalAuthority.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts"),
    "utf8",
  );
  if (
    helper.length < dynamicPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, dynamicPrefix.bytes)).digest("hex") !== dynamicPrefix.sha256
  )
    dynamicFail("original helper prefix changed");
  for (const pin of [dynamicC2aReceipt, ...dynamicAdditions.map((addition) => addition.sourcePin)]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      dynamicFail("full-file input changed: " + pin.path);
  }
  const c2a = authenticateRuntimePreparationPolicyEvolution();
  if (!same(c2a.current, preparationCurrentProfile)) dynamicFail("C2a predecessor authority mismatch");
  return freeze(receipt);
}
function dynamicSemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: DynamicCodePolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    dynamicFail("complete policy profile mismatch");
}
function proveDynamicCodeInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: DynamicCodePolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor capture must precede authority I/O and any caller property read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateDynamicCodePolicyEvolution();
  dynamicSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    current.files.filter((row) => row.layer === "legacy-host").length !== 55
  )
    dynamicFail("fixed inventory population mismatch");
  // Validate both rows against the untouched current array before removing either.
  for (const addition of receipt.additions) {
    if (
      !same(Object.keys(current.files[addition.fileIndex]!), Object.keys(addition.row)) ||
      !same(current.files[addition.fileIndex - 1], addition.previous) ||
      !same(current.files[addition.fileIndex], addition.row) ||
      !same(current.files[addition.fileIndex + 1], addition.next) ||
      current.files.filter((row) => row.path === addition.row.path).length !== 1
    )
      dynamicFail("fixed file row schema/order or neighbors mismatch");
  }
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const addition of [...receipt.additions].reverse()) predecessor.files.splice(addition.fileIndex, 1);
  dynamicSemanticProfile(predecessor, receipt.before);
  // Unchanged C2a proves the entire Number -> WKS -> C1 -> B authority chain.
  const verifiedC2a = authenticateRuntimePreparationPolicy(predecessor);
  const replay = capture(verifiedC2a) as MutableIrRuntimeProgramPolicy;
  // Validate all predecessor neighbors before replay inserts either fixed row.
  for (const addition of receipt.additions)
    if (
      !same(replay.files[addition.beforeIndex - 1], addition.previous) ||
      !same(replay.files[addition.beforeIndex], addition.next)
    )
      dynamicFail("predecessor replay neighbors mismatch");
  for (const [index, addition] of receipt.additions.entries())
    replay.files.splice(
      addition.beforeIndex + index,
      0,
      capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number],
    );
  dynamicSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) dynamicFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}
export function authenticateDynamicCodeInventoryPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveDynamicCodeInventoryPolicy(value).current) as IrValidationPolicy;
}
export function beforeDynamicCodeInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveDynamicCodeInventoryPolicy(value).predecessor;
}
function dynamicRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw);
  if (
    bytes !== profile.source.bytes ||
    sha(raw) !== profile.source.sha256 ||
    createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex") !== profile.source.gitBlob
  )
    dynamicFail("complete raw source profile mismatch");
}
function applyDynamicCodeInventoryRaw(raw: string, receipt: DynamicCodePolicyReceipt, forward: boolean): string {
  dynamicRawProfile(raw, forward ? receipt.before : receipt.current);
  let end = 0;
  const pieces: string[] = [];
  // Slice the unchanged input in ascending offsets; never apply stale offsets to an edited string.
  for (const addition of receipt.additions) {
    const span = addition.rawSpan,
      at = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after,
      to = forward ? span.after : span.before;
    if (
      !from ||
      !to ||
      at < end ||
      Buffer.byteLength(raw.slice(0, at)) !== at ||
      raw.slice(at, at + from.length) !== from ||
      raw.indexOf(from) !== at ||
      raw.lastIndexOf(from) !== at
    )
      dynamicFail("raw fragment missing, duplicated or reordered");
    pieces.push(raw.slice(end, at), to);
    end = at + from.length;
  }
  pieces.push(raw.slice(end));
  const output = pieces.join("");
  dynamicRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** Exact raw insertion inverse, semantic agreement and unchanged full C2a raw chain. */
export function beforeDynamicCodeInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") dynamicFail("raw input must be a primitive string");
  const receipt = authenticateDynamicCodePolicyEvolution();
  const predecessor = applyDynamicCodeInventoryRaw(raw, receipt, false);
  const semantic = proveDynamicCodeInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  dynamicSemanticProfile(parsed, receipt.before);
  beforeRuntimePreparationPolicySource(predecessor);
  if (!same(parsed, semantic.predecessor) || applyDynamicCodeInventoryRaw(predecessor, receipt, true) !== raw)
    dynamicFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Exact host-carrier inventory successor over the complete committed two-row proof.
export const hostCarrierPolicyReceiptPath = "tests/helpers/ir-runtime-program-policy-host-carrier.json";
const hostCarrierReceiptSha256 = "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583";
const hostCarrierBeforeProfile = dynamicCurrentProfile;
const hostCarrierCurrentProfile = {
  source: {
    bytes: 568231,
    sha256: "f3af1f31d813eaef9bd2b955466390616e9549f36e1e7ffffdcead812a611ac3",
    gitBlob: "d61ee74048fa3d16c2986fd3e448d234f4e5594b",
  },
  dataSha256: "89780e5ff7c660518ca92981369dab0e341b77e55f02f8e23d2312b615a97856",
  fileCount: 1779,
  filesSha256: "ced3f8116817be3978f55f438b657ca6b36ec8d50827db92bd7d708c2940853b",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
  allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
};
const hostCarrierPrefix = {
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  bytes: 68822,
  sha256: "90dce1410780cf924e78bdd4086be5b1b8c35cdbeb676c46126ac7e0f5f47c5c",
};
const hostCarrierDynamicReceipt = {
  path: "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
  bytes: 6159,
  sha256: "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f",
};
// Literal fixed authority; never derive membership or expected spans from caller input.
const hostCarrierAddition: DynamicInventoryAddition = {
  fileIndex: 605,
  beforeIndex: 605,
  row: {
    path: "src/codegen/host-carrier-to-primitive.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  previous: {
    path: "src/codegen/host-bridge-exports.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  next: {
    path: "src/codegen/host-fnctor-method-driver.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  sourcePin: {
    path: "src/codegen/host-carrier-to-primitive.ts",
    bytes: 14025,
    sha256: "6f74bd8c4b97789a1dbfe92dc18dd6e71e11860b0e8efd913c523bca032ce504",
  },
  rawSpan: {
    beforeOffset: 239710,
    afterOffset: 239710,
    before:
      '    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    after:
      '    {\n      "path": "src/codegen/host-carrier-to-primitive.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    beforeSha256: "3e551509901b9201393becb318e31b2c40e5a8be0d17fa97975556e33dda6bdc",
    afterSha256: "84ec8fc955578c6b77c59141a048c9233b0be087e2e45d3f5a11eb2e275a36db",
  },
};
interface HostCarrierPolicyReceipt {
  schema: string;
  kind: string;
  checkpoint: string;
  incomingMain: string;
  before: Profile & { allowedEdgesSha256: string };
  current: Profile & { allowedEdgesSha256: string };
  helperPrefix: typeof hostCarrierPrefix;
  dynamicReceipt: typeof hostCarrierDynamicReceipt;
  addition: DynamicInventoryAddition;
}
function hostCarrierFail(detail: string): never {
  throw new Error("host carrier inventory policy evolution: " + detail);
}
/** Recheck the exact receipt, complete prior helper and both source/receipt authorities afresh. */
export function authenticateHostCarrierPolicyEvolution(
  text = readFileSync(new URL(`../../${hostCarrierPolicyReceiptPath}`, import.meta.url), "utf8"),
): HostCarrierPolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 4673 || sha(text) !== hostCarrierReceiptSha256)
    hostCarrierFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as HostCarrierPolicyReceipt;
  const historicalAuthority = captureC1HistoricalAuthority();
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "checkpoint",
      "incomingMain",
      "before",
      "current",
      "helperPrefix",
      "dynamicReceipt",
      "addition",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-host-carrier-v1" ||
    receipt.kind !== "external-main-host-carrier-inventory-successor" ||
    receipt.checkpoint !== "f145ce94178071753e418021a586631441d19977" ||
    receipt.incomingMain !== "4509239df1d3454163b4656d39dfe8733714a47b" ||
    !same(receipt.before, hostCarrierBeforeProfile) ||
    !same(receipt.current, hostCarrierCurrentProfile) ||
    !same(receipt.helperPrefix, hostCarrierPrefix) ||
    !same(receipt.dynamicReceipt, hostCarrierDynamicReceipt) ||
    !same(receipt.addition, hostCarrierAddition)
  )
    hostCarrierFail("fixed receipt population mismatch");
  const span = receipt.addition.rawSpan;
  if (
    receipt.addition.fileIndex !== 605 ||
    receipt.addition.beforeIndex !== 605 ||
    !span.before ||
    !span.after ||
    span.beforeOffset !== 239710 ||
    span.afterOffset !== 239710 ||
    sha(span.before) !== span.beforeSha256 ||
    sha(span.after) !== span.afterSha256 ||
    Buffer.byteLength(span.after) - Buffer.byteLength(span.before) !== 323
  )
    hostCarrierFail("fixed row or raw anchor mismatch");
  const helper = Buffer.from(
    historicalAuthority.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts"),
    "utf8",
  );
  if (
    helper.length < hostCarrierPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, hostCarrierPrefix.bytes)).digest("hex") !== hostCarrierPrefix.sha256
  )
    hostCarrierFail("complete predecessor helper prefix changed");
  for (const pin of [hostCarrierDynamicReceipt, hostCarrierAddition.sourcePin]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      hostCarrierFail("full-file input changed: " + pin.path);
  }
  const predecessor = authenticateDynamicCodePolicyEvolution();
  if (!same(predecessor.current, hostCarrierBeforeProfile)) hostCarrierFail("two-row predecessor authority mismatch");
  return freeze(receipt);
}
function hostCarrierSemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: HostCarrierPolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    hostCarrierFail("complete policy profile mismatch");
}
function proveHostCarrierInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: HostCarrierPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor-safe capture precedes authority I/O, caller reads and serialization.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateHostCarrierPolicyEvolution();
  hostCarrierSemanticProfile(current, receipt.current);
  const addition = receipt.addition;
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    !same(Object.keys(current.files[605]!), Object.keys(addition.row)) ||
    !same(current.files[604], addition.previous) ||
    !same(current.files[605], addition.row) ||
    !same(current.files[606], addition.next) ||
    current.files.filter((row) => row.path === addition.row.path).length !== 1
  )
    hostCarrierFail("fixed file row schema/order or neighbors mismatch");
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(605, 1);
  hostCarrierSemanticProfile(predecessor, receipt.before);
  // Preserve the unchanged two-row -> C2a -> Number -> WKS -> C1 -> B guards.
  const verified = authenticateDynamicCodeInventoryPolicy(predecessor);
  const replay = capture(verified) as MutableIrRuntimeProgramPolicy;
  if (!same(replay.files[604], addition.previous) || !same(replay.files[605], addition.next))
    hostCarrierFail("predecessor replay neighbors mismatch");
  replay.files.splice(605, 0, capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number]);
  hostCarrierSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) hostCarrierFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}
export function authenticateHostCarrierInventoryPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveHostCarrierInventoryPolicy(value).current) as IrValidationPolicy;
}
export function beforeHostCarrierInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveHostCarrierInventoryPolicy(value).predecessor;
}
function hostCarrierRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw);
  if (
    bytes !== profile.source.bytes ||
    sha(raw) !== profile.source.sha256 ||
    createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex") !== profile.source.gitBlob
  )
    hostCarrierFail("complete raw source profile mismatch");
}
function applyHostCarrierInventoryRaw(raw: string, receipt: HostCarrierPolicyReceipt, forward: boolean): string {
  hostCarrierRawProfile(raw, forward ? receipt.before : receipt.current);
  const span = receipt.addition.rawSpan,
    at = forward ? span.beforeOffset : span.afterOffset;
  const from = forward ? span.before : span.after,
    to = forward ? span.after : span.before;
  // Explicit UTF-16 code-unit offsets; both frozen prefixes also have equal UTF-8 byte counts.
  if (
    !from ||
    !to ||
    Buffer.byteLength(raw.slice(0, at)) !== at ||
    raw.slice(at, at + from.length) !== from ||
    raw.indexOf(from) !== at ||
    raw.lastIndexOf(from) !== at
  )
    hostCarrierFail("raw fragment missing, duplicated or reordered");
  const output = raw.slice(0, at) + to + raw.slice(at + from.length);
  hostCarrierRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** One fixed anchored raw inverse, semantic agreement and unchanged full two-row raw proof. */
export function beforeHostCarrierInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") hostCarrierFail("raw input must be a primitive string");
  const receipt = authenticateHostCarrierPolicyEvolution();
  const predecessor = applyHostCarrierInventoryRaw(raw, receipt, false);
  const semantic = proveHostCarrierInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  hostCarrierSemanticProfile(parsed, receipt.before);
  beforeDynamicCodeInventoryPolicySource(predecessor);
  if (!same(parsed, semantic.predecessor) || applyHostCarrierInventoryRaw(predecessor, receipt, true) !== raw)
    hostCarrierFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Exact generator inventory successor over the complete committed host-carrier proof.
export const generatorInventoryPolicyReceiptPath =
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json";
const generatorInventoryReceiptSha256 = "5d78bc26201d43531d1a299d42f0ac0ae91a638de71620b94f675378572ccc8c";
const generatorInventoryBeforeProfile = hostCarrierCurrentProfile;
const generatorInventoryCurrentProfile = {
  source: {
    bytes: 568552,
    sha256: "64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff",
    gitBlob: "b9b8b1787cc202906c4e76cebc598cf460a7f0ae",
  },
  dataSha256: "2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6",
  fileCount: 1780,
  filesSha256: "bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6",
  activationCount: 101,
  activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
  layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
  allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
};
const generatorInventoryPrefix = {
  path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
  bytes: 80917,
  sha256: "2d33fdce750f57d745344fe9c08ecfdd2236bafaca48935bb2376f57255fce8f",
};
const generatorInventoryHostReceipt = {
  path: "tests/helpers/ir-runtime-program-policy-host-carrier.json",
  bytes: 4673,
  sha256: "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583",
};
// Literal fixed authority, never populated from caller input or a mutable receipt.
const generatorInventoryAddition: DynamicInventoryAddition = {
  fileIndex: 1615,
  beforeIndex: 1615,
  row: {
    path: "src/codegen/generator-eager-refusal.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  previous: {
    path: "src/codegen/fnctor-instance-names.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  next: {
    path: "src/codegen/generator-function-dynamic.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  },
  sourcePin: {
    path: "src/codegen/generator-eager-refusal.ts",
    bytes: 10619,
    sha256: "b44d14368759f11f18b11d75d2a5abb93fc448e0dc5cb7d8501eb0afe6272535",
  },
  rawSpan: {
    beforeOffset: 529175,
    afterOffset: 529175,
    before:
      '    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    after:
      '    {\n      "path": "src/codegen/generator-eager-refusal.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    beforeSha256: "eaa7278e51f6b98fed1c30f4ba59a0db4736a03c489c860549288c0aa3c1ad1d",
    afterSha256: "44584a36ba540f0e339e6e15bda22765c85db81114312d418cbec9041f086da3",
  },
};
interface GeneratorInventoryPolicyReceipt {
  schema: string;
  kind: string;
  checkpoint: string;
  incomingMain: string;
  before: Profile & { allowedEdgesSha256: string };
  current: Profile & { allowedEdgesSha256: string };
  helperPrefix: typeof generatorInventoryPrefix;
  hostReceipt: typeof generatorInventoryHostReceipt;
  addition: DynamicInventoryAddition;
}
function generatorInventoryFail(detail: string): never {
  throw new Error("generator inventory policy evolution: " + detail);
}
/** Recheck the exact receipt, complete prior helper and both source/receipt authorities afresh. */
export function authenticateGeneratorInventoryPolicyEvolution(
  text = readFileSync(new URL(`../../${generatorInventoryPolicyReceiptPath}`, import.meta.url), "utf8"),
): GeneratorInventoryPolicyReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 4693 || sha(text) !== generatorInventoryReceiptSha256)
    generatorInventoryFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as GeneratorInventoryPolicyReceipt;
  const historicalAuthority = captureC1HistoricalAuthority();
  if (
    !same(Object.keys(receipt), [
      "schema",
      "kind",
      "checkpoint",
      "incomingMain",
      "before",
      "current",
      "helperPrefix",
      "hostReceipt",
      "addition",
    ]) ||
    receipt.schema !== "ir-runtime-program-policy-generator-eager-refusal-v1" ||
    receipt.kind !== "external-main-generator-eager-refusal-inventory-successor" ||
    receipt.checkpoint !== "6ef874eb31bc70b5c138a6ea51824b24488edbcf" ||
    receipt.incomingMain !== "092ae4451c68ba1aa5bd9cdf76933d2e0d857fbf" ||
    !same(receipt.before, generatorInventoryBeforeProfile) ||
    !same(receipt.current, generatorInventoryCurrentProfile) ||
    !same(receipt.helperPrefix, generatorInventoryPrefix) ||
    !same(receipt.hostReceipt, generatorInventoryHostReceipt) ||
    !same(receipt.addition, generatorInventoryAddition)
  )
    generatorInventoryFail("fixed receipt population mismatch");
  const span = receipt.addition.rawSpan;
  if (
    receipt.addition.fileIndex !== 1615 ||
    receipt.addition.beforeIndex !== 1615 ||
    !span.before ||
    !span.after ||
    span.beforeOffset !== 529175 ||
    span.afterOffset !== 529175 ||
    sha(span.before) !== span.beforeSha256 ||
    sha(span.after) !== span.afterSha256 ||
    Buffer.byteLength(span.after) - Buffer.byteLength(span.before) !== 321
  )
    generatorInventoryFail("fixed row or raw anchor mismatch");
  const helper = Buffer.from(
    historicalAuthority.readHistorical("tests/helpers/ir-runtime-program-policy-evolution.ts"),
    "utf8",
  );
  if (
    helper.length < generatorInventoryPrefix.bytes ||
    createHash("sha256").update(helper.subarray(0, generatorInventoryPrefix.bytes)).digest("hex") !==
      generatorInventoryPrefix.sha256
  )
    generatorInventoryFail("complete predecessor helper prefix changed");
  for (const pin of [generatorInventoryHostReceipt, generatorInventoryAddition.sourcePin]) {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    if (bytes.length !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      generatorInventoryFail("full-file input changed: " + pin.path);
  }
  const predecessor = authenticateHostCarrierPolicyEvolution();
  if (!same(predecessor.current, generatorInventoryBeforeProfile))
    generatorInventoryFail("host predecessor authority mismatch");
  return freeze(receipt);
}
function generatorInventorySemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: GeneratorInventoryPolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    generatorInventoryFail("complete policy profile mismatch");
}
function proveGeneratorInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: GeneratorInventoryPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor-safe capture precedes authority I/O, caller reads and serialization.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateGeneratorInventoryPolicyEvolution();
  generatorInventorySemanticProfile(current, receipt.current);
  const addition = receipt.addition;
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    !same(Object.keys(current.files[1615]!), Object.keys(addition.row)) ||
    !same(current.files[1614], addition.previous) ||
    !same(current.files[1615], addition.row) ||
    !same(current.files[1616], addition.next) ||
    current.files.filter((row) => row.path === addition.row.path).length !== 1
  )
    generatorInventoryFail("fixed file row schema/order or neighbors mismatch");
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(1615, 1);
  generatorInventorySemanticProfile(predecessor, receipt.before);
  // Preserve the unchanged host -> two-row -> C2a -> Number -> WKS -> C1 -> B guards.
  const verified = authenticateHostCarrierInventoryPolicy(predecessor);
  const replay = capture(verified) as MutableIrRuntimeProgramPolicy;
  if (!same(replay.files[1614], addition.previous) || !same(replay.files[1615], addition.next))
    generatorInventoryFail("predecessor replay neighbors mismatch");
  replay.files.splice(1615, 0, capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number]);
  generatorInventorySemanticProfile(replay, receipt.current);
  if (!same(replay, current)) generatorInventoryFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}
export function authenticateGeneratorInventoryPolicy(value: unknown): IrValidationPolicy {
  return freeze(proveGeneratorInventoryPolicy(value).current) as IrValidationPolicy;
}
export function beforeGeneratorInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveGeneratorInventoryPolicy(value).predecessor;
}
function generatorInventoryRawProfile(raw: string, profile: Profile): void {
  const bytes = Buffer.byteLength(raw);
  if (
    bytes !== profile.source.bytes ||
    sha(raw) !== profile.source.sha256 ||
    createHash("sha1").update(`blob ${bytes}\0`).update(raw).digest("hex") !== profile.source.gitBlob
  )
    generatorInventoryFail("complete raw source profile mismatch");
}
function applyGeneratorInventoryRaw(raw: string, receipt: GeneratorInventoryPolicyReceipt, forward: boolean): string {
  generatorInventoryRawProfile(raw, forward ? receipt.before : receipt.current);
  const span = receipt.addition.rawSpan,
    at = forward ? span.beforeOffset : span.afterOffset;
  const from = forward ? span.before : span.after,
    to = forward ? span.after : span.before;
  // Explicit UTF-16 code-unit offsets; both frozen prefixes also have equal UTF-8 byte counts.
  if (
    !from ||
    !to ||
    Buffer.byteLength(raw.slice(0, at)) !== at ||
    raw.slice(at, at + from.length) !== from ||
    raw.indexOf(from) !== at ||
    raw.lastIndexOf(from) !== at
  )
    generatorInventoryFail("raw fragment missing, duplicated or reordered");
  const output = raw.slice(0, at) + to + raw.slice(at + from.length);
  generatorInventoryRawProfile(output, forward ? receipt.current : receipt.before);
  return output;
}
/** One fixed anchored raw inverse, semantic agreement and unchanged full host raw proof. */
export function beforeGeneratorInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") generatorInventoryFail("raw input must be a primitive string");
  const receipt = authenticateGeneratorInventoryPolicyEvolution();
  const predecessor = applyGeneratorInventoryRaw(raw, receipt, false);
  const semantic = proveGeneratorInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  generatorInventorySemanticProfile(parsed, receipt.before);
  beforeHostCarrierInventoryPolicySource(predecessor);
  if (!same(parsed, semantic.predecessor) || applyGeneratorInventoryRaw(predecessor, receipt, true) !== raw)
    generatorInventoryFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Fixed current-main four-row inventory successor; predecessor algorithms remain unchanged.
export const currentMainInventoryReceiptPath = "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json";
const currentMainInventoryReceiptSha256 = "b14b779229974856210fb3907aab7c7d0d97537c3f9d8a6324b083f3b3ef8c5e";
// Independently frozen literal authority, never initialized from an inspected receipt or caller.
const currentMainInventoryExpected = {
  schema: 1,
  kind: "fixed-main-inventory-four-row-successor",
  provenance: {
    checkpoint: "bfcf326c9426988e66fa6cc446132ed9ad9c1965",
    inputBase: "6fce22a8bbeaec91828e8b5b6922c3c1b1fa9b97",
    incomingMain: "a93d489420fac74aaba490a249f51251f90584c2",
    sourceInput: "fcf4b188d0bd19f23665a318316af766e641f737",
    planSha256: "25dea34fa24ff59f10b20b5a70da1a2a91061017aa3bcec9be3239c65bc03697",
  },
  before: {
    source: {
      bytes: 568552,
      sha256: "64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff",
      gitBlob: "b9b8b1787cc202906c4e76cebc598cf460a7f0ae",
    },
    dataSha256: "2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6",
    fileCount: 1780,
    filesSha256: "bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 569224,
      sha256: "68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91",
      gitBlob: "6dfe8603219039d3be53ff7c8804dbd58fa8534a",
    },
    dataSha256: "e0f089362ce0e56697978858e2d2ab1767b9cf53425f60b76a8cd2d5d17f8057",
    fileCount: 1782,
    filesSha256: "d9bb59233a38f7e4f074e54b9f1b22761fff2fc00b7805a62e910b4a1fefa02e",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 94912,
    sha256: "8b7b061100ffe195437058401fa904a65ccee3302322a97aae899e51f5d84f68",
    gitBlob: "8e979e9b3f6bb6831df63bf6a65c38a6098e6a85",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
    bytes: 4693,
    sha256: "5d78bc26201d43531d1a299d42f0ac0ae91a638de71620b94f675378572ccc8c",
    gitBlob: "e1ceeb12d63073f2f19b714c4e988dd3e2b4e26d",
  },
  sourcePins: [
    {
      path: "src/codegen/class-builtin-species-read.ts",
      bytes: 2143,
      sha256: "12ddf3f2e454845b58f8d2669533d2dd0e596d1d8ccbda1a43cb960e83da31eb",
      gitBlob: "5a7d3ef78ee34bc7fce3d0d6d92911907141f49f",
    },
    {
      path: "src/codegen/date-proto-to-json.ts",
      bytes: 6733,
      sha256: "448717146265ea56a128eaef010338f6511a03ea61230f830deb8179f27f7e2b",
      gitBlob: "4a587c01bc1e68ea519c5e9b290a5d389d3ce13b",
    },
    {
      path: "src/codegen/expressions/to-primitive-method-call.ts",
      bytes: 4481,
      sha256: "fb45a5292e6275ca40b3ee5d190bdd88ecedc6cba933d6b6dc5640b0162d4001",
      gitBlob: "0e3f192257e0437b29fce56205a129529587f4d3",
    },
  ],
  rowChanges: [
    {
      operation: "addition",
      beforeIndex: 366,
      currentIndex: 366,
      row: {
        path: "src/codegen/class-builtin-species-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/date-parse-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/date-proto-to-primitive.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/date-parse-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/date-proto-to-json.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 366,
      currentIndex: 367,
      row: {
        path: "src/codegen/date-proto-to-json.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/date-parse-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/date-proto-to-primitive.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/class-builtin-species-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/date-proto-to-primitive.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 512,
      currentIndex: 514,
      row: {
        path: "src/codegen/expressions/to-primitive-method-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/expressions/this-keyword.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/expressions/transferred-native-proto-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/expressions/this-keyword.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/expressions/transferred-native-proto-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "removal",
      beforeIndex: 1381,
      currentIndex: 1384,
      row: {
        path: "src/runtime-containment.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      beforePrevious: {
        path: "src/resolve/consumer-driven-barrels.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      beforeNext: {
        path: "src/runtime-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      currentPrevious: {
        path: "src/resolve/consumer-driven-barrels.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
      currentNext: {
        path: "src/runtime-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
      },
    },
  ],
  raw: {
    spans: [
      {
        beforeOffset: 162175,
        afterOffset: 162175,
        before: "",
        after:
          '    {\n      "path": "src/codegen/class-builtin-species-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/date-proto-to-json.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6f6dd24f93539ececc43e1423a466543e5e42e4051f56b33b3954e1c5da0193c",
      },
      {
        beforeOffset: 209899,
        afterOffset: 210539,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/to-primitive-method-call.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c7a524e5649650927432dc4be13732268461780e960355dc3b45faf2a4b4db31",
      },
      {
        beforeOffset: 485383,
        afterOffset: 486357,
        before:
          '    {\n      "path": "src/runtime-containment.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n',
        after: "",
        beforeSha256: "45f82bcd707e361470f6ea1ee6543cb54c2a0f5dd248c5b1583499a7b3b38cce",
        afterSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ],
  },
} as const;
type CurrentMainInventoryReceipt = typeof currentMainInventoryExpected;
function currentMainInventoryFail(detail: string): never {
  throw new Error("current main inventory evolution: " + detail);
}
function currentMainInventoryPin(
  bytes: Buffer,
  pin: { readonly bytes: number; readonly sha256: string; readonly gitBlob: string },
  label: string,
): void {
  if (
    bytes.length !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256 ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== pin.gitBlob
  )
    currentMainInventoryFail(label);
}
/** Authenticate fixed receipt and live source/prefix authorities on every public action. */
export function authenticateCurrentMainInventoryEvolution(
  text = readFileSync(new URL(`../../${currentMainInventoryReceiptPath}`, import.meta.url), "utf8"),
): CurrentMainInventoryReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 12856 || sha(text) !== currentMainInventoryReceiptSha256)
    currentMainInventoryFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as CurrentMainInventoryReceipt;
  if (!same(receipt, currentMainInventoryExpected)) currentMainInventoryFail("fixed receipt population mismatch");
  const prefix = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  currentMainInventoryPin(
    beforePolicyCaptureKernelPrefix(prefix.subarray(0, 94641)),
    receipt.helperPrefix,
    "complete predecessor helper prefix changed",
  );
  for (const pin of [receipt.predecessorReceipt, ...receipt.sourcePins])
    currentMainInventoryPin(
      readFileSync(new URL(`../../${pin.path}`, import.meta.url)),
      pin,
      "full-file input changed: " + pin.path,
    );
  const predecessor = authenticateGeneratorInventoryPolicyEvolution();
  if (!same(predecessor.current, receipt.before)) currentMainInventoryFail("generator predecessor authority mismatch");
  return freeze(receipt);
}
function currentMainInventorySemanticProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: CurrentMainInventoryReceipt["before"] | CurrentMainInventoryReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    currentMainInventoryFail("complete policy profile mismatch");
}
function currentMainInventoryRows(
  policy: MutableIrRuntimeProgramPolicy,
  receipt: CurrentMainInventoryReceipt,
  forward: boolean,
): void {
  if (!same(Object.keys(policy), wksTopKeys)) currentMainInventoryFail("fixed top-level schema mismatch");
  for (const change of receipt.rowChanges) {
    const index = forward ? change.beforeIndex : change.currentIndex;
    const present = forward ? change.operation === "removal" : change.operation === "addition";
    const previous = forward ? change.beforePrevious : change.currentPrevious;
    const next = forward ? change.beforeNext : change.currentNext;
    if (
      !same(policy.files[index - 1], previous) ||
      !same(policy.files[index + (present ? 1 : 0)], next) ||
      policy.files.filter((row) => row.path === change.row.path).length !== (present ? 1 : 0) ||
      (present &&
        (!same(Object.keys(policy.files[index]!), Object.keys(change.row)) || !same(policy.files[index], change.row)))
    )
      currentMainInventoryFail("fixed row schema, membership or neighbors mismatch");
  }
}
function proveCurrentMainInventoryPolicy(
  value: unknown,
  freshlyVerifiedReceipt?: CurrentMainInventoryReceipt,
): {
  predecessor: MutableIrRuntimeProgramPolicy;
  generatorPredecessor: MutableIrRuntimeProgramPolicy;
} {
  // Capture descriptors before receipt/source IO; keep subsequent historical mutants raw.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt ?? authenticateCurrentMainInventoryEvolution();
  currentMainInventorySemanticProfile(current, receipt.current);
  currentMainInventoryRows(current, receipt, false);
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(1384, 0, capture(receipt.rowChanges[3].row) as Record<string, string>);
  for (const index of [514, 367, 366]) predecessor.files.splice(index, 1);
  currentMainInventorySemanticProfile(predecessor, receipt.before);
  currentMainInventoryRows(predecessor, receipt, true);
  // Genuine generator -> host -> dynamic -> C2a -> Number -> WKS -> C1 -> B verification.
  const generatorPredecessor = beforeGeneratorInventoryPolicy(predecessor);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  replay.files.splice(1381, 1);
  for (const change of receipt.rowChanges.slice(0, 3))
    replay.files.splice(change.currentIndex, 0, capture(change.row) as Record<string, string>);
  currentMainInventorySemanticProfile(replay, receipt.current);
  currentMainInventoryRows(replay, receipt, false);
  if (!same(replay, current)) currentMainInventoryFail("complete reciprocal semantic replay mismatch");
  return { predecessor, generatorPredecessor };
}
export function beforeCurrentMainInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveCurrentMainInventoryPolicy(value).predecessor;
}
function applyCurrentMainInventoryRaw(raw: string, receipt: CurrentMainInventoryReceipt, forward: boolean): string {
  const bytes = Buffer.from(raw, "utf8");
  currentMainInventoryPin(
    bytes,
    forward ? receipt.before.source : receipt.current.source,
    "complete raw source profile mismatch",
  );
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of receipt.raw.spans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after, "utf8");
    const to = Buffer.from(forward ? span.after : span.before, "utf8");
    if (
      at < consumed ||
      at > bytes.length ||
      at + from.length > bytes.length ||
      !bytes.subarray(at, at + from.length).equals(from) ||
      (from.length > 0 && (bytes.indexOf(from) !== at || bytes.lastIndexOf(from) !== at))
    )
      currentMainInventoryFail("fixed raw span missing, duplicated or reordered");
    // Every slice uses the unchanged original input coordinate domain.
    pieces.push(bytes.subarray(consumed, at), to);
    consumed = at + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  const result = Buffer.concat(pieces);
  currentMainInventoryPin(
    result,
    forward ? receipt.current.source : receipt.before.source,
    "complete raw output profile mismatch",
  );
  return result.toString("utf8");
}
export function beforeCurrentMainInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") currentMainInventoryFail("raw input must be a primitive string");
  const receipt = authenticateCurrentMainInventoryEvolution();
  const predecessor = applyCurrentMainInventoryRaw(raw, receipt, false);
  const semantic = proveCurrentMainInventoryPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  currentMainInventorySemanticProfile(parsed, receipt.before);
  const generatorRawPredecessor = beforeGeneratorInventoryPolicySource(predecessor);
  if (
    !same(parsed, semantic.predecessor) ||
    !same(JSON.parse(generatorRawPredecessor), semantic.generatorPredecessor) ||
    applyCurrentMainInventoryRaw(predecessor, receipt, true) !== raw
  )
    currentMainInventoryFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

/** Reconstruct only the fixed pre-kernel prefix; every call authenticates its actual supplied bytes. */
function beforePolicyCaptureKernelPrefix(current: Buffer): Buffer {
  const label = "complete predecessor helper prefix changed";
  currentMainInventoryPin(
    current,
    {
      bytes: 94641,
      sha256: "4cf63b340b245b0f4f5ef297dc5a4b56b06507e981a7801ffcfb7e5c101f5103",
      gitBlob: "b33536a95c8b88e84f8e7c60c3c39bce3e2c7d82",
    },
    label,
  );
  const offset = 5477;
  const before = Buffer.from(
    "    // defineProperty also preserves a literal __proto__ key as ordinary owned data.\n    const result: Record<string, unknown> = {};\n    for (const key of keys as string[])\n      Object.defineProperty(result, key, {\n        value: capture(descriptors[key]!.value, active),\n        enumerable: true,\n        writable: true,\n        configurable: true,\n      });\n    return result;\n",
    "utf8",
  );
  const after = Buffer.from(
    "    return Object.fromEntries(keys.map((key) => [key, capture(descriptors[key as string]!.value, active)]));\n",
    "utf8",
  );
  if (
    !current.subarray(offset, offset + after.length).equals(after) ||
    current.indexOf(after) !== offset ||
    current.indexOf(after, offset + 1) !== -1
  )
    currentMainInventoryFail(label);
  const restored = Buffer.concat([current.subarray(0, offset), before, current.subarray(offset + after.length)]);
  currentMainInventoryPin(
    restored,
    {
      bytes: 94912,
      sha256: "8b7b061100ffe195437058401fa904a65ccee3302322a97aae899e51f5d84f68",
      gitBlob: "8e979e9b3f6bb6831df63bf6a65c38a6098e6a85",
    },
    label,
  );
  if (!restored.subarray(offset, offset + before.length).equals(before)) currentMainInventoryFail(label);
  const replay = Buffer.concat([restored.subarray(0, offset), after, restored.subarray(offset + before.length)]);
  if (!replay.equals(current)) currentMainInventoryFail(label);
  return restored;
}
// Fixed inventory-only canonical3c6 successor; complete prior117269-byte body is immutable.
export const canonical3c6ReceiptPath = "tests/helpers/ir-runtime-program-policy-canonical-3c6.json";
const canonical3c6ReceiptSha256 = "4a9cd6bd5109ab1cd3cbb1050066ef18377bb5e686f9f3111d572123fbc9127c";
// Independently frozen literal table; never rebuilt from mutants or runtime inventory.
const canonical3c6Expected = {
  schema: 1,
  kind: "fixed-canonical-3c6-inventory-only-successor",
  provenance: {
    checkpoint: "25ddc095e2b789a645e3e807633c6bf17cc1380d",
    previousMain: "a93d489420fac74aaba490a249f51251f90584c2",
    incomingMain: "3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8",
    planSha256: "5304e7c8902058ab6ee6b4cc6ca13b55844fdbaad01ea6d2177be60d7851b666",
    inventoryOnly: true,
  },
  before: {
    source: {
      bytes: 569224,
      sha256: "68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91",
      gitBlob: "6dfe8603219039d3be53ff7c8804dbd58fa8534a",
    },
    dataSha256: "e0f089362ce0e56697978858e2d2ab1767b9cf53425f60b76a8cd2d5d17f8057",
    fileCount: 1782,
    filesSha256: "d9bb59233a38f7e4f074e54b9f1b22761fff2fc00b7805a62e910b4a1fefa02e",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 577771,
      sha256: "2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a",
      gitBlob: "8a7a71945ac6c7728c43cd91ae80a8c270b444cf",
    },
    dataSha256: "4cf6541e0c4677135d54cc2aa47b29763122e4fc416caff66c6165d3cb1e33ac",
    fileCount: 1808,
    filesSha256: "63c4be5ba7d77abd122bbcd55f8273e1fd9ee7a9e59fe522d374d3a0f8c1f54b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 117269,
    sha256: "36c66ebee18b28209e7c3083873d76eec538b48f98753e8a09dac8ce44499180",
    gitBlob: "71b4f3d4686092f7ce7d8cc53ae3f5aa9bfa98d1",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json",
    bytes: 12856,
    sha256: "b14b779229974856210fb3907aab7c7d0d97537c3f9d8a6324b083f3b3ef8c5e",
    gitBlob: "ca01bda74a7eca6a10fe1c65f7c352897f2c6187",
  },
  rowChanges: [
    {
      operation: "addition",
      beforeIndex: 1,
      currentIndex: 1,
      row: {
        path: "src/codegen/object-model/native-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/backend/wasmgc/resources/native-string-own-keys.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      beforeNext: {
        path: "src/runtime/wasmgc/values/string-create-body.ts",
        state: "clean",
        layer: "native-runtime",
      },
      currentPrevious: {
        path: "src/backend/wasmgc/resources/native-string-own-keys.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      currentNext: {
        path: "src/codegen/object-model/ports.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 1,
      currentIndex: 2,
      row: {
        path: "src/codegen/object-model/ports.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/backend/wasmgc/resources/native-string-own-keys.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      beforeNext: {
        path: "src/runtime/wasmgc/values/string-create-body.ts",
        state: "clean",
        layer: "native-runtime",
      },
      currentPrevious: {
        path: "src/codegen/object-model/native-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/runtime/wasmgc/values/string-create-body.ts",
        state: "clean",
        layer: "native-runtime",
      },
    },
    {
      operation: "addition",
      beforeIndex: 186,
      currentIndex: 188,
      row: {
        path: "src/codegen/array/array-ctor-this.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/array-concat-spec.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/array-element-typing.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/array-concat-spec.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/array/array-copywithin-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 186,
      currentIndex: 189,
      row: {
        path: "src/codegen/array/array-copywithin-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/array-concat-spec.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/array-element-typing.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/array/array-ctor-this.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/array-element-typing.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 199,
      currentIndex: 203,
      row: {
        path: "src/codegen/array/array-length-holes.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/array-length-define.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/array-like-hof-arms.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/array-length-define.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/array/array-like-exotic-arms.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 199,
      currentIndex: 204,
      row: {
        path: "src/codegen/array/array-like-exotic-arms.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/array-length-define.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/array-like-hof-arms.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/array/array-length-holes.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/array-like-hof-arms.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 215,
      currentIndex: 221,
      row: {
        path: "src/codegen/array/array-set-length-coercion.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/array-reduce-fusion.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/array-species.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/array-reduce-fusion.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/array-species.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 218,
      currentIndex: 225,
      row: {
        path: "src/codegen/array/array-unscopables.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/array-tolocalestring.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/ast-modifiers.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/array-tolocalestring.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/ast-modifiers.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 240,
      currentIndex: 248,
      row: {
        path: "src/codegen/expressions/bool-to-locale-string.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/binary-ops.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/bound-fn-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/binary-ops.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/bound-fn-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 394,
      currentIndex: 403,
      row: {
        path: "src/codegen/object-model/define-rejection-channel.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/default-expression-import-global.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/define-properties-map.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/default-expression-import-global.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/define-properties-map.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 421,
      currentIndex: 431,
      row: {
        path: "src/codegen/expressions/eval-param-scope-hoist.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/escape-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/exec-census.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/escape-native.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/exec-census.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 598,
      currentIndex: 609,
      row: {
        path: "src/codegen/helpers/core-delegates.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/helpers/body-uses-arguments.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/helpers/is-strict-function.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/helpers/body-uses-arguments.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/helpers/is-strict-function.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 599,
      currentIndex: 611,
      row: {
        path: "src/codegen/helpers/reserved-helper-funcs.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/helpers/is-strict-function.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/helpers/sloppy-this-global.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/helpers/is-strict-function.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/helpers/sloppy-this-global.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 752,
      currentIndex: 765,
      row: {
        path: "src/codegen/expressions/tagged-template-standalone.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/new-target.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/node-fs-api.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/new-target.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/expressions/eval-spread-args.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 752,
      currentIndex: 766,
      row: {
        path: "src/codegen/expressions/eval-spread-args.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/new-target.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/node-fs-api.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/expressions/tagged-template-standalone.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/expressions/with-call-binding.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 752,
      currentIndex: 767,
      row: {
        path: "src/codegen/expressions/with-call-binding.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/new-target.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/node-fs-api.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/expressions/eval-spread-args.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/expressions/new-target-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 752,
      currentIndex: 768,
      row: {
        path: "src/codegen/expressions/new-target-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/new-target.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/node-fs-api.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/expressions/with-call-binding.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/node-fs-api.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 765,
      currentIndex: 782,
      row: {
        path: "src/codegen/object-model/object-assign-primitive-operands.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/numeric-property-analysis.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/object-builtin-effects.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/numeric-property-analysis.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/object-builtin-effects.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 774,
      currentIndex: 792,
      row: {
        path: "src/codegen/object-model/object-literal-reflective-escape.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/object-literal-method-receiver.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/object-literal-super-base.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/object-literal-method-receiver.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/object-literal-super-base.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 776,
      currentIndex: 795,
      row: {
        path: "src/codegen/object-model/object-own-key-order.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/object-method-arguments-first.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/object-ops.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/object-method-arguments-first.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/object-ops.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 782,
      currentIndex: 802,
      row: {
        path: "src/codegen/object-model/object-proto-to-locale-string.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/object-proto-proto-accessor.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/object-proto-symbol-tag.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/object-proto-proto-accessor.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/object-proto-symbol-tag.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 853,
      currentIndex: 874,
      row: {
        path: "src/codegen/object-model/proxy-own-keys-surfaces.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/proven-receiver-stats.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/proxy-revoker-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/proven-receiver-stats.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/proxy-revoker-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 854,
      currentIndex: 876,
      row: {
        path: "src/codegen/object-model/proxy-trap-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/proxy-revoker-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/proxy-value-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/proxy-revoker-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/closures/proxy-trap-closure-return.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 854,
      currentIndex: 877,
      row: {
        path: "src/codegen/closures/proxy-trap-closure-return.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/proxy-revoker-meta.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/proxy-value-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/object-model/proxy-trap-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/proxy-value-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 885,
      currentIndex: 909,
      row: {
        path: "src/codegen/registry/expression-helper-delegates.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/registry/error-types.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/registry/import-collector-delegates.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/registry/error-types.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/registry/import-collector-delegates.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 1043,
      currentIndex: 1068,
      row: {
        path: "src/codegen/array/vec-elem-fidelity.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/vec-elem-set.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/vec-externref-hole-presence.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/vec-elem-set.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/vec-externref-hole-presence.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  raw: {
    spans: [
      {
        beforeOffset: 69036,
        afterOffset: 69036,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/native-names.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/ports.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6be0fb04739b754a7f50bf450cd01cec25c061f041003a403a039a743da0017f",
      },
      {
        beforeOffset: 104800,
        afterOffset: 105439,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-ctor-this.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/array-copywithin-native.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c731d5d5c9c42752c7e098cf02f4ae3893217a11c97077e16fc418b0dfb479d4",
      },
      {
        beforeOffset: 108936,
        afterOffset: 110221,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-length-holes.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/array-like-exotic-arms.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "e5b2d9bb9aec6179fd397926a09ffbb6a04fa3015cc1f6152639964a5a87a76d",
      },
      {
        beforeOffset: 114021,
        afterOffset: 115954,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-set-length-coercion.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c8a7823cc1be16dd39275af6dec1cd8f13bd13fe9cd57f6dfe1845a02966f549",
      },
      {
        beforeOffset: 114966,
        afterOffset: 117228,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-unscopables.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "603fe9fc583b01ba787756d9afd2a8c1e61c6130c2b0340f3f3dfba835e0c372",
      },
      {
        beforeOffset: 121907,
        afterOffset: 124490,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/bool-to-locale-string.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "4da948be46bd65ddcd75a21872b553f4eed52d6875dff60168910f129947f86d",
      },
      {
        beforeOffset: 171443,
        afterOffset: 174357,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/define-rejection-channel.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "24537fa712dd09f177d5d32474b6e2af1679f82ec4414d1834bec73b561f2e32",
      },
      {
        beforeOffset: 179963,
        afterOffset: 183212,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/eval-param-scope-hoist.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "928f90277d70f5212a917ad9c601b7f1a0e08c595b1f86a3c9eccfa86aa75c38",
      },
      {
        beforeOffset: 237496,
        afterOffset: 241077,
        before: "",
        after:
          '    {\n      "path": "src/codegen/helpers/core-delegates.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "f96df65aa7cc3761181a2e68114cd385286d8d3ac3b797e82fa80e5d3c99f226",
      },
      {
        beforeOffset: 237820,
        afterOffset: 241721,
        before: "",
        after:
          '    {\n      "path": "src/codegen/helpers/reserved-helper-funcs.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6002f7640c0b6aeffee63de7300b69d13d4fecf7be24c21ca119a5b057715ca3",
      },
      {
        beforeOffset: 286683,
        afterOffset: 290911,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/tagged-template-standalone.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/eval-spread-args.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/with-call-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/new-target-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "8de8cb51aae005e2062a170c9dba13fee55686cdb69a29dbcaeaa845578bc723",
      },
      {
        beforeOffset: 290823,
        afterOffset: 296366,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-assign-primitive-operands.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "64b94561dbcf9a53a1f46ac715f8501d236f95069300cba25be312bb3c8d4a10",
      },
      {
        beforeOffset: 293741,
        afterOffset: 299627,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-literal-reflective-escape.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "1fb830f0b73779cc378965875ad42c2ecf36639b5c454ca194b7b9d46a2003ba",
      },
      {
        beforeOffset: 294391,
        afterOffset: 300620,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-own-key-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "af03537eacf5d449707fd2461cc8843129f6c52df2b6b3008d8a293fe87cc587",
      },
      {
        beforeOffset: 296338,
        afterOffset: 302898,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-proto-to-locale-string.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "76ad31f6e991ea380a8730f0f4e3349a5ebcbe1c7b34769c707bb02f6a012351",
      },
      {
        beforeOffset: 319888,
        afterOffset: 326788,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/proxy-own-keys-surfaces.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "f03516a6ccac11d6e96570e496bcc37b54b58e584aaee379ced1a60746aa5e9e",
      },
      {
        beforeOffset: 320204,
        afterOffset: 327438,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/proxy-trap-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/proxy-trap-closure-return.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "7c7f2d68418490f9bf5d95cf750eaa7eb73509f8b8bb672b7e957fcbd4e637dd",
      },
      {
        beforeOffset: 330067,
        afterOffset: 337959,
        before: "",
        after:
          '    {\n      "path": "src/codegen/registry/expression-helper-delegates.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "871b4b3b57f55e42355db6063a765f124f2534e19626a3979a0880f33b79041f",
      },
      {
        beforeOffset: 380579,
        afterOffset: 388805,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/vec-elem-fidelity.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "13111644dc4adb4a0ba27984ae918ced035d3a9389669665dc5ad3bb7f9d6ff7",
      },
    ],
  },
} as const;
type Canonical3c6InventoryReceipt = typeof canonical3c6Expected;
function canonical3c6Fail(detail: string): never {
  throw new Error("canonical 3c6 inventory evolution: " + detail);
}
/** Fixed inventory-only epoch: each action rereads all authority; prior source pins stay in the prior chain. */
export function authenticateCanonical3c6InventoryEvolution(
  text = readFileSync(new URL(`../../${canonical3c6ReceiptPath}`, import.meta.url), "utf8"),
): Canonical3c6InventoryReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 64620 || sha(text) !== canonical3c6ReceiptSha256)
    canonical3c6Fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as Canonical3c6InventoryReceipt;
  if (!same(receipt, canonical3c6Expected)) canonical3c6Fail("fixed receipt schema/population mismatch");
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  currentMainInventoryPin(
    helper.subarray(0, 117269),
    receipt.helperPrefix,
    "complete canonical predecessor helper prefix changed",
  );
  currentMainInventoryPin(
    readFileSync(new URL(`../../${receipt.predecessorReceipt.path}`, import.meta.url)),
    receipt.predecessorReceipt,
    "canonical predecessor receipt changed",
  );
  const previous = authenticateCurrentMainInventoryEvolution();
  if (!same(previous.current, receipt.before)) canonical3c6Fail("prior current-main profile mismatch");
  if (receipt.rowChanges.length !== 26 || receipt.raw.spans.length !== 19)
    canonical3c6Fail("fixed population mismatch");
  let inserted = 0;
  const groups = [...new Set(receipt.rowChanges.map((change) => change.beforeIndex))];
  for (const [i, span] of receipt.raw.spans.entries()) {
    const group = receipt.rowChanges.filter((change) => change.beforeIndex === groups[i]);
    const rows = JSON.parse("[" + span.after.trim().replace(/,$/, "") + "]");
    if (
      span.before !== "" ||
      span.afterOffset !== span.beforeOffset + inserted ||
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256 ||
      !same(
        rows,
        group.map((change) => change.row),
      )
    )
      canonical3c6Fail("fixed raw group/schema/coordinate mismatch");
    inserted += Buffer.byteLength(span.after);
  }
  if (inserted !== 8547) canonical3c6Fail("fixed raw insertion population mismatch");
  return freeze(receipt);
}
function canonical3c6Profile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: Canonical3c6InventoryReceipt["before"] | Canonical3c6InventoryReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    canonical3c6Fail("complete policy profile mismatch");
}
function canonical3c6Rows(
  policy: MutableIrRuntimeProgramPolicy,
  receipt: Canonical3c6InventoryReceipt,
  current: boolean,
): void {
  if (!same(Object.keys(policy), wksTopKeys)) canonical3c6Fail("fixed top-level schema mismatch");
  for (const change of receipt.rowChanges) {
    const at = current ? change.currentIndex : change.beforeIndex;
    if (
      !same(policy.files[at - 1], current ? change.currentPrevious : change.beforePrevious) ||
      !same(policy.files[at + (current ? 1 : 0)], current ? change.currentNext : change.beforeNext) ||
      policy.files.filter((row) => row.path === change.row.path).length !== (current ? 1 : 0) ||
      (current &&
        (!same(Object.keys(policy.files[at]!), Object.keys(change.row)) || !same(policy.files[at], change.row)))
    )
      canonical3c6Fail("fixed row schema/membership/neighbors mismatch");
  }
}
function proveCanonical3c6Policy(
  value: unknown,
  verified?: Canonical3c6InventoryReceipt,
): {
  predecessor: MutableIrRuntimeProgramPolicy;
  priorPredecessor: MutableIrRuntimeProgramPolicy;
} {
  // Primitive/descriptor/proxy/cycle capture remains ahead of every authority read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  if (current === null || typeof current !== "object" || Array.isArray(current))
    canonical3c6Fail("policy input must be a plain object");
  const receipt = verified ?? authenticateCanonical3c6InventoryEvolution();
  canonical3c6Profile(current, receipt.current);
  canonical3c6Rows(current, receipt, true);
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const change of [...receipt.rowChanges].reverse()) predecessor.files.splice(change.currentIndex, 1);
  canonical3c6Profile(predecessor, receipt.before);
  canonical3c6Rows(predecessor, receipt, false);
  const priorPredecessor = beforeCurrentMainInventoryPolicy(predecessor);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  for (const [inserted, change] of receipt.rowChanges.entries()) {
    if (change.currentIndex !== change.beforeIndex + inserted) canonical3c6Fail("fixed replay index mismatch");
    replay.files.splice(change.beforeIndex + inserted, 0, capture(change.row) as Record<string, string>);
  }
  canonical3c6Profile(replay, receipt.current);
  canonical3c6Rows(replay, receipt, true);
  if (!same(replay, current)) canonical3c6Fail("complete reciprocal semantic replay mismatch");
  return { predecessor, priorPredecessor };
}
export function beforeCanonical3c6InventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveCanonical3c6Policy(value).predecessor;
}
function applyCanonical3c6Raw(raw: string, receipt: Canonical3c6InventoryReceipt, forward: boolean): string {
  const bytes = Buffer.from(raw, "utf8");
  currentMainInventoryPin(
    bytes,
    forward ? receipt.before.source : receipt.current.source,
    "canonical complete raw source profile mismatch",
  );
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of receipt.raw.spans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after, "utf8");
    const to = Buffer.from(forward ? span.after : span.before, "utf8");
    if (
      at < consumed ||
      at > bytes.length ||
      at + from.length > bytes.length ||
      !bytes.subarray(at, at + from.length).equals(from) ||
      (from.length > 0 && (bytes.indexOf(from) !== at || bytes.lastIndexOf(from) !== at))
    )
      canonical3c6Fail("fixed raw span missing/duplicated/reordered");
    pieces.push(bytes.subarray(consumed, at), to);
    consumed = at + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  const result = Buffer.concat(pieces);
  currentMainInventoryPin(
    result,
    forward ? receipt.current.source : receipt.before.source,
    "canonical complete raw output profile mismatch",
  );
  return result.toString("utf8");
}
export function beforeCanonical3c6InventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") canonical3c6Fail("raw input must be a primitive string");
  const receipt = authenticateCanonical3c6InventoryEvolution();
  const predecessor = applyCanonical3c6Raw(raw, receipt, false);
  const semantic = proveCanonical3c6Policy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  canonical3c6Profile(parsed, receipt.before);
  const priorRaw = beforeCurrentMainInventoryPolicySource(predecessor);
  if (
    !same(parsed, semantic.predecessor) ||
    !same(JSON.parse(priorRaw), semantic.priorPredecessor) ||
    applyCanonical3c6Raw(predecessor, receipt, true) !== raw
  )
    canonical3c6Fail("raw/semantic reciprocal proof disagree");
  return predecessor;
}

// Fixed five-row inventory-only successor; the complete signed predecessor helper stays byte-exact.
const canonical489dReceiptPath = "tests/helpers/ir-runtime-program-policy-canonical-489d.json";
const canonical489dReceiptSha256 = "52dc8a9359369565c5d1f39f01af8d9c8d853aa1e4b0a1f469622e350f3a7497";
const canonical489dExpected = {
  schema: 1,
  kind: "fixed-canonical-489d-inventory-only-successor",
  provenance: {
    checkpoint: "367022d3e960d6346cacad134fd89a12e2afd3ee",
    previousMain: "3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8",
    incomingMain: "489d0aacd45b5eb7b11cb06ef4c613a719c20f18",
    planSha256: "23dc1411c73d288132e44c6cdb9bb1c8f5a791648601fc15969c00f069eacd21",
    inventoryOnly: true,
  },
  before: {
    source: {
      bytes: 577771,
      sha256: "2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a",
      gitBlob: "8a7a71945ac6c7728c43cd91ae80a8c270b444cf",
    },
    dataSha256: "4cf6541e0c4677135d54cc2aa47b29763122e4fc416caff66c6165d3cb1e33ac",
    fileCount: 1808,
    filesSha256: "63c4be5ba7d77abd122bbcd55f8273e1fd9ee7a9e59fe522d374d3a0f8c1f54b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 579411,
      sha256: "82cc93fe5db9e58c118c46fc85db6b3cd4e09656c347358f8334945e70a99d40",
      gitBlob: "9b8282d67bd0d06b1c27ad005ec27c220c1c0d18",
    },
    dataSha256: "f0d41bf5acb4d3378a4b2fa18dd06c5e0720b52deb781ae97ee53dcc0594944c",
    fileCount: 1813,
    filesSha256: "8e5de381a3bd0165b308077ce119567fa9f4804d5143c7fcecec34118224021b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 187631,
    sha256: "4358379bba95549871b4e17c358b586b8443ec098fb70278eefa4949f96cbeaa",
    gitBlob: "b8f29db92a90343762aff898dd010e5ac8306560",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-canonical-3c6.json",
    bytes: 64620,
    sha256: "4a9cd6bd5109ab1cd3cbb1050066ef18377bb5e686f9f3111d572123fbc9127c",
    gitBlob: "46b0ea9de836a5d4d8a8438fda87892438f3d1e0",
  },
  rowChanges: [
    {
      operation: "addition",
      beforeIndex: 297,
      currentIndex: 297,
      row: {
        path: "src/codegen/classes/class-ctor-call-apply.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/class-constructor-wrapper.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/class-dynamic-keys.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/class-constructor-wrapper.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/class-dynamic-keys.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 302,
      currentIndex: 303,
      row: {
        path: "src/codegen/classes/class-heritage-comma.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/class-heritage-check.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/class-instance-method-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/class-heritage-check.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/classes/class-heritage-runtime-get.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 302,
      currentIndex: 304,
      row: {
        path: "src/codegen/classes/class-heritage-runtime-get.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/class-heritage-check.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/class-instance-method-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/classes/class-heritage-comma.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/class-instance-method-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 368,
      currentIndex: 371,
      row: {
        path: "src/codegen/classes/ctor-return-override.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/cross-hierarchy-operands.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/custom-iterable.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/cross-hierarchy-operands.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/custom-iterable.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      operation: "addition",
      beforeIndex: 408,
      currentIndex: 412,
      row: {
        path: "src/codegen/classes/derived-ctor-this-guard.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforePrevious: {
        path: "src/codegen/derived-ascii-case.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      beforeNext: {
        path: "src/codegen/derived-split-scalar.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentPrevious: {
        path: "src/codegen/derived-ascii-case.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      currentNext: {
        path: "src/codegen/derived-split-scalar.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  raw: {
    spans: [
      {
        beforeOffset: 140128,
        afterOffset: 140128,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/class-ctor-call-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "9f6ab9f503be20bd5f3e166c56d8772dd07b196cc3ac62dbd12b1af274646bd9",
      },
      {
        beforeOffset: 141727,
        afterOffset: 142054,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/class-heritage-comma.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/classes/class-heritage-runtime-get.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "bf1fd16db3a0fd8005f56a64e7c8de9abaaa99df264978b1cf3fedab14ae732d",
      },
      {
        beforeOffset: 162880,
        afterOffset: 163865,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/ctor-return-override.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "47071fb74fc050c93d32e8f69fae66cdea9502589400147b890295a84353fc5f",
      },
      {
        beforeOffset: 175944,
        afterOffset: 177255,
        before: "",
        after:
          '    {\n      "path": "src/codegen/classes/derived-ctor-this-guard.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "2854cb381a4b29e5ad8e0a1477d9aa55b5a8675bcf390aec303e385d5038dda7",
      },
    ],
  },
} as const;
type Canonical489dInventoryReceipt = typeof canonical489dExpected;
function canonical489dFail(detail: string): never {
  throw new Error("canonical 489d inventory evolution: " + detail);
}
/** Fixed inventory-only epoch: each action rereads all authority; prior source pins stay in the prior chain. */
export function authenticateCanonical489dInventoryEvolution(
  text = readFileSync(new URL(`../../${canonical489dReceiptPath}`, import.meta.url), "utf8"),
): Canonical489dInventoryReceipt {
  if (typeof text !== "string" || Buffer.byteLength(text) !== 14714 || sha(text) !== canonical489dReceiptSha256)
    canonical489dFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as Canonical489dInventoryReceipt;
  if (!same(receipt, canonical489dExpected)) canonical489dFail("fixed receipt schema/population mismatch");
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  currentMainInventoryPin(
    helper.subarray(0, 187631),
    receipt.helperPrefix,
    "complete canonical predecessor helper prefix changed",
  );
  currentMainInventoryPin(
    readFileSync(new URL(`../../${receipt.predecessorReceipt.path}`, import.meta.url)),
    receipt.predecessorReceipt,
    "canonical predecessor receipt changed",
  );
  const previous = authenticateCanonical3c6InventoryEvolution();
  if (!same(previous.current, receipt.before)) canonical489dFail("prior canonical 3c6 profile mismatch");
  if (receipt.rowChanges.length !== 5 || receipt.raw.spans.length !== 4) canonical489dFail("fixed population mismatch");
  let inserted = 0;
  const groups = [...new Set(receipt.rowChanges.map((change) => change.beforeIndex))];
  for (const [i, span] of receipt.raw.spans.entries()) {
    const group = receipt.rowChanges.filter((change) => change.beforeIndex === groups[i]);
    const rows = JSON.parse("[" + span.after.trim().replace(/,$/, "") + "]");
    if (
      span.before !== "" ||
      span.afterOffset !== span.beforeOffset + inserted ||
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256 ||
      !same(
        rows,
        group.map((change) => change.row),
      )
    )
      canonical489dFail("fixed raw group/schema/coordinate mismatch");
    inserted += Buffer.byteLength(span.after);
  }
  if (inserted !== 1640) canonical489dFail("fixed raw insertion population mismatch");
  return freeze(receipt);
}
function canonical489dProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: Canonical489dInventoryReceipt["before"] | Canonical489dInventoryReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    canonical489dFail("complete policy profile mismatch");
}
function canonical489dRows(
  policy: MutableIrRuntimeProgramPolicy,
  receipt: Canonical489dInventoryReceipt,
  current: boolean,
): void {
  if (!same(Object.keys(policy), wksTopKeys)) canonical489dFail("fixed top-level schema mismatch");
  for (const change of receipt.rowChanges) {
    const at = current ? change.currentIndex : change.beforeIndex;
    if (
      !same(policy.files[at - 1], current ? change.currentPrevious : change.beforePrevious) ||
      !same(policy.files[at + (current ? 1 : 0)], current ? change.currentNext : change.beforeNext) ||
      policy.files.filter((row) => row.path === change.row.path).length !== (current ? 1 : 0) ||
      (current &&
        (!same(Object.keys(policy.files[at]!), Object.keys(change.row)) || !same(policy.files[at], change.row)))
    )
      canonical489dFail("fixed row schema/membership/neighbors mismatch");
  }
}
function proveCanonical489dPolicy(
  value: unknown,
  verified?: Canonical489dInventoryReceipt,
): {
  predecessor: MutableIrRuntimeProgramPolicy;
  priorPredecessor: MutableIrRuntimeProgramPolicy;
} {
  // Primitive/descriptor/proxy/cycle capture remains ahead of every authority read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  if (current === null || typeof current !== "object" || Array.isArray(current))
    canonical489dFail("policy input must be a plain object");
  const receipt = verified ?? authenticateCanonical489dInventoryEvolution();
  canonical489dProfile(current, receipt.current);
  canonical489dRows(current, receipt, true);
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const change of [...receipt.rowChanges].reverse()) predecessor.files.splice(change.currentIndex, 1);
  canonical489dProfile(predecessor, receipt.before);
  canonical489dRows(predecessor, receipt, false);
  const priorPredecessor = beforeCanonical3c6InventoryPolicy(predecessor);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  for (const [inserted, change] of receipt.rowChanges.entries()) {
    if (change.currentIndex !== change.beforeIndex + inserted) canonical489dFail("fixed replay index mismatch");
    replay.files.splice(change.beforeIndex + inserted, 0, capture(change.row) as Record<string, string>);
  }
  canonical489dProfile(replay, receipt.current);
  canonical489dRows(replay, receipt, true);
  if (!same(replay, current)) canonical489dFail("complete reciprocal semantic replay mismatch");
  return { predecessor, priorPredecessor };
}
export function beforeCanonical489dInventoryPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return proveCanonical489dPolicy(value).predecessor;
}
function applyCanonical489dRaw(raw: string, receipt: Canonical489dInventoryReceipt, forward: boolean): string {
  const bytes = Buffer.from(raw, "utf8");
  currentMainInventoryPin(
    bytes,
    forward ? receipt.before.source : receipt.current.source,
    "canonical complete raw source profile mismatch",
  );
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of receipt.raw.spans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after, "utf8");
    const to = Buffer.from(forward ? span.after : span.before, "utf8");
    if (
      at < consumed ||
      at > bytes.length ||
      at + from.length > bytes.length ||
      !bytes.subarray(at, at + from.length).equals(from) ||
      (from.length > 0 && (bytes.indexOf(from) !== at || bytes.lastIndexOf(from) !== at))
    )
      canonical489dFail("fixed raw span missing/duplicated/reordered");
    pieces.push(bytes.subarray(consumed, at), to);
    consumed = at + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  const result = Buffer.concat(pieces);
  currentMainInventoryPin(
    result,
    forward ? receipt.current.source : receipt.before.source,
    "canonical complete raw output profile mismatch",
  );
  return result.toString("utf8");
}
export function beforeCanonical489dInventoryPolicySource(raw: string): string {
  if (typeof raw !== "string") canonical489dFail("raw input must be a primitive string");
  const receipt = authenticateCanonical489dInventoryEvolution();
  const predecessor = applyCanonical489dRaw(raw, receipt, false);
  const semantic = proveCanonical489dPolicy(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  canonical489dProfile(parsed, receipt.before);
  const priorRaw = beforeCanonical3c6InventoryPolicySource(predecessor);
  if (
    !same(parsed, semantic.predecessor) ||
    !same(JSON.parse(priorRaw), semantic.priorPredecessor) ||
    applyCanonical489dRaw(predecessor, receipt, true) !== raw
  )
    canonical489dFail("raw/semantic reciprocal proof disagree");
  return predecessor;
}

/** Fresh exact inventory capture; predecessor policy proof remains a separate caller operation. */
function captureCanonical489dPolicyOperand(
  value: unknown,
  verified?: Canonical489dInventoryReceipt,
): MutableIrRuntimeProgramPolicy {
  // Primitive/descriptor/proxy/cycle capture remains ahead of every authority read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  if (current === null || typeof current !== "object" || Array.isArray(current))
    canonical489dFail("policy input must be a plain object");
  const receipt = verified ?? authenticateCanonical489dInventoryEvolution();
  canonical489dProfile(current, receipt.current);
  canonical489dRows(current, receipt, true);
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const change of [...receipt.rowChanges].reverse()) predecessor.files.splice(change.currentIndex, 1);
  canonical489dProfile(predecessor, receipt.before);
  canonical489dRows(predecessor, receipt, false);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  for (const [inserted, change] of receipt.rowChanges.entries()) {
    if (change.currentIndex !== change.beforeIndex + inserted) canonical489dFail("fixed replay index mismatch");
    replay.files.splice(change.beforeIndex + inserted, 0, capture(change.row) as Record<string, string>);
  }
  canonical489dProfile(replay, receipt.current);
  canonical489dRows(replay, receipt, true);
  if (!same(replay, current)) canonical489dFail("complete reciprocal semantic replay mismatch");
  return predecessor;
}
export function captureCanonical489dPredecessorPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  return captureCanonical489dPolicyOperand(value);
}
export function captureCanonical489dPredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") canonical489dFail("raw input must be a primitive string");
  const receipt = authenticateCanonical489dInventoryEvolution();
  const predecessor = applyCanonical489dRaw(raw, receipt, false);
  const semantic = captureCanonical489dPolicyOperand(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  canonical489dProfile(parsed, receipt.before);
  if (!same(parsed, semantic) || applyCanonical489dRaw(predecessor, receipt, true) !== raw)
    canonical489dFail("raw/semantic reciprocal proof disagree");
  return predecessor;
}

// Fresh fixed inventory captures for initial Number fixtures; original full proofs above remain unchanged.
function captureCurrentMainSemantic(
  value: unknown,
  freshlyVerifiedReceipt: CurrentMainInventoryReceipt,
): {
  predecessor: MutableIrRuntimeProgramPolicy;
} {
  // Capture descriptors before receipt/source IO; keep subsequent historical mutants raw.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt;
  currentMainInventorySemanticProfile(current, receipt.current);
  currentMainInventoryRows(current, receipt, false);
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(1384, 0, capture(receipt.rowChanges[3].row) as Record<string, string>);
  for (const index of [514, 367, 366]) predecessor.files.splice(index, 1);
  currentMainInventorySemanticProfile(predecessor, receipt.before);
  currentMainInventoryRows(predecessor, receipt, true);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  replay.files.splice(1381, 1);
  for (const change of receipt.rowChanges.slice(0, 3))
    replay.files.splice(change.currentIndex, 0, capture(change.row) as Record<string, string>);
  currentMainInventorySemanticProfile(replay, receipt.current);
  currentMainInventoryRows(replay, receipt, false);
  if (!same(replay, current)) currentMainInventoryFail("complete reciprocal semantic replay mismatch");
  return { predecessor };
}

function captureCanonical3c6Semantic(
  value: unknown,
  verified: Canonical3c6InventoryReceipt,
): {
  predecessor: MutableIrRuntimeProgramPolicy;
} {
  // Primitive/descriptor/proxy/cycle capture remains ahead of every authority read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  if (current === null || typeof current !== "object" || Array.isArray(current))
    canonical3c6Fail("policy input must be a plain object");
  const receipt = verified;
  canonical3c6Profile(current, receipt.current);
  canonical3c6Rows(current, receipt, true);
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const change of [...receipt.rowChanges].reverse()) predecessor.files.splice(change.currentIndex, 1);
  canonical3c6Profile(predecessor, receipt.before);
  canonical3c6Rows(predecessor, receipt, false);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  for (const [inserted, change] of receipt.rowChanges.entries()) {
    if (change.currentIndex !== change.beforeIndex + inserted) canonical3c6Fail("fixed replay index mismatch");
    replay.files.splice(change.beforeIndex + inserted, 0, capture(change.row) as Record<string, string>);
  }
  canonical3c6Profile(replay, receipt.current);
  canonical3c6Rows(replay, receipt, true);
  if (!same(replay, current)) canonical3c6Fail("complete reciprocal semantic replay mismatch");
  return { predecessor };
}

export function captureCanonical3c6PredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") canonical3c6Fail("raw input must be a primitive string");
  const receipt = authenticateCanonical3c6InventoryEvolution();
  const predecessor = applyCanonical3c6Raw(raw, receipt, false);
  const semantic = captureCanonical3c6Semantic(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  canonical3c6Profile(parsed, receipt.before);
  if (!same(parsed, semantic.predecessor) || applyCanonical3c6Raw(predecessor, receipt, true) !== raw)
    canonical3c6Fail("raw/semantic reciprocal proof disagree");
  return predecessor;
}
export function captureCurrentMainInventoryPredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") currentMainInventoryFail("raw input must be a primitive string");
  const receipt = authenticateCurrentMainInventoryEvolution();
  const predecessor = applyCurrentMainInventoryRaw(raw, receipt, false);
  const semantic = captureCurrentMainSemantic(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  currentMainInventorySemanticProfile(parsed, receipt.before);
  if (!same(parsed, semantic.predecessor) || applyCurrentMainInventoryRaw(predecessor, receipt, true) !== raw)
    currentMainInventoryFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Fixed authenticated initial-capture inverses for the four retained policy stages.
// Each invocation runs its original fresh authority once; local semantic and raw replay remain independent.

function captureGeneratorSemantic(
  value: unknown,
  freshlyVerifiedReceipt: GeneratorInventoryPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor-safe capture precedes authority I/O, caller reads and serialization.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt;
  generatorInventorySemanticProfile(current, receipt.current);
  const addition = receipt.addition;
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    !same(Object.keys(current.files[1615]!), Object.keys(addition.row)) ||
    !same(current.files[1614], addition.previous) ||
    !same(current.files[1615], addition.row) ||
    !same(current.files[1616], addition.next) ||
    current.files.filter((row) => row.path === addition.row.path).length !== 1
  )
    generatorInventoryFail("fixed file row schema/order or neighbors mismatch");
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(1615, 1);
  generatorInventorySemanticProfile(predecessor, receipt.before);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  if (!same(replay.files[1614], addition.previous) || !same(replay.files[1615], addition.next))
    generatorInventoryFail("predecessor replay neighbors mismatch");
  replay.files.splice(1615, 0, capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number]);
  generatorInventorySemanticProfile(replay, receipt.current);
  if (!same(replay, current)) generatorInventoryFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}

/** Fresh fixed-profile initial capture; direct controls retain the full predecessor guards. */
export function captureGeneratorPredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") generatorInventoryFail("raw input must be a primitive string");
  const receipt = authenticateGeneratorInventoryPolicyEvolution();
  const predecessor = applyGeneratorInventoryRaw(raw, receipt, false);
  const semantic = captureGeneratorSemantic(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  generatorInventorySemanticProfile(parsed, receipt.before);
  if (!same(parsed, semantic.predecessor) || applyGeneratorInventoryRaw(predecessor, receipt, true) !== raw)
    generatorInventoryFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

function captureHostCarrierSemantic(
  value: unknown,
  freshlyVerifiedReceipt: HostCarrierPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor-safe capture precedes authority I/O, caller reads and serialization.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt;
  hostCarrierSemanticProfile(current, receipt.current);
  const addition = receipt.addition;
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    !same(Object.keys(current.files[605]!), Object.keys(addition.row)) ||
    !same(current.files[604], addition.previous) ||
    !same(current.files[605], addition.row) ||
    !same(current.files[606], addition.next) ||
    current.files.filter((row) => row.path === addition.row.path).length !== 1
  )
    hostCarrierFail("fixed file row schema/order or neighbors mismatch");
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files.splice(605, 1);
  hostCarrierSemanticProfile(predecessor, receipt.before);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  if (!same(replay.files[604], addition.previous) || !same(replay.files[605], addition.next))
    hostCarrierFail("predecessor replay neighbors mismatch");
  replay.files.splice(605, 0, capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number]);
  hostCarrierSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) hostCarrierFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}

/** Fresh fixed-profile initial capture; direct controls retain the full predecessor guards. */
export function captureHostCarrierPredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") hostCarrierFail("raw input must be a primitive string");
  const receipt = authenticateHostCarrierPolicyEvolution();
  const predecessor = applyHostCarrierInventoryRaw(raw, receipt, false);
  const semantic = captureHostCarrierSemantic(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  hostCarrierSemanticProfile(parsed, receipt.before);
  if (!same(parsed, semantic.predecessor) || applyHostCarrierInventoryRaw(predecessor, receipt, true) !== raw)
    hostCarrierFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

function captureDynamicCodeSemantic(
  value: unknown,
  freshlyVerifiedReceipt: DynamicCodePolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; predecessor: MutableIrRuntimeProgramPolicy } {
  // Descriptor capture must precede authority I/O and any caller property read.
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt;
  dynamicSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    current.files.filter((row) => row.layer === "legacy-host").length !== 55
  )
    dynamicFail("fixed inventory population mismatch");
  // Validate both rows against the untouched current array before removing either.
  for (const addition of receipt.additions) {
    if (
      !same(Object.keys(current.files[addition.fileIndex]!), Object.keys(addition.row)) ||
      !same(current.files[addition.fileIndex - 1], addition.previous) ||
      !same(current.files[addition.fileIndex], addition.row) ||
      !same(current.files[addition.fileIndex + 1], addition.next) ||
      current.files.filter((row) => row.path === addition.row.path).length !== 1
    )
      dynamicFail("fixed file row schema/order or neighbors mismatch");
  }
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  for (const addition of [...receipt.additions].reverse()) predecessor.files.splice(addition.fileIndex, 1);
  dynamicSemanticProfile(predecessor, receipt.before);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  // Validate all predecessor neighbors before replay inserts either fixed row.
  for (const addition of receipt.additions)
    if (
      !same(replay.files[addition.beforeIndex - 1], addition.previous) ||
      !same(replay.files[addition.beforeIndex], addition.next)
    )
      dynamicFail("predecessor replay neighbors mismatch");
  for (const [index, addition] of receipt.additions.entries())
    replay.files.splice(
      addition.beforeIndex + index,
      0,
      capture(addition.row) as MutableIrRuntimeProgramPolicy["files"][number],
    );
  dynamicSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) dynamicFail("complete independent reciprocal replay mismatch");
  return { current, predecessor };
}

/** Fresh fixed-profile initial capture; direct controls retain the full predecessor guards. */
export function captureDynamicCodePredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") dynamicFail("raw input must be a primitive string");
  const receipt = authenticateDynamicCodePolicyEvolution();
  const predecessor = applyDynamicCodeInventoryRaw(raw, receipt, false);
  const semantic = captureDynamicCodeSemantic(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  dynamicSemanticProfile(parsed, receipt.before);
  if (!same(parsed, semantic.predecessor) || applyDynamicCodeInventoryRaw(predecessor, receipt, true) !== raw)
    dynamicFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

function captureRuntimePreparationSemantic(
  value: unknown,
  freshlyVerifiedReceipt: RuntimePreparationPolicyReceipt,
): { current: MutableIrRuntimeProgramPolicy; before: MutableIrRuntimeProgramPolicy } {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  const receipt = freshlyVerifiedReceipt;
  preparationSemanticProfile(current, receipt.current);
  if (
    !same(Object.keys(current), wksTopKeys) ||
    current.layers.length !== 20 ||
    digest(current.allowedEdges) !== edges ||
    digest(current.files.slice(0, 1775)) !== preparationBeforeProfile.filesSha256 ||
    digest(current.activationHistory.slice(0, 100)) !== preparationBeforeProfile.activationHistorySha256 ||
    !same(current.files.slice(1775), [preparationFile]) ||
    !same(current.activationHistory.slice(100), [preparationActivation]) ||
    current.files.filter((row) => row.layer === "ir-runtime").length !== 20
  )
    preparationFail("ordered current prefix or suffix mismatch");
  const before = capture(current) as MutableIrRuntimeProgramPolicy;
  const layer = before.layers[8]!;
  if (
    layer.id !== "ir-runtime" ||
    layer.status !== "active" ||
    layer.required !== true ||
    !same(layer.roots, ["src/ir/runtime"]) ||
    layer.entries?.length !== 20 ||
    layer.minModules !== 20 ||
    !same(layer.entries.slice(19), [preparationFile.path])
  )
    preparationFail("exact layer delta mismatch");
  before.files.length = 1775;
  before.activationHistory.length = 100;
  layer.entries.length = 19;
  layer.minModules = 19;
  preparationSemanticProfile(before, receipt.before);
  const replay = capture(before) as MutableIrRuntimeProgramPolicy;
  replay.files.push(capture(preparationFile) as MutableIrRuntimeProgramPolicy["files"][number]);
  replay.activationHistory.push(
    capture(preparationActivation) as MutableIrRuntimeProgramPolicy["activationHistory"][number],
  );
  replay.layers[8]!.entries!.push(preparationFile.path);
  replay.layers[8]!.minModules = 20;
  preparationSemanticProfile(replay, receipt.current);
  if (!same(replay, current)) preparationFail("complete independent reciprocal replay mismatch");
  return { current, before };
}

/** Fresh fixed-profile initial capture; direct controls retain the full predecessor guards. */
export function captureRuntimePreparationPredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") preparationFail("raw input must be a primitive string");
  const receipt = authenticateRuntimePreparationPolicyEvolution();
  const predecessor = applyRuntimePreparationRaw(raw, receipt, false);
  const semantic = captureRuntimePreparationSemantic(JSON.parse(raw), receipt);
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  preparationSemanticProfile(parsed, receipt.before);
  if (!same(parsed, semantic.before) || applyRuntimePreparationRaw(predecessor, receipt, true) !== raw)
    preparationFail("raw and semantic reciprocal proof disagree");
  return predecessor;
}

// Fixed nested stackification relocation; historical APIs above remain unchanged.
const nestedStackificationReceiptPath = "tests/helpers/ir-runtime-program-policy-nested-stackification.json";
const nestedStackificationReceiptSha256 = "b88978d331ba72939f67a78f0091cf32b746c5ac276e29ecb24b3adbc98efdf3";
const nestedStackificationExpected = {
  schema: 1,
  kind: "fixed-nested-stackification-policy-relocation",
  provenance: {
    canonicalMain: "f710603e1c11101d0135274c6218ca36cb64fa37",
    preparedHead: "c59ceb6c0c579824d903ab8746c588658cba0a6b",
    planSha256: "3e2098994389c33e4543c3dd482bf196f874fe8e1e1a9ce74dd13189e284f223",
    legacyRetained: true,
  },
  before: {
    source: {
      bytes: 579411,
      sha256: "82cc93fe5db9e58c118c46fc85db6b3cd4e09656c347358f8334945e70a99d40",
      gitBlob: "9b8282d67bd0d06b1c27ad005ec27c220c1c0d18",
    },
    dataSha256: "f0d41bf5acb4d3378a4b2fa18dd06c5e0720b52deb781ae97ee53dcc0594944c",
    fileCount: 1813,
    filesSha256: "8e5de381a3bd0165b308077ce119567fa9f4804d5143c7fcecec34118224021b",
    activationCount: 101,
    activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
    layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 580511,
      sha256: "81a0d94238a16cb762befa909ff057fc55d2da720996cf04af196bdd50cff7b2",
      gitBlob: "dfedad8b2e98a9479409b351db8399a342505e19",
    },
    dataSha256: "d0891226c6e20ecf3868f9979a39b68722fe240a6e3394ea953c86ab1d1754de",
    fileCount: 1814,
    filesSha256: "a7fa1f5391015e87db1b70f61b965b737c0e32f917be41630e40dcf75337cef6",
    activationCount: 102,
    activationHistorySha256: "9a7e77fdc8c67fc0683879feb8bac8a9ef7854e9b083ac0c7e9affa4ddb24020",
    layersSha256: "e7246f81b16f524db95bddcb8bf0d01faf17834948744b2a3a4bdd79b912984e",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 228005,
    sha256: "2ccb2f22084b78c45a4550b8b4e3b7048748a1e719b357155883a35e5030bea3",
    gitBlob: "c762f24f20ba032a081575ac10f04d06967cc538",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-canonical-489d.json",
    bytes: 14714,
    sha256: "52dc8a9359369565c5d1f39f01af8d9c8d853aa1e4b0a1f469622e350f3a7497",
    gitBlob: "3334ebc183519f391958b5ae34e09a85c99dc5bf",
  },
  sourcePins: [
    {
      path: "src/ir/nested-stackification.ts",
      bytes: 254,
      sha256: "4c7169e9b6b523c79b3491258e7561b72e27ebea4a8e30156002f512bd87aaf4",
      gitBlob: "def6a1d232547bbef072fd34391bf70c3f1ca57d",
    },
    {
      path: "src/ir/analysis/nested-stackification.ts",
      bytes: 3576,
      sha256: "eef74f625cb5edec3b0ff554e6b2d7546af26adbf85df6cac962a6facbfc3327",
      gitBlob: "3b6dc27662c9b8ee88975192181dd99211e7b0dc",
    },
  ],
  originalImplementation: {
    bytes: 3570,
    sha256: "f66f42492cb6aaf0c55ad3681289802c1e598ea98119edc975bd37618c905a33",
    gitBlob: "7da4f65d24f07fd2fdf08266680ceacbcb07ac87",
  },
  sourceInverse: {
    before: 'from "./nodes.js";',
    after: 'from "../core/nodes.js";',
    beforeOffset: 212,
    afterOffset: 212,
    completeInverseReplay: true,
  },
  facadeSource:
    '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\nexport { stackifyMovableNestedValues } from "./analysis/nested-stackification.js";\nexport type { NestedStackificationInput } from "./analysis/nested-stackification.js";\n',
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
  delta: {
    layerIndex: 6,
    beforeLayer: {
      id: "ir-analysis",
      status: "active",
      roots: [
        "src/ir/analysis/contracts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
      ],
      required: true,
      entries: [
        "src/ir/analysis/contracts/allocations.ts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
      ],
      minModules: 11,
    },
    currentLayer: {
      id: "ir-analysis",
      status: "active",
      roots: [
        "src/ir/analysis/contracts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
      ],
      required: true,
      entries: [
        "src/ir/analysis/contracts/allocations.ts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
      ],
      minModules: 12,
    },
    activationIndex: 0,
    activation: {
      layer: "ir-analysis",
      entries: [
        "src/ir/analysis/contracts/allocations.ts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
      ],
      minModules: 12,
    },
    moveIndex: 0,
    move: {
      from: "src/ir/nested-stackification.ts",
      to: "src/ir/analysis/nested-stackification.ts",
    },
    newRowIndex: 59,
    newRow: {
      path: "src/ir/analysis/nested-stackification.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    newRowPrevious: {
      path: "src/ir/analysis/effects.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    newRowNext: {
      path: "src/ir/analysis/intrinsics.ts",
      state: "clean",
      layer: "ir-analysis",
    },
    oldFacadeBeforeIndex: 1301,
    oldFacadeCurrentIndex: 1302,
    beforeFacade: {
      path: "src/ir/nested-stackification.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "ir-core",
      owner: "3518-coordinator",
      nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
    },
    currentFacade: {
      path: "src/ir/nested-stackification.ts",
      state: "compatibility-adapter",
      layer: "mixed-needs-split",
      destination: "ir-analysis",
      owner: "3518-coordinator",
      nextBoundary:
        "The unchanged stackification implementation and input type live in analysis/nested-stackification.ts. Retain this explicit same-identity compatibility export until existing consumers migrate and full IR parity is proved.",
    },
    facadePrevious: {
      path: "src/ir/module-init.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "ir-core",
      owner: "3518-coordinator",
      nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
    },
    facadeNext: {
      path: "src/ir/nodes.ts",
      state: "unmigrated",
      layer: "mixed-needs-split",
      destination: "ir-core",
      owner: "3518-coordinator",
      nextBoundary:
        "The complete semantic instruction/function closure lives in src/ir/core/nodes.ts and its activated pure dependencies. Retain old prepared-function aliases while prepared runtime attachments and program preparation remain mixed debt. irValSigned and isDynamic remain here with unresolved production-caller obligations.",
    },
  },
  rawSpans: [
    {
      beforeOffset: 4187,
      afterOffset: 4187,
      before:
        '    {\n      "id": "ir-analysis",\n      "status": "active",\n      "roots": [\n        "src/ir/analysis/contracts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts"\n      ],\n      "required": true,\n      "entries": [\n        "src/ir/analysis/contracts/allocations.ts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts"\n      ],\n      "minModules": 11\n    },\n',
      after:
        '    {\n      "id": "ir-analysis",\n      "status": "active",\n      "roots": [\n        "src/ir/analysis/contracts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts",\n        "src/ir/analysis/nested-stackification.ts"\n      ],\n      "required": true,\n      "entries": [\n        "src/ir/analysis/contracts/allocations.ts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts",\n        "src/ir/analysis/nested-stackification.ts"\n      ],\n      "minModules": 12\n    },\n',
      beforeSha256: "23f8d181cf2d503365411f5991bec56419c10c25f990bd3133f75e93d4b778e2",
      afterSha256: "d7cba84f80ffcc2f8ef775e838a9c0b117e306a80dd01f708c8cb9c982c31eba",
    },
    {
      beforeOffset: 25457,
      afterOffset: 25561,
      before:
        '    {\n      "layer": "backend-wasmgc",\n      "entries": ["src/backend/wasmgc/resources/native-delay-combinator.ts"],\n      "minModules": 15\n    },\n',
      after:
        '    {\n      "layer": "ir-analysis",\n      "entries": [\n        "src/ir/analysis/contracts/allocations.ts",\n        "src/ir/analysis/alloc-registry.ts",\n        "src/ir/analysis/effects.ts",\n        "src/ir/analysis/intrinsics.ts",\n        "src/ir/analysis/async-plan.ts",\n        "src/ir/analysis/lattice.ts",\n        "src/ir/analysis/ownership.ts",\n        "src/ir/analysis/encoding.ts",\n        "src/ir/analysis/escape.ts",\n        "src/ir/analysis/dominance.ts",\n        "src/ir/analysis/alloc-verification.ts",\n        "src/ir/analysis/nested-stackification.ts"\n      ],\n      "minModules": 12\n    },\n    {\n      "layer": "backend-wasmgc",\n      "entries": ["src/backend/wasmgc/resources/native-delay-combinator.ts"],\n      "minModules": 15\n    },\n',
      beforeSha256: "cb056d8676f66da8e0921f20fd39ccd62e25c9475872817cef92d33f108b257a",
      afterSha256: "8fd7b8d2a608dd93a627e28652bc8fea8e4d69aaf7c8adc9219d1ba88f593e25",
    },
    {
      beforeOffset: 66604,
      afterOffset: 67313,
      before:
        '    {\n      "from": "src/codegen/prepared-async-frame-engine.ts",\n      "to": "src/runtime/wasmgc/async/prepared-async-frame-engine.ts"\n    },\n',
      after:
        '    {\n      "from": "src/ir/nested-stackification.ts",\n      "to": "src/ir/analysis/nested-stackification.ts"\n    },\n    {\n      "from": "src/codegen/prepared-async-frame-engine.ts",\n      "to": "src/runtime/wasmgc/async/prepared-async-frame-engine.ts"\n    },\n',
      beforeSha256: "daa29a12281d9a4dd2971886df7fc30a06b8b8d4c1019dfcdfb6973d6d11c6fe",
      afterSha256: "02f457ad8200b11e4c258bcbb6a2b637d01e68fbfe32b693a94a15b890fb6c03",
    },
    {
      beforeOffset: 77080,
      afterOffset: 77906,
      before:
        '    {\n      "path": "src/ir/analysis/intrinsics.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n',
      after:
        '    {\n      "path": "src/ir/analysis/nested-stackification.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/intrinsics.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n',
      beforeSha256: "aa5882a40e3bc07f264d6c5648a018f2ff07e12f8ebd2a82d4dd7732cf9b8bb9",
      afterSha256: "ea597838ef4583b0f673b4a4ee8f21a9400ffcdab956c4d4fd85386a98da0100",
    },
    {
      beforeOffset: 458975,
      afterOffset: 459925,
      before:
        '    {\n      "path": "src/ir/nested-stackification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n    },\n',
      after:
        '    {\n      "path": "src/ir/nested-stackification.ts",\n      "state": "compatibility-adapter",\n      "layer": "mixed-needs-split",\n      "destination": "ir-analysis",\n      "owner": "3518-coordinator",\n      "nextBoundary": "The unchanged stackification implementation and input type live in analysis/nested-stackification.ts. Retain this explicit same-identity compatibility export until existing consumers migrate and full IR parity is proved."\n    },\n',
      beforeSha256: "1526eb4052d5643c0637a9928a84662be4f5e9c9a2a7685b35f318df7e8f66e5",
      afterSha256: "c56e1ef62cf0ba598eab976b7e10d39118f45a64c877065e8852c2399b3b34d1",
    },
  ],
} as const;
export type NestedStackificationPolicyReceipt = typeof nestedStackificationExpected;
function nestedStackificationFail(detail: string): never {
  throw new Error("nested stackification policy evolution: " + detail);
}
function nestedStackificationPin(
  bytes: Buffer,
  pin: { readonly bytes: number; readonly sha256: string; readonly gitBlob: string },
  label: string,
): void {
  if (
    bytes.length !== pin.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== pin.sha256 ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== pin.gitBlob
  )
    nestedStackificationFail(label);
}
/** Every public action reads current physical authority anew; no accepted capture crosses operations. */
export function authenticateNestedStackificationPolicyEvolution(): NestedStackificationPolicyReceipt {
  const text = readFileSync(new URL(`../../${nestedStackificationReceiptPath}`, import.meta.url), "utf8");
  if (Buffer.byteLength(text) !== 15523 || sha(text) !== nestedStackificationReceiptSha256)
    nestedStackificationFail("receipt digest mismatch");
  const receipt = JSON.parse(text) as NestedStackificationPolicyReceipt;
  if (!same(receipt, nestedStackificationExpected))
    nestedStackificationFail("fixed receipt schema/population mismatch");
  const helper = readFileSync(new URL("./ir-runtime-program-policy-evolution.ts", import.meta.url));
  nestedStackificationPin(
    helper.subarray(0, 228005),
    receipt.helperPrefix,
    "complete predecessor helper prefix changed",
  );
  nestedStackificationPin(
    readFileSync(new URL(`../../${receipt.predecessorReceipt.path}`, import.meta.url)),
    receipt.predecessorReceipt,
    "predecessor receipt changed",
  );
  const sources = receipt.sourcePins.map((pin) => {
    const bytes = readFileSync(new URL(`../../${pin.path}`, import.meta.url));
    nestedStackificationPin(bytes, pin, "current source changed: " + pin.path);
    return bytes;
  });
  if (sources[0]!.toString("utf8") !== receipt.facadeSource)
    nestedStackificationFail("exact compatibility facade changed");
  const owner = sources[1]!;
  const from = Buffer.from(receipt.sourceInverse.after, "utf8");
  const to = Buffer.from(receipt.sourceInverse.before, "utf8");
  const at = receipt.sourceInverse.afterOffset;
  if (owner.indexOf(from) !== at || owner.lastIndexOf(from) !== at || receipt.sourceInverse.beforeOffset !== at)
    nestedStackificationFail("unique owner import inverse mismatch");
  const original = Buffer.concat([owner.subarray(0, at), to, owner.subarray(at + from.length)]);
  nestedStackificationPin(original, receipt.originalImplementation, "canonical original implementation mismatch");
  if (
    original.indexOf(to) !== at ||
    original.lastIndexOf(to) !== at ||
    !Buffer.concat([original.subarray(0, at), from, original.subarray(at + to.length)]).equals(owner)
  )
    nestedStackificationFail("owner reciprocal import replay mismatch");
  let delta = 0;
  let consumedBefore = 0;
  let consumedAfter = 0;
  for (const span of receipt.rawSpans) {
    const before = Buffer.from(span.before, "utf8"),
      after = Buffer.from(span.after, "utf8");
    if (
      sha(span.before) !== span.beforeSha256 ||
      sha(span.after) !== span.afterSha256 ||
      span.beforeOffset < consumedBefore ||
      span.afterOffset < consumedAfter ||
      span.afterOffset !== span.beforeOffset + delta
    )
      nestedStackificationFail("fixed raw fragment/order/coordinate mismatch");
    consumedBefore = span.beforeOffset + before.length;
    consumedAfter = span.afterOffset + after.length;
    delta += after.length - before.length;
  }
  if (
    receipt.rawSpans.length !== 5 ||
    delta !== 1100 ||
    receipt.before.source.bytes + delta !== receipt.current.source.bytes
  )
    nestedStackificationFail("fixed raw population mismatch");
  const previous = authenticateCanonical489dInventoryEvolution();
  if (!same(previous.current, receipt.before)) nestedStackificationFail("prior canonical 489d profile mismatch");
  return freeze(receipt);
}
function nestedStackificationProfile(
  policy: MutableIrRuntimeProgramPolicy,
  profile: NestedStackificationPolicyReceipt["before"] | NestedStackificationPolicyReceipt["current"],
): void {
  if (
    digest(policy) !== profile.dataSha256 ||
    policy.files.length !== profile.fileCount ||
    policy.activationHistory.length !== profile.activationCount ||
    digest(policy.files) !== profile.filesSha256 ||
    digest(policy.activationHistory) !== profile.activationHistorySha256 ||
    digest(policy.layers) !== profile.layersSha256 ||
    digest(policy.allowedEdges) !== profile.allowedEdgesSha256
  )
    nestedStackificationFail("complete policy profile mismatch");
}
function nestedStackificationRows(
  policy: MutableIrRuntimeProgramPolicy,
  receipt: NestedStackificationPolicyReceipt,
  current: boolean,
): void {
  const d = receipt.delta,
    rowIndex = d.newRowIndex;
  const facadeIndex = current ? d.oldFacadeCurrentIndex : d.oldFacadeBeforeIndex;
  const facade = current ? d.currentFacade : d.beforeFacade;
  if (
    !same(Object.keys(policy), receipt.topLevelKeys) ||
    !same(policy.layers[d.layerIndex], current ? d.currentLayer : d.beforeLayer) ||
    !same(policy.files[rowIndex - 1], d.newRowPrevious) ||
    !same(policy.files[rowIndex + (current ? 1 : 0)], d.newRowNext) ||
    policy.files.filter((row) => row.path === d.newRow.path).length !== (current ? 1 : 0) ||
    (current &&
      (!same(policy.files[rowIndex], d.newRow) ||
        !same(Object.keys(policy.files[rowIndex]!), Object.keys(d.newRow)))) ||
    !same(policy.files[facadeIndex - 1], d.facadePrevious) ||
    !same(policy.files[facadeIndex + 1], d.facadeNext) ||
    !same(policy.files[facadeIndex], facade) ||
    !same(Object.keys(policy.files[facadeIndex]!), Object.keys(facade)) ||
    policy.files.filter((row) => row.path === facade.path).length !== 1
  )
    nestedStackificationFail("fixed layer/row schema/membership/neighbors mismatch");
  const moves = policy.moves as unknown[];
  if (
    !Array.isArray(moves) ||
    moves.length !== (current ? 7 : 6) ||
    (current && (!same(policy.activationHistory[0], d.activation) || !same(moves[0], d.move)))
  )
    nestedStackificationFail("fixed activation/move mismatch");
}
/** Pure, detached local inverse; the caller's next489d API retains the unchanged historical proof. */
function captureNestedStackificationPolicyOperand(
  current: MutableIrRuntimeProgramPolicy,
  receipt: NestedStackificationPolicyReceipt,
): MutableIrRuntimeProgramPolicy {
  nestedStackificationProfile(current, receipt.current);
  nestedStackificationRows(current, receipt, true);
  const d = receipt.delta;
  const predecessor = capture(current) as MutableIrRuntimeProgramPolicy;
  predecessor.files[d.oldFacadeCurrentIndex] = capture(d.beforeFacade) as Record<string, string>;
  predecessor.files.splice(d.newRowIndex, 1);
  predecessor.activationHistory.splice(d.activationIndex, 1);
  (predecessor.moves as unknown[]).splice(d.moveIndex, 1);
  predecessor.layers[d.layerIndex] = capture(d.beforeLayer) as MutableIrRuntimeProgramPolicy["layers"][number];
  nestedStackificationProfile(predecessor, receipt.before);
  nestedStackificationRows(predecessor, receipt, false);
  const replay = capture(predecessor) as MutableIrRuntimeProgramPolicy;
  replay.layers[d.layerIndex] = capture(d.currentLayer) as MutableIrRuntimeProgramPolicy["layers"][number];
  (replay.moves as unknown[]).splice(d.moveIndex, 0, capture(d.move));
  replay.activationHistory.splice(
    d.activationIndex,
    0,
    capture(d.activation) as MutableIrRuntimeProgramPolicy["activationHistory"][number],
  );
  replay.files.splice(d.newRowIndex, 0, capture(d.newRow) as Record<string, string>);
  replay.files[d.oldFacadeCurrentIndex] = capture(d.currentFacade) as Record<string, string>;
  nestedStackificationProfile(replay, receipt.current);
  nestedStackificationRows(replay, receipt, true);
  if (!same(replay, current)) nestedStackificationFail("complete reciprocal semantic replay mismatch");
  return predecessor;
}
export function captureNestedStackificationPredecessorPolicy(value: unknown): MutableIrRuntimeProgramPolicy {
  const current = capture(value) as MutableIrRuntimeProgramPolicy;
  if (current === null || typeof current !== "object" || Array.isArray(current))
    nestedStackificationFail("policy input must be a plain object");
  return captureNestedStackificationPolicyOperand(current, authenticateNestedStackificationPolicyEvolution());
}
function applyNestedStackificationRaw(
  raw: string,
  receipt: NestedStackificationPolicyReceipt,
  forward: boolean,
): string {
  const bytes = Buffer.from(raw, "utf8");
  nestedStackificationPin(
    bytes,
    forward ? receipt.before.source : receipt.current.source,
    "complete raw source profile mismatch",
  );
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of receipt.rawSpans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after, "utf8");
    const to = Buffer.from(forward ? span.after : span.before, "utf8");
    if (
      at < consumed ||
      at + from.length > bytes.length ||
      bytes.indexOf(from) !== at ||
      bytes.lastIndexOf(from) !== at ||
      !bytes.subarray(at, at + from.length).equals(from)
    )
      nestedStackificationFail("fixed raw fragment/membership/coordinate mismatch");
    pieces.push(bytes.subarray(consumed, at), to);
    consumed = at + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  const result = Buffer.concat(pieces);
  nestedStackificationPin(
    result,
    forward ? receipt.current.source : receipt.before.source,
    "reciprocal raw source profile mismatch",
  );
  return result.toString("utf8");
}
export function captureNestedStackificationPredecessorPolicySource(raw: string): string {
  if (typeof raw !== "string") nestedStackificationFail("raw input must be a primitive string");
  const receipt = authenticateNestedStackificationPolicyEvolution();
  const predecessor = applyNestedStackificationRaw(raw, receipt, false);
  const semantic = captureNestedStackificationPolicyOperand(
    capture(JSON.parse(raw)) as MutableIrRuntimeProgramPolicy,
    receipt,
  );
  const parsed = JSON.parse(predecessor) as MutableIrRuntimeProgramPolicy;
  nestedStackificationProfile(parsed, receipt.before);
  if (!same(parsed, semantic) || applyNestedStackificationRaw(predecessor, receipt, true) !== raw)
    nestedStackificationFail("raw/semantic reciprocal proof disagree");
  return predecessor;
}
