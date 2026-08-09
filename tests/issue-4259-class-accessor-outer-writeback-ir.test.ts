// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

function exactAccessorUnits(source: string, fileName: string): readonly IrTerminalUnitRecord[] {
  const ast = analyzeSource(source, fileName);
  const inventory = buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  });
  return inventory.terminalUnits.filter(
    (unit) =>
      unit.observedKind === "class-member" &&
      (unit.kind === "class-instance-getter" ||
        unit.kind === "class-static-getter" ||
        unit.kind === "class-instance-setter" ||
        unit.kind === "class-static-setter"),
  );
}

function exactOutcome(result: CompileResult, unitId: IrUnitId): IrObservedOutcome {
  const outcomes = (result.irOutcomes ?? []).filter((candidate) => candidate.unitId === unitId);
  expect(outcomes, `outcome count for ${unitId}`).toHaveLength(1);
  return outcomes[0]!;
}

async function instantiateAndInitialize(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  exports.__module_init?.();
  return exports;
}

const SUCCESS_SOURCE = `
  let declInstanceSet: any;
  let declStaticSet: any;
  let exprInstanceSet: any;
  let exprStaticSet: any;
  let getterMark: string = "";
  let setterMark: string = "";

  export function run(): number {
    class DeclInstance {
      get di() { return "di-get"; }
      set di(value) { declInstanceSet = value; }
    }
    class DeclStatic {
      static get 2() { return "ds-get"; }
      static set 2(value) { declStaticSet = value; }
    }
    let ExprInstance = class {
      get [getterMark = "g"]() { return "ei-get"; }
      set [setterMark = "s"](value) { exprInstanceSet = value; }
    };
    let ExprStatic = class {
      static get es() { return "es-get"; }
      static set es(value) { exprStaticSet = value; }
    };

    let score: number = 0;
    if (DeclInstance.prototype.di === "di-get") score = score | 1;
    DeclInstance.prototype.di = "di-set";
    if (declInstanceSet === "di-set") score = score | 2;
    if (DeclStatic[2] === "ds-get") score = score | 4;
    DeclStatic[2] = "ds-set";
    if (declStaticSet === "ds-set") score = score | 8;
    if (ExprInstance.prototype["g"] === "ei-get") score = score | 16;
    ExprInstance.prototype["s"] = "ei-set";
    if (exprInstanceSet === "ei-set") score = score | 32;
    if (ExprStatic["es"] === "es-get") score = score | 64;
    ExprStatic["es"] = "es-set";
    if (exprStaticSet === "es-set") score = score | 128;
    if (getterMark === "g" && setterMark === "s") score = score | 256;
    return score;
  }
`;

describe("#4259 class accessor outer-binding writeback IR", () => {
  it.each(TARGETS)(
    "IR-owns declaration/expression × instance/static getter/setter bodies once in the %s lane",
    async (target) => {
      const fileName = `issue-4259-all-accessors-${target}.ts`;
      const units = exactAccessorUnits(SUCCESS_SOURCE, fileName);
      expect(units).toHaveLength(8);

      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = [
          "DeclInstance_get_di",
          "DeclInstance_set_di",
          "DeclStatic_get_2",
          "DeclStatic_set_2",
          "__anonClass_0_get_g",
          "__anonClass_0_set_s",
          "__anonClass_1_get_es",
          "__anonClass_1_set_es",
        ].join(",");
        result = await compile(SUCCESS_SOURCE, {
          fileName,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
          deferTopLevelInit: true,
          hostBridge: "always",
          skipSemanticDiagnostics: true,
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const componentIds = new Set<string>();
      for (const unit of units) {
        const outcome = exactOutcome(result, unit.id);
        expect(outcome).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
        componentIds.add(outcome.preparedComponentId!);
      }
      expect(componentIds.size).toBe(4);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiateAndInitialize(result)).run!()).toBe(511);
    },
  );

  it.each(TARGETS)("throws ReferenceError before an outer let is initialized in the %s lane", async (target) => {
    const source = `
      function trigger(): void {
        const C = class {
          set value(next) { target = next; }
        };
        new C().value = 42;
      }
      var verdict: number = 0;
      try {
        trigger();
      } catch (error) {
        verdict = error instanceof ReferenceError ? 1 : 2;
      }
      let target: any;
      export function run(): number { return verdict; }
    `;
    const fileName = `issue-4259-tdz-${target}.ts`;
    const [setter] = exactAccessorUnits(source, fileName);
    expect(setter).toBeDefined();
    const result = await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
      deferTopLevelInit: true,
      hostBridge: "always",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(exactOutcome(result, setter!.id)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect((await instantiateAndInitialize(result)).run!()).toBe(1);
  });

  it.each(TARGETS)(
    "executes top-level class-root setter writes through IR-owned accessors in the %s lane",
    async (target) => {
      const source = `
        var exprInstanceSet;
        var exprStaticSet;
        var declInstanceSet;
        var declStaticSet;
        var computedSet;
        var computedKeyMark;

        var ExprInstance = class {
          get 2() { return "ei-get"; }
          set 2(value) { exprInstanceSet = value; }
        };
        var ExprStatic = class {
          static get "es"() { return "es-get"; }
          static set "es"(value) { exprStaticSet = value; }
        };
        class DeclInstance {
          get di() { return "di-get"; }
          set di(value) { declInstanceSet = value; }
        }
        class DeclStatic {
          static get 4() { return "ds-get"; }
          static set 4(value) { declStaticSet = value; }
        }
        class DeclComputed {
          get [computedKeyMark = "ck"]() { return "ck-get"; }
          set [computedKeyMark = "ck"](value) { computedSet = value; }
        }

        var exprInstanceGet = ExprInstance.prototype["2"];
        var exprStaticGet = ExprStatic["es"];
        var declInstanceGet = DeclInstance.prototype["di"];
        var declStaticGet = DeclStatic["4"];
        var computedGet = DeclComputed.prototype["ck"];

        ExprInstance.prototype["2"] = "ei-set";
        ExprStatic["es"] = "es-set";
        DeclInstance.prototype["di"] = "di-set";
        DeclStatic["4"] = "ds-set";
        DeclComputed.prototype["ck"] = "ck-set";

        export function run(): number {
          let score = 0;
          if (exprInstanceGet === "ei-get" && exprInstanceSet === "ei-set") score = score | 1;
          if (exprStaticGet === "es-get" && exprStaticSet === "es-set") score = score | 2;
          if (declInstanceGet === "di-get" && declInstanceSet === "di-set") score = score | 4;
          if (declStaticGet === "ds-get" && declStaticSet === "ds-set") score = score | 8;
          if (computedGet === "ck-get" && computedSet === "ck-set" && computedKeyMark === "ck") score = score | 16;
          return score;
        }
      `;
      const fileName = `issue-4259-top-level-class-root-write-${target}.ts`;
      const units = exactAccessorUnits(source, fileName);
      expect(units).toHaveLength(10);
      const result = await compile(source, {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
        deferTopLevelInit: true,
        hostBridge: "always",
        skipSemanticDiagnostics: true,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      for (const unit of units) {
        expect(exactOutcome(result, unit.id)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiateAndInitialize(result)).run!()).toBe(31);
    },
  );

  it.each(TARGETS)("does not dispatch a static write to an instance setter in the %s lane", async (target) => {
    const source = `
      var setterValue;
      class MixedPlacement {
        static get value() { return "static-get"; }
        set value(next) { setterValue = next; }
      }

      var observed = MixedPlacement["value"];
      MixedPlacement["value"] = "wrong-placement";

      export function run(): number {
        return observed === "static-get" && setterValue === undefined ? 1 : 0;
      }
    `;
    const fileName = `issue-4259-top-level-mixed-placement-${target}.ts`;
    const units = exactAccessorUnits(source, fileName);
    expect(units).toHaveLength(2);
    const result = await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
      deferTopLevelInit: true,
      hostBridge: "always",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    for (const unit of units) {
      expect(exactOutcome(result, unit.id)).toMatchObject({
        kind: "unsupported",
        code: "class-member-unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(exactOutcome(result, unit.id)).not.toHaveProperty("preparedComponentId");
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect((await instantiateAndInitialize(result)).run!()).toBe(1);
  });

  it.each(TARGETS)(
    "declines a stale class-root dispatch after an intervening reference in the %s lane",
    async (target) => {
      const source = `
      var setterValue;
      class Rebound {
        static get value() { return "original-get"; }
        static set value(next) { setterValue = next; }
      }
      class Replacement {}
      function replaceBinding() { Rebound = Replacement; }

      var observed = Rebound["value"];
      replaceBinding();
      Rebound["value"] = "replacement-write";

      export function run(): number {
        return observed === "original-get" && setterValue === undefined ? 1 : 0;
      }
    `;
      const fileName = `issue-4259-top-level-intervening-reference-${target}.ts`;
      const units = exactAccessorUnits(source, fileName);
      expect(units).toHaveLength(2);
      const result = await compile(source, {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
        deferTopLevelInit: true,
        hostBridge: "always",
        skipSemanticDiagnostics: true,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      for (const unit of units) {
        expect(exactOutcome(result, unit.id)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiateAndInitialize(result)).run!()).toBe(1);
    },
  );

  it.each(TARGETS)("rejects mutated value/TDZ evidence from a sibling lexical in the %s lane", async (target) => {
    const source = `
      function triggerFirst(): void {
        class First { set value(next) { first = next; } }
        new First().value = 1;
      }
      function triggerSecond(): void {
        class Second { set value(next) { second = next; } }
        new Second().value = 2;
      }
      try { triggerFirst(); } catch {}
      try { triggerSecond(); } catch {}
      let first: any;
      let second: any;
      export function run(): number { return 1; }
    `;
    const fileName = `issue-4259-tdz-pair-${target}.ts`;
    const units = exactAccessorUnits(source, fileName);
    expect(units).toHaveLength(2);
    const previous = process.env.JS2WASM_TEST_MUTATE_IR_ACCESSOR_TDZ_VALUE_PAIR;
    let result: CompileResult;
    try {
      process.env.JS2WASM_TEST_MUTATE_IR_ACCESSOR_TDZ_VALUE_PAIR = "1";
      result = await compile(source, {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
        deferTopLevelInit: true,
        hostBridge: "always",
        skipSemanticDiagnostics: true,
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_MUTATE_IR_ACCESSOR_TDZ_VALUE_PAIR");
      else process.env.JS2WASM_TEST_MUTATE_IR_ACCESSOR_TDZ_VALUE_PAIR = previous;
    }

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(exactOutcome(result, units[0]!.id)).toMatchObject({
      kind: "unsupported",
      code: "late-preparation-unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(exactOutcome(result, units[0]!.id)).not.toHaveProperty("preparedComponentId");
    expect(exactOutcome(result, units[1]!.id)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
  });

  it.each(TARGETS)(
    "typed-demotes a component before direct codegen when ABI sealing fails in the %s lane",
    async (target) => {
      const source = `
      var sink: any;
      export function run(): number {
        class Accessor {
          get value() { return "value"; }
          set value(next) { sink = next; }
        }
        const instance = new Accessor();
        instance.value = "set";
        return instance.value === "value" && sink === "set" ? 1 : 0;
      }
    `;
      const fileName = `issue-4259-seal-failure-${target}.ts`;
      const units = exactAccessorUnits(source, fileName);
      expect(units).toHaveLength(2);
      const previous = process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE = "1";
        result = await compile(source, {
          fileName,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
          deferTopLevelInit: true,
          hostBridge: "always",
          skipSemanticDiagnostics: true,
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE");
        else process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE = previous;
      }

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      for (const unit of units) {
        expect(exactOutcome(result, unit.id)).toMatchObject({
          kind: "unsupported",
          code: "late-preparation-unsupported",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(exactOutcome(result, unit.id)).not.toHaveProperty("preparedComponentId");
      }
      expect((await instantiateAndInitialize(result)).run!()).toBe(1);
    },
  );

  it.each(TARGETS)("keeps a mutable computed key on the atomic direct path in the %s lane", async (target) => {
    const source = `
      let key: string = "a";
      let sink: any;
      export function run(): number {
        key = "b";
        class DynamicKey {
          get [key]() { return "value"; }
          set [key](next) { sink = next; }
        }
        return 1;
      }
    `;
    const fileName = `issue-4259-dynamic-key-${target}.ts`;
    const units = exactAccessorUnits(source, fileName);
    expect(units).toHaveLength(2);
    const result = await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
      deferTopLevelInit: true,
      hostBridge: "always",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    for (const unit of units) {
      expect(exactOutcome(result, unit.id)).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(exactOutcome(result, unit.id)).not.toHaveProperty("preparedComponentId");
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)("claims every accessor in a bounded class or none in the %s lane", async (target) => {
    const source = `
      let sink: any;
      export function run(): number {
        class MixedAbi {
          get value() { return 1; }
          set value(next) { sink = next; }
        }
        return 1;
      }
    `;
    const fileName = `issue-4259-atomic-claim-${target}.ts`;
    const units = exactAccessorUnits(source, fileName);
    expect(units).toHaveLength(2);
    const result = await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
      deferTopLevelInit: true,
      hostBridge: "always",
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    for (const unit of units) {
      expect(exactOutcome(result, unit.id)).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(exactOutcome(result, unit.id)).not.toHaveProperty("preparedComponentId");
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([
    {
      label: "instance/static same-key collision",
      source: `
        let sink: any;
        export function run(): number {
          class Collision {
            get same() { return "instance"; }
            set same(value) { sink = value; }
            static get same() { return "static"; }
            static set same(value) { sink = value; }
          }
          return 1;
        }
      `,
    },
    {
      label: "static this",
      source: `
        let sink: any;
        export function run(): number {
          class StaticThis {
            static get value() { return this; }
            static set value(next) { sink = next; }
          }
          return 1;
        }
      `,
    },
    {
      label: "derived static super",
      source: `
        let sink: any;
        export function run(): number {
          class Parent { static get value() { return "parent"; } }
          class Derived extends Parent {
            static get value() { return super.value; }
            static set value(next) { sink = next; }
          }
          return 1;
        }
      `,
    },
  ])("demotes every bounded accessor before selection for $label", async ({ label, source }) => {
    const fileName = `issue-4259-control-${label.replaceAll(" ", "-")}.ts`;
    const allUnits = exactAccessorUnits(source, fileName);
    const units =
      label === "derived static super"
        ? allUnits.filter((unit) => unit.legacyMatchName.startsWith("Derived_"))
        : allUnits;
    expect(units.length).toBeGreaterThan(0);
    const result = await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    for (const unit of units) {
      const outcome = exactOutcome(result, unit.id);
      expect(outcome.kind).toBe("unsupported");
      expect(outcome.irBodyEmitted).toBe(false);
      expect(outcome).not.toHaveProperty("preparedComponentId");
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
