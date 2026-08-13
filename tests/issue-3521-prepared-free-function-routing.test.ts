// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { irFirstBodyIsProvenLowerable } from "../src/codegen/ir-first-gate.js";
import { compile, createIncrementalCompiler, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { irSupportGlobalRef } from "../src/ir/abi-bindings.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildImports } from "../src/runtime.js";

// Register the low-level codegen delegates used by generateModule.
import "../src/codegen/expressions.js";

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

function classMemberOutcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "class-member" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing class-member outcome for ${name}`);
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
  it.each([
    ["gc", "prepared-host-string-length.ts"],
    ["standalone", "prepared-native-string-length.ts"],
  ] as const)("dependency-seals a %s literal-length body before lowering", async (target, fileName) => {
    const result = await compile(`export function literalLength(): number { return "abc".length; }`, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      target,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(outcome(result, "literalLength")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "literalLength").preparedComponentId).toMatch(/^prepared-component:/);
    expect((await instantiate(result)).literalLength!()).toBe(3);
  });

  it.each([
    ["gc", "prepared-host-string-callables.ts"],
    ["standalone", "prepared-native-string-callables.ts"],
  ] as const)("dependency-seals %s concat, equality, and character providers", async (target, fileName) => {
    const result = await compile(
      `
      export function concatEquals(): boolean { return "a" + "b" === "ab"; }
      export function characterCode(): number { return "abc".charAt(1).charCodeAt(0); }
      `,
      {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    for (const name of ["concatEquals", "characterCode"]) {
      expect(outcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(outcome(result, name).preparedComponentId).toMatch(/^prepared-component:/);
    }
    const exports = await instantiate(result);
    expect(exports.concatEquals!()).toBe(1);
    expect(exports.characterCode!()).toBe(98);
  });

  it("dependency-seals native string iteration and its code-point provider", async () => {
    const result = await compile(
      `export function countCodePoints(): number {
        let count = 0;
        for (const value of "A💩B") count += 1;
        return count;
      }`,
      {
        fileName: "prepared-native-string-iteration.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "standalone",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(outcome(result, "countCodePoints")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "countCodePoints").preparedComponentId).toMatch(/^prepared-component:/);
    expect((await instantiate(result)).countCodePoints!()).toBe(3);
  });

  it.each([
    ["utf16", `${"x".repeat(9_999)}💩`, {}, 10_001, 10_000, true],
    ["utf8", `${"x".repeat(9_999)}💩`, { utf8Storage: true }, 10_001, 10_000, true],
    ["utf8-byte-only", "💩".repeat(2_501), { utf8Storage: true }, 5_002, 2_501, false],
  ] as const)(
    "dependency-seals an oversized %s native literal through exact prepared materialization",
    async (lane, literal, options, expectedLength, expectedCodePoints, expectsMaterializer) => {
      const source = `
        export function oversizedLength(): number { return "${literal}".length; }
        export function oversizedCodePoints(): number {
          let count = 0;
          for (const value of "${literal}") count += 1;
          return count;
        }
      `;
      const result = await compile(source, {
        ...options,
        fileName: `prepared-oversized-${lane}-native-literal.ts`,
        experimentalIR: true,
        emitWat: true,
        trackIrOutcomes: true,
        target: "standalone",
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
      for (const name of ["oversizedLength", "oversizedCodePoints"]) {
        expect(outcome(result, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
        expect(outcome(result, name).preparedComponentId).toMatch(/^prepared-component:/);
      }
      const irExports = await instantiate(result);
      expect(irExports.oversizedLength!()).toBe(expectedLength);
      expect(irExports.oversizedCodePoints!()).toBe(expectedCodePoints);
      expect(result.wat.includes("__strlit_materialize_")).toBe(expectsMaterializer);
      expect(result.wat).toMatch(expectsMaterializer ? /array\.new_fixed \d+ 10000/ : /array\.new_fixed \d+ 5002/);
      expect(result.wat).not.toMatch(/array\.new_fixed \d+ 1000[1-9]/);

      const direct = await compile(source, {
        ...options,
        fileName: `direct-oversized-${lane}-native-literal.ts`,
        target: "standalone",
      });
      expect(direct.success, direct.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(() => new WebAssembly.Module(direct.binary)).not.toThrow();
      const directExports = await instantiate(direct);
      expect(directExports.oversizedLength!()).toBe(expectedLength);
      expect(directExports.oversizedCodePoints!()).toBe(expectedCodePoints);
    },
  );

  it.each([
    ["gc", "prepared-host-owned-append.ts"],
    ["standalone", "prepared-native-owned-append.ts"],
  ] as const)("dependency-seals the %s owned-append provider", async (target, fileName) => {
    const result = await compile(
      `
      export function builderLength(count: number): number {
        let value = "";
        for (let index = 0; index < count; index++) value += "ab";
        return value.length;
      }
      `,
      {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(outcome(result, "builderLength")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "builderLength").preparedComponentId).toMatch(/^prepared-component:/);
    expect((await instantiate(result)).builderLength!(4)).toBe(8);
  });

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
    expect(outcome(result, "codeAtStart").preparedComponentId).toMatch(/^prepared-component:/);
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

  it("dependency-seals scalar runtime/intrinsic providers before lowering", async () => {
    const result = await compile(
      `export function compute(value: number): number {
      return Math.sin(value) + (value % 5);
    }`,
      {
        fileName: "prepared-intrinsic-provider.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const computeOutcome = outcome(result, "compute");
    expect(computeOutcome).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(computeOutcome.preparedComponentId).toMatch(/^prepared-component:/);
    expect((await instantiate(result)).compute!(1)).toBeCloseTo(Math.sin(1) + 1, 10);
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

  it("seals an exact lexical module global with its reader and free-to-class dependencies", async () => {
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
    expect(moduleGlobal.irFirstSkipped ?? []).toContain("readAnswer");
    expect(outcome(moduleGlobal, "readAnswer")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(
      moduleGlobal.irOutcomes?.find(
        ({ unitKind, displayName }) => unitKind === "module-init" && displayName === "<module-init>",
      ),
    ).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: outcome(moduleGlobal, "readAnswer").preparedComponentId,
    });
    expect((await instantiate(moduleGlobal)).readAnswer!()).toBe(42);

    const earlyClassCall = await compile(
      `
      class Reader {
        value(): number { return value; }
      }
      const observed: number = new Reader().value();
      let value: number = 42;
      export function readObserved(): number { return observed; }
      `,
      {
        fileName: "prepared-module-class-tdz-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect(earlyClassCall.success, earlyClassCall.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(earlyClassCall.irOutcomes?.find(({ unitKind }) => unitKind === "module-init")).toMatchObject({
      legacyBodyEmitted: true,
    });
    expect(
      earlyClassCall.irOutcomes?.find(({ unitKind }) => unitKind === "module-init")?.preparedComponentId,
    ).toBeUndefined();
    const earlyImports = buildImports(earlyClassCall.imports, undefined, earlyClassCall.stringPool);
    await expect(WebAssembly.instantiate(earlyClassCall.binary, earlyImports)).rejects.toThrow();

    const classOwned = await compile(
      `
      class Answer {
        constructor() {}
        value(): number { return 42; }
      }
      export function readClass(): number { return new Answer().value(); }
      `,
      {
        fileName: "prepared-class-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(classOwned.success, classOwned.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(classOwned.irFirstSkipped ?? []).toContain("readClass");
    const readClass = outcome(classOwned, "readClass");
    const answerValue = classMemberOutcome(classOwned, "Answer_value");
    expect(readClass).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(answerValue).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(readClass.preparedComponentId).toBe(answerValue.preparedComponentId);
    expect((await instantiate(classOwned)).readClass!()).toBe(42);
  });

  it("prepares nested callable owners atomically", async () => {
    const result = await compile(
      `
      export function run(value: number): number {
        let bias = 3;
        function double(input: number): number { return input * 2; }
        function addBias(input: number): number { return input + bias; }
        return double(value) + addBias(value);
      }
      `,
      {
        fileName: "prepared-nested-callable-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).toContain("run");
    expect(outcome(result, "run")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect((await instantiate(result)).run!(7)).toBe(24);
  });

  it.each([
    [
      "local variable",
      `
      function answer(): number { return 42; }
      export function run(): number {
        const callable = answer;
        return callable();
      }
      `,
    ],
    [
      "module object",
      `
      function answer(): number { return 42; }
      const holder = { callable: answer };
      export function run(): number { return holder.callable(); }
      `,
    ],
  ] as const)("prepares a function-value target used through a %s", async (_kind, source) => {
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let result: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "answer";
      result = await compile(source, {
        fileName: `prepared-function-value-${_kind.replace(" ", "-")}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(outcome(result, "answer")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect((await instantiate(result)).run!()).toBe(42);
  });

  it.each(["gc", "standalone"] as const)(
    "preserves singleton identity while the function-value target is prepared in %s",
    async (target) => {
      const source = `
        function answer(): number { return 42; }
        export function run(): number {
          const first: any = answer;
          const second: any = answer;
          return first === second ? first() : -1;
        }
      `;
      const direct = await compile(source, {
        fileName: `prepared-function-value-identity-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "answer";
        prepared = await compile(source, {
          fileName: `prepared-function-value-identity-${target}.ts`,
          experimentalIR: true,
          trackIrOutcomes: true,
          optimize: true,
          target,
        });
      } finally {
        if (previousPoison === undefined) {
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        } else {
          process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
        }
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!()).toBe(42);
      }
      expect(outcome(prepared, "answer")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it.each([
    {
      kind: "call",
      source: `
        function add(value: number): number { return value + 1; }
        export function run(): number { return add.call(undefined, 6); }
      `,
    },
    {
      kind: "apply",
      source: `
        function add(value: number): number { return value + 1; }
        export function run(): number { return add.apply(undefined, [6]); }
      `,
    },
  ])("retains the optimized zero-import route for an immediate local .$kind", async ({ kind, source }) => {
    const direct = await compile(source, {
      experimentalIR: false,
      fileName: `prepared-function-${kind}-direct.ts`,
      optimize: true,
      semanticProviders: "native-first",
    });
    const prepared = await compile(source, {
      experimentalIR: true,
      fileName: `prepared-function-${kind}-ir.ts`,
      optimize: true,
      semanticProviders: "native-first",
      trackIrOutcomes: true,
    });

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect(WebAssembly.Module.imports(new WebAssembly.Module(compiled.binary))).toEqual([]);
      expect((await instantiate(compiled)).run!()).toBe(7);
    }
    expect(outcome(prepared, "add")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("publishes exact singleton support beneath the prepared value target", () => {
    const source = `
      function answer(): number { return 42; }
      export function run(): number {
        const first: any = answer;
        return first();
      }
    `;
    const ast = analyzeSource(source, "prepared-function-value-program-abi.ts");
    const generated = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const answerOutcome = generated.irOutcomes?.find(
      (candidate) => candidate.unitKind === "function" && candidate.displayName === "answer",
    );
    expect(answerOutcome).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    if (!answerOutcome?.unitId) throw new Error("prepared answer has no exact terminal unit ID");

    const trampoline = irSupportFuncRef(
      answerOutcome.unitId,
      "function-value-trampoline",
      "diagnostic-prepared-function-value-trampoline",
    );
    const cache = irSupportGlobalRef(
      answerOutcome.unitId,
      "function-value-cache",
      "diagnostic-prepared-function-value-cache",
    );
    const entries = generated.programAbi!.abi.entries();
    expect(entries.find((entry) => entry.id === trampoline.binding.bindingId)).toMatchObject({
      id: trampoline.binding.bindingId,
      displayName: "__fn_tramp_answer_cached",
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "support", unitId: answerOutcome.unitId },
    });
    expect(entries.find((entry) => entry.id === cache.binding.bindingId)).toMatchObject({
      id: cache.binding.bindingId,
      displayName: "__fn_closure_answer",
      slotPolicy: "required",
      slotSpace: "global",
      intent: { kind: "global", origin: "support", mutable: true },
    });
    expect(generated.programAbi!.abi.resolveFinalIndex(trampoline.binding.bindingId)).toMatchObject({
      space: "function",
    });
    expect(generated.programAbi!.abi.resolveFinalIndex(cache.binding.bindingId)).toMatchObject({
      space: "global",
    });
  });

  it("does not allocate target support for a shadowed same-name local", () => {
    const source = `
      function answer(): number { return 42; }
      export function invoke(): number { return answer(); }
      export function readShadow(answer: number): number { return answer; }
    `;
    const ast = analyzeSource(source, "prepared-function-value-shadow.ts");
    const generated = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
    const answerOutcome = generated.irOutcomes?.find(
      (candidate) => candidate.unitKind === "function" && candidate.displayName === "answer",
    );
    expect(answerOutcome).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    if (!answerOutcome?.unitId) throw new Error("prepared answer has no exact terminal unit ID");
    const trampoline = irSupportFuncRef(
      answerOutcome.unitId,
      "function-value-trampoline",
      "diagnostic-shadowed-function-value-trampoline",
    );
    const cache = irSupportGlobalRef(
      answerOutcome.unitId,
      "function-value-cache",
      "diagnostic-shadowed-function-value-cache",
    );
    const entries = generated.programAbi!.abi.entries();
    expect(entries.some((entry) => entry.id === trampoline.binding.bindingId)).toBe(false);
    expect(entries.some((entry) => entry.id === cache.binding.bindingId)).toBe(false);
  });

  it("keeps function-value targets direct beside a current-function caller read", async () => {
    const source = `
      eval("\\\"use strict\\\";\\ngNonStrict();");
      function gNonStrict() {
        return gNonStrict.caller;
      }
      function answer() {
        return 42;
      }
      function directOnly() {
        return 1;
      }
      const callable = answer;
      if (callable() + directOnly() !== 43) throw new Error("function value changed");
    `;
    const direct = await compile(source, {
      allowJs: true,
      deferTopLevelInit: true,
      fileName: "15.3.5.4_2-12gs-direct.js",
      skipSemanticDiagnostics: true,
    });
    const result = await compile(source, {
      allowJs: true,
      deferTopLevelInit: true,
      experimentalIR: true,
      fileName: "15.3.5.4_2-12gs.js",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    });

    for (const compiled of [direct, result]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      const exports = await instantiate(compiled);
      expect(() => exports.__module_init!()).not.toThrow();
    }
    expect(outcome(result, "gNonStrict")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "answer")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "directOnly")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
  });

  it.each([
    {
      label: "strict eval inside a sloppy script",
      source: `
        eval("\\\"use strict\\\";\\ngNonStrict();");
        function gNonStrict() {
          return gNonStrict.caller;
        }
      `,
      throws: false,
    },
    {
      label: "strict script and inherited strict eval callback",
      source: `
        "use strict";
        (function () { eval("gNonStrict();"); })();
        function gNonStrict() {
          return gNonStrict.caller;
        }
      `,
      throws: true,
    },
  ])("keeps the caller activation boundary after incremental Program reuse: $label", async ({ source, throws }) => {
    const compiler = createIncrementalCompiler({
      allowJs: true,
      deferTopLevelInit: true,
      emitWat: false,
      fileName: "test.js",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    });
    const warmup = await compiler.compile(`function warmup() { return 1; } warmup();`);
    expect(warmup.success, warmup.errors.map((error) => error.message).join("\n")).toBe(true);

    const result = await compiler.compile(source);

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const exports = await instantiate(result);
    if (throws) expect(() => exports.__module_init!()).toThrow();
    else expect(() => exports.__module_init!()).not.toThrow();
    expect(outcome(result, "gNonStrict")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    compiler.dispose();
  });

  it("prepares a closed free-function component beside direct class and module owners", async () => {
    const result = await compile(
      `
      let moduleSeed = 40;
      class LegacyBox { value(): number { return moduleSeed + 2; } }
      function increment(value: number): number { return value + 1; }
      export function run(value: number): number { return increment(value); }
      `,
      {
        fileName: "prepared-mixed-owner-components.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes?.some((candidate) => candidate.unitKind === "class-member")).toBe(true);
    expect(result.irOutcomes?.some((candidate) => candidate.unitKind === "module-init")).toBe(true);
    for (const name of ["increment", "run"]) {
      expect(result.irFirstSkipped).toContain(name);
      expect(outcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
      expect(outcome(result, name).preparedComponentId).toMatch(/^prepared-component:/);
    }
    expect((await instantiate(result)).run!(41)).toBe(42);
  });

  it("keeps a free function called by a direct module initializer in the direct component", async () => {
    const result = await compile(
      `
      function increment(value: number): number { return value + 1; }
      let seeded = increment(41);
      export function run(): number { return seeded; }
      `,
      {
        fileName: "prepared-module-init-call-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("increment");
    expect(outcome(result, "increment")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).run!()).toBe(42);
  });

  it("prepares a free function called by a prepared class member", async () => {
    const result = await compile(
      `
      function increment(value: number): number { return value + 1; }
      class Box { value(): number { return increment(41); } }
      export function run(): number { return new Box().value(); }
      `,
      {
        fileName: "prepared-class-member-call-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    for (const observed of [outcome(result, "increment"), classMemberOutcome(result, "Box_value")]) {
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
    }
    expect(outcome(result, "run")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect((await instantiate(result)).run!()).toBe(42);
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
    expect(outcome(result, "codeAtStart").preparedComponentId).toMatch(/^prepared-component:/);
    expect(outcome(result, "caller").preparedComponentId).toMatch(/^prepared-component:/);
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
