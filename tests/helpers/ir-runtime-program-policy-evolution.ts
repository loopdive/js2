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
