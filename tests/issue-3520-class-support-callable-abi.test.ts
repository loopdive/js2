// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { compileDeclarations, collectDeclarations } from "../src/codegen/declarations.js";
import { generateModule } from "../src/codegen/index.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import { compile } from "../src/index.js";
import { irSupportFuncRef, irUnitCallableBindingId, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrClassId } from "../src/ir/identity.js";
import { compileIrPathFunctions } from "../src/ir/integration.js";
import type { IrClassShape } from "../src/ir/nodes.js";
import type { IrSelection } from "../src/ir/select.js";
import { createEmptyModule } from "../src/ir/types.js";
import { buildImports } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

function generate(source: string, fileName: string) {
  const ast = analyzeSource(source, fileName);
  const inventory = buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  });
  const result = generateModule(ast, {
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  return { inventory, result };
}

function classId(inventory: ReturnType<typeof buildIrUnitInventory>, name: string): IrClassId {
  const record = inventory.classes.find((candidate) => candidate.displayName === name);
  if (!record) throw new Error(`missing ${name} class identity`);
  return record.id;
}

async function runtimeValue(source: string, experimentalIR: boolean): Promise<unknown> {
  const compiled = await compile(source, { experimentalIR });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(compiled.imports, ENV_STUB, compiled.stringPool);
  const { instance } = await WebAssembly.instantiate(compiled.binary, {
    env: imports.env,
    "wasm:js-string": imports["wasm:js-string"],
    string_constants: imports.string_constants,
    string_constants16: imports.string_constants16,
  });
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.main as () => unknown)();
}

describe("#3520 production class-support callable Program ABI planning", () => {
  it("uses the synthesized identity context for compatibility-mode class resolution", () => {
    const source = `
      class Empty {}
      export function main(): number {
        const value = new Empty();
        return 1;
      }
    `;
    const ast = analyzeSource(source, "compatibility-class-resolution.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const emptyClassId = classId(inventory, "Empty");
    const implicitConstructor = inventory.allUnits.find(
      (unit) => unit.lexicalOwnerId === emptyClassId && unit.kind === "class-implicit-constructor",
    );
    expect(implicitConstructor).toBeDefined();
    const constructorNewRef = irSupportFuncRef(emptyClassId, "class-constructor-new", "Empty_new");
    const constructorInitRef = irUnitFuncRef({ unitId: implicitConstructor!.id, name: "Empty_init" });
    const emptyShape: IrClassShape = {
      classId: emptyClassId,
      className: "Empty",
      fields: [],
      methods: [],
      constructorParams: [],
      constructorTarget: constructorNewRef,
      constructorInitTarget: constructorInitRef,
    };
    const ctx = createCodegenContext(createEmptyModule(), ast.checker, { experimentalIR: true });
    collectDeclarations(ctx, ast.sourceFile);
    compileDeclarations(ctx, ast.sourceFile);
    const selection: IrSelection = { funcs: new Set(["main"]) };

    const report = compileIrPathFunctions(ctx, ast.sourceFile, selection, undefined, new Map([["Empty", emptyShape]]));

    expect(report.errors).toEqual([]);
    expect(report.compiled).toEqual(["main"]);
    expect(ctx.irUnitFuncMap.has(inventory.terminalUnits.find((unit) => unit.displayName === "main")!.id)).toBe(true);
    expect(ctx.irUnitFuncMap.get(implicitConstructor!.id)?.name).toBe("Empty_init");
    expect(ctx.irUnitFuncMap.get(implicitConstructor!.id)?.name).not.toBe("Empty_new");
  });

  it("publishes an implicit WasmGC constructor as source-owned init plus an AST-free new wrapper", () => {
    const source = `
      class Empty {
        value(): number { return 42; }
      }
      export function main(): number {
        return new Empty().value();
      }
    `;
    const { inventory, result } = generate(source, "implicit-constructor.ts");
    const emptyClassId = classId(inventory, "Empty");
    const constructors = inventory.allUnits.filter(
      (unit) =>
        unit.lexicalOwnerId === emptyClassId &&
        (unit.kind === "class-constructor" || unit.kind === "class-implicit-constructor"),
    );
    expect(constructors).toHaveLength(1);
    expect(constructors[0]!.kind).toBe("class-implicit-constructor");

    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("Empty_value");
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entries = result.programAbi!.abi.entries();
    const exactConstructorId = irUnitCallableBindingId(constructors[0]!.id);
    expect(entries.find((entry) => entry.id === exactConstructorId)).toMatchObject({
      id: exactConstructorId,
      displayName: "Empty_init",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "source",
        unitId: constructors[0]!.id,
      },
    });

    const constructorNew = irSupportFuncRef(emptyClassId, "class-constructor-new", "Empty_new");
    if (constructorNew.binding.kind !== "support") throw new Error("expected class-new support reference");
    expect(entries.find((entry) => entry.id === constructorNew.binding.bindingId)).toMatchObject({
      id: constructorNew.binding.bindingId,
      displayName: "Empty_new",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        classId: emptyClassId,
      },
    });

    const obsoleteInitSupport = irSupportFuncRef(emptyClassId, "class-constructor-init", "Empty_init");
    if (obsoleteInitSupport.binding.kind !== "support") throw new Error("expected class-init support reference");
    expect(entries.some((entry) => entry.id === obsoleteInitSupport.binding.bindingId)).toBe(false);
    expect(result.programAbi!.abi.resolveFinalIndex(exactConstructorId)).not.toEqual(
      result.programAbi!.abi.resolveFinalIndex(constructorNew.binding.bindingId),
    );
  });

  it("keeps an externref-backed constructor as the _new source unit without an _init split", () => {
    const source = `
      class HostError extends Error {
        constructor(message: string) { super(message); }
      }
      export function main(): HostError {
        return new HostError("boom");
      }
    `;
    const { inventory, result } = generate(source, "externref-constructor.ts");
    const hostErrorId = classId(inventory, "HostError");
    const constructorUnit = inventory.allUnits.find(
      (unit) => unit.lexicalOwnerId === hostErrorId && unit.kind === "class-constructor",
    );
    expect(constructorUnit).toBeDefined();

    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entries = result.programAbi!.abi.entries();
    const exactConstructorId = irUnitCallableBindingId(constructorUnit!.id);
    expect(entries.find((entry) => entry.id === exactConstructorId)).toMatchObject({
      id: exactConstructorId,
      displayName: "HostError_new",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "source",
        unitId: constructorUnit!.id,
      },
    });

    const fabricatedNewSupport = irSupportFuncRef(hostErrorId, "class-constructor-new", "HostError_new");
    const fabricatedInitSupport = irSupportFuncRef(hostErrorId, "class-constructor-init", "HostError_init");
    if (fabricatedNewSupport.binding.kind !== "support" || fabricatedInitSupport.binding.kind !== "support") {
      throw new Error("expected constructor support references");
    }
    expect(entries.some((entry) => entry.id === fabricatedNewSupport.binding.bindingId)).toBe(false);
    expect(entries.some((entry) => entry.id === fabricatedInitSupport.binding.bindingId)).toBe(false);
    expect(entries.some((entry) => entry.displayName === "HostError_init")).toBe(false);
  });

  it("publishes a relocated parent init and preserves the IR super path after DCE", async () => {
    // Reuses the #3000-E parent-init shape. The user A_init function forces the
    // class-owned A_init allocator into the collision-free `__cm$A_init` slot.
    const source = `
      class A {
        #name: string;
        #age: number;
        constructor(name: string, age: number) {
          this.#name = name;
          this.#age = age;
        }
        describe(): string { return this.#name + "/" + this.#age.toString(); }
      }
      function A_init(): number { return 99; }
      class B extends A {
        #breed: string;
        constructor(name: string, age: number, breed: string) {
          super(name, age);
          this.#breed = breed;
        }
        breedInfo(): string { return this.#breed; }
      }
      export function main(): string {
        const value = new B("Rex", 4, "Lab");
        return value.describe() + "|" + value.breedInfo() + "|" + A_init().toString();
      }
    `;
    const { inventory, result } = generate(source, "class-init-collision.ts");
    const parentClassId = classId(inventory, "A");
    const parentConstructor = inventory.allUnits.find(
      (unit) => unit.lexicalOwnerId === parentClassId && unit.kind === "class-constructor",
    );
    expect(parentConstructor).toBeDefined();
    const parentInitBindingId = irUnitCallableBindingId(parentConstructor!.id);
    const newSupportRef = irSupportFuncRef(parentClassId, "class-constructor-new", "A_new");
    if (newSupportRef.binding.kind !== "support") throw new Error("expected class-new support reference");

    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["A_new", "B_new", "main"]));
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const publication = result.programAbi!;
    const entry = publication.abi.entries().find((candidate) => candidate.id === parentInitBindingId);
    expect(entry).toMatchObject({
      id: parentInitBindingId,
      displayName: "__cm$A_init",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "source",
        unitId: parentConstructor!.id,
      },
    });
    if (!entry || entry.intent.kind !== "callable") {
      throw new Error("missing exact parent class-init ABI entry");
    }

    expect(
      publication.abi.entries().find((candidate) => candidate.id === newSupportRef.binding.bindingId),
    ).toMatchObject({
      id: newSupportRef.binding.bindingId,
      displayName: "A_new",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        classId: parentClassId,
      },
    });

    const finalIndex = publication.abi.resolveFinalIndex(entry.id);
    expect(finalIndex).toEqual(expect.objectContaining({ space: "function" }));
    if (!finalIndex || finalIndex.space !== "function") {
      throw new Error("missing final parent class-init slot");
    }
    const importCount = result.module.imports.filter((candidate) => candidate.desc.kind === "func").length;
    const init = result.module.functions[finalIndex.index - importCount];
    expect(init?.name).toBe("__cm$A_init");
    const signature = init ? result.module.types[init.typeIdx] : undefined;
    expect(signature).toEqual(expect.objectContaining({ kind: "func" }));
    if (!signature || signature.kind !== "func") {
      throw new Error("missing final parent class-init signature");
    }
    expect(
      [...signature.params, ...signature.results].some((type) => type.kind === "ref" || type.kind === "ref_null"),
    ).toBe(true);
    expect(canonicalProgramAbiCallableTypeContract(signature)).toEqual(entry.intent.signature);

    const userInit = publication.abi
      .entries()
      .find(
        (candidate) =>
          candidate.displayName === "A_init" &&
          candidate.intent.kind === "callable" &&
          candidate.intent.origin === "source",
      );
    expect(userInit).toBeDefined();
    expect(publication.abi.resolveFinalIndex(userInit!.id)).not.toEqual(finalIndex);

    expect(String(await runtimeValue(source, true))).toBe("Rex/4|Lab|99");
  });
});
