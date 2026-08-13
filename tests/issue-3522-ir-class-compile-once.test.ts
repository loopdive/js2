// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isEarlyPreparableClassLayout } from "../src/codegen/program-abi-type-planning.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) "keeps `_new` AST-free" / "prepares a layout exactly once" are
// asserted as exact opcode sequences and `ref.cast` counts in the emitted body.
// The IR inliner (default ON since the tuned-set flip) splices callee bodies
// into those functions, so the sequences grow and the counts rise — the
// compile-once property is intact, the instrument just cannot see it any more.
// Pin the inliner off; compile-once is an IR-preparation property.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });
import { buildImports } from "../src/runtime.js";

function classMemberOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "class-member" && candidate.displayName === name,
  );
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

function functionOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult, deps?: Record<string, unknown>): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

function watFunctionIndex(wat: string, name: string): number {
  const importedFunctionCount = [...wat.matchAll(/^\s*\(import .+ \(func\b/gm)].length;
  const functions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = functions.indexOf(name);
  expect(index, `missing WAT function index for ${name}`).toBeGreaterThanOrEqual(0);
  return importedFunctionCount + index;
}

function watTypeDefinition(wat: string, name: string): string {
  const definition = wat.split("\n").find((line) => line.startsWith(`  (type $${name} `));
  expect(definition, `missing WAT type $${name}`).toBeDefined();
  return definition!;
}

function watGlobalIndex(wat: string, name: string): number {
  const importedGlobalCount = [...wat.matchAll(/^\s*\(import .+ \(global\b/gm)].length;
  const globals = [...wat.matchAll(/^\s*\(global \$([^\s(]+)/gm)].map((match) => match[1]!);
  const index = globals.indexOf(name);
  expect(index, `missing WAT global index for ${name}`).toBeGreaterThanOrEqual(0);
  return importedGlobalCount + index;
}

function watInstructionOpcodes(body: string): string[] {
  return body
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("(local "))
    .map((line) => line.split(/\s+/, 1)[0]!);
}

function watNullableRefResultTypeIndex(body: string, name: string): number {
  const header = body.split("\n")[0]!;
  const match = header.match(/\(result \(ref null (\d+)\)\)$/);
  expect(match, `missing nullable reference result for ${name}`).not.toBeNull();
  return Number(match![1]);
}

function watAnyStringTypeIndex(wat: string): number {
  expect(watTypeDefinition(wat, "AnyString")).toContain("(field $len i32)");
  const native = watTypeDefinition(wat, "NativeString").match(/\(sub \$type(\d+) /);
  const cons = watTypeDefinition(wat, "ConsString").match(/\(sub final \$type(\d+) /);
  expect(native, "NativeString must extend the native string root").not.toBeNull();
  expect(cons, "ConsString must extend the native string root").not.toBeNull();
  expect(cons![1]).toBe(native![1]);
  return Number(native![1]);
}

describe("#3522 instance class-method compile-once ownership", () => {
  it("admits scalar, reference-bearing, and inherited layouts through remappable Program ABI cells", () => {
    expect(
      isEarlyPreparableClassLayout({
        kind: "struct",
        name: "ScalarBox",
        fields: [
          { name: "__tag", type: { kind: "i32" }, mutable: false },
          { name: "value", type: { kind: "f64" }, mutable: true },
        ],
      }),
    ).toBe(true);
    expect(
      isEarlyPreparableClassLayout({
        kind: "struct",
        name: "StringBox",
        superTypeIdx: 3,
        fields: [
          { name: "__tag", type: { kind: "i32" }, mutable: false },
          { name: "value", type: { kind: "ref_null", typeIdx: 7 }, mutable: true },
        ],
      }),
    ).toBe(true);
  });

  it.each(["gc", "standalone"] as const)(
    "prepares the exact Animal/Dog constructor-method-accessor component once in the %s lane",
    async (target) => {
      const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
      const result = await compile(source, {
        fileName: "website/playground/examples/js/classes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const prepared = [
        "Animal_new",
        "Animal_get_name",
        "Animal_set_name",
        "Animal_get_age",
        "Animal_speak",
        "Dog_new",
        "Dog_speak",
        "Dog_get_breed",
        "Animal_kingdom",
        "Dog_kingdom",
      ];
      const componentIds = new Set<string>();
      for (const name of prepared) {
        const observed = classMemberOutcome(result, name);
        expect(observed).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
        componentIds.add(observed.preparedComponentId!);
      }
      expect(componentIds.size).toBeGreaterThan(0);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    },
  );

  it("preserves the unchanged Animal/Dog runtime trace", async () => {
    const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
    const result = await compile(source, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: true,
      target: "gc",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const observed: string[] = [];
    const consoleCapture = {
      log: (value: unknown): void => {
        observed.push(String(value));
      },
    };
    const exports = await instantiate(result, { console: consoleCapture });
    exports.main!();
    expect(observed).toEqual([
      "name  = Rex",
      "age   = 4",
      "breed = Labrador",
      "Rex makes a sound — woof!",
      "renamed: Rex Jr.",
      "rex instanceof Dog    = true",
      "rex instanceof Animal = true",
      "Animal.kingdom() = Animalia",
      "Dog.kingdom()    = Animalia (canine)",
    ]);
  });

  it.each(["gc", "standalone"] as const)(
    "never enters the direct emitter for prepared Animal/Dog constructors or members in the %s lane",
    async (target) => {
      const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        // Positive control: a parameter-property constructor remains deliberately
        // unsupported, so the same poison seam must still stop its direct body.
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "UnsupportedConstructor_new";
        const unsupported = await compile(
          `
          class UnsupportedConstructor {
            constructor(public value: number) {}
          }
          export function run(): number { return new UnsupportedConstructor(7).value; }
          `,
          {
            fileName: `unsupported-constructor-positive-control-${target}.ts`,
            experimentalIR: true,
            trackIrOutcomes: true,
            target,
          },
        );
        expect(unsupported.success).toBe(false);
        expect(classMemberOutcome(unsupported, "UnsupportedConstructor_new")).toMatchObject({
          kind: "unsupported",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(
          unsupported.errors.some((error) =>
            error.message.includes("injected direct class-body poison: UnsupportedConstructor_new"),
          ),
        ).toBe(true);

        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = [
          "Animal_new",
          "Animal_get_name",
          "Animal_set_name",
          "Animal_get_age",
          "Animal_speak",
          "Dog_new",
          "Dog_speak",
          "Dog_get_breed",
        ].join(",");
        const prepared = await compile(source, {
          fileName: "website/playground/examples/js/classes.ts",
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
        for (const name of ["Animal_new", "Dog_new"]) {
          expect(classMemberOutcome(prepared, name), `${name} must compile once through IR`).toMatchObject({
            kind: "emitted",
            legacyBodyEmitted: false,
            irBodyEmitted: true,
            preparedComponentId: expect.stringMatching(/^prepared-component:/),
          });
        }
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "runs the base constructor before derived work on the same allocated receiver in the %s lane",
    async (target) => {
      const result = await compile(
        `
        class Base {
          trace: number;
          label: string;
          constructor(label: string, age: number) {
            this.trace = 1;
            this.label = label;
            this.trace = this.trace * 10 + age;
          }
        }
        class Derived extends Base {
          suffix: string;
          constructor(label: string, age: number, suffix: string) {
            super(label, age);
            this.trace = this.trace * 10 + 3;
            this.suffix = suffix;
          }
        }
        export function run(): number {
          const value = new Derived("ab", 2, "xyz");
          return value.trace * 100 + value.label.length * 10 + value.suffix.length;
        }
        `,
        {
          fileName: `ir-constructor-ordering-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      for (const name of ["Base_new", "Derived_new"]) {
        expect(classMemberOutcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect((await instantiate(result)).run!()).toBe(12_323);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps _new AST-free and gives constructor source work exclusively to _init in the %s lane",
    async (target) => {
      const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
      const result = await compile(source, {
        fileName: "website/playground/examples/js/classes.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      for (const name of ["Animal_new", "Dog_new"]) {
        expect(classMemberOutcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }

      const animalNew = watFunctionBody(result.wat, "Animal_new");
      const animalInit = watFunctionBody(result.wat, "Animal_init");
      const dogNew = watFunctionBody(result.wat, "Dog_new");
      const dogInit = watFunctionBody(result.wat, "Dog_init");
      const animalInitIdx = watFunctionIndex(result.wat, "Animal_init");
      const dogInitIdx = watFunctionIndex(result.wat, "Dog_init");
      const animalTypeIdx = watNullableRefResultTypeIndex(animalNew, "Animal_new");
      const dogTypeIdx = watNullableRefResultTypeIndex(dogNew, "Dog_new");
      const currentThisIdx = watGlobalIndex(result.wat, "__current_this");
      const anyStringTypeIdx = target === "standalone" ? watAnyStringTypeIndex(result.wat) : undefined;

      // The exact source ABI keeps user parameters in source order and appends
      // the already allocated receiver last; `_init` returns that same type.
      const stringParam = target === "standalone" ? String.raw`\(ref null ${anyStringTypeIdx}\)` : "externref";
      expect(animalInit.split("\n")[0]!.trim()).toMatch(
        new RegExp(
          `^\\(func \\$Animal_init \\(param ${stringParam} f64 \\(ref null ${animalTypeIdx}\\)\\) \\(result \\(ref null ${animalTypeIdx}\\)\\)$`,
        ),
      );
      expect(dogInit.split("\n")[0]!.trim()).toMatch(
        new RegExp(
          `^\\(func \\$Dog_init \\(param ${stringParam} f64 ${stringParam} \\(ref null ${dogTypeIdx}\\)\\) \\(result \\(ref null ${dogTypeIdx}\\)\\)$`,
        ),
      );
      expect(animalNew).toContain(`struct.new ${animalTypeIdx}`);
      expect(dogNew).toContain(`struct.new ${dogTypeIdx}`);

      // Each `_new` is an AST-free support wrapper: allocate exactly once and
      // tail-call its `_init`. The exact opcode sequences exclude hidden calls,
      // globals, alternate allocation forms, and duplicated source work.
      for (const [body, initIdx, expectedOpcodes] of [
        [
          animalNew,
          animalInitIdx,
          [
            "i32.const",
            "ref.null",
            "f64.const",
            "struct.new",
            "local.set",
            "local.get",
            "local.get",
            "local.get",
            "return_call",
          ],
        ],
        [
          dogNew,
          dogInitIdx,
          [
            "i32.const",
            "ref.null",
            "f64.const",
            "ref.null",
            "struct.new",
            "local.set",
            "local.get",
            "local.get",
            "local.get",
            "local.get",
            "return_call",
          ],
        ],
      ] as const) {
        expect(watInstructionOpcodes(body)).toEqual(expectedOpcodes);
        expect(body.match(/\bstruct\.new\b/g) ?? []).toHaveLength(1);
        expect(body).not.toContain("struct.set");
        expect(body.match(/\breturn_call \d+\b/g) ?? []).toEqual([`return_call ${initIdx}`]);
      }

      // `_init` is the sole source-body owner. A derived init narrows the same
      // receiver to the parent ABI, runs the parent init once, then writes only
      // its own field; it never allocates a second instance.
      expect(animalInit).not.toContain("struct.new");
      expect(watInstructionOpcodes(animalInit)).toEqual([
        "local.get",
        "local.get",
        "struct.set",
        "local.get",
        "local.get",
        "struct.set",
        "local.get",
        "return",
      ]);
      expect(animalInit.match(/\bstruct\.set\b/g) ?? []).toHaveLength(2);
      expect(dogInit).not.toContain("struct.new");
      expect(watInstructionOpcodes(dogInit)).toEqual([
        "local.get",
        "local.get",
        "local.get",
        "ref.cast",
        "call",
        "drop",
        "local.get",
        "local.get",
        "struct.set",
        "local.get",
        "return",
      ]);
      expect(dogInit.match(/\bstruct\.set\b/g) ?? []).toHaveLength(1);
      expect(dogInit.match(new RegExp(`\\bcall ${animalInitIdx}\\b`, "g")) ?? []).toHaveLength(1);
      expect(result.wat.match(new RegExp(`\\bstruct\\.new ${animalTypeIdx}\\b`, "g")) ?? []).toHaveLength(1);
      expect(result.wat.match(new RegExp(`\\bstruct\\.new ${dogTypeIdx}\\b`, "g")) ?? []).toHaveLength(1);

      // Preserve the lane's native class layout: f64 stays unboxed and strings
      // use either the host carrier (gc) or `$AnyString` hierarchy (standalone).
      const stringFieldType = target === "standalone" ? String.raw`\(ref null ${anyStringTypeIdx}\)` : "externref";
      expect(watTypeDefinition(result.wat, "Animal")).toMatch(
        new RegExp(
          `\\(field \\$__priv_name \\(mut ${stringFieldType}\\)\\)[\\s\\S]*\\(field \\$__priv_age \\(mut f64\\)\\)`,
        ),
      );
      expect(watTypeDefinition(result.wat, "Dog")).toMatch(
        new RegExp(`\\(field \\$__priv_breed \\(mut ${stringFieldType}\\)\\)`),
      );

      for (const body of [animalNew, animalInit, dogNew, dogInit]) {
        expect(body).not.toMatch(new RegExp(`\\bglobal\\.(?:get|set) ${currentThisIdx}\\b`));
        expect(body).not.toMatch(
          /__current_this|__extern_(?:get|set)|(?:return_)?call_ref|any\.convert_extern|extern\.convert_any|ref\.test/,
        );
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps conditional, late, and repeated super constructors on the direct path in the %s lane",
    async (target) => {
      const cases = [
        {
          name: "ConditionalSuper",
          body: `
            constructor(value: number, branch: boolean) {
              if (branch) super(value);
              else super(value + 1);
            }
          `,
        },
        {
          name: "LateSuper",
          body: `
            constructor(value: number) {
              let adjusted: number = value + 1;
              super(adjusted);
            }
          `,
        },
        {
          name: "RepeatedSuper",
          body: `
            constructor(value: number) {
              super(value);
              super(value + 1);
            }
          `,
        },
      ] as const;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        for (const unsafe of cases) {
          const source = `
            class Base {
              value: number;
              constructor(value: number) { this.value = value; }
            }
            class ${unsafe.name} extends Base {
              ${unsafe.body}
            }
            export function marker(): number { return 1; }
          `;
          const fileName = `unsafe-${unsafe.name.toLowerCase()}-${target}.ts`;
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
          const direct = await compile(source, {
            fileName,
            experimentalIR: true,
            trackIrOutcomes: true,
            target,
          });
          expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
          expect(WebAssembly.validate(direct.binary)).toBe(true);
          expect(classMemberOutcome(direct, `${unsafe.name}_new`)).toMatchObject({
            kind: "unsupported",
            stage: "select",
            legacyBodyEmitted: true,
            irBodyEmitted: false,
          });
          expect(direct.irPostClaimErrors ?? []).toEqual([]);

          process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = `${unsafe.name}_new`;
          const poisoned = await compile(source, {
            fileName,
            experimentalIR: true,
            trackIrOutcomes: true,
            target,
          });
          expect(poisoned.success).toBe(false);
          expect(classMemberOutcome(poisoned, `${unsafe.name}_new`)).toMatchObject({
            kind: "unsupported",
            stage: "select",
            legacyBodyEmitted: true,
            irBodyEmitted: false,
          });
          expect(
            poisoned.errors.some((error) =>
              error.message.includes(`injected direct class-body poison: ${unsafe.name}_new`),
            ),
          ).toBe(true);
        }
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps constructor receiver calls on the virtual-dispatch direct path in the %s lane",
    async (target) => {
      const source = `
        let observed: number = 0;
        class A {
          constructor() { this.tag(); }
          tag(): void { observed = 1; }
        }
        class B extends A {
          constructor() { super(); }
          tag(): void { observed = 2; }
        }
        export function run(): number { new B(); return observed; }
      `;
      const fileName = `constructor-virtual-dispatch-${target}.ts`;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        const direct = await compile(source, {
          fileName,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(direct.binary)).toBe(true);
        expect(classMemberOutcome(direct, "A_new")).toMatchObject({
          kind: "unsupported",
          stage: "select",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect((await instantiate(direct)).run!()).toBe(2);
        expect(direct.irPostClaimErrors ?? []).toEqual([]);

        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "A_new";
        const poisoned = await compile(source, {
          fileName,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(poisoned.success).toBe(false);
        expect(
          poisoned.errors.some((error) => error.message.includes("injected direct class-body poison: A_new")),
        ).toBe(true);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps constructor receiver accessors on the direct dispatch path in the %s lane",
    async (target) => {
      const source = `
        class A {
          x: number;
          constructor() {
            this.value = 5;
            this.x = this.value;
          }
          set value(next: number) { this.x = next; }
          get value(): number { return this.x + 1; }
        }
        export function run(): number { return new A().x; }
      `;
      const fileName = `constructor-accessor-dispatch-${target}.ts`;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        const direct = await compile(source, {
          fileName,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(direct.binary)).toBe(true);
        expect(classMemberOutcome(direct, "A_new")).toMatchObject({
          kind: "unsupported",
          stage: "select",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect((await instantiate(direct)).run!()).toBe(6);
        expect(direct.irPostClaimErrors ?? []).toEqual([]);

        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "A_new";
        const poisoned = await compile(source, {
          fileName,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(poisoned.success).toBe(false);
        expect(
          poisoned.errors.some((error) => error.message.includes("injected direct class-body poison: A_new")),
        ).toBe(true);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps externref-backed constructors outside the prepared _new/_init split in the %s lane",
    async (target) => {
      const source = `
        class NativeError extends Error {
          code: number;
          constructor(message: string, code: number) {
            super(message);
            this.code = code;
          }
        }
        export function marker(): number { return 1; }
      `;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        const direct = await compile(source, {
          fileName: `externref-backed-constructor-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
        expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(direct.binary)).toBe(true);
        expect(classMemberOutcome(direct, "NativeError_new")).toMatchObject({
          kind: "unsupported",
          stage: "select",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(direct.wat).not.toContain("(func $NativeError_init");
        expect(direct.irPostClaimErrors ?? []).toEqual([]);

        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "NativeError_new";
        const poisoned = await compile(source, {
          fileName: `externref-backed-constructor-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(poisoned.success).toBe(false);
        expect(classMemberOutcome(poisoned, "NativeError_new")).toMatchObject({
          kind: "unsupported",
          stage: "select",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(
          poisoned.errors.some((error) => error.message.includes("injected direct class-body poison: NativeError_new")),
        ).toBe(true);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares every exact forward-class callable ABI position once in the %s lane",
    async (target) => {
      const source = `
        class Holder {
          constructor(current: Value) { current.amount = current.amount; }
          replace(next: Value): Value { return next; }
          get held(): Value { return new Value(5); }
          set held(next: Value) { next.amount = next.amount; }
          static keep(next: Value): Value { return next; }
        }
        class Value {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        export function run(): number {
          const holder = new Holder(new Value(3));
          holder.held = holder.replace(new Value(4));
          return Holder.keep(holder.held).amount;
        }
      `;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      try {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        const direct = await compile(source, {
          fileName: `forward-class-constructor-param-${target}.ts`,
          experimentalIR: false,
          emitWat: true,
          target,
        });
        const prepared = await compile(source, {
          fileName: `forward-class-constructor-param-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
        expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(direct.binary)).toBe(true);
        expect(WebAssembly.validate(prepared.binary)).toBe(true);
        expect((await instantiate(direct)).run!()).toBe(5);
        expect((await instantiate(prepared)).run!()).toBe(5);
        for (const name of [
          "Holder_new",
          "Holder_replace",
          "Holder_get_held",
          "Holder_set_held",
          "Holder_keep",
          "Value_new",
        ]) {
          const observed = classMemberOutcome(prepared, name);
          expect(observed, `${name} must compile once through IR: ${JSON.stringify(observed)}`).toMatchObject({
            kind: "emitted",
            legacyBodyEmitted: false,
            irBodyEmitted: true,
          });
        }
        expect(prepared.irPostClaimErrors ?? []).toEqual([]);
        expect(prepared.binary.length).toBeLessThanOrEqual(direct.binary.length);

        const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(prepared.wat, "Value_new"), "Value_new");
        for (const name of ["Holder_init", "Holder_replace", "Holder_get_held", "Holder_set_held", "Holder_keep"]) {
          const body = watFunctionBody(prepared.wat, name);
          expect(body.split("\n")[0], `${name} forward-class ABI`).toContain(`(ref null ${valueTypeIdx})`);
          expect(body).not.toMatch(
            /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
          );
        }

        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY =
          "Holder_new,Holder_replace,Holder_get_held,Holder_set_held,Holder_keep,Value_new";
        const poisoned = await compile(source, {
          fileName: `forward-class-constructor-param-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
        expect(poisoned.success, poisoned.errors.map((error) => error.message).join("\n")).toBe(true);
        expect((await instantiate(poisoned)).run!()).toBe(5);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares an exact class-typed field only when its committed struct ABI matches in the %s lane",
    async (target) => {
      const source = `
        class Value {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        class Holder {
          current: Value;
          constructor(current: Value) { this.current = current; }
          read(): number { return this.current.amount; }
        }
        export function run(): number { return new Holder(new Value(42)).read(); }
      `;
      const direct = await compile(source, {
        fileName: `exact-class-field-abi-${target}.ts`,
        experimentalIR: false,
        emitWat: true,
        target,
      });
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Value_new,Holder_new,Holder_read";
        prepared = await compile(source, {
          fileName: `exact-class-field-abi-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }

      for (const result of [direct, prepared]) {
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        expect((await instantiate(result)).run!()).toBe(42);
      }
      for (const name of ["Value_new", "Holder_new", "Holder_read"]) {
        expect(classMemberOutcome(prepared, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.binary.length).toBeLessThanOrEqual(direct.binary.length);

      const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(prepared.wat, "Value_new"), "Value_new");
      expect(watTypeDefinition(prepared.wat, "Holder")).toContain(`(field $current (mut (ref null ${valueTypeIdx})))`);
      for (const name of ["Holder_init", "Holder_read"]) {
        const body = watFunctionBody(prepared.wat, name);
        expect(body).not.toMatch(
          /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
        );
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "commits an exact forward class field before prepared bodies in the %s lane",
    async (target) => {
      const source = `
        class Holder {
          current: Value;
          constructor(current: Value) { this.current = current; }
          replace(next: Value): Value {
            const previous = this.current;
            this.current = next;
            return previous;
          }
        }
        class Value {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        export function run(): number {
          const holder = new Holder(new Value(2));
          const previous = holder.replace(new Value(5));
          return previous.amount * 10 + holder.current.amount;
        }
      `;
      const direct = await compile(source, {
        fileName: `forward-class-field-abi-${target}.ts`,
        experimentalIR: false,
        emitWat: true,
        target,
      });
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Holder_new,Holder_replace,Value_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        prepared = await compile(source, {
          fileName: `forward-class-field-abi-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
      } finally {
        if (previousClassPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        }
        if (previousFunctionPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
        }
      }

      for (const result of [direct, prepared]) {
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        expect((await instantiate(result)).run!()).toBe(25);
      }
      for (const name of ["Holder_new", "Holder_replace", "Value_new"]) {
        expect(classMemberOutcome(prepared, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      expect(functionOutcome(prepared, "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.binary.length).toBeLessThanOrEqual(direct.binary.length);
      expect(watTypeDefinition(direct.wat, "Holder")).toContain("(field $current (mut externref))");

      const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(prepared.wat, "Value_new"), "Value_new");
      expect(watTypeDefinition(prepared.wat, "Holder")).toContain(`(field $current (mut (ref null ${valueTypeIdx})))`);
      for (const name of ["Holder_init", "Holder_replace", "run"]) {
        expect(watFunctionBody(prepared.wat, name)).not.toMatch(
          /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
        );
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "preserves typed forward-field initialization without a direct body in the %s lane",
    async (target) => {
      const source = `
        class Holder {
          current: Value = new Value(2);
          read(): number { return this.current.amount; }
        }
        class Value {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        export function run(): number {
          const holder = new Holder();
          const before = holder.read();
          holder.current = new Value(5);
          return before * 10 + holder.read();
        }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Holder_new,Holder_read,Value_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        prepared = await compile(source, {
          fileName: `forward-class-field-initializer-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
      } finally {
        if (previousClassPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        }
        if (previousFunctionPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
        }
      }

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(25);
      for (const name of ["Holder_new", "Holder_read", "Value_new"]) {
        expect(classMemberOutcome(prepared, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      expect(functionOutcome(prepared, "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(prepared.wat, "Value_new"), "Value_new");
      expect(watTypeDefinition(prepared.wat, "Holder")).toContain(`(field $current (mut (ref null ${valueTypeIdx})))`);
      for (const name of ["Holder_init", "Holder_read", "run"]) {
        expect(watFunctionBody(prepared.wat, name)).not.toMatch(
          /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
        );
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps multiple public and private forward fields on exact storage in the %s lane",
    async (target) => {
      const source = `
        class Holder {
          first: Value;
          #second: Value;
          constructor(first: Value, second: Value) {
            this.first = first;
            this.#second = second;
          }
          total(): number { return this.first.amount + this.#second.amount; }
        }
        class Value {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        export function run(): number { return new Holder(new Value(2), new Value(5)).total(); }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Holder_new,Holder_total,Value_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        prepared = await compile(source, {
          fileName: `forward-class-private-fields-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
      } finally {
        if (previousClassPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        }
        if (previousFunctionPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
        }
      }

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expect((await instantiate(prepared)).run!()).toBe(7);
      for (const name of ["Holder_new", "Holder_total", "Value_new"]) {
        expect(classMemberOutcome(prepared, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      expect(functionOutcome(prepared, "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(prepared.wat, "Value_new"), "Value_new");
      const holderType = watTypeDefinition(prepared.wat, "Holder");
      expect(holderType).toContain(`(field $first (mut (ref null ${valueTypeIdx})))`);
      expect(holderType).toContain(`(field $__priv_second (mut (ref null ${valueTypeIdx})))`);
      expect(watFunctionBody(prepared.wat, "Holder_total")).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
      );
    },
  );

  it.each(["gc", "standalone"] as const)(
    "shares the finalized forward-field ABI with an adjacent typed direct fallback in the %s lane",
    async (target) => {
      const source = `
        class Holder {
          current: Value;
          constructor(current: Value) { this.current = current; }
          read(extra: number = 0): number { return this.current.amount + extra; }
        }
        class Value {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        export function run(): number { return new Holder(new Value(40)).read(2); }
      `;
      const result = await compile(source, {
        fileName: `forward-class-field-hybrid-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect((await instantiate(result)).run!()).toBe(42);
      expect(classMemberOutcome(result, "Holder_read")).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(result.wat, "Value_new"), "Value_new");
      expect(watTypeDefinition(result.wat, "Holder")).toContain(`(field $current (mut (ref null ${valueTypeIdx})))`);
      expect(watFunctionBody(result.wat, "Holder_read")).toContain("struct.get");
      expect(watFunctionBody(result.wat, "Holder_read")).not.toContain("__extern_get");
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares an inherited forward-field layout exactly once in the %s lane",
    async (target) => {
      const source = `
        class Amount {
          amount: number;
          constructor(amount: number) { this.amount = amount; }
        }
        class Base {
          current: Value;
          constructor(current: Value) { this.current = current; }
          read(): number { return this.current.amount; }
        }
        class Child extends Base {
          other: Value;
          constructor(current: Value, other: Value) {
            super(current);
            this.other = other;
          }
          combined(): number { return this.current.amount + this.other.amount; }
        }
        class Value extends Amount {
          constructor(amount: number) { super(amount); }
        }
        export function run(): number {
          const child = new Child(new Value(4), new Value(5));
          return child.read() + child.combined();
        }
      `;
      const direct = await compile(source, {
        fileName: `forward-class-field-inheritance-${target}.ts`,
        experimentalIR: false,
        emitWat: true,
        target,
      });
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY =
          "Amount_new,Base_new,Base_read,Child_new,Child_combined,Value_new";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        result = await compile(source, {
          fileName: `forward-class-field-inheritance-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
      } finally {
        if (previousClassPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        }
        if (previousFunctionPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
        }
      }

      for (const compiled of [direct, result]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!()).toBe(13);
      }
      for (const name of ["Amount_new", "Base_new", "Base_read", "Child_new", "Child_combined", "Value_new"]) {
        expect(classMemberOutcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      expect(functionOutcome(result, "run")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(result.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
      expect(watTypeDefinition(direct.wat, "Base")).toContain("(field $current (mut externref))");
      expect(watTypeDefinition(direct.wat, "Child")).toContain("(field $current (mut externref))");

      const valueTypeIdx = watNullableRefResultTypeIndex(watFunctionBody(result.wat, "Value_new"), "Value_new");
      expect(watTypeDefinition(result.wat, "Base")).toContain(`(field $current (mut (ref null ${valueTypeIdx})))`);
      expect(watTypeDefinition(result.wat, "Child")).toContain(`(field $current (mut (ref null ${valueTypeIdx})))`);
      expect(watTypeDefinition(result.wat, "Child")).toContain(`(field $other (mut (ref null ${valueTypeIdx})))`);
      for (const name of ["Base_init", "Base_read", "Child_combined"]) {
        expect(watFunctionBody(result.wat, name)).not.toMatch(
          /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.(?:test|cast)/,
        );
      }
      // Preserve the direct-super optimization: the derived initializer uses
      // one static subtype-to-parent narrowing and one direct call, never a
      // dynamic dispatch ladder or an externref conversion.
      const childInit = watFunctionBody(result.wat, "Child_init");
      expect(watInstructionOpcodes(childInit)).toEqual([
        "local.get",
        "local.get",
        "ref.cast",
        "call",
        "drop",
        "local.get",
        "local.get",
        "struct.set",
        "local.get",
        "return",
      ]);
      expect(childInit).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.test/,
      );
      const runBody = watFunctionBody(result.wat, "run");
      expect(runBody).not.toMatch(/externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.test/);
      expect(runBody.match(/ref\.cast/g) ?? []).toHaveLength(1);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares mutually recursive class layouts exactly once in the %s lane",
    async (target) => {
      const source = `
        class Left {
          right!: Right;
          constructor() {}
          attach(right: Right): void { this.right = right; }
          value(): number { return this.right.amount; }
        }
        class Right {
          left!: Left;
          amount: number;
          constructor(amount: number) { this.amount = amount; }
          attach(left: Left): void { this.left = left; }
        }
        export function run(): number {
          const left = new Left();
          const right = new Right(7);
          left.attach(right);
          right.attach(left);
          return left.value() + right.left.value();
        }
      `;
      const direct = await compile(source, {
        fileName: `cyclic-class-constructor-abi-${target}.ts`,
        experimentalIR: false,
        emitWat: true,
        target,
      });
      expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(direct.binary)).toBe(true);
      expect((await instantiate(direct)).run!()).toBe(14);
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = [
          "Left_new",
          "Left_attach",
          "Left_value",
          "Right_new",
          "Right_attach",
        ].join(",");
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        const result = await compile(source, {
          fileName: `cyclic-class-constructor-abi-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        for (const name of ["Left_new", "Left_attach", "Left_value", "Right_new", "Right_attach"]) {
          expect(classMemberOutcome(result, name)).toMatchObject({
            kind: "emitted",
            legacyBodyEmitted: false,
            irBodyEmitted: true,
          });
        }
        expect(functionOutcome(result, "run")).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(watTypeDefinition(result.wat, "Left")).toContain("(field $right (mut (ref null");
        expect(watTypeDefinition(result.wat, "Right")).toContain("(field $left (mut (ref null");
        for (const name of ["Left_attach", "Left_value", "Right_attach", "run"]) {
          expect(watFunctionBody(result.wat, name)).not.toMatch(
            /any\.convert_extern|extern\.convert_any|ref\.(?:test|cast)|call_ref|call_indirect/,
          );
        }
        expect((await instantiate(result)).run!()).toBe(14);
        expect(result.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
      } finally {
        if (previousClassPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        if (previousFunctionPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares a self-recursive class layout exactly once in the %s lane",
    async (target) => {
      const source = `
        class Node {
          next!: Node;
          value: number;
          constructor(value: number) { this.value = value; }
          link(next: Node): void { this.next = next; }
          sum(): number { return this.value + this.next.value; }
        }
        export function run(): number {
          const first = new Node(3);
          const second = new Node(4);
          first.link(second);
          return first.sum();
        }
      `;
      const previousClassPoison = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      const previousFunctionPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Node_new,Node_link,Node_sum";
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run";
        const result = await compile(source, {
          fileName: `self-recursive-class-layout-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          emitWat: true,
          target,
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        for (const name of ["Node_new", "Node_link", "Node_sum"]) {
          expect(classMemberOutcome(result, name)).toMatchObject({
            kind: "emitted",
            legacyBodyEmitted: false,
            irBodyEmitted: true,
          });
        }
        expect(functionOutcome(result, "run")).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
        expect(watTypeDefinition(result.wat, "Node")).toContain("(field $next (mut (ref null");
        for (const name of ["Node_link", "Node_sum", "run"]) {
          expect(watFunctionBody(result.wat, name)).not.toMatch(
            /any\.convert_extern|extern\.convert_any|ref\.(?:test|cast)|call_ref|call_indirect/,
          );
        }
        expect((await instantiate(result)).run!()).toBe(7);
      } finally {
        if (previousClassPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClassPoison;
        if (previousFunctionPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunctionPoison;
      }
    },
  );

  it("preserves typed receivers, private struct fields, direct super dispatch, and string concat", async () => {
    const source = readFileSync(new URL("../website/playground/examples/js/classes.ts", import.meta.url), "utf8");
    const direct = await compile(source, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: false,
      emitWat: true,
    });
    const prepared = await compile(source, {
      fileName: "website/playground/examples/js/classes.ts",
      experimentalIR: true,
      emitWat: true,
    });
    for (const result of [direct, prepared]) {
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    }

    for (const wat of [direct.wat, prepared.wat]) {
      for (const name of ["Animal_get_name", "Animal_get_age", "Animal_speak", "Dog_get_breed"]) {
        expect(watFunctionBody(wat, name)).toContain("struct.get");
      }
      expect(watFunctionBody(wat, "Animal_set_name")).toContain("struct.set");
    }
    const directAnimalSpeak = watFunctionBody(direct.wat, "Animal_speak");
    expect(directAnimalSpeak).toMatch(/ref\.test|ref\.cast/);

    const directDogSpeak = watFunctionBody(direct.wat, "Dog_speak");
    const preparedAnimalSpeak = watFunctionBody(prepared.wat, "Animal_speak");
    const preparedDogSpeak = watFunctionBody(prepared.wat, "Dog_speak");
    expect(preparedAnimalSpeak.match(/\bcall \d+/g) ?? []).toHaveLength(1);
    expect(preparedDogSpeak.match(/\bcall \d+/g) ?? []).toHaveLength(2);
    for (const body of [directDogSpeak, preparedDogSpeak]) {
      expect(body.match(/ref\.cast/g) ?? []).toHaveLength(1);
      expect(body).not.toMatch(/ref\.test|__extern_(?:get|set)|extern\.convert_any/);
    }
    for (const body of [
      preparedAnimalSpeak,
      watFunctionBody(prepared.wat, "Animal_get_name"),
      watFunctionBody(prepared.wat, "Animal_set_name"),
      watFunctionBody(prepared.wat, "Dog_get_breed"),
    ]) {
      expect(body).not.toMatch(/__extern_(?:get|set)|extern\.convert_any|ref\.(?:test|cast)/);
    }
  });

  it.each(["gc", "standalone"] as const)(
    "keeps inherited class-call targets inside the sealed prepared component in the %s lane",
    async (target) => {
      const source = `
        class Base {
          value: number = 10;
          getValue(): number { return this.value; }
        }
        class Child extends Base {
          extra: number = 20;
          sum(): number { return this.getValue() + this.extra; }
        }
        export function run(): number { return new Child().sum(); }
      `;
      const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
      let result: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Base_getValue,Child_sum";
        result = await compile(source, {
          fileName: `ir-inherited-prepared-target-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
      }

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      for (const name of ["Base_getValue", "Child_sum"]) {
        expect(classMemberOutcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiate(result)).run!()).toBe(30);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "prepares a two-method %s class component once while an Unsupported sibling stays direct",
    async (target) => {
      const result = await compile(
        `
        class Calculator {
          value: number;
          constructor(value: number) { this.value = value; }
          add(delta: number): number { return this.value + delta; }
          scale(factor: number): number { return this.value * factor; }
        }
        class LegacyCalculator {
          label: string;
          constructor(label: string) { this.label = label; }
          withDefault(value: number = 9): number { return this.label.length + value; }
        }
        export function run(value: number): number {
          const calculator = new Calculator(value);
          return calculator.add(2) * 100 + calculator.scale(3) * 10 + new LegacyCalculator("legacy").withDefault();
        }
        `,
        {
          fileName: `ir-instance-method-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          target,
        },
      );

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      const add = classMemberOutcome(result, "Calculator_add");
      const scale = classMemberOutcome(result, "Calculator_scale");
      for (const observed of [add, scale]) {
        expect(observed).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }
      expect(scale.preparedComponentId).toBe(add.preparedComponentId);
      expect(classMemberOutcome(result, "LegacyCalculator_withDefault")).toMatchObject({
        kind: "unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect((await instantiate(result)).run!(5)).toBe(865);
    },
  );

  it("fails an instance-method invariant without retrying the direct body emitter", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE;
    process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE = "Box_read";
    let result: CompileResult;
    try {
      result = await compile(
        `
        class Box {
          value: number;
          constructor(value: number) { this.value = value; }
          read(): number { return this.value; }
        }
        export function run(): number { return new Box(7).read(); }
        `,
        {
          fileName: "ir-instance-method-invariant.ts",
          experimentalIR: true,
          trackIrOutcomes: true,
        },
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE");
      else process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE = previous;
    }

    expect(result.success).toBe(false);
    expect(classMemberOutcome(result, "Box_read")).toMatchObject({
      kind: "invariant",
      code: "verifier-failure",
      stage: "verify",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
  });
});
