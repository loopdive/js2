// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { generateModule, generateMultiModule } from "../src/codegen/index.js";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import { irSupportFuncRef, irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrUnitInventory, type IrUnitRecord } from "../src/ir/identity.js";
import type { ProgramAbiPlanEntry } from "../src/ir/program-abi.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function exactUnit(inventory: IrUnitInventory, kind: string, displayName: string): IrUnitRecord {
  const matches = inventory.allUnits.filter((unit) => unit.kind === kind && unit.displayName === displayName);
  if (matches.length !== 1) {
    throw new Error(`expected one ${kind} ${displayName}, found ${matches.length}`);
  }
  return matches[0]!;
}

function exactUnitKind(inventory: IrUnitInventory, kind: string): IrUnitRecord {
  const matches = inventory.allUnits.filter((unit) => unit.kind === kind);
  if (matches.length !== 1) {
    throw new Error(`expected one ${kind}, found ${matches.length}`);
  }
  return matches[0]!;
}

function requiredCallable(entries: readonly ProgramAbiPlanEntry[], bindingId: string): ProgramAbiPlanEntry {
  const entry = entries.find((candidate) => candidate.id === bindingId);
  if (!entry) throw new Error(`missing callable ABI entry ${bindingId}`);
  expect(entry).toMatchObject({
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "source" },
  });
  return entry;
}

async function instantiate(result: CompileResult): Promise<Record<string, WebAssembly.ExportValue>> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, WebAssembly.ExportValue>;
}

describe("#3520 source callable Program ABI ownership", () => {
  it("owns an Unsupported retained direct body by its exact source unit", async () => {
    const source = `export function withDefault(value: number = 1): number { return value; }`;
    const ast = analyzeSource(source, "source-callable-unsupported.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const unit = exactUnit(inventory, "top-level-function", "withDefault");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(generated.irOutcomes?.find((outcome) => outcome.unitId === unit.id)).toMatchObject({
      kind: "unsupported",
      code: "param-shape-rejected",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const bindingId = irUnitCallableBindingId(unit.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });

    const runtime = await compile(source, {
      fileName: "source-callable-unsupported.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.withDefault as (value: number) => number)(7)).toBe(7);
  });

  it("keeps the exact source owner when IR replaces the preallocated body", async () => {
    const source = `export function double(value: number): number { return value * 2; }`;
    const ast = analyzeSource(source, "source-callable-ir.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const unit = exactUnit(inventory, "top-level-function", "double");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(generated.irOutcomes?.find((outcome) => outcome.unitId === unit.id)).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });

    const bindingId = irUnitCallableBindingId(unit.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
    expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
      expect.objectContaining({ space: "function" }),
    );

    const runtime = await compile(source, {
      fileName: "source-callable-ir.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.double as (value: number) => number)(9)).toBe(18);
  });

  it("keeps same-named retained functions source-qualified across a multi-source collision", async () => {
    const files = {
      "dependency.ts": `
        export function shared(value: number): number { return value + 1; }
        export function depCaller(value: number): number { return shared(value); }
      `,
      "entry.ts": `
        import { depCaller } from "./dependency.ts";
        function shared(value: number): number { return value + 10; }
        export function entryCaller(value: number): number { return shared(value); }
        export function runDep(value: number): number { return depCaller(value); }
      `,
    };
    const ast = analyzeMultiSource(files, "entry.ts");
    const inventory = buildIrUnitInventory(ast.sourceFiles, {
      entrySource: ast.entryFile,
      checker: ast.checker,
    });
    const sharedUnits = inventory.allUnits.filter(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "shared",
    );
    expect(sharedUnits).toHaveLength(2);

    const generated = generateMultiModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(new Set(generated.irCompiledFuncs ?? []).has("shared")).toBe(false);

    const entries = generated.programAbi!.abi.entries();
    const sharedBindings = sharedUnits.map((unit) => {
      const bindingId = irUnitCallableBindingId(unit.id);
      const entry = requiredCallable(entries, bindingId);
      expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
      return { bindingId, slot: generated.programAbi!.abi.resolveFinalIndex(bindingId) };
    });
    expect(sharedBindings[0]!.slot).toEqual(expect.objectContaining({ space: "function" }));
    expect(sharedBindings[1]!.slot).toEqual(expect.objectContaining({ space: "function" }));
    expect(sharedBindings[0]!.slot).not.toEqual(sharedBindings[1]!.slot);
    expect(() => generated.programAbi!.legacy.resolveUniqueLegacyName("function", "shared")).toThrow(
      /matches 2 canonical structural owners/,
    );

    const runtime = await compileMulti(files, "entry.ts", { experimentalIR: true });
    const exports = await instantiate(runtime);
    expect((exports.entryCaller as (value: number) => number)(7)).toBe(17);
    expect((exports.runDep as (value: number) => number)(7)).toBe(8);
  });

  it("owns retained arrow and function-expression bodies by their exact nested source units", async () => {
    const source = `
      export function run(value: number): number {
        const increment = (input: number): number => input + 1;
        const double = function named(input: number): number { return input * 2; };
        return increment(value) + double(value);
      }
    `;
    const ast = analyzeSource(source, "source-callable-nested.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const arrow = exactUnitKind(inventory, "arrow-function");
    const expression = exactUnitKind(inventory, "function-expression");

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const entries = generated.programAbi!.abi.entries();
    for (const unit of [arrow, expression]) {
      const bindingId = irUnitCallableBindingId(unit.id);
      const entry = requiredCallable(entries, bindingId);
      expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
      expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
        expect.objectContaining({ space: "function" }),
      );
    }

    const runtime = await compile(source, {
      fileName: "source-callable-nested.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.run as (value: number) => number)(7)).toBe(22);
  });

  it("owns an admitted typed-this twin as support beneath its exact function expression", async () => {
    const source = `
      var P = function P(n) { this.pos = n; this.acc = 0; };
      var pp = P.prototype;
      pp.step = function (k) {
        this.pos = this.pos + k;
        return this.pos;
      };
      var p = new P(3);
      export function test(): number { return p.step(4); }
    `;
    const ast = analyzeSource(source, "source-callable-typed-this-twin.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const expression = exactUnit(inventory, "function-expression", "<anonymous-function>");

    const publish = vi.spyOn(ProgramAbiSession.prototype, "publish");
    const runtime = await compile(source, {
      fileName: "source-callable-typed-this-twin.ts",
      experimentalIR: true,
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    const publication = publish.mock.instances.at(-1)?.publication;
    publish.mockRestore();
    expect(runtime.success, runtime.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(runtime.wat).toMatch(/__typed_this/);
    expect(publication).toBeDefined();

    const bodyBindingId = irUnitCallableBindingId(expression.id);
    const twinRef = irSupportFuncRef(expression.id, "typed-this-twin", "diagnostic-name-is-not-identity");
    if (twinRef.binding.kind !== "support") throw new Error("missing typed-this support reference");
    const twinBindingId = twinRef.binding.bindingId;
    const entries = publication!.abi.entries();
    const body = requiredCallable(entries, bodyBindingId);
    expect(body.intent).toMatchObject({ kind: "callable", origin: "source", unitId: expression.id });
    expect(entries.find((entry) => entry.id === twinBindingId)).toMatchObject({
      id: twinBindingId,
      displayName: expect.stringMatching(/__typed_this$/),
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        unitId: expression.id,
      },
    });
    const bodySlot = publication!.abi.resolveFinalIndex(bodyBindingId);
    const twinSlot = publication!.abi.resolveFinalIndex(twinBindingId);
    expect(bodySlot).toEqual(expect.objectContaining({ space: "function" }));
    expect(twinSlot).toEqual(expect.objectContaining({ space: "function" }));
    expect(twinSlot).not.toEqual(bodySlot);

    const exports = await instantiate(runtime);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("owns a retained direct host-callback body by its exact arrow unit", () => {
    const source = `
      export function install(target: EventTarget, sink: HTMLElement): void {
        target.addEventListener("tick", () => { sink.textContent = "ready"; });
      }
    `;
    const ast = analyzeSource(source, "source-callable-host-callback.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const arrow = exactUnitKind(inventory, "arrow-function");

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const bindingId = irUnitCallableBindingId(arrow.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: arrow.id });
    expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
      expect.objectContaining({ space: "function" }),
    );
  });

  it("owns object-literal method and accessor bodies by their exact callable units", () => {
    const source = `
      export function make(): object {
        return {
          value: 1,
          method(): number { return this.value; },
          get current(): number { return this.value; },
          set current(next: number) { this.value = next; },
        };
      }
    `;
    const ast = analyzeSource(source, "source-callable-object-members.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const units = [
      exactUnitKind(inventory, "object-method"),
      exactUnitKind(inventory, "object-getter"),
      exactUnitKind(inventory, "object-setter"),
    ];

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const entries = generated.programAbi!.abi.entries();
    for (const unit of units) {
      const bindingId = irUnitCallableBindingId(unit.id);
      const entry = requiredCallable(entries, bindingId);
      expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
      expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
        expect.objectContaining({ space: "function" }),
      );
    }
  });

  it("does not let an accessor adapter steal a top-level function declaration's exact slot", () => {
    const source = `
      const target: any = {};
      function getValue(): number { return 20; }
      Object.defineProperties(target, { value: { get: getValue } });
      export function read(): number { return target.value; }
    `;
    const ast = analyzeSource(source, "source-callable-accessor-adapter.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const getter = exactUnit(inventory, "top-level-function", "getValue");

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const bindingId = irUnitCallableBindingId(getter.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: getter.id });
    expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
      expect.objectContaining({ space: "function" }),
    );
  });

  it("owns retained nested function declarations across reservation paths", async () => {
    const source = `
      export function run(value: number): number {
        let bias = 3;
        function double(input: number): number { return input * 2; }
        function addBias(input: number): number { return input + bias; }
        function throughSingle(input: number): number {
          function decrement(inner: number): number { return inner - 1; }
          return decrement(input);
        }
        return double(value) + addBias(value) + throughSingle(value);
      }
    `;
    const ast = analyzeSource(source, "source-callable-nested-declarations.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const units = ["double", "addBias", "throughSingle", "decrement"].map((name) =>
      exactUnit(inventory, "nested-function", name),
    );

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const entries = generated.programAbi!.abi.entries();
    for (const unit of units) {
      const bindingId = irUnitCallableBindingId(unit.id);
      const entry = requiredCallable(entries, bindingId);
      expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
      expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
        expect.objectContaining({ space: "function" }),
      );
    }

    const runtime = await compile(source, {
      fileName: "source-callable-nested-declarations.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.run as (value: number) => number)(7)).toBe(30);
  });

  it("owns direct function-value trampolines and preserves their cache strategy", async () => {
    const source = `
      export function captureFree(value: number): number {
        function increment(input: number): number { return input + 1; }
        const first = increment;
        const second = increment;
        return first === second ? first(value) : -100;
      }
      export function capturing(value: number): number {
        let bias = 3;
        function addBias(input: number): number { return input + bias; }
        const first = addBias;
        const second = addBias;
        return first === second ? second(value) : -100;
      }
    `;
    const ast = analyzeSource(source, "source-callable-function-values.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const captureFree = exactUnit(inventory, "nested-function", "increment");
    const capturing = exactUnit(inventory, "nested-function", "addBias");

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    const publication = generated.programAbi!;
    const entries = publication.abi.entries();

    const captureFreeTrampoline = irSupportFuncRef(
      captureFree.id,
      "function-value-trampoline",
      "diagnostic-capture-free-trampoline",
    );
    const capturingTrampoline = irSupportFuncRef(
      capturing.id,
      "function-value-trampoline",
      "diagnostic-capturing-trampoline",
    );
    for (const [unit, ref] of [
      [captureFree, captureFreeTrampoline],
      [capturing, capturingTrampoline],
    ] as const) {
      const entry = entries.find((candidate) => candidate.id === ref.binding.bindingId);
      expect(entry).toMatchObject({
        id: ref.binding.bindingId,
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "support",
          unitId: unit.id,
        },
      });
      expect(publication.abi.resolveFinalIndex(ref.binding.bindingId)).toEqual(
        expect.objectContaining({ space: "function" }),
      );
    }

    const cache = irSupportGlobalRef(captureFree.id, "function-value-cache", "diagnostic-capture-free-cache");
    expect(entries.find((candidate) => candidate.id === cache.binding.bindingId)).toMatchObject({
      id: cache.binding.bindingId,
      displayName: "__fn_closure_increment",
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: "support",
        mutable: true,
      },
    });
    expect(publication.abi.resolveFinalIndex(cache.binding.bindingId)).toEqual(
      expect.objectContaining({ space: "global" }),
    );
    const capturingCache = irSupportGlobalRef(capturing.id, "function-value-cache", "diagnostic-capturing-cache");
    expect(entries.some((candidate) => candidate.id === capturingCache.binding.bindingId)).toBe(false);

    const runtime = await compile(source, {
      fileName: "source-callable-function-values.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.captureFree as (value: number) => number)(7)).toBe(8);
    expect((exports.capturing as (value: number) => number)(7)).toBe(10);
  });

  it("keeps eager class-order reservations on the nested declaration's exact slot", async () => {
    const source = `
      export function run(): number {
        function initialValue(): number { return 6; }
        class Box {
          value: number = initialValue();
        }
        return new Box().value;
      }
    `;
    const ast = analyzeSource(source, "source-callable-eager-class-order.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const nested = exactUnit(inventory, "nested-function", "initialValue");

    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);

    const bindingId = irUnitCallableBindingId(nested.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: nested.id });
    expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
      expect.objectContaining({ space: "function" }),
    );

    const runtime = await compile(source, {
      fileName: "source-callable-eager-class-order.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.run as () => number)()).toBe(6);
  });

  it("keeps post-inventory literal-eval function declarations on support-callable planning", async () => {
    const generated = await compile(
      `
        export function run(): number {
          return eval("function increment(value) { return value + 1; } increment(2);");
        }
      `,
      {
        fileName: "source-callable-literal-eval-function.ts",
        experimentalIR: true,
      },
    );
    expect(generated.success, generated.errors.map((error) => error.message).join("\n")).toBe(true);
  });

  it("keeps post-inventory literal-eval accessors on support-callable planning", async () => {
    const generated = await compile(
      `
        export function run(): number {
          eval("({ value: 1, get value() {} });");
          return 1;
        }
      `,
      {
        fileName: "source-callable-literal-eval.ts",
        experimentalIR: true,
      },
    );
    expect(generated.success, generated.errors.map((error) => error.message).join("\n")).toBe(true);
  });
});
