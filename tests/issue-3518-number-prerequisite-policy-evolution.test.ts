// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  captureLoweringAnalysisPredecessorPolicySource,
  captureWasmGcHelperPredecessorPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { captureProgramValidatorPredecessorPolicySource } from "./helpers/ir-runtime-program-policy-evolution.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureNestedStackificationPredecessorPolicySource,
  captureGeneratorPredecessorPolicySource,
  captureHostCarrierPredecessorPolicySource,
  captureDynamicCodePredecessorPolicySource,
  captureRuntimePreparationPredecessorPolicySource,
  captureCanonical489dPredecessorPolicySource,
  captureCanonical3c6PredecessorPolicySource,
  authenticateGeneratorInventoryPolicyEvolution,
  authenticateGeneratorInventoryPolicy,
  beforeGeneratorInventoryPolicy,
  beforeGeneratorInventoryPolicySource,
  generatorInventoryPolicyReceiptPath,
  authenticateHostCarrierPolicyEvolution,
  authenticateHostCarrierInventoryPolicy,
  beforeHostCarrierInventoryPolicy,
  beforeHostCarrierInventoryPolicySource,
  hostCarrierPolicyReceiptPath,
  authenticateDynamicCodePolicyEvolution,
  authenticateDynamicCodeInventoryPolicy,
  beforeDynamicCodeInventoryPolicy,
  beforeDynamicCodeInventoryPolicySource,
  dynamicCodePolicyReceiptPath,
  authenticateRuntimePreparationPolicyEvolution,
  authenticateRuntimePreparationPolicy,
  beforeRuntimePreparationPolicy,
  beforeRuntimePreparationPolicySource,
  runtimePreparationPolicyReceiptPath,
  authenticateNumberPrerequisitePolicyEvolution,
  authenticateNumberPrerequisitePolicy,
  beforeNumberPrerequisitePolicy,
  beforeNumberPrerequisitePolicySource,
  numberPrerequisitePolicyReceiptPath,
  authenticateWellKnownSymbolPolicyEvolution,
  authenticateWellKnownSymbolPolicy,
  beforeWellKnownSymbolPolicy,
  beforeWellKnownSymbolPolicySource,
  authenticateIrRuntimeProgramPolicy,
  beforeIrRuntimeProgramPolicy,
  type MutableIrRuntimeProgramPolicy as Policy,
  captureCurrentMainInventoryPredecessorPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { authenticateIrValidationPolicy } from "./helpers/ir-validation-policy-evolution.js";
afterEach(async () => {
  // Yield between synchronous source proofs so Vitest can process task-update RPCs.
  await setImmediate();
});
const { intercepted, interceptedReads } = vi.hoisted(() => ({
  intercepted: new Map<string, number>(),
  interceptedReads: new Map<string, number>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: (...args: Parameters<typeof readFileSync>) => {
      const bytes = original.readFileSync(...args);
      const key = args[0] instanceof URL ? args[0].pathname : String(args[0]);
      for (const [path, offset] of intercepted)
        if (key === path) {
          interceptedReads.set(path, (interceptedReads.get(path) ?? 0) + 1);
          const mutant = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
          mutant[offset] = mutant[offset]! ^ 1;
          return typeof bytes === "string" ? mutant.toString("utf8") : mutant;
        }
      return bytes;
    },
  };
});
import { c1HistoricalArtifactPath, type C1HistoricalLogicalPath } from "./helpers/ir-c1-historical-authority.js";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const historicalPolicyOperandPaths: readonly string[] = [
  "tests/issue-3518-runtime-program-relocation.test.ts",
  "tests/issue-3518-program-data-contract-seam.test.ts",
  "tests/issue-3518-program-ownership-runtime-seam.test.ts",
  "tests/issue-3518-program-pre-a-evolution.test.ts",
  "tests/issue-3518-program-initial-graph-evolution.test.ts",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
];
const historicalPolicyPhysicalPath = (path: string): string =>
  historicalPolicyOperandPaths.includes(path) ? c1HistoricalArtifactPath(path as C1HistoricalLogicalPath) : path;
// Raw physical operand reads let the original mutation assertions inspect corruption before the guard rejects it.
const readHistoricalPolicyOperand = (path: string): string => read(historicalPolicyPhysicalPath(path));
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// The original Number historical input is derived from the outer actual C2a policy.
const raw = (): string =>
  captureRuntimePreparationPredecessorPolicySource(
    captureDynamicCodePredecessorPolicySource(
      captureHostCarrierPredecessorPolicySource(
        captureGeneratorPredecessorPolicySource(
          captureCurrentMainInventoryPredecessorPolicySource(
            captureCanonical3c6PredecessorPolicySource(
              captureCanonical489dPredecessorPolicySource(
                captureNestedStackificationPredecessorPolicySource(
                  captureProgramValidatorPredecessorPolicySource(
                    captureWasmGcHelperPredecessorPolicySource(
                      captureLoweringAnalysisPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
const actual = (): Policy => JSON.parse(raw()) as Policy;
const receiptText = (): string => read(numberPrerequisitePolicyReceiptPath);
const receipt = () => authenticateNumberPrerequisitePolicyEvolution(receiptText());
const bodies = [
  "src/runtime/wasmgc/values/bigint-to-number-body.ts",
  "src/runtime/wasmgc/values/number-from-value-body.ts",
];
const owners = [
  "src/backend/wasmgc/resources/native-bigint-number.ts",
  "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
];
function accepted(): void {
  expect(authenticateNumberPrerequisitePolicy(actual()).files).toHaveLength(1775);
}
function refused(value: unknown): void {
  expect(() => authenticateNumberPrerequisitePolicy(value)).toThrow();
  expect(() => beforeNumberPrerequisitePolicy(value)).toThrow();
}
function rejected(change: (p: Policy) => void): void {
  const p = actual(),
    original = JSON.stringify(p);
  authenticateNumberPrerequisitePolicy(p);
  change(p);
  expect(JSON.stringify(p)).not.toBe(original);
  refused(p);
  const restored = JSON.parse(original) as Policy;
  // Restore the same warmed object so identity cannot act as completion authority.
  for (const key of Object.keys(p)) Reflect.deleteProperty(p, key);
  Object.assign(p, restored);
  expect(JSON.stringify(p)).toBe(original);
  authenticateNumberPrerequisitePolicy(p);
  accepted();
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) frozen(child);
  }
}
function independentReplay(wks: Policy): Policy {
  const p = clone(wks);
  p.files.push(
    { path: bodies[0]!, state: "clean", layer: "native-runtime" },
    { path: bodies[1]!, state: "clean", layer: "native-runtime" },
    { path: owners[0]!, state: "clean", layer: "backend-wasmgc" },
    { path: owners[1]!, state: "clean", layer: "backend-wasmgc" },
  );
  p.layers[11]!.entries!.push(...owners);
  p.layers[11]!.minModules = 52;
  p.layers[12]!.entries!.push(...bodies);
  p.layers[12]!.minModules = 99;
  p.activationHistory.push(
    { layer: "native-runtime", entries: [...bodies], minModules: 2 },
    { layer: "backend-wasmgc", entries: [...owners], minModules: 2 },
  );
  return p;
}
function rawRefused(mutant: string): void {
  expect(mutant).not.toBe(raw());
  expect(sha(mutant)).not.toBe("8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df");
  expect(() => beforeNumberPrerequisitePolicySource(mutant)).toThrow();
  expect(sha(beforeNumberPrerequisitePolicySource(raw()))).toBe(
    "451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59",
  );
}
describe("Number prerequisite exact successor of genuine WKS, C1 and B", () => {
  it("independently reads true complete current bytes, ordered profiles and all current census populations", () => {
    const text = raw(),
      p = actual();
    expect(Buffer.byteLength(text)).toBe(567166);
    expect(sha(text)).toBe("8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex"),
    ).toBe("0d90f336925232fd22c98c438121b93e7e5bcf52");
    expect(digest(p)).toBe("5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21");
    expect([p.files.length, p.activationHistory.length, p.layers.length]).toEqual([1775, 100, 20]);
    for (const [id, entries, floor, classified] of [
      ["runtime-contracts", 10, 10, 10],
      ["backend-wasmgc", 52, 52, 57],
      ["ir-program", 43, 43, 44],
      ["ir-runtime", 19, 19, 19],
      ["native-runtime", 100, 99, 105],
      ["ir-analysis", 11, 11, 11],
      ["ir-core", 29, 29, 29],
    ] as const) {
      const rows = p.layers.filter((row) => row.id === id);
      expect(rows).toHaveLength(1);
      expect([rows[0]!.entries!.length, rows[0]!.minModules, p.files.filter((row) => row.layer === id).length]).toEqual(
        [entries, floor, classified],
      );
    }
    expect(Object.keys(p)).toEqual([
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
    ]);
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    accepted();
  });
  it("pins all 28 full files, exact WKS and nested C1 prefixes, and complete predecessor profile", () => {
    const read = readHistoricalPolicyOperand;
    const r = receipt(),
      wks = authenticateWellKnownSymbolPolicyEvolution();
    expect(Buffer.byteLength(receiptText())).toBe(12726);
    expect(sha(receiptText())).toBe("92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845");
    const currentText = receiptText();
    let oldText = currentText;
    for (const path of ["src/backend/wasmgc", "src/runtime/wasmgc"]) {
      const inline = `"roots": ["${path}"]`;
      expect(oldText.indexOf(inline)).toBeGreaterThanOrEqual(0);
      expect(oldText.indexOf(inline)).toBe(oldText.lastIndexOf(inline));
      oldText = oldText.replace(inline, `"roots": [\n        "${path}"\n      ]`);
    }
    expect(Buffer.byteLength(oldText)).toBe(12758);
    expect(sha(oldText)).toBe("a5bd7bdf49069d030c29eda4f1b334d97c761b220f2e2887ca3a7cea0d9abfb4");
    expect(JSON.stringify(JSON.parse(oldText))).toBe(JSON.stringify(JSON.parse(currentText)));
    expect(() => authenticateNumberPrerequisitePolicyEvolution(oldText)).toThrow("receipt digest mismatch");
    expect(receipt().current.fileCount).toBe(1775);
    expect(r.before).toEqual(wks.current);
    expect(r.provenance.immutableInputs).toEqual([
      {
        path: "tests/helpers/ir-runtime-program-policy-well-known-symbols.json",
        bytes: 9470,
        sha256: "5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61",
      },
      ...wks.provenance.immutableInputs,
    ]);
    expect(r.provenance.sourceInputs.map((pin) => pin.path)).toEqual([
      ...bodies,
      ...owners,
      "tests/issue-3518-bigint-to-number-body.test.ts",
      "tests/issue-3518-native-bigint-number-owner.test.ts",
      "tests/issue-3518-native-number-primitive-classifier.test.ts",
      "tests/issue-3518-number-from-value-body.test.ts",
    ]);
    const pins = [...r.provenance.immutableInputs, ...r.provenance.sourceInputs];
    expect([
      r.provenance.immutableInputs.length,
      r.provenance.sourceInputs.length,
      new Set(pins.map((pin) => pin.path)).size,
    ]).toEqual([20, 8, 28]);
    for (const pin of pins) {
      expect(Buffer.byteLength(read(pin.path))).toBe(pin.bytes);
      expect(sha(read(pin.path))).toBe(pin.sha256);
    }
    const helper = Buffer.from(read("tests/helpers/ir-runtime-program-policy-evolution.ts"));
    for (const [bytes, hash] of [
      [23854, "fe575facb2aedc750760ba302ded54ab37ac223ff70e0d07f25faa804de84474"],
      [10742, "2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d"],
    ] as const)
      expect(createHash("sha256").update(helper.subarray(0, bytes)).digest("hex")).toBe(hash);
    frozen(r);
  });
  it("independently replays the four-leaf delta and proves unchanged WKS to C1 to B guards", () => {
    const p = actual(),
      original = JSON.stringify(p),
      wks = beforeNumberPrerequisitePolicy(p);
    expect([wks.files.length, wks.activationHistory.length]).toEqual([1771, 98]);
    expect(digest(wks)).toBe("462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7");
    authenticateWellKnownSymbolPolicy(wks);
    const c1 = beforeWellKnownSymbolPolicy(wks),
      b = beforeIrRuntimeProgramPolicy(c1);
    expect([c1.files.length, c1.activationHistory.length, b.files.length, b.activationHistory.length]).toEqual([
      1769, 96, 1765, 94,
    ]);
    authenticateIrRuntimeProgramPolicy(c1);
    authenticateIrValidationPolicy(b);
    expect(JSON.stringify(independentReplay(wks))).toBe(original);
    expect(JSON.stringify(p)).toBe(original);
    for (const guard of [
      authenticateWellKnownSymbolPolicy,
      authenticateIrRuntimeProgramPolicy,
      authenticateIrValidationPolicy,
    ])
      expect(() => guard(p)).toThrow();
    for (const old of [wks, c1, b]) refused(old);
    accepted();
  });
  it("independently slices the four raw spans in both directions and exercises unchanged WKS raw inverse", () => {
    const text = raw(),
      r = receipt(),
      wks = beforeNumberPrerequisitePolicySource(text);
    expect(Buffer.byteLength(wks)).toBe(565875);
    expect(sha(wks)).toBe("451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(wks)}\0`)
        .update(wks)
        .digest("hex"),
    ).toBe("74dc1b073145713d122e28a0b45f34c0cc41a066");
    expect(JSON.parse(wks)).toEqual(beforeNumberPrerequisitePolicy(actual()));
    expect(r.raw.spans.map((s) => [s.role, s.beforeOffset, s.afterOffset, s.before.length, s.after.length])).toEqual([
      ["backend-wasmgc-layer-tail", 12886, 12886, 91, 233],
      ["native-runtime-layer-tail", 19261, 19403, 89, 214],
      ["activation-history-tail", 65258, 65525, 166, 623],
      ["files-tail", 565726, 566450, 149, 716],
    ]);
    for (const forward of [false, true]) {
      const input = forward ? wks : text;
      let end = 0,
        rebuilt = "",
        displacement = 0;
      for (const span of r.raw.spans) {
        expect(span.afterOffset).toBe(span.beforeOffset + displacement);
        const offset = forward ? span.beforeOffset : span.afterOffset,
          from = forward ? span.before : span.after;
        expect(input.indexOf(from)).toBe(offset);
        expect(input.lastIndexOf(from)).toBe(offset);
        expect(offset).toBeGreaterThanOrEqual(end);
        rebuilt += input.slice(end, offset) + (forward ? span.after : span.before);
        end = offset + from.length;
        displacement += span.after.length - span.before.length;
      }
      rebuilt += input.slice(end);
      expect(rebuilt).toBe(forward ? text : wks);
    }
    expect(sha(beforeWellKnownSymbolPolicySource(wks))).toBe(
      "460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57",
    );
    expect(() => beforeWellKnownSymbolPolicySource(text)).toThrow();
    expect(() => beforeNumberPrerequisitePolicySource(wks)).toThrow();
  });
  it("returns freshly detached frozen current and mutable WKS without changing input", () => {
    const p = actual(),
      original = JSON.stringify(p),
      a = authenticateNumberPrerequisitePolicy(p),
      a2 = authenticateNumberPrerequisitePolicy(p);
    frozen(a);
    expect(a).not.toBe(p);
    expect(a2).not.toBe(a);
    expect(a.files[0]).not.toBe(p.files[0]);
    const wks = beforeNumberPrerequisitePolicy(p),
      wks2 = beforeNumberPrerequisitePolicy(p);
    expect(wks).not.toBe(wks2);
    expect(wks.files[0]).not.toBe(wks2.files[0]);
    expect(wks.layers[12]!.entries).not.toBe(wks2.layers[12]!.entries);
    expect(Object.isFrozen(wks)).toBe(false);
    expect(Object.isFrozen(wks.layers[12]!.entries)).toBe(false);
    wks.files[0]!.state = "unmigrated";
    expect(wks.files[0]!.state).toBe("unmigrated");
    expect(() => authenticateWellKnownSymbolPolicy(wks)).toThrow();
    authenticateWellKnownSymbolPolicy(wks2);
    expect(JSON.stringify(p)).toBe(original);
    accepted();
  });
  for (const index of [1771, 1772, 1773, 1774]) {
    for (const operation of [
      "delete",
      "duplicate",
      "replace",
      "reorder",
      "unknown",
      "state",
      "layer",
      "key-order",
    ] as const)
      it(`rejects new file ${index} ${operation}`, () =>
        rejected((p) => {
          const row = p.files[index]!;
          if (operation === "delete") p.files.splice(index, 1);
          if (operation === "duplicate") p.files.splice(index, 0, { ...row });
          if (operation === "replace") row.path = "src/runtime/contracts/unknown.ts";
          if (operation === "unknown")
            p.files.push({ path: "src/runtime/contracts/unknown.ts", state: "clean", layer: "runtime-contracts" });
          if (operation === "reorder")
            [p.files[index], p.files[1771 + ((index - 1771 + 1) % 4)]] = [
              p.files[1771 + ((index - 1771 + 1) % 4)]!,
              p.files[index]!,
            ];
          if (operation === "state") row.state = "unmigrated";
          if (operation === "layer") row.layer = "ir-core";
          if (operation === "key-order") p.files[index] = { layer: row.layer!, path: row.path!, state: row.state! };
        }));
  }
  for (const index of [11, 12]) {
    for (const operation of [
      "entry-delete",
      "entry-replace",
      "entry-duplicate",
      "entry-reorder",
      "same-count",
      "unknown-entry",
      "index",
      "id",
      "root",
      "status",
      "required",
      "floor",
      "key-order",
    ] as const)
      it(`rejects changed layer ${index} ${operation}`, () =>
        rejected((p) => {
          const layer = p.layers[index]!,
            entries = layer.entries!;
          if (operation === "entry-delete") entries.pop();
          if (operation === "entry-replace") entries[entries.length - 1] = "src/runtime/contracts/unknown.ts";
          if (operation === "entry-duplicate") entries.push(entries[entries.length - 1]!);
          if (operation === "entry-reorder") entries.reverse();
          if (operation === "same-count")
            [entries[0], entries[entries.length - 1]] = [entries[entries.length - 1]!, entries[0]!];
          if (operation === "unknown-entry") entries.push("src/runtime/contracts/unknown.ts");
          if (operation === "index") [p.layers[11], p.layers[12]] = [p.layers[12]!, p.layers[11]!];
          if (operation === "id") layer.id = "ir-core";
          if (operation === "root") layer.roots[0] = "src/runtime/foreign";
          if (operation === "status") layer.status = "inactive";
          if (operation === "required") layer.required = false;
          if (operation === "floor") layer.minModules!++;
          if (operation === "key-order")
            p.layers[index] = {
              status: layer.status,
              id: layer.id,
              required: layer.required,
              roots: layer.roots,
              entries: layer.entries,
              minModules: layer.minModules,
            };
        }));
  }
  for (const index of [98, 99]) {
    for (const operation of [
      "delete",
      "duplicate",
      "replace",
      "reorder",
      "entry-delete",
      "entry-duplicate",
      "layer",
      "floor",
      "key-order",
    ] as const)
      it(`rejects new activation ${index} ${operation}`, () =>
        rejected((p) => {
          const row = p.activationHistory[index]!;
          if (operation === "delete") p.activationHistory.splice(index, 1);
          if (operation === "duplicate") p.activationHistory.splice(index, 0, clone(row));
          if (operation === "replace") row.entries[0] = "src/runtime/contracts/unknown.ts";
          if (operation === "reorder")
            [p.activationHistory[98], p.activationHistory[99]] = [p.activationHistory[99]!, p.activationHistory[98]!];
          if (operation === "entry-delete") row.entries.length = 0;
          if (operation === "entry-duplicate") row.entries.push(row.entries[0]!);
          if (operation === "layer") row.layer = "ir-core";
          if (operation === "floor") row.minModules = 3;
          if (operation === "key-order")
            p.activationHistory[index] = { entries: row.entries, layer: row.layer, minModules: row.minModules };
        }));
  }
  for (const part of [
    "file-prefix",
    "history-prefix",
    "layer-prefix",
    "edge",
    "unrelated",
    "top-key-order",
    "same-count-file",
  ] as const)
    it(`rejects changed ${part}`, () =>
      rejected((p) => {
        if (part === "file-prefix") p.files[0]!.state = "unmigrated";
        if (part === "history-prefix") p.activationHistory[0]!.minModules++;
        if (part === "layer-prefix") p.layers[0]!.id = "changed";
        if (part === "edge") p.allowedEdges["ir-core"]!.push("unknown");
        if (part === "unrelated") p.description = "changed description";
        if (part === "top-key-order") {
          const schema = p.schema;
          Reflect.deleteProperty(p, "schema");
          p.schema = schema;
        }
        if (part === "same-count-file") [p.files[0], p.files[1]] = [p.files[1]!, p.files[0]!];
      }));

  for (const location of ["top", "layer", "file", "history", "array-element"] as const)
    it(`rejects ${location} accessors with zero getter calls before serialization, then restores and retries`, () => {
      const p = actual();
      authenticateNumberPrerequisitePolicy(p);
      const target =
        location === "top"
          ? p
          : location === "layer"
            ? p.layers[11]!
            : location === "file"
              ? p.files[1771]!
              : location === "history"
                ? p.activationHistory[98]!
                : p.files;
      const key =
        location === "top"
          ? "description"
          : location === "layer"
            ? "entries"
            : location === "file"
              ? "path"
              : location === "history"
                ? "entries"
                : "1771";
      const original = Object.getOwnPropertyDescriptor(target, key)!;
      expect(Object.hasOwn(original, "value")).toBe(true);
      let reads = 0;
      try {
        Object.defineProperty(target, key, {
          enumerable: true,
          configurable: true,
          get() {
            reads++;
            return original.value;
          },
        });
        expect(Object.hasOwn(Object.getOwnPropertyDescriptor(target, key)!, "value")).toBe(false);
        refused(p);
        expect(reads).toBe(0);
      } finally {
        Object.defineProperty(target, key, original);
      }
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(original);
      authenticateNumberPrerequisitePolicy(p);
      accepted();
    });
  for (const shape of [
    "hidden",
    "symbol",
    "foreign-prototype",
    "sparse",
    "inherited",
    "extra-array",
    "cycle",
    "function",
    "toJSON",
    "undefined",
    "bigint",
    "nan",
    "infinity",
    "negative-zero",
  ] as const)
    it(`rejects ${shape} descriptors or non-JSON data after a warm success without invoking callbacks`, () => {
      const p = actual();
      authenticateNumberPrerequisitePolicy(p);
      const originalText = JSON.stringify(p),
        originalDigest = digest(p),
        restored = JSON.parse(originalText) as Policy,
        originalKeys = Reflect.ownKeys(p);
      let calls = 0;
      if (shape === "hidden") Object.defineProperty(p.files[1771]!, "path", { enumerable: false });
      if (shape === "symbol")
        Object.defineProperty(p, Symbol("extra"), { value: 1, enumerable: true, configurable: true });
      if (shape === "foreign-prototype") Object.setPrototypeOf(p.files[1771]!, { foreign: true });
      if (shape === "sparse") Reflect.deleteProperty(p.files, "1771");
      if (shape === "inherited") {
        const row = p.files[1771]!;
        Reflect.deleteProperty(p.files, "1771");
        Object.setPrototypeOf(p.files, Object.assign(Object.create(Array.prototype), { 1771: row }));
      }
      if (shape === "extra-array") Object.defineProperty(p.files, "extra", { value: 1, enumerable: true });
      if (shape === "cycle") p.cycle = p;
      if (shape === "function")
        p.extra = () => {
          calls++;
          return 1;
        };
      if (shape === "toJSON")
        p.toJSON = () => {
          calls++;
          return actual();
        };
      if (shape === "undefined") p.extra = undefined;
      if (shape === "bigint") p.extra = 1n;
      if (shape === "nan") p.extra = NaN;
      if (shape === "infinity") p.extra = Infinity;
      if (shape === "negative-zero") p.extra = -0;
      // Inspect the mutation through reflection rather than serializing its untrusted values.
      if (shape === "hidden") expect(Object.getOwnPropertyDescriptor(p.files[1771]!, "path")!.enumerable).toBe(false);
      else if (shape === "symbol") expect(Reflect.ownKeys(p).some((key) => typeof key === "symbol")).toBe(true);
      else if (shape === "foreign-prototype") expect(Object.getPrototypeOf(p.files[1771]!)).not.toBe(Object.prototype);
      else if (shape === "sparse" || shape === "inherited") expect(Object.hasOwn(p.files, "1771")).toBe(false);
      else if (shape === "extra-array") expect(Object.hasOwn(p.files, "extra")).toBe(true);
      else expect(Object.hasOwn(p, shape === "cycle" ? "cycle" : shape === "toJSON" ? "toJSON" : "extra")).toBe(true);
      if (shape === "cycle") expect(p.cycle).toBe(p);
      if (shape === "function") expect(typeof p.extra).toBe("function");
      if (shape === "toJSON") expect(typeof p.toJSON).toBe("function");
      if (shape === "undefined") expect(Object.getOwnPropertyDescriptor(p, "extra")!.value).toBeUndefined();
      if (shape === "bigint") expect(p.extra).toBe(1n);
      if (shape === "nan") expect(Number.isNaN(p.extra)).toBe(true);
      if (shape === "infinity") expect(p.extra).toBe(Infinity);
      if (shape === "negative-zero") expect(Object.is(p.extra, -0)).toBe(true);
      const captureError =
        shape === "hidden"
          ? "accessor or hidden policy field"
          : shape === "symbol"
            ? "symbol policy key"
            : shape === "foreign-prototype" || shape === "inherited"
              ? "foreign prototype"
              : shape === "sparse" || shape === "extra-array"
                ? "array holes or extra fields"
                : "non-JSON or cyclic policy";
      expect(() => authenticateNumberPrerequisitePolicy(p)).toThrow(captureError);
      refused(p);
      expect(calls).toBe(0);
      for (const key of Reflect.ownKeys(p)) expect(Reflect.deleteProperty(p, key)).toBe(true);
      expect(Reflect.ownKeys(p)).toEqual([]);
      Object.setPrototypeOf(p, Object.prototype);
      Object.assign(p, restored);
      expect(Reflect.ownKeys(p)).toEqual(originalKeys);
      expect(Object.getOwnPropertyDescriptors(p)).toEqual(Object.getOwnPropertyDescriptors(restored));
      expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
      expect(digest(p)).toBe(originalDigest);
      authenticateNumberPrerequisitePolicy(p);
      expect(digest(actual())).toBe(originalDigest);
      accepted();
    });
  it("rejects repeated warm mutations and reaccepts the exact authentic data after restoration", () => {
    const p = actual(),
      original = p.layers[11]!.minModules;
    for (let i = 0; i < 2; i++) {
      authenticateNumberPrerequisitePolicy(p);
      p.layers[11]!.minModules = 11;
      expect(p.layers[11]!.minModules).toBe(11);
      refused(p);
      p.layers[11]!.minModules = original;
      authenticateNumberPrerequisitePolicy(p);
    }
    accepted();
  });

  for (const index of [0, 1, 2, 3]) {
    for (const boundary of ["first", "last", "outside", "missing", "duplicate", "reordered"] as const)
      it(`rejects raw span ${index} ${boundary}`, () => {
        const text = raw(),
          spans = receipt().raw.spans,
          span = spans[index]!;
        let mutant: string;
        if (boundary === "missing")
          mutant = text.slice(0, span.afterOffset) + text.slice(span.afterOffset + span.after.length);
        else if (boundary === "duplicate")
          mutant = text.slice(0, span.afterOffset) + span.after + text.slice(span.afterOffset);
        else if (boundary === "reordered") {
          const next = spans[(index + 1) % 4]!;
          mutant = text.slice(0, span.afterOffset) + next.after + text.slice(span.afterOffset + span.after.length);
        } else {
          const at =
            boundary === "first"
              ? span.afterOffset
              : boundary === "last"
                ? span.afterOffset + span.after.length - 1
                : span.afterOffset - 1;
          mutant = text.slice(0, at) + (text[at] === "X" ? "Y" : "X") + text.slice(at + 1);
        }
        rawRefused(mutant);
      });
  }
  for (const drift of ["leading-space", "trailing-space", "crlf", "no-final-newline", "extra-final-newline"] as const)
    it(`rejects semantically equal raw ${drift}`, () => {
      const text = raw();
      const mutant =
        drift === "leading-space"
          ? " " + text
          : drift === "trailing-space"
            ? text + " "
            : drift === "crlf"
              ? text.replaceAll("\n", "\r\n")
              : drift === "no-final-newline"
                ? text.slice(0, -1)
                : text + "\n";
      expect(JSON.parse(mutant)).toEqual(JSON.parse(text));
      rawRefused(mutant);
    });
  it("refuses nonprimitive raw without invoking its conversion callback", () => {
    let calls = 0;
    const input = {
      toString() {
        calls++;
        return raw();
      },
    };
    expect(() => beforeNumberPrerequisitePolicySource(input as unknown as string)).toThrow();
    expect(calls).toBe(0);
    accepted();
  });
  for (const drift of [
    "whitespace",
    "newline",
    "before",
    "current",
    "inputs",
    "prefix",
    "census",
    "delta",
    "files",
    "activations",
    "edges",
    "unknown-field",
  ] as const)
    it(`rejects fixed receipt ${drift} drift and reaccepts the fresh original`, () => {
      const text = receiptText(),
        r = JSON.parse(text) as ReturnType<typeof receipt> & { extra?: boolean };
      if (drift === "before") r.before.source.bytes++;
      if (drift === "current") r.current.fileCount--;
      if (drift === "inputs") r.provenance.immutableInputs.pop();
      if (drift === "prefix") r.provenance.wksHelperPrefix.bytes--;
      if (drift === "census") r.census.classifiedBackend!++;
      if (drift === "delta") r.layerDeltas[0]!.currentMinModules++;
      if (drift === "files") r.addedFiles.reverse();
      if (drift === "activations") r.activationAdditions.reverse();
      if (drift === "edges") r.allowedEdgesSha256 = "0".repeat(64);
      if (drift === "unknown-field") r.extra = true;
      const mutant =
        drift === "whitespace" ? " " + text : drift === "newline" ? text.replaceAll("\n", "\r\n") : JSON.stringify(r);
      expect(sha(mutant)).not.toBe(sha(text));
      if (drift !== "whitespace" && drift !== "newline")
        expect(JSON.stringify(r)).not.toBe(JSON.stringify(JSON.parse(text)));
      expect(() => authenticateNumberPrerequisitePolicyEvolution(mutant)).toThrow("receipt digest mismatch");
      expect(receipt().current.fileCount).toBe(1775);
    });
  for (const index of [0, 1, 2, 3]) {
    for (const field of ["role", "beforeOffset", "afterOffset", "before", "after"] as const)
      it(`rejects fixed raw receipt span ${index} ${field} mutation`, () => {
        const r = clone(receipt());
        const span = r.raw.spans[index]!;
        if (field === "beforeOffset" || field === "afterOffset") span[field]++;
        else span[field] += "changed";
        expect(span[field]).not.toBe(receipt().raw.spans[index]![field]);
        expect(() => authenticateNumberPrerequisitePolicyEvolution(JSON.stringify(r))).toThrow(
          "receipt digest mismatch",
        );
        accepted();
      });
  }

  for (const path of [
    "tests/helpers/ir-runtime-program-policy-well-known-symbols.json",
    "tests/helpers/ir-runtime-program-policy-evolution.json",
    "src/ir/program.ts",
    "src/ir/program-abi-contracts.ts",
    "src/ir/prepared-component-dependencies.ts",
    "src/ir/generator-support.ts",
    "src/ir/program/owner.ts",
    "src/ir/program/draft-abi-lookup.ts",
    "src/ir/program/runtime-support-dependencies.ts",
    "src/ir/runtime/generator-support.ts",
    "tests/issue-3518-runtime-program-c1-relocation.test.ts",
    "tests/helpers/ir-runtime-program-relocation.ts",
    "tests/helpers/ir-runtime-program-relocation.json",
    "tests/issue-3518-runtime-program-relocation.test.ts",
    "tests/issue-3518-program-data-contract-seam.test.ts",
    "tests/issue-3518-program-ownership-runtime-seam.test.ts",
    "tests/issue-3518-program-pre-a-evolution.test.ts",
    "tests/issue-3518-program-initial-graph-evolution.test.ts",
    "tests/helpers/ir-validation-policy-evolution.ts",
    "tests/helpers/ir-validation-policy-evolution.json",
    "src/runtime/wasmgc/values/bigint-to-number-body.ts",
    "src/runtime/wasmgc/values/number-from-value-body.ts",
    "src/backend/wasmgc/resources/native-bigint-number.ts",
    "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
    "tests/issue-3518-bigint-to-number-body.test.ts",
    "tests/issue-3518-native-bigint-number-owner.test.ts",
    "tests/issue-3518-native-number-primitive-classifier.test.ts",
    "tests/issue-3518-number-from-value-body.test.ts",
    "tests/helpers/ir-runtime-program-policy-evolution.ts",
    "tests/helpers/ir-runtime-program-policy-number-prerequisites.json",
  ]) {
    it(`freshly rejects changed file bytes for ${path} through every public action after warm success and restores`, () => {
      const read = readHistoricalPolicyOperand;
      const p = actual(),
        text = raw(),
        original = read(path);
      receipt();
      authenticateNumberPrerequisitePolicy(p);
      beforeNumberPrerequisitePolicy(p);
      beforeNumberPrerequisitePolicySource(text);
      try {
        const exactPath = new URL(`../${historicalPolicyPhysicalPath(path)}`, import.meta.url).pathname;
        interceptedReads.set(exactPath, 0);
        intercepted.set(exactPath, 0);
        expect(read(path)).not.toBe(original);
        expect(sha(read(path))).not.toBe(sha(original));
        expect(() => authenticateNumberPrerequisitePolicyEvolution()).toThrow();
        refused(p);
        expect(() => beforeNumberPrerequisitePolicySource(text)).toThrow();
        expect(interceptedReads.get(exactPath)).toBeGreaterThanOrEqual(6);
      } finally {
        const exactPath = new URL(`../${historicalPolicyPhysicalPath(path)}`, import.meta.url).pathname;
        intercepted.delete(exactPath);
        interceptedReads.delete(exactPath);
      }
      expect(read(path)).toBe(original);
      receipt();
      authenticateNumberPrerequisitePolicy(p);
      beforeNumberPrerequisitePolicy(p);
      beforeNumberPrerequisitePolicySource(text);
    });
  }
  for (const [layerIndex, entryIndex] of [
    [11, 50],
    [11, 51],
    [12, 98],
    [12, 99],
  ] as const) {
    for (const operation of ["delete", "replace", "duplicate", "reorder"] as const)
      it(`rejects each new required entry ${layerIndex}/${entryIndex} ${operation}`, () =>
        rejected((p) => {
          const entries = p.layers[layerIndex]!.entries!;
          if (operation === "delete") entries.splice(entryIndex, 1);
          if (operation === "replace") entries[entryIndex] = "src/unknown.ts";
          if (operation === "duplicate") entries.splice(entryIndex, 0, entries[entryIndex]!);
          if (operation === "reorder") [entries[entryIndex], entries[0]] = [entries[0]!, entries[entryIndex]!];
        }));
  }
  for (const history of [98, 99]) {
    for (const entry of [0, 1]) {
      for (const operation of ["delete", "replace", "duplicate", "reorder"] as const)
        it(`rejects each new activation entry ${history}/${entry} ${operation}`, () =>
          rejected((p) => {
            const entries = p.activationHistory[history]!.entries;
            if (operation === "delete") entries.splice(entry, 1);
            if (operation === "replace") entries[entry] = "src/unknown.ts";
            if (operation === "duplicate") entries.splice(entry, 0, entries[entry]!);
            if (operation === "reorder") entries.reverse();
          }));
    }
  }
  for (const field of [
    "schema",
    "description",
    "sourceRoot",
    "tsconfig",
    "requireGitProvenance",
    "externalAssets",
    "frontendWrapper",
    "moduleExtensions",
    "externalPackages",
    "nonModules",
    "moves",
    "evidence",
  ])
    it(`rejects complete unrelated field ${field} drift`, () =>
      rejected((p) => {
        p[field] = { changed: true };
      }));
  it("captures the complete unknown input before reading a corrupted authority and invokes no getter", () => {
    const p = actual(),
      original = Object.getOwnPropertyDescriptor(p, "evidence")!;
    let calls = 0;
    authenticateNumberPrerequisitePolicy(p);
    const path = new URL(`../${numberPrerequisitePolicyReceiptPath}`, import.meta.url).pathname;
    try {
      Object.defineProperty(p, "evidence", {
        configurable: true,
        enumerable: true,
        get() {
          calls++;
          return original.value;
        },
      });
      expect(Object.hasOwn(Object.getOwnPropertyDescriptor(p, "evidence")!, "value")).toBe(false);
      intercepted.set(path, 0);
      interceptedReads.set(path, 0);
      expect(() => authenticateNumberPrerequisitePolicy(p)).toThrow("accessor or hidden policy field");
      expect(() => beforeNumberPrerequisitePolicy(p)).toThrow("accessor or hidden policy field");
      expect(interceptedReads.get(path)).toBe(0);
      expect(calls).toBe(0);
    } finally {
      Object.defineProperty(p, "evidence", original);
      intercepted.delete(path);
      interceptedReads.delete(path);
    }
    expect(Object.getOwnPropertyDescriptor(p, "evidence")).toEqual(original);
    authenticateNumberPrerequisitePolicy(p);
  });
  it("rejects object-wrapped raw and receipt strings without conversion callbacks", () => {
    let calls = 0;
    const wrapped = {
      toString() {
        calls++;
        return raw();
      },
    };
    expect(() => beforeNumberPrerequisitePolicySource(wrapped as unknown as string)).toThrow();
    expect(() => authenticateNumberPrerequisitePolicyEvolution(wrapped as unknown as string)).toThrow();
    expect(calls).toBe(0);
    accepted();
  });
  it("rejects an extra unknown activation history row", () =>
    rejected((p) => {
      p.activationHistory.push({
        layer: "native-runtime",
        entries: ["src/runtime/wasmgc/values/unknown.ts"],
        minModules: 1,
      });
    }));
});

// C2a controls receive authenticated predecessor bytes; the original Number rows keep their historical input.
describe("C2a exact runtime preparation policy successor", () => {
  const path = "src/ir/runtime/intrinsic-preparation.ts";
  const currentRaw = (): string =>
    captureDynamicCodePredecessorPolicySource(
      captureHostCarrierPredecessorPolicySource(
        captureGeneratorPredecessorPolicySource(
          captureCurrentMainInventoryPredecessorPolicySource(
            captureCanonical3c6PredecessorPolicySource(
              captureCanonical489dPredecessorPolicySource(
                captureNestedStackificationPredecessorPolicySource(
                  captureProgramValidatorPredecessorPolicySource(
                    captureWasmGcHelperPredecessorPolicySource(
                      captureLoweringAnalysisPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  const current = (): Policy => JSON.parse(currentRaw()) as Policy;
  const authority = () => authenticateRuntimePreparationPolicyEvolution();
  const accept = (p: Policy): void => {
    expect(authenticateRuntimePreparationPolicy(p).files).toHaveLength(1776);
  };
  const refuse = (p: unknown): void => {
    expect(() => authenticateRuntimePreparationPolicy(p)).toThrow();
    expect(() => beforeRuntimePreparationPolicy(p)).toThrow();
  };
  const restore = (p: Policy, original: string): void => {
    for (const key of Reflect.ownKeys(p)) expect(Reflect.deleteProperty(p, key)).toBe(true);
    Object.assign(p, JSON.parse(original));
    expect(JSON.stringify(p)).toBe(original);
    accept(p);
  };
  const reject = (change: (p: Policy) => void): void => {
    const p = current(),
      original = JSON.stringify(p);
    accept(p);
    change(p);
    expect(JSON.stringify(p)).not.toBe(original);
    refuse(p);
    restore(p, original);
  };
  function replay(number: Policy): Policy {
    const p = clone(number);
    p.files.push({ path, state: "clean", layer: "ir-runtime" });
    p.layers[8]!.entries!.push(path);
    p.layers[8]!.minModules = 20;
    p.activationHistory.push({ layer: "ir-runtime", entries: [path], minModules: 1 });
    return p;
  }

  it("pins actual complete current bytes, ordered populations and all new full-file authorities", () => {
    const read = readHistoricalPolicyOperand;
    const text = currentRaw(),
      p = current(),
      r = authority();
    expect([Buffer.byteLength(text), sha(text), digest(p)]).toEqual([
      567465,
      "92d653aff02d823339071f24721b803d88da4f31bdbd721859b0ac48b6c9c7f7",
      "28ae111b7b9f0f6eda144d5d57beaf76fd5c7617b474846d39409a56cc196e08",
    ]);
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex"),
    ).toBe("70b280c7cf2a56cbd5cbfa88b484b57414d2ef7c");
    expect([p.files.length, p.activationHistory.length, p.layers.length]).toEqual([1776, 101, 20]);
    expect([
      p.layers[8]!.entries!.length,
      p.layers[8]!.minModules,
      p.files.filter((row) => row.layer === "ir-runtime").length,
    ]).toEqual([20, 20, 20]);
    expect([digest(p.files), digest(p.activationHistory), digest(p.layers), digest(p.allowedEdges)]).toEqual([
      "ca4d9d7d5c999a4e742abd7773d847f1652ca8fe995a491a594fca1e5cf37a1a",
      "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    ]);
    expect([
      Buffer.byteLength(read(runtimePreparationPolicyReceiptPath)),
      sha(read(runtimePreparationPolicyReceiptPath)),
    ]).toEqual([6239, "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca"]);
    expect(r.sourceInputs).toEqual([
      {
        path: "src/ir/intrinsic-support.ts",
        bytes: 850,
        sha256: "584322a7384556a6f3b82dc85cc30c2213510fe70f2cd437ccbef97826156351",
      },
      { path, bytes: 49541, sha256: "bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b" },
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
    ]);
    for (const pin of [...r.sourceInputs, r.numberReceipt]) {
      expect([Buffer.byteLength(read(pin.path)), sha(read(pin.path))]).toEqual([pin.bytes, pin.sha256]);
    }
    const helper = Buffer.from(read("tests/helpers/ir-runtime-program-policy-evolution.ts"));
    expect(createHash("sha256").update(helper.subarray(0, 40368)).digest("hex")).toBe(
      "2b6358379b9f9145b54a5287b6a74f61a89ef9deff215ce6fb21a2174ee1845e",
    );
    frozen(r);
    accept(p);
  });

  it("independently subtracts and replays only three deltas through unchanged Number, WKS, C1 and B", () => {
    const p = current(),
      number = clone(p);
    expect(number.files.pop()).toEqual({ path, state: "clean", layer: "ir-runtime" });
    expect(number.activationHistory.pop()).toEqual({ layer: "ir-runtime", entries: [path], minModules: 1 });
    expect(number.layers[8]!.entries!.pop()).toBe(path);
    number.layers[8]!.minModules = 19;
    expect(digest(number)).toBe("5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21");
    authenticateNumberPrerequisitePolicy(number);
    expect(beforeRuntimePreparationPolicy(p)).toEqual(number);
    expect(replay(number)).toEqual(p);
    const wks = beforeNumberPrerequisitePolicy(number),
      c1 = beforeWellKnownSymbolPolicy(wks),
      b = beforeIrRuntimeProgramPolicy(c1);
    authenticateWellKnownSymbolPolicy(wks);
    authenticateIrRuntimeProgramPolicy(c1);
    authenticateIrValidationPolicy(b);
    for (const old of [number, wks, c1, b]) refuse(old);
    const a = authenticateRuntimePreparationPolicy(p),
      a2 = authenticateRuntimePreparationPolicy(p);
    frozen(a);
    expect(a).not.toBe(p);
    expect(a2).not.toBe(a);
    const n1 = beforeRuntimePreparationPolicy(p),
      n2 = beforeRuntimePreparationPolicy(p);
    expect(n1).not.toBe(n2);
    expect(n1.files[0]).not.toBe(n2.files[0]);
    expect(Object.isFrozen(n1)).toBe(false);
    expect(Object.isFrozen(n1.layers[8]!.entries)).toBe(false);
    expect(p).toEqual(current());
  });

  it("independently applies all three unique raw spans and proves reciprocal bytes and old raw guards", () => {
    const text = currentRaw(),
      r = authority();
    expect(r.raw.spans.map((span) => [span.role, span.beforeOffset, span.afterOffset])).toEqual([
      ["runtime-layer-tail", 6444, 6444],
      ["activation-history-tail", 65731, 65782],
      ["files-tail", 566806, 566983],
    ]);
    const apply = (input: string, forward: boolean): string => {
      let end = 0,
        output = "",
        displacement = 0;
      for (const span of r.raw.spans) {
        expect(span.afterOffset).toBe(span.beforeOffset + displacement);
        const offset = forward ? span.beforeOffset : span.afterOffset,
          from = forward ? span.before : span.after;
        expect(input.indexOf(from)).toBe(offset);
        expect(input.lastIndexOf(from)).toBe(offset);
        expect(offset).toBeGreaterThanOrEqual(end);
        output += input.slice(end, offset) + (forward ? span.after : span.before);
        end = offset + from.length;
        displacement += span.after.length - span.before.length;
      }
      return output + input.slice(end);
    };
    const numberRaw = apply(text, false);
    expect([Buffer.byteLength(numberRaw), sha(numberRaw)]).toEqual([
      567166,
      "8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df",
    ]);
    expect(beforeRuntimePreparationPolicySource(text)).toBe(numberRaw);
    expect(JSON.parse(numberRaw)).toEqual(beforeRuntimePreparationPolicy(current()));
    expect(apply(numberRaw, true)).toBe(text);
    const wksRaw = beforeNumberPrerequisitePolicySource(numberRaw);
    expect(sha(wksRaw)).toBe("451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59");
    expect(sha(beforeWellKnownSymbolPolicySource(wksRaw))).toBe(
      "460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57",
    );
    expect(() => beforeRuntimePreparationPolicySource(numberRaw)).toThrow();
  });

  for (const operation of [
    "file-delete",
    "file-duplicate",
    "file-state",
    "file-layer",
    "file-order",
    "entry-delete",
    "entry-duplicate",
    "entry-order",
    "floor-lower",
    "floor-higher",
    "history-delete",
    "history-extra",
    "history-order",
    "history-change",
    "old-file",
    "old-history",
    "old-layer",
    "edge",
    "unrelated",
    "key-order",
  ] as const)
    it(`rejects C2a ${operation} after success and restores the same object`, () =>
      reject((p) => {
        const layer = p.layers[8]!,
          entries = layer.entries!;
        if (operation === "file-delete") p.files.pop();
        if (operation === "file-duplicate") p.files.push(clone(p.files[1775]!));
        if (operation === "file-state") p.files[1775]!.state = "unmigrated";
        if (operation === "file-layer") p.files[1775]!.layer = "ir-core";
        if (operation === "file-order") [p.files[1774], p.files[1775]] = [p.files[1775]!, p.files[1774]!];
        if (operation === "entry-delete") entries.pop();
        if (operation === "entry-duplicate") entries.push(path);
        if (operation === "entry-order") entries.reverse();
        if (operation === "floor-lower") layer.minModules = 19;
        if (operation === "floor-higher") layer.minModules = 21;
        if (operation === "history-delete") p.activationHistory.pop();
        if (operation === "history-extra") p.activationHistory.push(clone(p.activationHistory[100]!));
        if (operation === "history-order")
          [p.activationHistory[99], p.activationHistory[100]] = [p.activationHistory[100]!, p.activationHistory[99]!];
        if (operation === "history-change") p.activationHistory[100]!.minModules = 2;
        if (operation === "old-file") p.files[0]!.state = "unmigrated";
        if (operation === "old-history") p.activationHistory[0]!.minModules++;
        if (operation === "old-layer") p.layers[0]!.id = "changed";
        if (operation === "edge") p.allowedEdges["ir-core"]!.push("unknown");
        if (operation === "unrelated") p.description = "changed";
        if (operation === "key-order") {
          const schema = p.schema;
          Reflect.deleteProperty(p, "schema");
          p.schema = schema;
        }
      }));

  for (const shape of ["accessor", "hidden", "sparse", "cycle", "function", "symbol", "alias-mutation"] as const)
    it(`captures C2a ${shape} safely after success and reaccepts the restored same object`, () => {
      const p = current(),
        original = JSON.stringify(p);
      accept(p);
      let calls = 0;
      if (shape === "accessor")
        Object.defineProperty(p, "description", {
          configurable: true,
          enumerable: true,
          get() {
            calls++;
            return "changed";
          },
        });
      if (shape === "hidden") Object.defineProperty(p.files[1775]!, "path", { enumerable: false });
      if (shape === "sparse") Reflect.deleteProperty(p.files, "1775");
      if (shape === "cycle") p.cycle = p;
      if (shape === "function")
        p.extra = () => {
          calls++;
          return 1;
        };
      if (shape === "symbol")
        Object.defineProperty(p, Symbol("extra"), { configurable: true, enumerable: true, value: 1 });
      if (shape === "alias-mutation") {
        const alias = p.files[1775]!;
        alias.state = "unmigrated";
      }
      refuse(p);
      expect(calls).toBe(0);
      restore(p, original);
    });

  for (const drift of ["whitespace", "schema", "profile", "span-offset", "span-fragment", "span-order"] as const)
    it(`refuses fixed C2a receipt ${drift}`, () => {
      const p = current();
      accept(p);
      const text = read(runtimePreparationPolicyReceiptPath),
        r = clone(authority());
      if (drift === "schema") r.schema += "changed";
      if (drift === "profile") r.current.source.bytes++;
      if (drift === "span-offset") r.raw.spans[0]!.afterOffset++;
      if (drift === "span-fragment") r.raw.spans[0]!.after += "changed";
      if (drift === "span-order") r.raw.spans.reverse();
      const mutant = drift === "whitespace" ? " " + text : JSON.stringify(r);
      expect(sha(mutant)).not.toBe(sha(text));
      expect(() => authenticateRuntimePreparationPolicyEvolution(mutant)).toThrow("receipt digest mismatch");
      accept(p);
    });

  for (const pin of [
    "src/ir/intrinsic-support.ts",
    path,
    "tests/helpers/ir-runtime-preparation-relocation.json",
    "tests/helpers/ir-runtime-preparation-relocation.ts",
    "tests/helpers/ir-runtime-program-policy-evolution.ts",
    runtimePreparationPolicyReceiptPath,
    numberPrerequisitePolicyReceiptPath,
  ])
    it(`freshly refuses changed C2a authority ${pin} on every public action and restores`, () => {
      const read = readHistoricalPolicyOperand;
      const p = current(),
        text = currentRaw(),
        original = read(pin),
        exact = new URL(`../${historicalPolicyPhysicalPath(pin)}`, import.meta.url).pathname;
      accept(p);
      authority();
      beforeRuntimePreparationPolicy(p);
      beforeRuntimePreparationPolicySource(text);
      try {
        intercepted.set(exact, 0);
        interceptedReads.set(exact, 0);
        expect(read(pin)).not.toBe(original);
        expect(() => authenticateRuntimePreparationPolicyEvolution()).toThrow();
        refuse(p);
        expect(() => beforeRuntimePreparationPolicySource(text)).toThrow();
        expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(5);
      } finally {
        intercepted.delete(exact);
        interceptedReads.delete(exact);
      }
      expect(read(pin)).toBe(original);
      accept(p);
      authority();
      beforeRuntimePreparationPolicy(p);
      beforeRuntimePreparationPolicySource(text);
    });

  for (const index of [0, 1, 2])
    for (const mutation of ["missing", "duplicate", "offset", "fragment"] as const)
      it(`refuses C2a raw span ${index} ${mutation}`, () => {
        const text = currentRaw(),
          span = authority().raw.spans[index]!;
        beforeRuntimePreparationPolicySource(text);
        const at = span.afterOffset;
        const mutant =
          mutation === "missing"
            ? text.slice(0, at) + text.slice(at + span.after.length)
            : mutation === "duplicate"
              ? text.slice(0, at) + span.after + text.slice(at)
              : mutation === "offset"
                ? " " + text
                : text.slice(0, at) + "X" + text.slice(at + 1);
        expect(mutant).not.toBe(text);
        expect(() => beforeRuntimePreparationPolicySource(mutant)).toThrow();
        expect(beforeRuntimePreparationPolicySource(text)).toBe(raw());
      });

  it("refuses nonprimitive C2a raw without conversion and captures descriptors before corrupted authority reads", () => {
    const p = current();
    accept(p);
    let calls = 0;
    expect(() =>
      beforeRuntimePreparationPolicySource({
        toString() {
          calls++;
          return currentRaw();
        },
      } as unknown as string),
    ).toThrow();
    const original = Object.getOwnPropertyDescriptor(p, "description")!;
    const exact = new URL(`../${runtimePreparationPolicyReceiptPath}`, import.meta.url).pathname;
    try {
      Object.defineProperty(p, "description", {
        configurable: true,
        enumerable: true,
        get() {
          calls++;
          return original.value;
        },
      });
      intercepted.set(exact, 0);
      interceptedReads.set(exact, 0);
      expect(() => authenticateRuntimePreparationPolicy(p)).toThrow("accessor or hidden policy field");
      expect(interceptedReads.get(exact)).toBe(0);
      expect(calls).toBe(0);
    } finally {
      Object.defineProperty(p, "description", original);
      intercepted.delete(exact);
      interceptedReads.delete(exact);
    }
    accept(p);
  });

  it("passes a post-capture Number-space mutant to the unchanged Number guard without replacing it", () => {
    const p = current();
    accept(p);
    const number = beforeRuntimePreparationPolicy(p),
      original = JSON.stringify(number);
    authenticateNumberPrerequisitePolicy(number);
    number.files[1771]!.state = "unmigrated";
    expect(() => authenticateNumberPrerequisitePolicy(number)).toThrow("Number prerequisite policy evolution:");
    expect(() => beforeNumberPrerequisitePolicy(number)).toThrow("Number prerequisite policy evolution:");
    expect(number.files[1771]!.state).toBe("unmigrated");
    restore(p, JSON.stringify(p));
    for (const key of Object.keys(number)) Reflect.deleteProperty(number, key);
    Object.assign(number, JSON.parse(original));
    authenticateNumberPrerequisitePolicy(number);
    expect(replay(number)).toEqual(p);
  });
});

// Exact external-main inventory input; these controls never reuse the historical raw readers.
describe("dynamic-code inventory successor preserves the C2a policy proof", () => {
  const latestRaw = (): string =>
    captureHostCarrierPredecessorPolicySource(
      captureGeneratorPredecessorPolicySource(
        captureCurrentMainInventoryPredecessorPolicySource(
          captureCanonical3c6PredecessorPolicySource(
            captureCanonical489dPredecessorPolicySource(
              captureNestedStackificationPredecessorPolicySource(
                captureProgramValidatorPredecessorPolicySource(
                  captureWasmGcHelperPredecessorPolicySource(
                    captureLoweringAnalysisPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  const latest = (): Policy => JSON.parse(latestRaw()) as Policy;
  const added = { path: "src/runtime/dynamic-code-policy.ts", state: "unmigrated", layer: "legacy-host" };
  const arrayRow: Record<string, string> = {
    path: "src/codegen/array-method-arg-order.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  };
  const arrayInsertion =
    '    {\n      "path": "src/codegen/array-method-arg-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n';
  const insertion =
    '    {\n      "path": "src/runtime/dynamic-code-policy.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n';
  const accept = (p: unknown): void => {
    expect(authenticateDynamicCodeInventoryPolicy(p).files).toHaveLength(1778);
  };
  const refuse = (p: unknown): void => {
    expect(() => authenticateDynamicCodeInventoryPolicy(p)).toThrow();
    expect(() => beforeDynamicCodeInventoryPolicy(p)).toThrow();
  };
  const restore = (p: Policy, original: string): void => {
    for (const key of Reflect.ownKeys(p)) expect(Reflect.deleteProperty(p, key)).toBe(true);
    Object.assign(p, JSON.parse(original));
    expect(JSON.stringify(p)).toBe(original);
    accept(p);
  };
  const reject = (edit: (p: Policy) => void): void => {
    const p = latest(),
      original = JSON.stringify(p);
    accept(p);
    edit(p);
    expect(JSON.stringify(p)).not.toBe(original);
    refuse(p);
    restore(p, original);
  };
  it("independently pins the current inventory, fixed authority and reciprocal insertion", () => {
    const read = readHistoricalPolicyOperand;
    const text = latestRaw(),
      p = latest();
    expect(Buffer.byteLength(text)).toBe(567908);
    expect(sha(text)).toBe("5c1c4a16928b421c112eb81180a315d31e116ff442a40375e8c6efb4f220c685");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex"),
    ).toBe("59bdd78821afa174b9273c100a03ec79713249b4");
    expect(digest(p)).toBe("65b382b173594abd15ffdef1a51f96daf017f4d91bd60e47f6308da434ab97b3");
    expect(p.files).toHaveLength(1778);
    expect(p.files[202]).toEqual(arrayRow);
    expect(Object.keys(p.files[202]!)).toEqual(["path", "state", "layer", "destination", "owner", "nextBoundary"]);
    expect(p.files[1404]).toEqual(added);
    expect(Object.keys(p.files[1404]!)).toEqual(["path", "state", "layer"]);
    expect(p.files.filter((row) => row.layer === "legacy-host")).toHaveLength(55);
    expect(p.activationHistory).toHaveLength(101);
    expect(p.layers).toHaveLength(20);
    expect(digest(p.files)).toBe("c306548d8e3f44695a102d10ef8a9503860e39ef6168719f88f874f616563f54");
    expect(digest(p.layers)).toBe("3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7");
    expect(digest(p.activationHistory)).toBe("9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650");
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    const pins = [
      [dynamicCodePolicyReceiptPath, 6159, "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f"],
      [runtimePreparationPolicyReceiptPath, 6239, "3ebfca62d268ca5bcc8b1c461ef6e71b55bd513a5649bf6bce3fe6ee689032ca"],
      [
        "src/codegen/array-method-arg-order.ts",
        6032,
        "9a4527970fd0fd12f7f0fc7210e92a63f64872b143c4d5bc5931ea0f8be03f0b",
      ],
      ["src/runtime/dynamic-code-policy.ts", 3863, "afad7fbda3469347671a99f6564de57d45e135c0dee989da5b6f0c1d249ad5af"],
    ] as const;
    for (const [path, bytes, hash] of pins) {
      const source = read(path);
      expect(Buffer.byteLength(source)).toBe(bytes);
      expect(sha(source)).toBe(hash);
    }
    const prefix = Buffer.from(read("tests/helpers/ir-runtime-program-policy-evolution.ts")).subarray(0, 53693);
    expect(prefix.length).toBe(53693);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe(
      "dd8399e266770753fca08984c4ba33cba9e1486d3243571d988416569cbc981a",
    );
    accept(p);
    const c2aRaw = beforeDynamicCodeInventoryPolicySource(text),
      c2a = beforeDynamicCodeInventoryPolicy(p);
    expect(Buffer.byteLength(c2aRaw)).toBe(567465);
    expect(sha(c2aRaw)).toBe("92d653aff02d823339071f24721b803d88da4f31bdbd721859b0ac48b6c9c7f7");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(c2aRaw)}\0`)
        .update(c2aRaw)
        .digest("hex"),
    ).toBe("70b280c7cf2a56cbd5cbfa88b484b57414d2ef7c");
    expect(digest(c2a.files)).toBe("ca4d9d7d5c999a4e742abd7773d847f1652ca8fe995a491a594fca1e5cf37a1a");
    expect(digest(c2a)).toBe("28ae111b7b9f0f6eda144d5d57beaf76fd5c7617b474846d39409a56cc196e08");
    expect(c2a.files).toHaveLength(1776);
    expect(c2a.files.filter((row) => row.layer === "legacy-host")).toHaveLength(54);
    expect(JSON.parse(c2aRaw)).toEqual(c2a);
    expect(Buffer.byteLength(insertion)).toBe(123);
    expect(c2aRaw.slice(488814).startsWith('    {\n      "path": "src/runtime/dynamic-function-import.ts",')).toBe(
      true,
    );
    expect(Buffer.byteLength(arrayInsertion)).toBe(320);
    expect(c2aRaw.slice(109891).startsWith('    {\n      "path": "src/codegen/array-method-host.ts",')).toBe(true);
    expect(
      c2aRaw.slice(0, 109891) + arrayInsertion + c2aRaw.slice(109891, 488814) + insertion + c2aRaw.slice(488814),
    ).toBe(text);
    const replay = clone(c2a);
    replay.files.splice(202, 0, { ...arrayRow });
    replay.files.splice(1404, 0, { ...added });
    expect(replay).toEqual(p);
    expect(authenticateRuntimePreparationPolicy(c2a).files).toHaveLength(1776);
    const number = beforeRuntimePreparationPolicy(c2a);
    authenticateNumberPrerequisitePolicy(number);
    const wks = beforeNumberPrerequisitePolicy(number);
    authenticateWellKnownSymbolPolicy(wks);
    const c1 = beforeWellKnownSymbolPolicy(wks);
    authenticateIrRuntimeProgramPolicy(c1);
    authenticateIrValidationPolicy(beforeIrRuntimeProgramPolicy(c1));
    expect(beforeRuntimePreparationPolicySource(c2aRaw)).toBe(raw());
  });

  const mutations: readonly [string, (p: Policy) => void][] = [
    [
      "missing row",
      (p) => {
        p.files.splice(1404, 1);
      },
    ],
    [
      "duplicate row",
      (p) => {
        p.files.splice(1404, 0, { ...added });
      },
    ],
    [
      "moved row",
      (p) => {
        const row = p.files.splice(1404, 1)[0]!;
        p.files.splice(1405, 0, row);
      },
    ],
    [
      "path",
      (p) => {
        p.files[1404]!.path = "src/runtime/wrong.ts";
      },
    ],
    [
      "state",
      (p) => {
        p.files[1404]!.state = "clean";
      },
    ],
    [
      "layer",
      (p) => {
        p.files[1404]!.layer = "ir-runtime";
      },
    ],
    [
      "extra field",
      (p) => {
        p.files[1404]!.extra = "changed";
      },
    ],
    [
      "previous neighbor",
      (p) => {
        p.files[1403]!.path += ".changed";
      },
    ],
    [
      "next neighbor",
      (p) => {
        p.files[1405]!.state = "clean";
      },
    ],
    [
      "retained prefix",
      (p) => {
        p.files[0]!.state = "changed";
      },
    ],
    [
      "unrelated layer",
      (p) => {
        p.layers[0]!.roots.push("src/unreviewed");
      },
    ],
    [
      "activation",
      (p) => {
        p.activationHistory[0]!.minModules++;
      },
    ],
    [
      "allowed edge",
      (p) => {
        p.allowedEdges.unreviewed = ["legacy-host"];
      },
    ],
    [
      "top level",
      (p) => {
        p.description = "changed";
      },
    ],
  ];
  it.each(mutations)("rejects changed inventory %s after success and restores the same object", (_name, edit) =>
    reject(edit),
  );
  const arrayMutations: readonly [string, (p: Policy) => void][] = [
    [
      "missing",
      (p) => {
        p.files.splice(202, 1);
      },
    ],
    [
      "duplicate",
      (p) => {
        p.files.splice(202, 0, { ...arrayRow });
      },
    ],
    [
      "moved",
      (p) => {
        const row = p.files.splice(202, 1)[0]!;
        p.files.splice(203, 0, row);
      },
    ],
    ...["path", "state", "layer", "destination", "owner", "nextBoundary"].map(
      (field): [string, (p: Policy) => void] => [
        field,
        (p) => {
          p.files[202]![field] += ".changed";
        },
      ],
    ),
    [
      "extra field",
      (p) => {
        p.files[202]!.extra = "changed";
      },
    ],
    [
      "schema order",
      (p) => {
        p.files[202] = Object.fromEntries(Object.entries(p.files[202]!).reverse());
      },
    ],
    [
      "previous neighbor",
      (p) => {
        p.files[201]!.path += ".changed";
      },
    ],
    [
      "next neighbor",
      (p) => {
        p.files[203]!.state = "clean";
      },
    ],
    [
      "swapped additions",
      (p) => {
        [p.files[202], p.files[1404]] = [p.files[1404]!, p.files[202]!];
      },
    ],
    [
      "wrong replay position",
      (p) => {
        const row = p.files.splice(1404, 1)[0]!;
        p.files.splice(1403, 0, row);
      },
    ],
  ];
  it.each(arrayMutations)("rejects array successor %s with both old-space neighbors retained", (_name, edit) =>
    reject(edit),
  );

  for (const shape of [
    "accessor",
    "hidden",
    "symbol",
    "prototype",
    "sparse",
    "array-extra",
    "cycle",
    "literal-proto",
    "toJSON",
  ] as const)
    it(`captures successor ${shape} without caller execution before corrupted authority reads`, () => {
      const p = latest(),
        original = JSON.stringify(p);
      accept(p);
      let calls = 0;
      if (shape === "accessor")
        Object.defineProperty(p, "description", {
          configurable: true,
          enumerable: true,
          get() {
            calls++;
            return "changed";
          },
        });
      if (shape === "hidden") Object.defineProperty(p.files[1404]!, "path", { enumerable: false });
      if (shape === "symbol")
        Object.defineProperty(p, Symbol("extra"), { configurable: true, enumerable: true, value: 1 });
      if (shape === "prototype") Object.setPrototypeOf(p.files[1404]!, { inherited: true });
      if (shape === "sparse") Reflect.deleteProperty(p.files, "1404");
      if (shape === "array-extra")
        Object.defineProperty(p.files, "extra", { configurable: true, enumerable: true, value: 1 });
      if (shape === "cycle") p.extra = p;
      if (shape === "literal-proto")
        Object.defineProperty(p, "__proto__", { configurable: true, enumerable: true, value: { data: true } });
      if (shape === "toJSON")
        p.toJSON = () => {
          calls++;
          return latest();
        };
      if (shape === "literal-proto") refuse(p);
      const exact = new URL(`../${dynamicCodePolicyReceiptPath}`, import.meta.url).pathname;
      try {
        intercepted.set(exact, 0);
        interceptedReads.set(exact, 0);
        refuse(p);
        // Descriptor-invalid values stop before I/O; literal data reaches profile authentication.
        if (shape !== "literal-proto") expect(interceptedReads.get(exact)).toBe(0);
        expect(calls).toBe(0);
      } finally {
        intercepted.delete(exact);
        interceptedReads.delete(exact);
      }
      restore(p, original);
    });

  it("returns detached frozen current and fresh mutable predecessor without a successful-object cache", () => {
    const p = latest();
    accept(p);
    const frozen = authenticateDynamicCodeInventoryPolicy(p),
      first = beforeDynamicCodeInventoryPolicy(p),
      second = beforeDynamicCodeInventoryPolicy(p);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.files)).toBe(true);
    expect(Object.isFrozen(frozen.files[1404])).toBe(true);
    expect(first).not.toBe(second);
    expect(first.files).not.toBe(second.files);
    p.files[1404]!.state = "clean";
    expect(frozen.files[1404]!.state).toBe("unmigrated");
    refuse(p);
    p.files[1404]!.state = "unmigrated";
    accept(p);
  });
  it("keeps predecessor mutants in the unchanged C2a guard and refuses either cross-domain input", () => {
    const p = latest();
    accept(p);
    expect(() => authenticateRuntimePreparationPolicy(p)).toThrow("runtime preparation policy evolution:");
    const c2a = beforeDynamicCodeInventoryPolicy(p),
      original = JSON.stringify(c2a);
    authenticateRuntimePreparationPolicy(c2a);
    refuse(c2a);
    expect(() => beforeDynamicCodeInventoryPolicySource(JSON.stringify(c2a))).toThrow();
    c2a.files[1775]!.state = "unmigrated";
    expect(() => authenticateRuntimePreparationPolicy(c2a)).toThrow("runtime preparation policy evolution:");
    expect(() => beforeRuntimePreparationPolicy(c2a)).toThrow("runtime preparation policy evolution:");
    expect(c2a.files[1775]!.state).toBe("unmigrated");
    Object.assign(c2a, JSON.parse(original));
    authenticateRuntimePreparationPolicy(c2a);
  });
  it.each(["whitespace", "offset", "missing", "duplicate", "fragment"] as const)(
    "refuses exact raw %s drift",
    (change) => {
      const text = latestRaw();
      beforeDynamicCodeInventoryPolicySource(text);
      const at = 489134;
      const mutant =
        change === "whitespace"
          ? text + "\n"
          : change === "offset"
            ? " " + text
            : change === "missing"
              ? text.slice(0, at) + text.slice(at + insertion.length)
              : change === "duplicate"
                ? text.slice(0, at) + insertion + text.slice(at)
                : text.slice(0, at) + "X" + text.slice(at + 1);
      expect(mutant).not.toBe(text);
      expect(() => beforeDynamicCodeInventoryPolicySource(mutant)).toThrow();
      beforeDynamicCodeInventoryPolicySource(text);
    },
  );
  it.each(["missing", "duplicate", "fragment", "swapped spans", "stale offset"] as const)(
    "refuses two-span array/raw %s confusion",
    (change) => {
      const text = latestRaw();
      beforeDynamicCodeInventoryPolicySource(text);
      const at = 109891;
      const mutant =
        change === "missing"
          ? text.slice(0, at) + text.slice(at + arrayInsertion.length)
          : change === "duplicate"
            ? text.slice(0, at) + arrayInsertion + text.slice(at)
            : change === "fragment"
              ? text.slice(0, at) + "X" + text.slice(at + 1)
              : change === "stale offset"
                ? text.slice(0, 488814) + insertion + text.slice(488814 + insertion.length)
                : text.slice(0, at) +
                  insertion +
                  text.slice(at + arrayInsertion.length, 489134) +
                  arrayInsertion +
                  text.slice(489134 + insertion.length);
      expect(mutant).not.toBe(text);
      expect(() => beforeDynamicCodeInventoryPolicySource(mutant)).toThrow();
      beforeDynamicCodeInventoryPolicySource(text);
    },
  );
  it("refuses the exact former one-row successor instead of selecting a historical domain", () => {
    const text = latestRaw();
    beforeDynamicCodeInventoryPolicySource(text);
    const staleRaw = text.slice(0, 109891) + text.slice(109891 + arrayInsertion.length);
    expect(Buffer.byteLength(staleRaw)).toBe(567588);
    expect(sha(staleRaw)).toBe("070df5fc6f40a164643ea8f9474de5264adee2d588a81afd3b6010620a398c0d");
    const stale = JSON.parse(staleRaw) as Policy;
    expect(stale.files).toHaveLength(1777);
    refuse(stale);
    expect(() => beforeDynamicCodeInventoryPolicySource(staleRaw)).toThrow();
    accept(latest());
  });
  it("refuses wrapped strings without invoking conversion", () => {
    accept(latest());
    let calls = 0;
    const wrapped = Object(latestRaw());
    wrapped.toString = () => {
      calls++;
      return latestRaw();
    };
    expect(() => beforeDynamicCodeInventoryPolicySource(wrapped)).toThrow("raw input must be a primitive string");
    expect(() => authenticateDynamicCodePolicyEvolution(wrapped)).toThrow("receipt digest mismatch");
    expect(calls).toBe(0);
  });
  it.each(["whitespace", "schema", "profile", "span-offset", "span-fragment"] as const)(
    "refuses immutable dynamic receipt %s",
    (change) => {
      accept(latest());
      const text = read(dynamicCodePolicyReceiptPath),
        authority = clone(authenticateDynamicCodePolicyEvolution());
      if (change === "schema") authority.schema += "changed";
      if (change === "profile") authority.current.fileCount++;
      if (change === "span-offset") authority.additions[1]!.rawSpan.afterOffset++;
      if (change === "span-fragment") authority.additions[1]!.rawSpan.after += "changed";
      const mutant = change === "whitespace" ? text + "\n" : JSON.stringify(authority);
      expect(mutant).not.toBe(text);
      expect(() => authenticateDynamicCodePolicyEvolution(mutant)).toThrow("receipt digest mismatch");
    },
  );
  it.each(["membership", "record order", "source pin", "array schema", "span offset", "span swap"] as const)(
    "refuses changed fixed two-addition receipt %s",
    (change) => {
      accept(latest());
      const receipt = clone(authenticateDynamicCodePolicyEvolution());
      if (change === "membership") receipt.additions.pop();
      if (change === "record order") receipt.additions.reverse();
      if (change === "source pin") receipt.additions[0]!.sourcePin.sha256 = "0".repeat(64);
      if (change === "array schema") receipt.additions[0]!.row.owner = "changed";
      if (change === "span offset") receipt.additions[1]!.rawSpan.afterOffset = 488814;
      if (change === "span swap")
        [receipt.additions[0]!.rawSpan, receipt.additions[1]!.rawSpan] = [
          receipt.additions[1]!.rawSpan,
          receipt.additions[0]!.rawSpan,
        ];
      expect(() => authenticateDynamicCodePolicyEvolution(JSON.stringify(receipt))).toThrow("receipt digest mismatch");
    },
  );
  it.each([
    dynamicCodePolicyReceiptPath,
    runtimePreparationPolicyReceiptPath,
    "tests/helpers/ir-runtime-program-policy-evolution.ts",
    "src/runtime/dynamic-code-policy.ts",
    "src/codegen/array-method-arg-order.ts",
  ])("recaptures changed successor authority %s after success and restores", (path) => {
    const read = readHistoricalPolicyOperand;
    const p = latest(),
      text = latestRaw(),
      original = read(path),
      exact = new URL(`../${historicalPolicyPhysicalPath(path)}`, import.meta.url).pathname;
    accept(p);
    authenticateDynamicCodePolicyEvolution();
    beforeDynamicCodeInventoryPolicy(p);
    beforeDynamicCodeInventoryPolicySource(text);
    try {
      intercepted.set(exact, 0);
      interceptedReads.set(exact, 0);
      expect(read(path)).not.toBe(original);
      expect(() => authenticateDynamicCodePolicyEvolution()).toThrow();
      refuse(p);
      expect(() => beforeDynamicCodeInventoryPolicySource(text)).toThrow();
      expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(5);
    } finally {
      intercepted.delete(exact);
      interceptedReads.delete(exact);
    }
    expect(read(path)).toBe(original);
    accept(p);
    authenticateDynamicCodePolicyEvolution();
    beforeDynamicCodeInventoryPolicy(p);
    beforeDynamicCodeInventoryPolicySource(text);
  });
});

// Direct current-main controls; earlier Number/C2a/two-row readers keep their exact domains.
describe("host-carrier current-main inventory successor", () => {
  const hostRaw = (): string =>
    captureGeneratorPredecessorPolicySource(
      captureCurrentMainInventoryPredecessorPolicySource(
        captureCanonical3c6PredecessorPolicySource(
          captureCanonical489dPredecessorPolicySource(
            captureNestedStackificationPredecessorPolicySource(
              captureProgramValidatorPredecessorPolicySource(
                captureWasmGcHelperPredecessorPolicySource(
                  captureLoweringAnalysisPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  const hostPolicy = (): Policy => JSON.parse(hostRaw()) as Policy;
  const row: Record<string, string> = {
    path: "src/codegen/host-carrier-to-primitive.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  };
  const insertion =
    '    {\n      "path": "src/codegen/host-carrier-to-primitive.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n';
  const accept = (p: unknown): void => {
    expect(authenticateHostCarrierInventoryPolicy(p).files).toHaveLength(1779);
  };
  const refuse = (p: unknown): void => {
    expect(() => authenticateHostCarrierInventoryPolicy(p)).toThrow();
    expect(() => beforeHostCarrierInventoryPolicy(p)).toThrow();
  };
  const restore = (p: Policy, original: string): void => {
    for (const key of Reflect.ownKeys(p)) expect(Reflect.deleteProperty(p, key)).toBe(true);
    Object.assign(p, JSON.parse(original));
    expect(JSON.stringify(p)).toBe(original);
    accept(p);
  };
  const reject = (edit: (p: Policy) => void): void => {
    const p = hostPolicy(),
      original = JSON.stringify(p);
    accept(p);
    edit(p);
    expect(JSON.stringify(p)).not.toBe(original);
    refuse(p);
    restore(p, original);
  };
  it("independently pins current-main bytes and debt row and replays its exact predecessor", () => {
    const read = readHistoricalPolicyOperand;
    const text = hostRaw(),
      p = hostPolicy();
    expect(Buffer.byteLength(text)).toBe(568231);
    expect(sha(text)).toBe("f3af1f31d813eaef9bd2b955466390616e9549f36e1e7ffffdcead812a611ac3");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex"),
    ).toBe("d61ee74048fa3d16c2986fd3e448d234f4e5594b");
    expect(digest(p)).toBe("89780e5ff7c660518ca92981369dab0e341b77e55f02f8e23d2312b615a97856");
    expect(p.files).toHaveLength(1779);
    expect(digest(p.files)).toBe("ced3f8116817be3978f55f438b657ca6b36ec8d50827db92bd7d708c2940853b");
    expect(p.files[605]).toEqual(row);
    expect(Object.keys(p.files[605]!)).toEqual(["path", "state", "layer", "destination", "owner", "nextBoundary"]);
    expect(p.files[604]!.path).toBe("src/codegen/host-bridge-exports.ts");
    expect(p.files[606]!.path).toBe("src/codegen/host-fnctor-method-driver.ts");
    expect(p.layers).toHaveLength(20);
    expect(p.activationHistory).toHaveLength(101);
    expect(digest(p.layers)).toBe("3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7");
    expect(digest(p.activationHistory)).toBe("9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650");
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    for (const [path, bytes, hash] of [
      [hostCarrierPolicyReceiptPath, 4673, "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583"],
      [dynamicCodePolicyReceiptPath, 6159, "785ef0a740ac17ba636bb75b15cf4eed2266ac4ca0ec588e1eb4cff3642a708f"],
      [
        "src/codegen/host-carrier-to-primitive.ts",
        14025,
        "6f74bd8c4b97789a1dbfe92dc18dd6e71e11860b0e8efd913c523bca032ce504",
      ],
    ] as const) {
      const source = read(path);
      expect(Buffer.byteLength(source)).toBe(bytes);
      expect(sha(source)).toBe(hash);
    }
    const prefix = Buffer.from(read("tests/helpers/ir-runtime-program-policy-evolution.ts")).subarray(0, 68822);
    expect(prefix.length).toBe(68822);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe(
      "90dce1410780cf924e78bdd4086be5b1b8c35cdbeb676c46126ac7e0f5f47c5c",
    );
    accept(p);
    const twoRaw = beforeHostCarrierInventoryPolicySource(text),
      two = beforeHostCarrierInventoryPolicy(p);
    expect(Buffer.byteLength(twoRaw)).toBe(567908);
    expect(sha(twoRaw)).toBe("5c1c4a16928b421c112eb81180a315d31e116ff442a40375e8c6efb4f220c685");
    expect(two.files).toHaveLength(1778);
    expect(digest(two)).toBe("65b382b173594abd15ffdef1a51f96daf017f4d91bd60e47f6308da434ab97b3");
    expect(JSON.parse(twoRaw)).toEqual(two);
    expect(Buffer.byteLength(insertion)).toBe(323);
    expect(twoRaw.slice(239710).startsWith('    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",')).toBe(
      true,
    );
    expect(twoRaw.slice(0, 239710) + insertion + twoRaw.slice(239710)).toBe(text);
    const replay = clone(two);
    replay.files.splice(605, 0, { ...row });
    expect(replay).toEqual(p);
    authenticateDynamicCodeInventoryPolicy(two);
    const c2a = beforeDynamicCodeInventoryPolicy(two);
    authenticateRuntimePreparationPolicy(c2a);
    const number = beforeRuntimePreparationPolicy(c2a);
    authenticateNumberPrerequisitePolicy(number);
    const wks = beforeNumberPrerequisitePolicy(number);
    authenticateWellKnownSymbolPolicy(wks);
    const c1 = beforeWellKnownSymbolPolicy(wks);
    authenticateIrRuntimeProgramPolicy(c1);
    authenticateIrValidationPolicy(beforeIrRuntimeProgramPolicy(c1));
    beforeDynamicCodeInventoryPolicySource(twoRaw);
  });
  const mutations: readonly [string, (p: Policy) => void][] = [
    [
      "missing",
      (p) => {
        p.files.splice(605, 1);
      },
    ],
    [
      "duplicate",
      (p) => {
        p.files.splice(605, 0, { ...row });
      },
    ],
    [
      "moved",
      (p) => {
        const moved = p.files.splice(605, 1)[0]!;
        p.files.splice(606, 0, moved);
      },
    ],
    ...["path", "state", "layer", "destination", "owner", "nextBoundary"].map(
      (field): [string, (p: Policy) => void] => [
        field,
        (p) => {
          p.files[605]![field] += ".changed";
        },
      ],
    ),
    [
      "extra field",
      (p) => {
        p.files[605]!.extra = "changed";
      },
    ],
    [
      "previous neighbor",
      (p) => {
        p.files[604]!.path += ".changed";
      },
    ],
    [
      "next neighbor",
      (p) => {
        p.files[606]!.state = "clean";
      },
    ],
    [
      "retained prefix",
      (p) => {
        p.files[0]!.state = "changed";
      },
    ],
    [
      "unrelated layer",
      (p) => {
        p.layers[0]!.roots.push("src/unreviewed");
      },
    ],
    [
      "activation",
      (p) => {
        p.activationHistory[0]!.minModules++;
      },
    ],
    [
      "allowed edge",
      (p) => {
        p.allowedEdges.unreviewed = ["legacy-host"];
      },
    ],
    [
      "top level",
      (p) => {
        p.description = "changed";
      },
    ],
  ];
  it.each(mutations)("refuses host-carrier inventory %s after success and restores", (_label, edit) => reject(edit));
  it.each(["whitespace", "offset", "missing", "duplicate", "fragment"] as const)(
    "refuses host-carrier raw %s",
    (change) => {
      const text = hostRaw();
      beforeHostCarrierInventoryPolicySource(text);
      const at = 239710;
      const mutant =
        change === "whitespace"
          ? text + "\n"
          : change === "offset"
            ? " " + text
            : change === "missing"
              ? text.slice(0, at) + text.slice(at + insertion.length)
              : change === "duplicate"
                ? text.slice(0, at) + insertion + text.slice(at)
                : text.slice(0, at) + "X" + text.slice(at + 1);
      expect(mutant).not.toBe(text);
      expect(() => beforeHostCarrierInventoryPolicySource(mutant)).toThrow();
      beforeHostCarrierInventoryPolicySource(text);
    },
  );
  it.each(["accessor", "hidden", "symbol", "prototype", "cycle", "toJSON"] as const)(
    "captures host-carrier %s before authority I/O or caller execution",
    (shape) => {
      const p = hostPolicy(),
        original = JSON.stringify(p);
      accept(p);
      let calls = 0;
      if (shape === "accessor")
        Object.defineProperty(p, "description", {
          configurable: true,
          enumerable: true,
          get() {
            calls++;
            return "changed";
          },
        });
      if (shape === "hidden") Object.defineProperty(p.files[605]!, "path", { enumerable: false });
      if (shape === "symbol")
        Object.defineProperty(p, Symbol("extra"), { configurable: true, enumerable: true, value: 1 });
      if (shape === "prototype") Object.setPrototypeOf(p.files[605]!, { inherited: true });
      if (shape === "cycle") p.extra = p;
      if (shape === "toJSON")
        p.toJSON = () => {
          calls++;
          return hostPolicy();
        };
      const exact = new URL(`../${hostCarrierPolicyReceiptPath}`, import.meta.url).pathname;
      try {
        intercepted.set(exact, 0);
        interceptedReads.set(exact, 0);
        refuse(p);
        expect(interceptedReads.get(exact)).toBe(0);
        expect(calls).toBe(0);
      } finally {
        intercepted.delete(exact);
        interceptedReads.delete(exact);
      }
      restore(p, original);
    },
  );
  it("returns detached frozen current and recaptures the same changed object", () => {
    const p = hostPolicy(),
      original = JSON.stringify(p);
    accept(p);
    const frozen = authenticateHostCarrierInventoryPolicy(p),
      first = beforeHostCarrierInventoryPolicy(p),
      second = beforeHostCarrierInventoryPolicy(p);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.files[605])).toBe(true);
    expect(first).not.toBe(second);
    expect(first.files).not.toBe(second.files);
    p.files[605]!.state = "clean";
    expect(frozen.files[605]!.state).toBe("unmigrated");
    refuse(p);
    restore(p, original);
  });
  it("refuses predecessor domains and sends a captured two-row mutant to the unchanged guard", () => {
    const p = hostPolicy();
    accept(p);
    expect(() => authenticateDynamicCodeInventoryPolicy(p)).toThrow("dynamic code inventory policy evolution:");
    expect(() => beforeDynamicCodeInventoryPolicySource(hostRaw())).toThrow("dynamic code inventory policy evolution:");
    const twoRaw = beforeHostCarrierInventoryPolicySource(hostRaw()),
      two = beforeHostCarrierInventoryPolicy(p),
      original = JSON.stringify(two);
    authenticateDynamicCodeInventoryPolicy(two);
    refuse(two);
    expect(() => beforeHostCarrierInventoryPolicySource(twoRaw)).toThrow();
    const c2a = beforeDynamicCodeInventoryPolicy(two);
    refuse(c2a);
    expect(() => beforeHostCarrierInventoryPolicySource(beforeDynamicCodeInventoryPolicySource(twoRaw))).toThrow();
    two.files[202]!.state = "clean";
    expect(() => authenticateDynamicCodeInventoryPolicy(two)).toThrow("dynamic code inventory policy evolution:");
    expect(() => beforeDynamicCodeInventoryPolicy(two)).toThrow("dynamic code inventory policy evolution:");
    expect(two.files[202]!.state).toBe("clean");
    Object.assign(two, JSON.parse(original));
    authenticateDynamicCodeInventoryPolicy(two);
  });
  it("refuses wrapped source strings before conversion", () => {
    accept(hostPolicy());
    let calls = 0;
    const wrapped = Object(hostRaw());
    wrapped.toString = () => {
      calls++;
      return hostRaw();
    };
    expect(() => beforeHostCarrierInventoryPolicySource(wrapped)).toThrow("raw input must be a primitive string");
    expect(() => authenticateHostCarrierPolicyEvolution(wrapped)).toThrow("receipt digest mismatch");
    expect(calls).toBe(0);
  });
  it.each(["whitespace", "schema", "profile", "span"] as const)(
    "refuses immutable host-carrier receipt %s",
    (change) => {
      accept(hostPolicy());
      const text = read(hostCarrierPolicyReceiptPath),
        receipt = clone(authenticateHostCarrierPolicyEvolution());
      if (change === "schema") receipt.schema += ".changed";
      if (change === "profile") receipt.current.fileCount++;
      if (change === "span") receipt.addition.rawSpan.afterOffset++;
      const mutant = change === "whitespace" ? text + "\n" : JSON.stringify(receipt);
      expect(mutant).not.toBe(text);
      expect(() => authenticateHostCarrierPolicyEvolution(mutant)).toThrow("receipt digest mismatch");
    },
  );
  it.each([
    hostCarrierPolicyReceiptPath,
    dynamicCodePolicyReceiptPath,
    "tests/helpers/ir-runtime-program-policy-evolution.ts",
    "src/codegen/host-carrier-to-primitive.ts",
  ])("recaptures changed host-carrier authority %s after success", (path) => {
    const read = readHistoricalPolicyOperand;
    const p = hostPolicy(),
      text = hostRaw(),
      original = read(path),
      exact = new URL(`../${historicalPolicyPhysicalPath(path)}`, import.meta.url).pathname;
    accept(p);
    authenticateHostCarrierPolicyEvolution();
    beforeHostCarrierInventoryPolicy(p);
    beforeHostCarrierInventoryPolicySource(text);
    try {
      intercepted.set(exact, 0);
      interceptedReads.set(exact, 0);
      expect(read(path)).not.toBe(original);
      expect(() => authenticateHostCarrierPolicyEvolution()).toThrow();
      refuse(p);
      expect(() => beforeHostCarrierInventoryPolicySource(text)).toThrow();
      expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(5);
    } finally {
      intercepted.delete(exact);
      interceptedReads.delete(exact);
    }
    expect(read(path)).toBe(original);
    accept(p);
    authenticateHostCarrierPolicyEvolution();
    beforeHostCarrierInventoryPolicy(p);
    beforeHostCarrierInventoryPolicySource(text);
  });
});

// Direct generator-current input; all prior control blocks retain their exact captured domains.
describe("generator eager-refusal current-main inventory successor", () => {
  const generatorRaw = (): string =>
    captureCurrentMainInventoryPredecessorPolicySource(
      captureCanonical3c6PredecessorPolicySource(
        captureCanonical489dPredecessorPolicySource(
          captureNestedStackificationPredecessorPolicySource(
            captureProgramValidatorPredecessorPolicySource(
              captureWasmGcHelperPredecessorPolicySource(
                captureLoweringAnalysisPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
              ),
            ),
          ),
        ),
      ),
    );
  const generatorPolicy = (): Policy => JSON.parse(generatorRaw()) as Policy;
  const row: Record<string, string> = {
    path: "src/codegen/generator-eager-refusal.ts",
    state: "unmigrated",
    layer: "mixed-needs-split",
    destination: "backend-wasmgc",
    owner: "3518-coordinator",
    nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
  };
  const insertion =
    '    {\n      "path": "src/codegen/generator-eager-refusal.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n';
  const accept = (p: unknown): void => {
    expect(authenticateGeneratorInventoryPolicy(p).files).toHaveLength(1780);
  };
  const refuse = (p: unknown): void => {
    expect(() => authenticateGeneratorInventoryPolicy(p)).toThrow();
    expect(() => beforeGeneratorInventoryPolicy(p)).toThrow();
  };
  const restore = (p: Policy, original: string): void => {
    for (const key of Reflect.ownKeys(p)) expect(Reflect.deleteProperty(p, key)).toBe(true);
    Object.assign(p, JSON.parse(original));
    expect(JSON.stringify(p)).toBe(original);
    accept(p);
  };
  const reject = (edit: (p: Policy) => void): void => {
    const p = generatorPolicy(),
      original = JSON.stringify(p);
    accept(p);
    edit(p);
    expect(JSON.stringify(p)).not.toBe(original);
    refuse(p);
    restore(p, original);
  };
  it("independently pins the generator current profile and exact reciprocal host predecessor", () => {
    const read = readHistoricalPolicyOperand;
    const text = generatorRaw(),
      p = generatorPolicy();
    expect(Buffer.byteLength(text)).toBe(568552);
    expect(sha(text)).toBe("64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex"),
    ).toBe("b9b8b1787cc202906c4e76cebc598cf460a7f0ae");
    expect(digest(p)).toBe("2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6");
    expect(p.files).toHaveLength(1780);
    expect(digest(p.files)).toBe("bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6");
    expect(p.files[1615]).toEqual(row);
    expect(Object.keys(p.files[1615]!)).toEqual(["path", "state", "layer", "destination", "owner", "nextBoundary"]);
    expect(p.files[1614]!.path).toBe("src/codegen/fnctor-instance-names.ts");
    expect(p.files[1616]!.path).toBe("src/codegen/generator-function-dynamic.ts");
    expect(p.layers).toHaveLength(20);
    expect(p.activationHistory).toHaveLength(101);
    expect(digest(p.layers)).toBe("3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7");
    expect(digest(p.activationHistory)).toBe("9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650");
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    for (const [path, bytes, hash] of [
      [generatorInventoryPolicyReceiptPath, 4693, "5d78bc26201d43531d1a299d42f0ac0ae91a638de71620b94f675378572ccc8c"],
      [hostCarrierPolicyReceiptPath, 4673, "30c0912d7868e4da44c083243bb68073e48e70e7eb4b26dbc1b1e73090a5f583"],
      [
        "src/codegen/generator-eager-refusal.ts",
        10619,
        "b44d14368759f11f18b11d75d2a5abb93fc448e0dc5cb7d8501eb0afe6272535",
      ],
    ] as const) {
      const source = read(path);
      expect(Buffer.byteLength(source)).toBe(bytes);
      expect(sha(source)).toBe(hash);
    }
    const prefix = Buffer.from(read("tests/helpers/ir-runtime-program-policy-evolution.ts")).subarray(0, 80917);
    expect(prefix.length).toBe(80917);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe(
      "2d33fdce750f57d745344fe9c08ecfdd2236bafaca48935bb2376f57255fce8f",
    );
    accept(p);
    const hostText = beforeGeneratorInventoryPolicySource(text),
      host = beforeGeneratorInventoryPolicy(p);
    expect(Buffer.byteLength(hostText)).toBe(568231);
    expect(sha(hostText)).toBe("f3af1f31d813eaef9bd2b955466390616e9549f36e1e7ffffdcead812a611ac3");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(hostText)}\0`)
        .update(hostText)
        .digest("hex"),
    ).toBe("d61ee74048fa3d16c2986fd3e448d234f4e5594b");
    expect(host.files).toHaveLength(1779);
    expect(digest(host)).toBe("89780e5ff7c660518ca92981369dab0e341b77e55f02f8e23d2312b615a97856");
    expect(JSON.parse(hostText)).toEqual(host);
    expect(Buffer.byteLength(insertion)).toBe(321);
    expect(hostText.slice(529175).startsWith('    {\n      "path": "src/codegen/generator-function-dynamic.ts",')).toBe(
      true,
    );
    expect(hostText.slice(0, 529175) + insertion + hostText.slice(529175)).toBe(text);
    const replay = clone(host);
    replay.files.splice(1615, 0, { ...row });
    expect(replay).toEqual(p);
    authenticateHostCarrierInventoryPolicy(host);
    const two = beforeHostCarrierInventoryPolicy(host);
    authenticateDynamicCodeInventoryPolicy(two);
    const c2a = beforeDynamicCodeInventoryPolicy(two);
    authenticateRuntimePreparationPolicy(c2a);
    const number = beforeRuntimePreparationPolicy(c2a);
    authenticateNumberPrerequisitePolicy(number);
    const wks = beforeNumberPrerequisitePolicy(number);
    authenticateWellKnownSymbolPolicy(wks);
    const c1 = beforeWellKnownSymbolPolicy(wks);
    authenticateIrRuntimeProgramPolicy(c1);
    authenticateIrValidationPolicy(beforeIrRuntimeProgramPolicy(c1));
    beforeHostCarrierInventoryPolicySource(hostText);
  });
  const mutations: readonly [string, (p: Policy) => void][] = [
    [
      "missing",
      (p) => {
        p.files.splice(1615, 1);
      },
    ],
    [
      "duplicate",
      (p) => {
        p.files.splice(1615, 0, { ...row });
      },
    ],
    [
      "moved",
      (p) => {
        const moved = p.files.splice(1615, 1)[0]!;
        p.files.splice(1616, 0, moved);
      },
    ],
    ...["path", "state", "layer", "destination", "owner", "nextBoundary"].map(
      (field): [string, (p: Policy) => void] => [
        field,
        (p) => {
          p.files[1615]![field] += ".changed";
        },
      ],
    ),
    [
      "extra field",
      (p) => {
        p.files[1615]!.extra = "changed";
      },
    ],
    [
      "previous neighbor",
      (p) => {
        p.files[1614]!.path += ".changed";
      },
    ],
    [
      "next neighbor",
      (p) => {
        p.files[1616]!.state = "clean";
      },
    ],
    [
      "retained row",
      (p) => {
        p.files[0]!.state = "changed";
      },
    ],
    [
      "layer",
      (p) => {
        p.layers[0]!.roots.push("src/unreviewed");
      },
    ],
    [
      "activation",
      (p) => {
        p.activationHistory[0]!.minModules++;
      },
    ],
    [
      "allowed edge",
      (p) => {
        p.allowedEdges.unreviewed = ["legacy-host"];
      },
    ],
    [
      "top level",
      (p) => {
        p.description = "changed";
      },
    ],
    [
      "plausible second unmigrated row",
      (p) => {
        p.files.splice(1616, 0, { ...row, path: "src/codegen/unreviewed.ts" });
      },
    ],
  ];
  it.each(mutations)("refuses generator inventory %s after success and restores", (_label, edit) => reject(edit));
  it.each(["whitespace", "duplicate key", "offset", "missing", "duplicate span", "fragment"] as const)(
    "refuses exact generator raw %s",
    (change) => {
      const text = generatorRaw();
      beforeGeneratorInventoryPolicySource(text);
      const at = 529175;
      const mutant =
        change === "whitespace"
          ? text + "\n"
          : change === "duplicate key"
            ? text.slice(0, at) +
              text.slice(at).replace('"state": "unmigrated",', '"state": "unmigrated", "state": "unmigrated",')
            : change === "offset"
              ? " " + text
              : change === "missing"
                ? text.slice(0, at) + text.slice(at + insertion.length)
                : change === "duplicate span"
                  ? text.slice(0, at) + insertion + text.slice(at)
                  : text.slice(0, at) + "X" + text.slice(at + 1);
      expect(mutant).not.toBe(text);
      if (change === "whitespace" || change === "duplicate key") expect(JSON.parse(mutant)).toEqual(JSON.parse(text));
      expect(() => beforeGeneratorInventoryPolicySource(mutant)).toThrow();
      beforeGeneratorInventoryPolicySource(text);
    },
  );
  it.each(["accessor", "hidden", "symbol", "prototype", "cycle", "toJSON"] as const)(
    "captures generator %s before caller execution or authority I/O",
    (shape) => {
      const p = generatorPolicy(),
        original = JSON.stringify(p);
      accept(p);
      let calls = 0;
      if (shape === "accessor")
        Object.defineProperty(p, "description", {
          configurable: true,
          enumerable: true,
          get() {
            calls++;
            return "changed";
          },
        });
      if (shape === "hidden") Object.defineProperty(p.files[1615]!, "path", { enumerable: false });
      if (shape === "symbol")
        Object.defineProperty(p, Symbol("extra"), { configurable: true, enumerable: true, value: 1 });
      if (shape === "prototype") Object.setPrototypeOf(p.files[1615]!, { inherited: true });
      if (shape === "cycle") p.extra = p;
      if (shape === "toJSON")
        p.toJSON = () => {
          calls++;
          return generatorPolicy();
        };
      const exact = new URL(`../${generatorInventoryPolicyReceiptPath}`, import.meta.url).pathname;
      try {
        intercepted.set(exact, 0);
        interceptedReads.set(exact, 0);
        refuse(p);
        expect(calls).toBe(0);
        expect(interceptedReads.get(exact)).toBe(0);
      } finally {
        intercepted.delete(exact);
        interceptedReads.delete(exact);
      }
      restore(p, original);
    },
  );
  it("keeps input immutable and returns detached frozen current and fresh mutable predecessors", () => {
    const p = generatorPolicy(),
      original = JSON.stringify(p);
    accept(p);
    const frozen = authenticateGeneratorInventoryPolicy(p),
      first = beforeGeneratorInventoryPolicy(p),
      second = beforeGeneratorInventoryPolicy(p);
    expect(JSON.stringify(p)).toBe(original);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.files[1615])).toBe(true);
    expect(first).not.toBe(second);
    expect(first.files).not.toBe(second.files);
    first.files[0]!.state = "changed";
    expect(JSON.stringify(p)).toBe(original);
    p.files[1615]!.state = "clean";
    expect(frozen.files[1615]!.state).toBe("unmigrated");
    refuse(p);
    restore(p, original);
  });
  it("refuses prior domains and leaves a captured host mutant visible to its unchanged guard", () => {
    const p = generatorPolicy();
    accept(p);
    expect(() => authenticateHostCarrierInventoryPolicy(p)).toThrow("host carrier inventory policy evolution:");
    const hostText = beforeGeneratorInventoryPolicySource(generatorRaw()),
      host = beforeGeneratorInventoryPolicy(p),
      original = JSON.stringify(host);
    authenticateHostCarrierInventoryPolicy(host);
    refuse(host);
    expect(() => beforeGeneratorInventoryPolicySource(hostText)).toThrow();
    const two = beforeHostCarrierInventoryPolicy(host);
    refuse(two);
    expect(() => beforeGeneratorInventoryPolicySource(beforeHostCarrierInventoryPolicySource(hostText))).toThrow();
    host.files[605]!.state = "clean";
    expect(() => authenticateHostCarrierInventoryPolicy(host)).toThrow("host carrier inventory policy evolution:");
    expect(() => beforeHostCarrierInventoryPolicy(host)).toThrow("host carrier inventory policy evolution:");
    expect(host.files[605]!.state).toBe("clean");
    Object.assign(host, JSON.parse(original));
    authenticateHostCarrierInventoryPolicy(host);
  });
  it("refuses boxed raw and receipt strings without coercion", () => {
    accept(generatorPolicy());
    let calls = 0;
    const wrapped = Object(generatorRaw());
    wrapped.toString = () => {
      calls++;
      return generatorRaw();
    };
    expect(() => beforeGeneratorInventoryPolicySource(wrapped)).toThrow("raw input must be a primitive string");
    expect(() => authenticateGeneratorInventoryPolicyEvolution(wrapped)).toThrow("receipt digest mismatch");
    expect(calls).toBe(0);
  });
  it.each(["whitespace", "schema", "profile", "span"] as const)("refuses fixed generator receipt %s", (change) => {
    accept(generatorPolicy());
    const text = read(generatorInventoryPolicyReceiptPath),
      receipt = clone(authenticateGeneratorInventoryPolicyEvolution());
    if (change === "schema") receipt.schema += ".changed";
    if (change === "profile") receipt.current.fileCount++;
    if (change === "span") receipt.addition.rawSpan.afterOffset++;
    const mutant = change === "whitespace" ? text + "\n" : JSON.stringify(receipt);
    expect(mutant).not.toBe(text);
    expect(() => authenticateGeneratorInventoryPolicyEvolution(mutant)).toThrow("receipt digest mismatch");
  });
  it.each([
    generatorInventoryPolicyReceiptPath,
    hostCarrierPolicyReceiptPath,
    "tests/helpers/ir-runtime-program-policy-evolution.ts",
    "src/codegen/generator-eager-refusal.ts",
    "src/codegen/host-carrier-to-primitive.ts",
  ])("freshly refuses changed generator/predecessor authority %s and restores", (path) => {
    const read = readHistoricalPolicyOperand;
    const p = generatorPolicy(),
      text = generatorRaw(),
      original = read(path),
      exact = new URL(`../${historicalPolicyPhysicalPath(path)}`, import.meta.url).pathname;
    accept(p);
    authenticateGeneratorInventoryPolicyEvolution();
    beforeGeneratorInventoryPolicy(p);
    beforeGeneratorInventoryPolicySource(text);
    try {
      intercepted.set(exact, 0);
      interceptedReads.set(exact, 0);
      expect(read(path)).not.toBe(original);
      expect(() => authenticateGeneratorInventoryPolicyEvolution()).toThrow();
      refuse(p);
      expect(() => beforeGeneratorInventoryPolicySource(text)).toThrow();
      expect(interceptedReads.get(exact)).toBeGreaterThanOrEqual(5);
    } finally {
      intercepted.delete(exact);
      interceptedReads.delete(exact);
    }
    expect(read(path)).toBe(original);
    accept(p);
    authenticateGeneratorInventoryPolicyEvolution();
    beforeGeneratorInventoryPolicy(p);
    beforeGeneratorInventoryPolicySource(text);
  });
});
