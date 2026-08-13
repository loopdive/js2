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

  it("keeps destructured method values captured by nested closures on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const invoke = (value: number): number => add(value);
        return invoke(input);
      }`,
      {
        fileName: "object-method-value-destructured-captured-direct.ts",
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

  it("keeps captured destructured method alias chains on the direct path", async () => {
    const result = await compile(
      `export function run(input: number): number {
        const operations = {
          add(value: number): number { return value + 2; }
        };
        const { add } = operations;
        const selected = add;
        const invoke = (value: number): number => selected(value);
        return invoke(input);
      }`,
      {
        fileName: "object-method-value-destructured-alias-captured-direct.ts",
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
