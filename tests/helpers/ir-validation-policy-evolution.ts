// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const irValidationPolicyReceiptPath = "tests/helpers/ir-validation-policy-evolution.json";
const receiptSha256 = "39dacc9d17fb52b6a369ed81d7498afc30b00bc06d89362bba039305aa96fa0e";
const historySha256 = "906d96d460433bb445216a2ed6fe10ffd7bf7dbbebbe1a9f557b0f878ad4403f";
const allowedEdgesSha256 = "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7";
const nineHistorySha256 = "820a39c3d3b05a1a20d030ae10b1e19621802cfed5cf9a29ccb5dccb80b3d6ee";

export interface IrValidationPolicyActivation {
  readonly layer: string;
  readonly entries: readonly string[];
  readonly minModules: number;
}
export interface IrValidationPolicyLayer {
  readonly id: string;
  readonly roots: readonly string[];
  readonly status: string;
  readonly required?: boolean;
  readonly entries?: readonly string[];
  readonly minModules?: number;
}
export interface IrValidationPolicy {
  readonly layers: readonly IrValidationPolicyLayer[];
  readonly activationHistory: readonly IrValidationPolicyActivation[];
  readonly allowedEdges: Readonly<Record<string, readonly string[]>>;
  readonly files: readonly Readonly<Record<string, string>>[];
  readonly [key: string]: unknown;
}
interface HistoricalLayer {
  readonly id: string;
  readonly entries: readonly string[];
  readonly minModules: number;
  readonly status: "active";
  readonly required: true;
  readonly activationIndex: number;
}
export interface IrValidationPolicyReceipt {
  readonly schema: number;
  readonly kind: string;
  readonly before: {
    readonly dataSha256: string;
    readonly fileCount: number;
    readonly filesSha256: string;
    readonly activationCount: number;
    readonly activationHistorySha256: string;
    readonly allowedEdgesSha256: string;
    readonly layers: readonly IrValidationPolicyLayer[];
    readonly otherPolicyFieldsSha256: string;
  };
  readonly current: {
    readonly dataSha256: string;
    readonly fileCount: number;
    readonly filesSha256: string;
    readonly activationCount: number;
    readonly activationHistorySha256: string;
    readonly layers: readonly IrValidationPolicyLayer[];
  };
  readonly activationAdditions: readonly IrValidationPolicyActivation[];
  readonly fileReclassifications: readonly {
    readonly index: number;
    readonly before: Readonly<Record<string, string>>;
    readonly after: Readonly<Record<string, string>>;
  }[];
  readonly addedFiles: readonly Readonly<Record<string, string>>[];
  readonly conservativeFacades: readonly Readonly<Record<string, string>>[];
  readonly historical: {
    readonly layerEntryCount: number;
    readonly layers: readonly HistoricalLayer[];
    readonly nineActivationIndexes: readonly number[];
    readonly nineActivationSha256: string;
  };
}

function fail(detail: string): never {
  throw new Error(`validation policy evolution: ${detail}`);
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const irValidationPolicyActivations: readonly IrValidationPolicyActivation[] = freeze([
  {
    layer: "ir-analysis",
    entries: [
      "src/ir/analysis/lattice.ts",
      "src/ir/analysis/ownership.ts",
      "src/ir/analysis/encoding.ts",
      "src/ir/analysis/escape.ts",
      "src/ir/analysis/dominance.ts",
      "src/ir/analysis/alloc-verification.ts",
    ],
    minModules: 6,
  },
  { layer: "ir-runtime", entries: ["src/ir/runtime/verify.ts"], minModules: 1 },
  {
    layer: "ir-program",
    entries: ["src/ir/program/allocations.ts", "src/ir/program/class-layouts.ts"],
    minModules: 2,
  },
]);

/** Capture current JSON data without invoking getters, toJSON, or inherited fields. */
function capture(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== "object" || value === null || active.has(value)) fail("non-JSON or cyclic policy");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) fail("foreign prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) fail("symbol policy key");
  for (const key of keys) {
    const descriptor = descriptors[key as string]!;
    if (!("value" in descriptor) || (!descriptor.enumerable && !(array && key === "length")))
      fail("accessor or hidden policy field");
  }
  active.add(value);
  try {
    if (array) {
      const length = descriptors.length!.value as number;
      if (keys.length !== length + 1) fail("array holes or extra policy fields");
      return Array.from({ length }, (_, i) => {
        const descriptor = descriptors[String(i)];
        if (!descriptor) fail("array hole");
        return capture(descriptor.value, active);
      });
    }
    return Object.fromEntries(keys.map((key) => [key, capture(descriptors[key as string]!.value, active)]));
  } finally {
    active.delete(value);
  }
}

export function authenticateIrValidationPolicyEvolution(
  text = readFileSync(new URL(`../../${irValidationPolicyReceiptPath}`, import.meta.url), "utf8"),
): IrValidationPolicyReceipt {
  if (sha(text) !== receiptSha256) fail("receipt digest mismatch");
  const receipt = JSON.parse(text) as IrValidationPolicyReceipt;
  if (
    receipt.schema !== 1 ||
    receipt.kind !== "phase-b-exact-policy-evolution" ||
    receipt.before.fileCount !== 1761 ||
    receipt.current.fileCount !== 1765 ||
    receipt.before.activationCount !== 91 ||
    receipt.current.activationCount !== 94 ||
    receipt.before.activationHistorySha256 !== historySha256 ||
    receipt.before.allowedEdgesSha256 !== allowedEdgesSha256 ||
    receipt.historical.nineActivationSha256 !== nineHistorySha256 ||
    receipt.historical.layerEntryCount !== 56 ||
    receipt.historical.layers.length !== 10 ||
    receipt.fileReclassifications.length !== 5 ||
    receipt.addedFiles.length !== 4 ||
    !same(receipt.activationAdditions, irValidationPolicyActivations) ||
    !same(receipt.historical.nineActivationIndexes, [66, 67, 68, 69, 70, 71, 72, 73, 74])
  )
    fail("fixed receipt population mismatch");
  return freeze(receipt);
}

/** A fresh mutable history copy lets the unchanged old detectors receive actual mutations. */
export function beforeIrValidationPolicyActivations(value: unknown): IrValidationPolicyActivation[] {
  const history = capture(value);
  if (!Array.isArray(history) || history.length !== 94) fail("activation population mismatch");
  const original = history.slice(0, 91);
  if (digest(original) !== historySha256) fail("original activation prefix mismatch");
  if (!same(history.slice(91), irValidationPolicyActivations)) fail("Phase B activation suffix mismatch");
  // This is an input view for older tests, not a retained completion token.
  // Freezing it would stop their nested mutations before their detector runs.
  return original as IrValidationPolicyActivation[];
}

/** Authenticate all actual policy fields and reverse only the reviewed B metadata delta. */
export function authenticateIrValidationPolicy(value: unknown): IrValidationPolicy {
  const receipt = authenticateIrValidationPolicyEvolution();
  const policy = capture(value) as IrValidationPolicy;
  if (!policy || digest(policy) !== receipt.current.dataSha256) fail("complete current policy mismatch");
  const history = beforeIrValidationPolicyActivations(policy.activationHistory);
  if (digest(policy.allowedEdges) !== allowedEdgesSha256) fail("allowed edges mismatch");
  if (!same(policy.layers, receipt.current.layers)) fail("complete current layers mismatch");
  if (policy.files.length !== 1765 || digest(policy.files) !== receipt.current.filesSha256)
    fail("complete file inventory mismatch");
  if (!same(policy.files.slice(1761), receipt.addedFiles)) fail("new file suffix mismatch");
  const restoredFiles = policy.files.slice(0, 1761);
  for (const change of receipt.fileReclassifications) {
    if (!same(restoredFiles[change.index], change.after)) fail("analysis classification mismatch");
    restoredFiles[change.index] = change.before;
  }
  if (digest(restoredFiles) !== receipt.before.filesSha256) fail("original file inventory mismatch");
  for (const facade of receipt.conservativeFacades)
    if (
      !same(
        policy.files.filter((row) => row.path === facade.path),
        [facade],
      )
    )
      fail("facade classification mismatch");
  const restored = { ...policy, layers: receipt.before.layers, activationHistory: history, files: restoredFiles };
  if (digest(restored) !== receipt.before.dataSha256) fail("reciprocal original policy mismatch");
  return freeze(policy);
}

export interface HistoricalIrValidationPolicyView {
  readonly layers: readonly Omit<HistoricalLayer, "activationIndex">[];
  readonly activationHistory: readonly IrValidationPolicyActivation[];
  readonly layerActivations: readonly IrValidationPolicyActivation[];
}

/** Historical metadata only. This view never supplies source text or compiler inputs. */
export function historicalIrValidationPolicyView(value: unknown): HistoricalIrValidationPolicyView {
  const policy = authenticateIrValidationPolicy(value);
  const receipt = authenticateIrValidationPolicyEvolution();
  const layers = receipt.historical.layers.map(({ activationIndex, ...historical }) => {
    const current = policy.layers.filter((row) => row.id === historical.id);
    if (current.length !== 1 || !same(current[0]!.entries!.slice(0, historical.entries.length), historical.entries))
      fail("historical layer prefix mismatch");
    const expected = { layer: historical.id, entries: historical.entries, minModules: historical.minModules };
    if (!same(policy.activationHistory[activationIndex], expected)) fail("historical layer activation mismatch");
    return { ...historical, entries: current[0]!.entries!.slice(0, historical.entries.length) };
  });
  if (layers.reduce((count, layer) => count + layer.entries.length, 0) !== 56) fail("historical layer denominator");
  const activationHistory = receipt.historical.nineActivationIndexes.map((i) => policy.activationHistory[i]!);
  if (digest(activationHistory) !== nineHistorySha256) fail("original nine activation receipt mismatch");
  return freeze({
    layers,
    activationHistory,
    layerActivations: receipt.historical.layers.map((row) => policy.activationHistory[row.activationIndex]!),
  });
}
