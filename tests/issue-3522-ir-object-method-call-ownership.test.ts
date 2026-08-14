// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, createIncrementalCompiler, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

const SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; },
    positive(value: number): boolean { return value > 0; }
  };
  return operations.add(input) + (operations.positive(input) ? 1 : 0);
}
`;

const METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; }
  };
  const add = operations.add;
  return add(input);
}
`;

const CHAINED_METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; }
  };
  const add = operations.add;
  const alias = add;
  const invoke = alias;
  return invoke(input);
}
`;

const DESTRUCTURED_METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value - offset; }
  };
  const { add } = operations;
  return add(input);
}
`;

const RENAMED_DESTRUCTURED_METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; }
  };
  const { add: selected } = operations;
  const alias = selected;
  const invoke = alias;
  return invoke(input);
}
`;

const OBJECT_ALIAS_DESTRUCTURED_METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; }
  };
  const copy = operations;
  const { add } = copy;
  return add(input);
}
`;

const NO_OBJECT_ALIAS_DESTRUCTURED_METHOD_VALUE_SOURCE = `
export function run(input: number): number {
  const offset: number = 2;
  const operations = {
    add(value: number): number { return value + offset; }
  };
  const { add } = operations;
  return add(input);
}
`;

const COLLIDING_OBJECT_ALIAS_AND_METHOD_NAME_SOURCE = `
export function run(input: number): number {
  const operations = {
    copy(value: number): number { return value + 2; }
  };
  const copy = operations;
  const { copy: invoke } = copy;
  return invoke(input);
}
`;

function outcome(result: CompileResult): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName === "run");
  expect(observed).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function importLabels(result: CompileResult): string[] {
  return result.imports.map((entry) => `${entry.module}::${entry.name}`).sort();
}

function watFunctionBody(wat: string | undefined, name: string): string {
  expect(wat).toBeDefined();
  const start = wat!.indexOf(`(func $${name}`);
  expect(start, `missing WAT body for ${name}`).toBeGreaterThanOrEqual(0);
  const next = wat!.indexOf("\n  (func $", start + 1);
  return wat!.slice(start, next < 0 ? undefined : next);
}

function watTypeLines(wat: string): string[] {
  return wat
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("(type "));
}

function expectCanonicalCapturedMethodAbi(wat: string): void {
  const types = watTypeLines(wat);
  const rootStructs = types.filter((line) => /\$__fn_wrap_\d+_struct \(sub \(struct/.test(line));
  expect(rootStructs, "expected one canonical callable wrapper root").toHaveLength(1);
  const rootStruct = rootStructs[0]!;
  expect(rootStruct).not.toContain("(sub final");

  const rootSuffix = rootStruct.match(/\$__fn_wrap_(\d+)_struct/)?.[1];
  expect(rootSuffix, "canonical callable wrapper root has no suffix").toBeDefined();
  const rootLifted = types.find((line) => line.includes(`$__fn_wrap_${rootSuffix}_type`));
  expect(rootLifted, "canonical callable wrapper root has no lifted function type").toBeDefined();
  expect(rootLifted).toContain("(result i32)");
  const rootIdxText = rootLifted!.match(/\(ref(?: null)? (\d+)\)/)?.[1];
  expect(rootIdxText, "canonical callable wrapper root has no self type").toBeDefined();
  const rootIdx = Number(rootIdxText);

  const exactFuncType = types.find((line) =>
    new RegExp(
      `\\$__fn_wrap_(\\d+)_type \\(func \\(param \\(ref(?: null)? ${rootIdx}\\) f64\\) \\(result f64\\)\\)`,
    ).test(line),
  );
  expect(exactFuncType, "number method wrapper has no exact lifted function type").toBeDefined();
  const exactSuffix = exactFuncType!.match(/\$__fn_wrap_(\d+)_type/)?.[1];
  expect(exactSuffix).toBeDefined();
  const exactWrapper = types.find((line) => line.includes(`$__fn_wrap_${exactSuffix}_struct`));
  expect(exactWrapper, "number method wrapper has no allocation type").toBeDefined();
  expect(exactWrapper).toContain(`(sub $type${rootIdx}`);

  const capturedTypes = types.filter((line) => line.includes("(type $__ir_closure_"));
  expect(capturedTypes, "only invoke should need an IR capture subtype").toHaveLength(1);
  const invokeSubtype = capturedTypes[0]!;
  const exactWrapperIdx = Number(invokeSubtype.match(/\(sub final \$type(\d+)/)?.[1]);
  expect(exactWrapperIdx, "fixture did not force a non-root number wrapper").not.toBe(rootIdx);
  expect(invokeSubtype).toMatch(new RegExp(`\\(field \\$cap0 \\(ref(?: null)? ${rootIdx}\\)\\)`));
  expect(invokeSubtype).not.toMatch(new RegExp(`\\(field \\$cap0 \\(ref(?: null)? ${exactWrapperIdx}\\)\\)`));

  const invokeBody = watFunctionBody(wat, "run__closure_2");
  expect(invokeBody).toMatch(/ref\.cast \(ref (\d+)\)\s+struct\.get \1 3/);
  expect(invokeBody).toMatch(
    new RegExp(`struct\\.get ${rootIdx} 0\\s+ref\\.cast \\(ref (\\d+)\\)\\s+(?:return_)?call_ref \\1`),
  );
  expect(invokeBody).not.toMatch(
    /any\.convert_extern|extern\.convert_any|ref\.test|call_indirect|__call_m_|__call_function|\bcall \d+/,
  );
}

function expectCanonicalMultiCapturedMethodAbi(wat: string): void {
  const types = watTypeLines(wat);
  const rootStructs = types.filter((line) => /\$__fn_wrap_\d+_struct \(sub \(struct/.test(line));
  expect(rootStructs, "expected one canonical callable wrapper root").toHaveLength(1);
  const rootSuffix = rootStructs[0]!.match(/\$__fn_wrap_(\d+)_struct/)?.[1];
  expect(rootSuffix).toBeDefined();
  const rootLifted = types.find((line) => line.includes(`$__fn_wrap_${rootSuffix}_type`));
  const rootIdxText = rootLifted?.match(/\(ref(?: null)? (\d+)\)/)?.[1];
  expect(rootIdxText, "canonical callable wrapper root has no self type").toBeDefined();
  const rootIdx = Number(rootIdxText);

  const capturedTypes = types.filter((line) => line.includes("(type $__ir_closure_"));
  expect(capturedTypes, "only invoke should need an IR capture subtype").toHaveLength(1);
  const invokeSubtype = capturedTypes[0]!;
  expect(invokeSubtype).toMatch(new RegExp(`\\(field \\$cap0 \\(ref(?: null)? ${rootIdx}\\)\\)`));
  expect(invokeSubtype).toMatch(new RegExp(`\\(field \\$cap1 \\(ref(?: null)? ${rootIdx}\\)\\)`));

  const invokeBody = watFunctionBody(wat, "run__closure_2");
  expect(invokeBody).toMatch(/struct\.get \d+ 3/);
  expect(invokeBody).toMatch(/struct\.get \d+ 4/);
  expect((invokeBody.match(new RegExp(`struct\\.get ${rootIdx} 0`, "g")) ?? []).length).toBeGreaterThanOrEqual(2);
  expect((invokeBody.match(/call_ref \d+/g) ?? []).length).toBeGreaterThanOrEqual(2);
  expect(invokeBody).not.toMatch(
    /any\.convert_extern|extern\.convert_any|ref\.test|call_indirect|__call_m_|__call_function|\bcall \d+/,
  );
}

function expectTypedCapturedSiblingCalls(wat: string, names: readonly string[]): void {
  for (const name of names) {
    const body = watFunctionBody(wat, name);
    expect(body).toMatch(
      /struct\.get \d+ 3[\s\S]*struct\.get \d+ 0\s+ref\.cast \(ref (\d+)\)\s+(?:return_)?call_ref \1/,
    );
    expect(body).not.toMatch(
      /any\.convert_extern|extern\.convert_any|ref\.test|call_indirect|__call_m_|__call_function|\bcall \d+/,
    );
  }
}

function expectCanonicalSiblingCapturedMethodAbi(wat: string, names: readonly string[]): void {
  const types = watTypeLines(wat);
  const rootStructs = types.filter((line) => /\$__fn_wrap_\d+_struct \(sub \(struct/.test(line));
  expect(rootStructs, "expected one canonical callable wrapper root").toHaveLength(1);
  const rootSuffix = rootStructs[0]!.match(/\$__fn_wrap_(\d+)_struct/)?.[1];
  expect(rootSuffix).toBeDefined();
  const rootLifted = types.find((line) => line.includes(`$__fn_wrap_${rootSuffix}_type`));
  const rootIdxText = rootLifted?.match(/\(ref(?: null)? (\d+)\)/)?.[1];
  expect(rootIdxText, "canonical callable wrapper root has no self type").toBeDefined();
  const rootIdx = Number(rootIdxText);

  const liftedTypes = types.filter((line) => /\$__fn_wrap_\d+_type \(func/.test(line));
  expect(
    liftedTypes.some((line) => line.includes("(result f64)")),
    "number wrapper is missing",
  ).toBe(true);
  expect(
    liftedTypes.some((line) => line.includes("(result i32)")),
    "boolean wrapper is missing",
  ).toBe(true);
  const capturedTypes = types.filter((line) => line.includes("(type $__ir_closure_"));
  expect(capturedTypes, "each sibling should have one IR capture subtype").toHaveLength(names.length);
  for (const capturedType of capturedTypes) {
    expect(capturedType).toMatch(new RegExp(`\\(field \\$cap0 \\(ref(?: null)? ${rootIdx}\\)\\)`));
  }

  expectTypedCapturedSiblingCalls(wat, names);
  for (const name of names) {
    expect(watFunctionBody(wat, name)).toContain(`struct.get ${rootIdx} 0`);
  }
}

function expectSiblingCaptureOfCapturedMethodAbi(wat: string, names: readonly string[]): void {
  const types = watTypeLines(wat);
  const rootStructs = types.filter((line) => /\$__fn_wrap_\d+_struct \(sub \(struct/.test(line));
  expect(rootStructs, "expected one canonical callable wrapper root").toHaveLength(1);
  const rootSuffix = rootStructs[0]!.match(/\$__fn_wrap_(\d+)_struct/)?.[1];
  expect(rootSuffix).toBeDefined();
  const rootLifted = types.find((line) => line.includes(`$__fn_wrap_${rootSuffix}_type`));
  const rootIdxText = rootLifted?.match(/\(ref(?: null)? (\d+)\)/)?.[1];
  expect(rootIdxText, "canonical callable wrapper root has no self type").toBeDefined();
  const rootIdx = Number(rootIdxText);

  const capturedTypes = types.filter((line) => line.includes("(type $__ir_closure_"));
  expect(capturedTypes, "method and identical siblings need two semantic capture layouts").toHaveLength(2);
  expect(capturedTypes.some((line) => /\(field \$cap0 f64\)/.test(line))).toBe(true);
  expect(
    capturedTypes.some((line) => new RegExp(`\\(field \\$cap0 \\(ref(?: null)? ${rootIdx}\\)\\)`).test(line)),
  ).toBe(true);

  expectTypedCapturedSiblingCalls(wat, names);
  for (const name of names) {
    expect(watFunctionBody(wat, name)).toContain(`struct.get ${rootIdx} 0`);
  }
}

function expectNoImportRegression(
  direct: CompileResult,
  prepared: CompileResult,
  target: (typeof TARGETS)[number],
): void {
  const directImports = importLabels(direct);
  const preparedImports = importLabels(prepared);
  expect(preparedImports.filter((label) => !directImports.includes(label))).toEqual([]);
  expect(preparedImports.length).toBeLessThanOrEqual(directImports.length);
  expect(preparedImports).not.toContain("env::__call_function");
  expect(preparedImports).not.toContain("env::__js_array_new");
  expect(preparedImports).not.toContain("env::__js_array_push");
  if (target === "standalone") expect(preparedImports).toEqual([]);
}

describe("#3522 object-method call ownership", () => {
  it.each(TARGETS)("prepares parameterized direct object-method calls in the %s lane", async (target) => {
    const direct = await compile(SOURCE, {
      fileName: `object-method-call-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1";
      prepared = await compile(SOURCE, {
        fileName: `object-method-call-prepared-${target}.ts`,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(43);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("prepares an exact object-method value call in the %s lane", async (target) => {
    const direct = await compile(METHOD_VALUE_SOURCE, {
      fileName: `object-method-value-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
      prepared = await compile(METHOD_VALUE_SOURCE, {
        fileName: `object-method-value-prepared-${target}.ts`,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("preserves an exact object-method value through a const alias in the %s lane", async (target) => {
    const direct = await compile(CHAINED_METHOD_VALUE_SOURCE, {
      fileName: `object-method-value-alias-direct-${target}.ts`,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
      prepared = await compile(CHAINED_METHOD_VALUE_SOURCE, {
        fileName: `object-method-value-alias-prepared-${target}.ts`,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("prepares a destructured exact object-method value in the %s lane", async (target) => {
    const direct = await compile(DESTRUCTURED_METHOD_VALUE_SOURCE, {
      fileName: `object-method-value-destructured-direct-${target}.ts`,
      emitWat: true,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
      prepared = await compile(DESTRUCTURED_METHOD_VALUE_SOURCE, {
        fileName: `object-method-value-destructured-prepared-${target}.ts`,
        emitWat: true,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(38);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)("preserves a renamed destructured method through const aliases in the %s lane", async (target) => {
    const direct = await compile(RENAMED_DESTRUCTURED_METHOD_VALUE_SOURCE, {
      fileName: `object-method-value-destructured-alias-direct-${target}.ts`,
      emitWat: true,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
      prepared = await compile(RENAMED_DESTRUCTURED_METHOD_VALUE_SOURCE, {
        fileName: `object-method-value-destructured-alias-prepared-${target}.ts`,
        emitWat: true,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
    expect(prepared.wat).toContain("call_ref");
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("keeps mutable object-method value aliases on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        let add = operations.add;
        return add(input);
      }`,
      {
        fileName: "object-method-value-let-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "call-resolution-unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a mutable link in an object-method value alias chain on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const add = operations.add;
        let alias = add;
        return alias(input);
      }`,
      {
        fileName: "object-method-value-chain-let-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "call-resolution-unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)(
    "prepares a destructured method through one immutable object alias in the %s lane",
    async (target) => {
      const direct = await compile(OBJECT_ALIAS_DESTRUCTURED_METHOD_VALUE_SOURCE, {
        fileName: `object-method-value-destructured-object-alias-direct-${target}.ts`,
        emitWat: true,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      let noAliasControl: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
        prepared = await compile(OBJECT_ALIAS_DESTRUCTURED_METHOD_VALUE_SOURCE, {
          fileName: `object-method-value-destructured-object-alias-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
        noAliasControl = await compile(NO_OBJECT_ALIAS_DESTRUCTURED_METHOD_VALUE_SOURCE, {
          fileName: `object-method-value-destructured-no-object-alias-control-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared, noAliasControl]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      for (const compiled of [prepared, noAliasControl]) {
        expect(outcome(compiled)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
        expect(compiled.irPostClaimErrors ?? []).toEqual([]);
        expect(compiled.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
      }
      expect(prepared.wat).toContain("call_ref");
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      const exactPreparedImports = target === "gc" ? ["env::__box_number", "env::__unbox_number"] : [];
      expect(importLabels(prepared)).toEqual(exactPreparedImports);
      expect(importLabels(noAliasControl)).toEqual(exactPreparedImports);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
      expect(Buffer.from(prepared.binary)).toEqual(Buffer.from(noAliasControl.binary));
    },
  );

  it.each(TARGETS)(
    "distinguishes a method property name from its colliding object alias in the %s lane",
    async (target) => {
      const direct = await compile(COLLIDING_OBJECT_ALIAS_AND_METHOD_NAME_SOURCE, {
        fileName: `object-method-value-destructured-object-alias-name-collision-direct-${target}.ts`,
        emitWat: true,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0";
        prepared = await compile(COLLIDING_OBJECT_ALIAS_AND_METHOD_NAME_SOURCE, {
          fileName: `object-method-value-destructured-object-alias-name-collision-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0"]));
      expect(prepared.wat).toContain("call_ref");
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it("keeps destructuring through a mutable object alias on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        let copy = operations;
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-let-object-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not widen property-value projection through an object alias", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const copy = operations;
        const add = copy.add;
        return add(input);
      }`,
      {
        fileName: "object-method-value-property-through-object-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps method writes through an object alias on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 1; }
        };
        const copy = operations;
        copy.add = (value: number): number => value + 2;
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-written-object-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps an object alias captured by a nested closure on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const copy = operations;
        const invoke = (value: number): number => {
          const { add } = copy;
          return add(value);
        };
        return invoke(input);
      }`,
      {
        fileName: "object-method-value-destructured-captured-object-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a second object alias before destructuring on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const copy = operations;
        const second = copy;
        const { add } = second;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-second-object-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps root method writes after aliasing on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 1; }
        };
        const copy = operations;
        operations.add = (value: number): number => value + 2;
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-root-written-after-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a root captured after aliasing on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const copy = operations;
        const observe = (): number => operations.add(input);
        observe();
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-root-captured-after-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps an object alias escaped through shorthand on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const copy = operations;
        const escaped = { copy };
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-object-alias-shorthand-escape-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps an unsafe sibling destructure through the root on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { toString } = operations;
        const copy = operations;
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-root-unsafe-sibling-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps an unsafe sibling destructure through the alias on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const copy = operations;
        const { toString } = copy;
        const { add } = copy;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-alias-unsafe-sibling-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps two independent aliases of the same root on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const first = operations;
        const second = operations;
        const { add } = first;
        const { add: again } = second;
        return add(input) + again(0) - 2;
      }`,
      {
        fileName: "object-method-value-destructured-two-root-aliases-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not reuse a certified alias for a mutable block-local shadow after a changed snapshot", async () => {
    const source = `export function run(input: number): number {
      {
        const operations = {
          add(value: number): number { return value + 1; }
        };
        let copy = operations;
        const { add } = copy;
        add(input);
      }
      const operations = {
        add(value: number): number { return value + 2; }
      };
      const copy = operations;
      const { add } = copy;
      return add(input);
    }`;
    const options = {
      fileName: "object-method-value-destructured-object-alias-shadow-reuse.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    } as const;

    const fresh = await compile(source, options);
    const compiler = createIncrementalCompiler(options);
    try {
      const warmup = await compiler.compile(OBJECT_ALIAS_DESTRUCTURED_METHOD_VALUE_SOURCE);
      expect(warmup.success, warmup.errors.map((error) => error.message).join("\n")).toBe(true);
      const warmed = await compiler.compile(source);
      const reused = await compiler.compile(source);
      for (const result of [fresh, warmed, reused]) {
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        expect((await instantiate(result)).run!(40)).toBe(42);
        expect(outcome(result)).toMatchObject({
          kind: "unsupported",
          stage: "select",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      }
      expect(Buffer.from(warmed.binary)).toEqual(Buffer.from(fresh.binary));
      expect(Buffer.from(reused.binary)).toEqual(Buffer.from(fresh.binary));
    } finally {
      compiler.dispose();
    }
  });

  it("keeps mixed exact and inherited destructuring atomic on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add, toString } = operations;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-mixed-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps receiver-wide destructuring atomic across declarations", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { toString } = operations;
        const { add } = operations;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-receiver-atomic-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps optional calls through destructured methods on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        add?.(input);
        return 42;
      }`,
      {
        fileName: "object-method-value-destructured-optional-call-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not let a later destructured projection mask an earlier optional call", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const other = (value: number): number => value + 1;
        other?.(input);
        const operations = {
          add(value: number): number { return value + 2; }
        };
        operations.add?.(input);
        const { add } = operations;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-prior-optional-call-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)("prepares a captured direct-property method alias chain in the %s lane", async (target) => {
    const source = `export function run(input: number): number {
      const operations = {
        add(value: number): number { return value + 2; }
      };
      const add = operations.add;
      const selected = add;
      const invoke = (value: number): number => selected(value);
      return invoke(input);
    }`;
    const direct = await compile(source, {
      fileName: `object-method-value-property-alias-captured-direct-${target}.ts`,
      emitWat: true,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1";
      prepared = await compile(source, {
        fileName: `object-method-value-property-alias-captured-prepared-${target}.ts`,
        emitWat: true,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));

    const invokeBody = watFunctionBody(prepared.wat, "run__closure_1");
    expect(invokeBody).toMatch(/struct\.get \d+ 3[\s\S]*struct\.get \d+ 0[\s\S]*call_ref \d+/);
    expect(invokeBody).not.toMatch(/any\.convert_extern|extern\.convert_any|call_indirect|\bcall \d+/);
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(importLabels(prepared)).toEqual(target === "gc" ? ["env::__box_number", "env::__unbox_number"] : []);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("keeps a direct-property method capture two closure owners deep on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const add = operations.add;
        const outer = (value: number): number => {
          const inner = (nested: number): number => add(nested);
          return inner(value);
        };
        return outer(input);
      }`,
      {
        fileName: "object-method-value-property-two-owner-depth-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)(
    "prepares a direct-property method captured by two sibling closures in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const add = operations.add;
        const selected = add;
        const first = (value: number): number => selected(value);
        const second = (value: number): number => selected(value);
        return first(input) + second(0) - 2;
      }`;
      const exactBodies = ["run", "run__closure_0", "run__closure_1", "run__closure_2"];
      const direct = await compile(source, {
        fileName: `object-method-value-property-two-capture-owners-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = exactBodies.join(",");
        prepared = await compile(source, {
          fileName: `object-method-value-property-two-capture-owners-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(exactBodies);
      expect(watTypeLines(prepared.wat!).filter((line) => line.includes("(type $__ir_closure_"))).toHaveLength(1);
      expectTypedCapturedSiblingCalls(prepared.wat!, ["run__closure_1", "run__closure_2"]);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(target === "gc" ? ["env::__box_number", "env::__unbox_number"] : []);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it("keeps an escaped direct-property method capture closure on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const add = operations.add;
        const invoke = (value: number): number => add(value);
        const escaped = { invoke };
        return escaped.invoke(input);
      }`,
      {
        fileName: "object-method-value-property-capture-escape-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)(
    "prepares a destructured method value captured by a nested closure in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        return invoke(input);
      }`;
      const direct = await compile(source, {
        fileName: `object-method-value-destructured-captured-direct-${target}.ts`,
        emitWat: true,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1";
        prepared = await compile(source, {
          fileName: `object-method-value-destructured-captured-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(
        expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]),
      );

      const runBody = watFunctionBody(prepared.wat, "run");
      const invokeBody = watFunctionBody(prepared.wat, "run__closure_1");
      expect((runBody.match(/\bstruct\.new\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(invokeBody).toMatch(/struct\.get \d+ 3[\s\S]*struct\.get \d+ 0[\s\S]*call_ref \d+/);
      expect(invokeBody).not.toMatch(/any\.convert_extern|extern\.convert_any|call_indirect|\bcall \d+/);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(target === "gc" ? ["env::__box_number", "env::__unbox_number"] : []);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it("keeps a mutable destructured method capture on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        let { add } = operations;
        const invoke = (value: number): number => add(value);
        add = (value: number): number => value + 3;
        return invoke(input);
      }`,
      {
        fileName: "object-method-value-destructured-mutable-capture-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(43);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not confuse a shadowing callable parameter with the destructured method declaration", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (add: (value: number) => number, value: number): number => add(value);
        return invoke((value: number): number => value + 3, input);
      }`,
      {
        fileName: "object-method-value-destructured-capture-shadow-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(43);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)("prepares a captured destructured method alias chain in the %s lane", async (target) => {
    const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const selected = add;
        const invoke = (value: number): number => selected(value);
        return invoke(input);
      }`;
    const direct = await compile(source, {
      fileName: `object-method-value-destructured-alias-captured-direct-${target}.ts`,
      emitWat: true,
      experimentalIR: false,
      optimize: true,
      target,
    });
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    let prepared: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1";
      prepared = await compile(source, {
        fileName: `object-method-value-destructured-alias-captured-prepared-${target}.ts`,
        emitWat: true,
        experimentalIR: true,
        optimize: true,
        target,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousPoison === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
    }

    for (const compiled of [direct, prepared]) {
      expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(compiled.binary)).toBe(true);
      expect((await instantiate(compiled)).run!(40)).toBe(42);
    }
    expect(outcome(prepared)).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
    expect(prepared.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["run", "run__closure_0", "run__closure_1"]));

    const invokeBody = watFunctionBody(prepared.wat, "run__closure_1");
    expect(invokeBody).toMatch(/struct\.get \d+ 3[\s\S]*struct\.get \d+ 0[\s\S]*call_ref \d+/);
    expect(invokeBody).not.toMatch(/any\.convert_extern|extern\.convert_any|call_indirect|\bcall \d+/);
    expect(prepared.wat).not.toContain("__call_m_");
    expectNoImportRegression(direct, prepared, target);
    expect(importLabels(prepared)).toEqual(target === "gc" ? ["env::__box_number", "env::__unbox_number"] : []);
    expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it.each(TARGETS)(
    "prepares one captured method alias shared by two sibling closures in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const selected = add;
        const first = (value: number): number => selected(value);
        const second = (value: number): number => selected(value);
        return first(input) + second(0) - 2;
      }`;
      const exactBodies = ["run", "run__closure_0", "run__closure_1", "run__closure_2"];
      const direct = await compile(source, {
        fileName: `object-method-value-destructured-two-capture-owners-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = exactBodies.join(",");
        prepared = await compile(source, {
          fileName: `object-method-value-destructured-two-capture-owners-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(exactBodies);
      expect(watTypeLines(prepared.wat!).filter((line) => line.includes("(type $__ir_closure_"))).toHaveLength(1);
      expectTypedCapturedSiblingCalls(prepared.wat!, ["run__closure_1", "run__closure_2"]);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(target === "gc" ? ["env::__box_number", "env::__unbox_number"] : []);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it.each(TARGETS)(
    "captures a method with its own readonly capture through two sibling closures in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const offset: number = 2;
        const operations = {
          add(value: number): number { return value + offset; }
        };
        const { add } = operations;
        const first = (value: number): number => add(value);
        const second = (value: number): number => add(value);
        return first(input) + second(0) - offset;
      }`;
      const exactBodies = ["run", "run__closure_0", "run__closure_1", "run__closure_2"];
      const direct = await compile(source, {
        fileName: `object-method-value-captured-method-siblings-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = exactBodies.join(",");
        prepared = await compile(source, {
          fileName: `object-method-value-captured-method-siblings-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(exactBodies);
      expectSiblingCaptureOfCapturedMethodAbi(prepared.wat!, ["run__closure_1", "run__closure_2"]);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(target === "gc" ? ["env::__box_number", "env::__unbox_number"] : []);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it.each(TARGETS)(
    "prepares one heterogeneous destructuring pattern captured by two sibling closures in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; },
          positive(value: number): boolean { return value > 0; }
        };
        const { add, positive } = operations;
        const invokeAdd = (value: number): number => add(value);
        const invokePositive = (value: number): boolean => positive(value);
        return invokeAdd(input) + (invokePositive(input) ? 0 : 1);
      }`;
      const exactBodies = ["run", "run__closure_0", "run__closure_1", "run__closure_2", "run__closure_3"];
      const direct = await compile(source, {
        fileName: `object-method-value-destructured-pattern-two-capture-owners-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = exactBodies.join(",");
        prepared = await compile(source, {
          fileName: `object-method-value-destructured-pattern-two-capture-owners-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(exactBodies);
      expectCanonicalSiblingCapturedMethodAbi(prepared.wat!, ["run__closure_2", "run__closure_3"]);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(
        target === "gc" ? ["env::__box_boolean", "env::__box_number", "env::__unbox_number"] : [],
      );
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it("keeps sibling capture fan-out stable across changed incremental snapshots", async () => {
    const source = `export function run(input: number): number {
      const operations = {
        add(value: number): number { return value + 2; }
      };
      const { add } = operations;
      const selected = add;
      const first = (value: number): number => selected(value);
      const second = (value: number): number => selected(value);
      return first(input) + second(0) - 2;
    }`;
    const unsafe = source.replace(
      "return first(input) + second(0) - 2;",
      "const escaped = { second }; return first(input) + escaped.second(0) - 2;",
    );
    const options = {
      fileName: "object-method-value-sibling-capture-reuse.ts",
      emitWat: true,
      experimentalIR: true,
      optimize: true,
      trackIrOutcomes: true,
    } as const;

    const fresh = await compile(source, options);
    const compiler = createIncrementalCompiler(options);
    try {
      const warmup = await compiler.compile(unsafe);
      expect(warmup.success, warmup.errors.map((error) => error.message).join("\n")).toBe(true);
      expect((await instantiate(warmup)).run!(40)).toBe(42);
      expect(outcome(warmup)).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(warmup.irPostClaimErrors ?? []).toEqual([]);

      const warmed = await compiler.compile(source);
      const reused = await compiler.compile(source);
      const exactBodies = ["run", "run__closure_0", "run__closure_1", "run__closure_2"];
      for (const result of [fresh, warmed, reused]) {
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        expect((await instantiate(result)).run!(40)).toBe(42);
        expect(outcome(result)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
        expect(result.irCompiledFuncs ?? []).toEqual(exactBodies);
      }
      expect(Buffer.from(warmed.binary)).toEqual(Buffer.from(fresh.binary));
      expect(Buffer.from(reused.binary)).toEqual(Buffer.from(fresh.binary));
    } finally {
      compiler.dispose();
    }
  });

  it("keeps mixed safe and escaped sibling captures atomic on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const first = (value: number): number => add(value);
        const second = (value: number): number => add(value);
        const escaped = { second };
        return first(input) + escaped.second(0) - 2;
      }`,
      {
        fileName: "object-method-value-mixed-safe-escaped-sibling-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a captured method closure that escapes through object storage on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        const escaped = { invoke };
        return escaped.invoke(input);
      }`,
      {
        fileName: "object-method-value-destructured-capture-escape-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)(
    "prepares a captured method closure passed once to an immediate const consumer in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        const consume = (fn: (value: number) => number, value: number): number => fn(value);
        return consume(invoke, input);
      }`;
      const exactBodies = ["run", "run__closure_0", "run__closure_1", "run__closure_2"];
      const direct = await compile(source, {
        fileName: `object-method-value-destructured-capture-passed-direct-${target}.ts`,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = exactBodies.join(",");
        prepared = await compile(source, {
          fileName: `object-method-value-destructured-capture-passed-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(exactBodies);
      expect((prepared.irOutcomes ?? []).filter(({ legacyBodyEmitted }) => legacyBodyEmitted)).toEqual([]);
      expect(prepared.wat).not.toContain("__call_m_");
      for (const bodyName of exactBodies) {
        expect(watFunctionBody(prepared.wat, bodyName)).not.toMatch(/any\.convert_extern|extern\.convert_any/);
      }
      expectNoImportRegression(direct, prepared, target);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it.each([
    [
      "through a second callable pass",
      "object-method-value-destructured-capture-deep-pass-direct.ts",
      `
        const consume = (fn: (value: number) => number, value: number): number => fn(value);
        const relay = (fn: (value: number) => number, value: number): number => consume(fn, value);
        return relay(invoke, input);
      `,
    ],
    [
      "through a callable return",
      "object-method-value-destructured-capture-return-direct.ts",
      `
        const select = (fn: (value: number) => number): ((value: number) => number) => fn;
        const selected = select(invoke);
        return selected(input);
      `,
    ],
    [
      "to two immediate consumers",
      "object-method-value-destructured-capture-two-consumers-direct.ts",
      `
        const consumeA = (fn: (value: number) => number, value: number): number => fn(value);
        const consumeB = (fn: (value: number) => number, value: number): number => fn(value);
        return consumeA(invoke, input) + consumeB(invoke, input) - 42;
      `,
    ],
  ] as const)("keeps a captured method closure passed %s on the direct path", async (_label, fileName, body) => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        ${body}
      }`,
      {
        fileName,
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a defaulted captured method closure on the direct path across a callable pass", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number = 40): number => add(value);
        const consume = (fn: (value: number) => number, value: number): number => fn(value);
        return consume(invoke, input);
      }`,
      {
        fileName: "object-method-value-destructured-capture-defaulted-pass-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a method call captured two nested closure owners deep on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const outer = (value: number): number => {
          const inner = (next: number): number => add(next);
          return inner(value);
        };
        return outer(input);
      }`,
      {
        fileName: "object-method-value-destructured-two-owner-depth-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps an optional call through a captured method closure on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        invoke?.(input);
        return 42;
      }`,
      {
        fileName: "object-method-value-destructured-captured-optional-call-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each(TARGETS)(
    "captures heterogeneous destructured methods in one canonical closure in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; },
          positive(value: number): boolean { return value > 0; }
        };
        const { add, positive } = operations;
        const invoke = (value: number): number => add(value) + (positive(value) ? 0 : 1);
        return invoke(input);
      }`;
      const direct = await compile(source, {
        fileName: `object-method-value-multi-capture-direct-${target}.ts`,
        emitWat: true,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1,run__closure_2";
        prepared = await compile(source, {
          fileName: `object-method-value-multi-capture-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(
        expect.arrayContaining(["run", "run__closure_0", "run__closure_1", "run__closure_2"]),
      );
      expectCanonicalMultiCapturedMethodAbi(prepared.wat!);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(
        target === "gc" ? ["env::__box_boolean", "env::__box_number", "env::__unbox_number"] : [],
      );
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it.each(TARGETS)(
    "captures a method through the canonical wrapper root when another signature is registered first in the %s lane",
    async (target) => {
      const source = `export function run(input: number): number {
        const checks = {
          positive(value: number): boolean { return value > 0; }
        };
        const allowed = checks.positive(input);
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        return invoke(input) + (allowed ? 0 : 0);
      }`;
      const direct = await compile(source, {
        fileName: `object-method-value-canonical-capture-direct-${target}.ts`,
        emitWat: true,
        experimentalIR: false,
        optimize: true,
        target,
      });
      const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
      let prepared: CompileResult;
      try {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "run,run__closure_0,run__closure_1,run__closure_2";
        prepared = await compile(source, {
          fileName: `object-method-value-canonical-capture-prepared-${target}.ts`,
          emitWat: true,
          experimentalIR: true,
          optimize: true,
          target,
          trackIrOutcomes: true,
        });
      } finally {
        if (previousPoison === undefined)
          Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
        else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }

      for (const compiled of [direct, prepared]) {
        expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(WebAssembly.validate(compiled.binary)).toBe(true);
        expect((await instantiate(compiled)).run!(40)).toBe(42);
      }
      expect(outcome(prepared)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(prepared.irPostClaimErrors ?? []).toEqual([]);
      expect(prepared.irCompiledFuncs ?? []).toEqual(
        expect.arrayContaining(["run", "run__closure_0", "run__closure_1", "run__closure_2"]),
      );
      expectCanonicalCapturedMethodAbi(prepared.wat!);
      expect(prepared.wat).not.toContain("__call_m_");
      expectNoImportRegression(direct, prepared, target);
      expect(importLabels(prepared)).toEqual(
        target === "gc" ? ["env::__box_boolean", "env::__box_number", "env::__unbox_number"] : [],
      );
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    },
  );

  it("keeps reassigned method fields destructured later on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 1; }
        };
        operations.add = (value: number): number => value + 2;
        const { add } = operations;
        return add(input);
      }`,
      {
        fileName: "object-method-value-destructured-reassigned-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a bare nested-function alias on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        function add(value: number): number { return value + 2; }
        const alias = add;
        return alias(input);
      }`,
      {
        fileName: "nested-function-value-alias-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(40)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "call-resolution-unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("does not let a block-local destructured method hide a later ambient call after compiler reuse", async () => {
    const source = `export function run(input: number): number {
      {
        const operations = {
          add(value: number): number { return value + 1; }
        };
        const { add: parseInt } = operations;
        parseInt(input);
      }
      return parseInt("42");
    }`;
    const options = {
      fileName: "block-local-destructured-method-shadow.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    } as const;

    const fresh = await compile(source, options);
    const compiler = createIncrementalCompiler(options);
    try {
      const contaminant = source
        .replace("add(value", "sub(value")
        .replace("{ add: parseInt }", "{ sub: parseNum }")
        .replace("parseInt(input)", "parseNum(input)");
      const warmup = await compiler.compile(contaminant);
      expect(warmup.success, warmup.errors.map((error) => error.message).join("\n")).toBe(true);
      const warmed = await compiler.compile(source);
      const reused = await compiler.compile(source);
      for (const result of [fresh, warmed, reused]) {
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        expect((await instantiate(result)).run!(0)).toBe(42);
        expect(outcome(result)).toMatchObject({
          kind: "unsupported",
          stage: "select",
          legacyBodyEmitted: true,
          irBodyEmitted: false,
        });
        expect(result.irPostClaimErrors ?? []).toEqual([]);
      }
      expect(Buffer.from(warmed.binary)).toEqual(Buffer.from(fresh.binary));
      expect(Buffer.from(reused.binary)).toEqual(Buffer.from(fresh.binary));
    } finally {
      compiler.dispose();
    }
  });

  it("keeps receiver-sensitive object methods on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return this.double(value) + 2; },
          double(value: number): number { return value * 2; }
        };
        return operations.add(input);
      }`,
      {
        fileName: "object-method-call-this-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(20)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps mixed method/data objects on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          offset: 2,
          add(value: number): number { return value + 2; }
        };
        return operations.add(input) + operations.offset;
      }`,
      {
        fileName: "object-method-call-mixed-direct.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(38)).toBe(42);
    expect(outcome(result)).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
