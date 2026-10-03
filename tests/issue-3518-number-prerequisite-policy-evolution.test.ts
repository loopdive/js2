// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
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
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { authenticateIrValidationPolicy } from "./helpers/ir-validation-policy-evolution.js";
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
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const raw = (): string => read("scripts/compiler-boundaries.json");
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
      const p = actual(),
        text = raw(),
        original = read(path);
      receipt();
      authenticateNumberPrerequisitePolicy(p);
      beforeNumberPrerequisitePolicy(p);
      beforeNumberPrerequisitePolicySource(text);
      try {
        const exactPath = new URL(`../${path}`, import.meta.url).pathname;
        interceptedReads.set(exactPath, 0);
        intercepted.set(exactPath, 0);
        expect(read(path)).not.toBe(original);
        expect(sha(read(path))).not.toBe(sha(original));
        expect(() => authenticateNumberPrerequisitePolicyEvolution()).toThrow();
        refused(p);
        expect(() => beforeNumberPrerequisitePolicySource(text)).toThrow();
        expect(interceptedReads.get(exactPath)).toBeGreaterThanOrEqual(6);
      } finally {
        const exactPath = new URL(`../${path}`, import.meta.url).pathname;
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
