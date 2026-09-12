// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ts } from "../src/ts-api.js";
import { describe, expect, it } from "vitest";
import {
  buildIrUnitInventory,
  createIrSourceId,
  createIrUnitId,
  createIrClassId,
  type IrUnitId,
  type IrBindingId,
} from "../src/ir/identity.js";
import { createDerivedIrUnitId, createIrBindingId } from "../src/shared/contracts/identity-values.js";
import {
  ProgramAbiMap,
  ProgramAbiInvariantError,
  type ProgramAbiPlanEntry,
  type ProgramAbiInvariantCode,
} from "../src/ir/program/abi.js";
import type { ProgramAbiInventory } from "../src/ir/program/abi-inventory.js";
import {
  ProgramAbiMap as CompatibilityMap,
  ProgramAbiInvariantError as CompatibilityError,
  LegacyAbiAdapter,
} from "../src/ir/program-abi.js";
import { irGlobalBindingKey } from "../src/ir/abi-bindings.js";
import { irSourceGlobalBindingKey } from "../src/ir/core/binding-key-primitives.js";
import { PreparedIrCandidateProgramBuilder } from "../src/ir/prepare.js";

const root = resolve(import.meta.dirname, "..");
const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "entry.ts" });
const otherSourceId = createIrSourceId({ kind: "source", order: 1, sourceKey: "other.ts" });
const unitId = (ordinal: number) =>
  createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal });
const first = unitId(0);
const second = unitId(1);
const classId = createIrClassId({ sourceId, lexicalOwnerId: null, declarationKind: "declaration", ordinal: 0 });
const inventory: ProgramAbiInventory = {
  sources: [
    { id: sourceId, order: 0 },
    { id: otherSourceId, order: 1 },
  ],
  allUnits: [first, second].map((id) => ({ id, sourceId, terminalOwnerId: id })),
  classes: [{ id: classId, sourceId }],
  terminalUnits: [{ id: first }, { id: second }],
};
const binding = (role: string, domain: "callable" | "global" | "export" | "type" | "class" | "support" = "callable") =>
  createIrBindingId({ ownerId: sourceId, domain, role });
const signature = { params: ["f64"], results: ["f64"] };
function callable(role: string, order: number, owner: IrUnitId = first): ProgramAbiPlanEntry {
  return {
    id: binding(role),
    displayName: "same",
    order: { sourceOrder: 0, declarationOrder: order },
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "source", unitId: owner, signature },
  };
}
function invariant(action: () => unknown, code: ProgramAbiInvariantCode) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
  expect(caught).toBeInstanceOf(CompatibilityError);
  expect((caught as ProgramAbiInvariantError).code).toBe(code);
}

describe("canonical program ABI seam", () => {
  it("retains one constructor and error class, plus rich inventory identity for old and new consumers", () => {
    expect(CompatibilityMap).toBe(ProgramAbiMap);
    expect(CompatibilityError).toBe(ProgramAbiInvariantError);
    const file = ts.createSourceFile(
      "/repo/entry.ts",
      "export function value(): number { return 4; }",
      ts.ScriptTarget.Latest,
      true,
    );
    const rich = buildIrUnitInventory([file], { entrySource: file });
    const old: CompatibilityMap = new CompatibilityMap(rich);
    const canonical = new ProgramAbiMap(rich);
    expect(old).toBeInstanceOf(ProgramAbiMap);
    expect(canonical).toBeInstanceOf(CompatibilityMap);
    expect(old.inventory).toBe(rich);
    expect(canonical.inventory).toBe(rich);
    expect(old.inventory.terminalUnits[0]).toBe(rich.terminalUnits[0]);
    expect(canonical.inventory.terminalUnits[0].kind).toBe("top-level-function");
    old.sealPlan();
    const builder = new PreparedIrCandidateProgramBuilder(old);
    const free = old.inventory.terminalUnits.filter((unit) => unit.kind === "top-level-function");
    expect(free).toHaveLength(1);
    builder.recordDirectCandidate({
      unitId: free[0].id,
      code: "unsupported-syntax",
      stage: "select",
      detail: "compatibility fixture",
    });
    builder.addComponentCandidate({ id: "only", unitIds: [free[0].id] });
    expect([...builder.seal().units.keys()]).toEqual([free[0].id]);
  });

  it("orders same-named owners structurally despite insertion order and unrelated owners", () => {
    const a = callable("first", 0),
      b = callable("second", 1, second);
    const left = new ProgramAbiMap(inventory),
      right = new ProgramAbiMap(inventory);
    left.plan(b);
    left.plan(a);
    right.plan(a);
    right.plan(b);
    right.plan({
      id: binding("unrelated", "support"),
      displayName: "same",
      order: { sourceOrder: 1, declarationOrder: 0 },
      slotPolicy: "none",
      intent: { kind: "support", role: "unrelated" },
    });
    expect(left.inventory).toBe(inventory);
    expect(right.entries().filter((entry) => entry.id === a.id || entry.id === b.id)).toEqual(left.entries());
    expect(left.entries().map((entry) => entry.id)).toEqual([a.id, b.id]);
    expect(Object.isFrozen(left.get(a.id))).toBe(true);
    const planned = left.get(a.id)!;
    if (planned.intent.kind !== "callable") throw new Error("missing callable fixture");
    expect(Object.isFrozen(planned.intent.signature.params)).toBe(true);
    expect(planned.intent.signature.params).not.toBe(signature.params);
    const rich = {
      ...inventory,
      terminalUnits: inventory.terminalUnits.map((row) => ({ ...row, kind: "top-level-function" as const })),
    };
    const inferred = new ProgramAbiMap(rich);
    expect(inferred.inventory.terminalUnits[0].kind).toBe("top-level-function");
  });

  it("preserves legacy naming and ambiguity through the rich specialization", () => {
    const file = ts.createSourceFile(
      "/repo/entry.ts",
      "function first() {} function second() {}",
      ts.ScriptTarget.Latest,
      true,
    );
    const rich = buildIrUnitInventory([file], { entrySource: file });
    const abi = new CompatibilityMap(rich);
    const units = rich.terminalUnits.filter((row) => row.kind === "top-level-function");
    expect(units).toHaveLength(2);
    const entries = units.map((unit, index) => ({
      ...callable(String(index), index, unit.id),
      order: { sourceOrder: rich.sources[0].order, declarationOrder: index },
    }));
    for (const entry of entries) abi.plan(entry);
    abi.sealPlan();
    const adapter = new LegacyAbiAdapter(abi);
    expect(adapter.abi).toBe(abi);
    invariant(() => adapter.resolveUniqueLegacyName("function", "same"), "ambiguous-legacy-name");
    expect(entries.map((entry) => adapter.internalWasmName(entry.id))).toEqual(
      entries.map((entry) => `same__ir_${encodeURIComponent(entry.id)}`),
    );
  });

  it("retains alias resolution and seal/bind/finish rules across all three index spaces", () => {
    const abi = new ProgramAbiMap(inventory);
    const fn = callable("fn", 0);
    const alias = binding("alias", "export"),
      global = binding("global", "global"),
      type = binding("type", "type");
    abi.plan(fn);
    abi.plan({
      id: alias,
      displayName: "alias",
      order: { sourceOrder: 0, declarationOrder: 1 },
      slotPolicy: "alias",
      aliasOf: fn.id,
      intent: { kind: "export", externalName: "alias", targetId: fn.id },
    });
    abi.plan({
      id: global,
      displayName: "global",
      order: { sourceOrder: 0, declarationOrder: 2 },
      slotPolicy: "required",
      slotSpace: "global",
      intent: { kind: "global", origin: "source", valueType: "f64", mutable: true },
    });
    abi.plan({
      id: type,
      displayName: "type",
      order: { sourceOrder: 0, declarationOrder: 3 },
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "type", shapeKey: "(f64)->f64" },
    });
    invariant(() => abi.bindFinalIndex(fn.id, { space: "function", index: 0 }), "planning-not-sealed");
    abi.sealPlan();
    abi.sealPlan();
    invariant(() => abi.plan(callable("late", 5)), "planning-sealed");
    invariant(() => abi.bindFinalIndex(alias, { space: "function", index: 0 }), "alias-final-binding");
    invariant(() => abi.bindFinalIndex(fn.id, { space: "global", index: 0 }), "final-index-space-mismatch");
    invariant(() => abi.finishBinding(), "unresolved-required-binding");
    abi.bindFinalIndex(fn.id, { space: "function", index: 0 });
    abi.bindFinalIndex(global, { space: "global", index: 0 });
    abi.bindFinalIndex(type, { space: "type", index: 0 });
    abi.finishBinding();
    expect(abi.resolveFinalIndex(alias)).toBe(abi.resolveFinalIndex(fn.id));
    expect(abi.resolveFinalIndex(alias)).toEqual({ space: "function", index: 0 });
    invariant(() => abi.bindFinalIndex(fn.id, { space: "function", index: 1 }), "binding-complete");
  });

  it("rejects index collisions, altered alias signatures and capability/provider pairs", () => {
    const a = callable("a", 0),
      b = callable("b", 1, second);
    const abi = new ProgramAbiMap(inventory);
    abi.plan(a);
    abi.plan(b);
    abi.sealPlan();
    abi.bindFinalIndex(a.id, { space: "function", index: 2 });
    invariant(() => abi.bindFinalIndex(b.id, { space: "function", index: 2 }), "final-index-collision");
    for (const tamper of ["signature", "provider"] as const) {
      const map = new ProgramAbiMap(inventory);
      map.plan({
        ...a,
        intent: { kind: "callable", origin: "import", signature, capabilityId: "dom", providerId: "dom-provider" },
      });
      map.plan({
        id: b.id,
        displayName: "alias",
        order: b.order,
        slotPolicy: "alias",
        aliasOf: a.id,
        intent: {
          kind: "callable",
          origin: "import",
          signature: tamper === "signature" ? { params: [], results: [] } : signature,
          capabilityId: "dom",
          providerId: tamper === "provider" ? "foreign" : "dom-provider",
        },
      });
      invariant(() => map.sealPlan(), "alias-signature-mismatch");
    }
    invariant(
      () =>
        new ProgramAbiMap(inventory).plan({
          ...a,
          intent: { kind: "callable", origin: "import", signature, capabilityId: "dom" },
        }),
      "invalid-callable-provenance",
    );
  });

  it("keeps derived provenance and class membership bound to the structural inventory", () => {
    const derived = {
      id: createDerivedIrUnitId({ parentId: first, role: "lifted-closure", ordinal: 0 }),
      parentId: first,
      terminalOwnerId: first,
      sourceId,
      role: "lifted-closure" as const,
      ordinal: 0,
    };
    const abi = new ProgramAbiMap(inventory, [derived]);
    abi.plan(callable("derived", 0, derived.id));
    abi.plan({
      id: binding("class", "class"),
      displayName: "class",
      order: { sourceOrder: 0, declarationOrder: 1 },
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "class", classId, layoutKey: "layout" },
    });
    expect(abi.entries()).toHaveLength(2);
    invariant(() => new ProgramAbiMap(inventory, [{ ...derived, ordinal: 1 }]), "invalid-derived-unit");
    invariant(() => new ProgramAbiMap(inventory, [{ ...derived, sourceId: otherSourceId }]), "derived-source-mismatch");
    invariant(
      () => new ProgramAbiMap(inventory, [{ ...derived, terminalOwnerId: second }]),
      "derived-terminal-owner-mismatch",
    );
    invariant(() => new ProgramAbiMap({ ...inventory, classes: [] }).plan(abi.entries()[1]), "unknown-inventory-class");
  });

  it("preserves exact source key grammar, UTF-16 length, validation order and capability provenance", () => {
    const id = "ir-binding:v1:global:😀" as IrBindingId;
    expect(irSourceGlobalBindingKey(id)).toBe("source|23:ir-binding:v1:global:😀");
    expect(irSourceGlobalBindingKey(id, "dom")).toBe("source|23:ir-binding:v1:global:😀|capability|3:dom");
    for (const capability of [undefined, "dom"] as const) {
      expect(irGlobalBindingKey({ kind: "source", bindingId: id, capability })).toBe(
        irSourceGlobalBindingKey(id, capability),
      );
    }
    for (const key of [
      (value: IrBindingId, capability?: "dom") => irSourceGlobalBindingKey(value, capability),
      (value: IrBindingId, capability?: "dom") => irGlobalBindingKey({ kind: "source", bindingId: value, capability }),
    ]) {
      expect(() => key("" as IrBindingId, "wrong" as "dom")).toThrow("global bindingId must be a non-empty string");
      expect(() => key(binding("wrong", "type"), "wrong" as "dom")).toThrow(
        "global bindingId must belong to the global binding domain",
      );
      expect(() => key(id, "wrong" as "dom")).toThrow("source global capability must be dom when present");
    }
    const globalId = binding("dom", "global");
    const entry: ProgramAbiPlanEntry = {
      id: globalId,
      displayName: "dom",
      order: { sourceOrder: 0, declarationOrder: 0 },
      slotPolicy: "required",
      slotSpace: "global",
      structuralReferenceKey: irSourceGlobalBindingKey(globalId, "dom"),
      intent: {
        kind: "global",
        origin: "source",
        valueType: "externref",
        mutable: true,
        capability: "dom",
        sourceId,
        unitId: first,
      },
    };
    new ProgramAbiMap(inventory).plan(entry);
    invariant(
      () => new ProgramAbiMap(inventory).plan({ ...entry, structuralReferenceKey: irSourceGlobalBindingKey(globalId) }),
      "invalid-binding-reference",
    );
  });

  it("checks rich old/new types and all four distinct identity brands with the real TypeScript checker", () => {
    const file = resolve(root, "src/ir/program/__abi_seam_type_probe.ts");
    const content = `
      import { ProgramAbiMap as Canonical } from './abi.js';
      import { ProgramAbiMap as Old, LegacyAbiAdapter } from '../program-abi.js';
      import type { IrUnitInventory, IrSourceId, IrClassId, IrUnitId, IrBindingId } from '../identity.js';
      declare const inventory: IrUnitInventory;
      const old: Old = new Old(inventory);
      const canonical = new Canonical(inventory);
      const adapter = new LegacyAbiAdapter(old);
      const kind: IrUnitInventory['terminalUnits'][number]['kind'] = old.inventory.terminalUnits[0].kind;
      const inferredKind: typeof kind = canonical.inventory.terminalUnits[0].kind;
      const retained: IrUnitInventory = adapter.abi.inventory;
      const minimal = {
        sources: inventory.sources.map(({ id, order }) => ({ id, order })),
        allUnits: inventory.allUnits.map(({ id, sourceId, terminalOwnerId }) => ({ id, sourceId, terminalOwnerId })),
        classes: inventory.classes.map(({ id, sourceId }) => ({ id, sourceId })),
        terminalUnits: inventory.terminalUnits.map(({ id }) => ({ id })),
      };
      const structural = new Canonical(minimal);
      // @ts-expect-error structural records lack the rich inventory's terminal kind and source metadata
      const incomplete = new Old(minimal);
      declare const source: IrSourceId;
      declare const unit: IrUnitId;
      declare const cls: IrClassId;
      declare const binding: IrBindingId;
      // @ts-expect-error source and unit identities remain distinct
      const badUnit: IrUnitId = source;
      // @ts-expect-error unit and class identities remain distinct
      const badClass: IrClassId = unit;
      // @ts-expect-error class and binding identities remain distinct
      const badBinding: IrBindingId = cls;
      // @ts-expect-error binding and source identities remain distinct
      const badSource: IrSourceId = binding;
    `;
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host),
      exists = host.fileExists.bind(host);
    host.readFile = (path) => (path === file ? content : read(path));
    host.fileExists = (path) => path === file || exists(path);
    const program = ts.createProgram([file], options, host);
    expect(program.getSourceFile(file)).toBeDefined();
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .filter((row) => row.file?.fileName === file)
        .map((row) => ts.flattenDiagnosticMessageText(row.messageText, "\n")),
    ).toEqual([]);
  });

  it("observes canonical methods on real standalone preparation, codec validation and accepted emission", () => {
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { ProgramAbiMap } from './src/ir/program/abi.ts';
      import { ProgramAbiMap as Old } from './src/ir/program-abi.ts';
      assert.equal(Old, ProgramAbiMap);
      const names = ['plan', 'sealPlan', 'bindFinalIndex', 'finishBinding'];
      const originals = new Map(names.map(name => [name, ProgramAbiMap.prototype[name]]));
      let calls = Object.fromEntries(names.map(name => [name, 0]));
      for (const name of names) ProgramAbiMap.prototype[name] = function(...args) {
        calls[name]++;
        return originals.get(name).apply(this, args);
      };
      try {
        const { analyzeMultiSource } = await import('./src/checker/index.ts');
        const { prepareWholeIrProgram } = await import('./src/ir/program-preparation.ts');
        const { encodePreparedIrProgram, decodePreparedIrProgram } = await import('./src/ir/program-codec.ts');
        const { acceptPreparedIrProgram, emitAcceptedIrProgram } = await import('./src/ir/program-consumer.ts');
        const { emitBinary } = await import('./src/emit/binary.ts');
        const policy = { target: 'standalone', backend: 'wasmgc' };
        const fixtures = [
          { files: { './math.ts': 'export function double(x: number): number { return x * 2; }', './entry.ts': 'import { double as twice } from "./math"; export function main(): number { return twice(20) + 2; }' }, value: 42 },
          { files: { './entry.ts': 'export let answer: number = 40; answer = answer + 2; export function read(): number { return answer; }' }, value: 42 },
        ];
        const reports = [];
        for (const fixture of fixtures) {
          const ast = analyzeMultiSource(fixture.files, './entry.ts');
          calls = Object.fromEntries(names.map(name => [name, 0]));
          const prepared = prepareWholeIrProgram({ sourceFiles: ast.sourceFiles, entrySource: ast.entryFile, checker: ast.checker, policy, runtimePolicies: [policy], deferTopLevelInit: false });
          assert.equal(prepared.kind, 'prepared', prepared.kind === 'prepared' ? '' : prepared.code + ': ' + prepared.detail);
          assert.ok(prepared.program.ir.functions.length > 0);
          assert.ok(calls.plan > 0 && calls.sealPlan > 0);
          const preparation = { ...calls };
          const encoded = encodePreparedIrProgram(prepared.program);
          calls = Object.fromEntries(names.map(name => [name, 0]));
          const decoded = decodePreparedIrProgram(encoded);
          assert.equal(encodePreparedIrProgram(decoded), encoded);
          assert.deepEqual(decoded.abi.entries, prepared.program.abi.entries);
          assert.ok(calls.plan > 0 && calls.sealPlan > 0);
          const codec = { ...calls };
          const options = { ...policy, sharedExceptionTag: false, utf8Storage: false, sourceMap: false, moduleName: 'abi-seam' };
          const run = async program => {
            const accepted = acceptPreparedIrProgram(program, options);
            assert.equal(accepted.kind, 'accepted');
            calls = Object.fromEntries(names.map(name => [name, 0]));
            const emitted = emitAcceptedIrProgram(accepted);
            assert.ok(calls.plan > 0 && calls.sealPlan > 0 && calls.bindFinalIndex > 0 && calls.finishBinding > 0);
            const emission = { ...calls };
            const binary = emitBinary(emitted.module);
            assert.ok(binary.byteLength > 0);
            assert.equal(emitted.module.imports.length, 0);
            const { instance } = await WebAssembly.instantiate(binary);
            const result = instance.exports.main ? instance.exports.main() : instance.exports.read();
            assert.equal(result, fixture.value);
            if (instance.exports.answer) assert.equal(instance.exports.answer.value, 42);
            return { binary, emission, exports: emitted.module.exports.map(entry => entry.name), result, bodies: emitted.emittedUnitIds.length };
          };
          const original = await run(prepared.program), replay = await run(decoded);
          assert.deepEqual(original.binary, replay.binary);
          reports.push({ preparation, codec, emission: replay.emission, terminalUnits: decoded.inventory.terminalUnits.length, bodies: replay.bodies, abiEntries: decoded.abi.entries.length, bytes: replay.binary.byteLength, exports: replay.exports, result: replay.result });
        }
        console.log(JSON.stringify(reports));
      } finally {
        for (const [name, method] of originals) ProgramAbiMap.prototype[name] = method;
      }
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(child.status, child.stderr + child.stdout).toBe(0);
    const reports = JSON.parse(child.stdout.trim());
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.terminalUnits).toBeGreaterThan(0);
      expect(report.bodies).toBeGreaterThan(0);
      expect(report.abiEntries).toBeGreaterThan(0);
      expect(report.bytes).toBeGreaterThan(0);
      expect(report.result).toBe(42);
    }
    expect(reports[0].exports).toContain("main");
    expect(reports[1].exports).toEqual(expect.arrayContaining(["answer", "read"]));
  }, 100_000);
});
