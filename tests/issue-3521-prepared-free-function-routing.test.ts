// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { irFirstBodyIsProvenLowerable } from "../src/codegen/ir-first-gate.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function firstFunction(source: string): ts.FunctionDeclaration {
  const sourceFile = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("fixture has no function declaration");
  return declaration;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing outcome for ${name}`);
  return observed;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  (imports as { setExports?: (value: Record<string, Function>) => void }).setExports?.(exports);
  return exports;
}

describe("#3521 prepare-before-emit free-function routing", () => {
  it("IR-owns a string-method body outside the retired primitive skip allowlist", async () => {
    const code = `function codeAtStart(value: string): number { return value.charCodeAt(0); }`;
    expect(irFirstBodyIsProvenLowerable(firstFunction(code), new Map([["codeAtStart", 1]]))).toBe(false);

    const result = await compile(
      `${code}
       export function run(): number { return codeAtStart("A"); }`,
      {
        fileName: "prepared-string-method.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "standalone",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irFirstSkipped).toContain("codeAtStart");
    expect(outcome(result, "codeAtStart")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "codeAtStart").preparedComponentId).toBeUndefined();
    expect((await instantiate(result)).run()).toBe(65);
  });

  it("dependency-seals a scalar call component before lowering either body", async () => {
    const result = await compile(
      `
      function increment(value: number): number {
        if (value > 0) return value + 1;
        return 1;
      }
      export function run(): number { return increment(41); }
      `,
      {
        fileName: "prepared-scalar-component.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const incrementOutcome = outcome(result, "increment");
    const runOutcome = outcome(result, "run");
    expect(incrementOutcome).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(incrementOutcome.preparedComponentId).toMatch(/^prepared-component:/);
    expect(runOutcome.preparedComponentId).toBe(incrementOutcome.preparedComponentId);
    expect((await instantiate(result)).run!()).toBe(42);
  });

  it("direct-emits a selector-unsupported free function once", async () => {
    const result = await compile(`export function withDefault(value: number = 41): number { return value + 1; }`, {
      fileName: "prepared-direct.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("withDefault");
    expect(outcome(result, "withDefault")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("preserves the existing fast-mode boolean compile-once population", async () => {
    const result = await compile(`export function flag(value: boolean): boolean { return !value; }`, {
      fileName: "prepared-fast-boolean.ts",
      experimentalIR: true,
      fast: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped).toContain("flag");
    expect(outcome(result, "flag")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).flag!(0)).toBe(1);
  });

  // (#3907) There is no longer a fast-mode numeric ABI drift to keep off the
  // overlay. The drift WAS the #3907 bug: legacy fast mode grounded every
  // `number` to i32 while IR's semantic `number` is f64, so the two signatures
  // disagreed and the IR patch was refused. Fast mode now carries the same f64
  // representation, the signatures match, and the IR body legitimately patches
  // over the direct one. This test therefore pins the OPPOSITE outcome to the
  // one it was written for — the old expectation was recording a consequence of
  // an unsound representation, not a property worth preserving.
  it("fast-mode numeric bodies reach the IR patch now that the ABI no longer drifts", async () => {
    const result = await compile(`export function add(left: number, right: number): number { return left + right; }`, {
      fileName: "prepared-fast-number.ts",
      experimentalIR: true,
      fast: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("add");
    expect(outcome(result, "add")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).add!(20, 22)).toBe(42);
    // The point of the fix: the same body is correct past 2^31, which the i32
    // ABI it used to be grounded to could not represent.
    expect((await instantiate(result)).add!(4_000_000_000, 4_000_000_000)).toBe(8_000_000_000);
  });

  // (#3907) Same reversal as above, one call edge deeper: the callee no longer
  // drifts, so neither it nor its boolean caller is held off the IR patch.
  it("fast boolean callers with a numeric callee also reach the IR patch", async () => {
    const result = await compile(
      `
      function numeric(value: number): number { return value + 1; }
      export function positive(value: boolean): boolean {
        return numeric(value ? 1 : 0) > 0;
      }
      `,
      {
        fileName: "prepared-fast-mixed-component.ts",
        experimentalIR: true,
        fast: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("numeric");
    expect(result.irFirstSkipped ?? []).not.toContain("positive");
    expect(outcome(result, "numeric")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect(outcome(result, "positive")).toMatchObject({
      legacyBodyEmitted: true,
    });
    expect((await instantiate(result)).positive!(1)).toBe(1);
  });

  it("keeps an implicit-any component with an allocated ABI mismatch on the post-direct overlay", async () => {
    const result = await compile(
      `
      function sameValue(left, right) { return left === right; }
      function compare(left, right) { return sameValue(left, right); }
      export function run(): number { return compare(1, 1) ? 42 : 0; }
      `,
      {
        fileName: "prepared-allocated-abi-mismatch.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("sameValue");
    expect(result.irFirstSkipped ?? []).not.toContain("compare");
    expect(outcome(result, "sameValue")).toMatchObject({
      kind: "unsupported",
      code: "abi-signature-parity",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "compare")).toMatchObject({
      legacyBodyEmitted: true,
    });
    expect((await instantiate(result)).run!()).toBe(42);
  });

  it("preserves the existing sync-pass-through async compile-once population", async () => {
    const result = await compile(`export async function answer(): Promise<number> { return 42; }`, {
      fileName: "prepared-async-pass-through.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped).toContain("answer");
    expect(outcome(result, "answer")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).answer!()).toBe(42);
  });

  it("keeps module-global and class-owned dependencies on the post-direct overlay", async () => {
    const moduleGlobal = await compile(
      `
      let answer = 42;
      export function readAnswer(): number { return answer; }
      `,
      {
        fileName: "prepared-module-global-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(moduleGlobal.success, moduleGlobal.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleGlobal.irFirstSkipped ?? []).not.toContain("readAnswer");
    expect(outcome(moduleGlobal, "readAnswer")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(moduleGlobal)).readAnswer!()).toBe(42);

    const classOwned = await compile(
      `
      class Answer { value(): number { return 42; } }
      export function readClass(): number { return new Answer().value(); }
      `,
      {
        fileName: "prepared-class-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(classOwned.success, classOwned.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(classOwned.irFirstSkipped ?? []).not.toContain("readClass");
    expect(outcome(classOwned, "readClass")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(classOwned)).readClass!()).toBe(42);
  });

  it("keeps prepared bodies valid when a later direct owner adds a host import", async () => {
    const result = await compile(
      `
      export function codeAtStart(value: string): number {
        return value.charCodeAt(0);
      }
      export function caller(value: string): number {
        return codeAtStart(value);
      }
      export function lateDirect(value: any = "A"): boolean {
        return value === "A";
      }
      `,
      {
        fileName: "prepared-before-late-import.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "gc",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.some((entry) => entry.name === "__extern_is_undefined")).toBe(true);
    expect(outcome(result, "codeAtStart")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "caller")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "lateDirect")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    const exports = await instantiate(result);
    expect(exports.caller!("A")).toBe(65);
    expect(exports.lateDirect!()).toBe(1);
  });

  it("fails a preparation invariant without retrying the direct body emitter", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW = "1";
    let result: CompileResult;
    try {
      result = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
        fileName: "prepared-invariant.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_BUILD_THROW");
      else process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW = previous;
    }

    expect(result.success).toBe(false);
    expect(result.irFirstSkipped).toContain("add");
    expect(outcome(result, "add")).toMatchObject({
      kind: "invariant",
      code: "unexpected-internal-throw",
      stage: "build",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
  });
});
