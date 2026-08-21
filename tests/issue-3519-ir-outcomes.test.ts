// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatIrPathFallbackDiagnostic } from "../src/codegen/index.js";
import { compile, compileMulti, type IrInvariantCode, type IrObservedOutcome } from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";

const TRACKED_ENV = [
  "JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW",
  "JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE",
  "JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE",
  "JS2WASM_TEST_INJECT_IR_PHASE_THROW",
  "JS2WASM_TEST_DROP_IR_TERMINAL",
  "JS2WASM_TEST_INJECT_IR_ITERATOR_REGISTRATION_THROW",
  "JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW",
  "JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW",
] as const;
const ORIGINAL_ENV = new Map(TRACKED_ENV.map((name) => [name, process.env[name]]));

function terminal(result: Awaited<ReturnType<typeof compile>>): readonly IrObservedOutcome[] {
  expect(result.irOutcomes).toBeDefined();
  return result.irOutcomes ?? [];
}

function invariant(code: IrInvariantCode, detail: string): IrObservedOutcome {
  return {
    key: `fixture::function::f#0`,
    file: "fixture.ts",
    unitKind: "function",
    displayName: "f",
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
    kind: "invariant",
    code,
    stage: code === "backend-legality-failure" ? "backend-legality" : "patch",
    detail,
  };
}

afterEach(() => {
  for (const name of TRACKED_ENV) {
    const original = ORIGINAL_ENV.get(name);
    if (original === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = original;
  }
});

describe("#3519 typed IR terminal outcomes", () => {
  it("accounts a supported free function once and both policies consume the same row", async () => {
    const result = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      fileName: "supported.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      unitKind: "function",
      displayName: "add",
      kind: "emitted",
      irBodyEmitted: true,
    });
    expect(evaluateIrOutcomePolicy(outcomes, "hybrid").ready).toBe(true);
    expect(evaluateIrOutcomePolicy(outcomes, "ir-only").ready).toBe(outcomes[0]!.legacyBodyEmitted === false);
  });

  it("records a selector rejection as Unsupported while production hybrid succeeds", async () => {
    const result = await compile(`export function withDefault(x: number = 1): number { return x; }`, {
      fileName: "selector-reject.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "param-shape-rejected",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(evaluateIrOutcomePolicy(outcomes, "hybrid").ready).toBe(true);
    expect(evaluateIrOutcomePolicy(outcomes, "ir-only").ready).toBe(false);
  });

  it("seeds reassigned scalar parameters into slots before lowering", async () => {
    const result = await compile(
      `export function countdown(n: number): number {
        let count = 0;
        do { count++; n--; } while (n > 0);
        return count;
      }`,
      { fileName: "mutable-param.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result)).toEqual([
      expect.objectContaining({ displayName: "countdown", kind: "emitted", irBodyEmitted: true }),
    ]);
  });

  it("rejects native typed-array construction before the builder", async () => {
    const result = await compile(
      `export function first(): number {
        const values = new Uint8Array(1);
        values[0] = 257;
        return values[0];
      }`,
      { fileName: "typed-array-selector.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result)).toEqual([
      expect.objectContaining({
        displayName: "first",
        kind: "unsupported",
        stage: "select",
        code: "typed-array-constructor-unsupported",
      }),
    ]);
  });

  it("rejects unimplemented Array methods before lowering a vec receiver", async () => {
    const result = await compile(
      `export function find(): number {
        const values = [10, 20, 30];
        return values.indexOf(20);
      }`,
      { fileName: "array-method-selector.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result)).toEqual([
      expect.objectContaining({
        displayName: "find",
        kind: "unsupported",
        stage: "select",
        code: "array-method-unsupported",
      }),
    ]);
  });

  it("collects fallback evidence quietly unless verbose logging is requested", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await compile(`export function withDefault(x: number = 1): number { return x; }`, {
        fileName: "quiet-outcomes.ts",
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(true);
      expect(terminal(result)[0]).toMatchObject({ kind: "unsupported", code: "param-shape-rejected" });
      expect(write.mock.calls.flat().join("")).not.toContain("[ir-fallback]");
    } finally {
      write.mockRestore();
    }
  });

  it("emits discarded super calls instead of retaining the obsolete void-call gap", async () => {
    const result = await compile(
      `
class Animal {
  age: number;
  constructor(age: number) { this.age = age; }
}
class Dog extends Animal {
  constructor(age: number) {
    super(age);
  }
}
export function value(): number { return new Dog(4).age; }
`,
      { fileName: "void-call.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const constructorOutcome = terminal(result).find((outcome) => outcome.displayName === "Dog_new");
    expect(constructorOutcome).toMatchObject({
      kind: "emitted",
      stage: "patch",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(constructorOutcome && evaluateIrOutcomePolicy([constructorOutcome], "hybrid").ready).toBe(true);
    expect(constructorOutcome && evaluateIrOutcomePolicy([constructorOutcome], "ir-only").ready).toBe(true);
  });

  it("accounts class members and a non-empty module initializer exactly once", async () => {
    const result = await compile(
      `
let seed: number = 3;
class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
  read(): number { return this.value; }
  static zero(): number { return 0; }
}
export function readSeed(): number { return seed; }
`,
      { fileName: "class-module.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes.filter((outcome) => outcome.unitKind === "module-init")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.unitKind === "class-member")).toHaveLength(3);
    expect(outcomes.find((outcome) => outcome.displayName === "Counter_zero")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(new Set(outcomes.map((outcome) => outcome.key)).size).toBe(outcomes.length);
  });

  it("counts only executable overload implementations and ignores ambient signatures", async () => {
    const result = await compile(
      `
declare function ambient(value: number): number;
function overloaded(value: number): number;
function overloaded(value: number): number { return value + 1; }
export function run(value: number): number { return overloaded(value); }
`,
      { fileName: "overloads.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result).map((outcome) => outcome.displayName)).toEqual(["overloaded", "run"]);
  });

  it("inventories static initialization and implicit instance initialization explicitly", async () => {
    const result = await compile(
      `
class Counter {
  static seed = 1;
  static { Counter.seed = Counter.seed + 1; }
  value = 3;
  read(): number { return this.value; }
}
export function answer(): number { return 42; }
`,
      { fileName: "class-initializers.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes.filter((outcome) => outcome.unitKind === "module-init")).toEqual([
      expect.objectContaining({ kind: "unsupported", code: "static-class-initialization" }),
    ]);
    expect(outcomes.find((outcome) => outcome.displayName === "Counter_new")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
  });

  it("gives anonymous default-class bodies stable observational identities", async () => {
    const result = await compile(
      `export default class { constructor(public value: number) {} read(): number { return this.value; } }`,
      { fileName: "anonymous-class.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result)).toEqual([
      expect.objectContaining({
        displayName: "<anonymous-default-class:0>_new",
        kind: "unsupported",
        code: "anonymous-class",
        legacyBodyEmitted: true,
      }),
      expect.objectContaining({
        displayName: "<anonymous-default-class:0>_read",
        kind: "unsupported",
        code: "anonymous-class",
        legacyBodyEmitted: true,
      }),
    ]);
  });

  it("records the compiler-injected timer wrapper as an exact IR terminal", async () => {
    const result = await compile(`export function delayed(): void { setTimeout(() => {}, 1); }`, {
      fileName: "timer.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result)).toHaveLength(2);
    const timer = terminal(result).find((outcome) => outcome.displayName === "setTimeout");
    expect(timer).toMatchObject({
      unitKind: "function",
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(timer?.unitId).toContain("compiler-unit%3Atimer-shim%3Aset-timeout");
    expect(result.irBodyRouteAudit?.dispositions.find((row) => row.unitId === timer?.unitId)).toMatchObject({
      terminal: true,
      terminalOwnerId: timer?.unitId,
      disposition: "terminal-ir",
    });
    expect(terminal(result).find((outcome) => outcome.displayName === "delayed")).toMatchObject({
      line: 1,
      column: 1,
    });
  });

  it("preserves typed TypeMap invariants on a failed CompileResult", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW = "1";
    const result = await compile(`export function f(x: number): number { return x; }`, {
      fileName: "typemap-failure.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, JSON.stringify({ outcomes: result.irOutcomes, errors: result.errors }, null, 2)).toBe(false);
    expect(terminal(result)).toEqual([
      expect.objectContaining({ kind: "invariant", code: "type-map-failure", stage: "resolve" }),
    ]);
  });

  it.each([
    ["hygiene-synthetic", "unexpected-internal-throw"],
    ["provenance-synthetic", "allocation-provenance-failure"],
    ["lower-synthetic", "unexpected-internal-throw"],
  ] as const)("rolls %s failures up to the source owner without synthetic rows", async (phase, code) => {
    process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = phase;
    const result = await compile(
      `
export function outer(x: number): number {
  function inner(y: number): number { return x + y; }
  return inner(2);
}
export function independent(x: number): number { return x + 1; }
`,
      { fileName: `owner-${phase}.ts`, trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify({ outcomes: result.irOutcomes, errors: result.errors }, null, 2)).toBe(false);
    const outcomes = terminal(result);
    expect(outcomes.find((outcome) => outcome.displayName === "outer")).toMatchObject({ kind: "invariant", code });
    expect(outcomes.find((outcome) => outcome.displayName === "independent")).toMatchObject({ kind: "emitted" });
    expect(outcomes.some((outcome) => outcome.displayName.includes("__nested"))).toBe(false);
  });

  it.each(["inline", "monomorphize", "tagged-union"] as const)(
    "fans a module-wide %s throw out to every active source owner",
    async (phase) => {
      process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = phase;
      const result = await compile(
        `export function first(x: number): number { return x + 1; }
export function second(x: number): number { return x + 2; }`,
        { fileName: `module-${phase}.ts`, trackIrOutcomes: true },
      );
      expect(result.success).toBe(false);
      expect(terminal(result)).toEqual([
        expect.objectContaining({ displayName: "first", kind: "invariant", code: "unexpected-internal-throw" }),
        expect.objectContaining({ displayName: "second", kind: "invariant", code: "unexpected-internal-throw" }),
      ]);
    },
  );

  it("uses the real verifier producer for a malformed built artifact", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_VERIFY_FAILURE = "1";
    const result = await compile(`export function f(x: number): number { return x + 1; }`, {
      fileName: "verifier-producer.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, JSON.stringify({ outcomes: result.irOutcomes, errors: result.errors }, null, 2)).toBe(false);
    expect(terminal(result)).toEqual([
      expect.objectContaining({ displayName: "f", kind: "invariant", code: "verifier-failure", stage: "verify" }),
    ]);
  });

  it.each([
    ["function", "unknown-function-ref"],
    ["global", "unknown-global-ref"],
    ["type", "unknown-type-ref"],
  ] as const)("preserves the real %s resolver producer code", async (kind, code) => {
    process.env.JS2WASM_TEST_INJECT_IR_RESOLVER_FAILURE = kind;
    const result = await compile(`export function f(x: number): number { return x + 1; }`, {
      fileName: `resolver-${kind}.ts`,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(terminal(result)).toEqual([
      expect.objectContaining({ displayName: "f", kind: "invariant", code, stage: "lower" }),
    ]);
  });

  it("turns an actual missing integration terminal into a reconciliation invariant", async () => {
    process.env.JS2WASM_TEST_DROP_IR_TERMINAL = "delay";
    const result = await compile(
      `export function delay(ms: number, value: number): Promise<number> {
        return new Promise<number>((resolve) => { setTimeout(() => resolve(value), ms); });
      }`,
      { fileName: "missing-terminal.ts", trackIrOutcomes: true },
    );
    expect(result.success, JSON.stringify({ outcomes: result.irOutcomes, errors: result.errors }, null, 2)).toBe(false);
    expect(terminal(result)).toEqual([
      expect.objectContaining({
        displayName: "setTimeout",
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      }),
      expect.objectContaining({ displayName: "delay", kind: "invariant", code: "missing-terminal-outcome" }),
    ]);
  });

  it("routes iterator registration throws through the owning source outcome", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_ITERATOR_REGISTRATION_THROW = "1";
    const result = await compile(
      `export function sum(values: Set<number>): number {
        let total = 0;
        for (const value of values) total = total + value;
        return total;
      }`,
      { fileName: "iterator-registration.ts", trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    expect(terminal(result)).toEqual([
      expect.objectContaining({ displayName: "sum", kind: "invariant", code: "unexpected-internal-throw" }),
    ]);
  });

  it("does not demote an unexpected Promise final-registration throw", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW = "1";
    const result = await compile(
      `export function delay(ms: number, value: number): Promise<number> {
        return new Promise<number>((resolve) => { setTimeout(() => resolve(value), ms); });
      }`,
      { fileName: "promise-registration.ts", trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    expect(terminal(result).find((outcome) => outcome.displayName === "delay")).toMatchObject({
      kind: "invariant",
      code: "unexpected-internal-throw",
    });
  });

  it("does not demote unexpected imported-call planning throws", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_IMPORTED_PLAN_THROW = "run";
    const result = await compileMulti(
      {
        "lib.ts": `export function imported(value: number): number { return value + 1; }`,
        "main.ts": `import { imported } from "./lib";
export function run(value: number): number { return imported(value); }`,
      },
      "main.ts",
      { trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    expect(terminal(result).find((outcome) => outcome.displayName === "run")).toMatchObject({
      kind: "invariant",
      code: "unexpected-internal-throw",
    });
  });

  it("preserves typed outcome accounting when the multi-module outer boundary catches", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW = "1";
    const result = await compileMulti(
      {
        "lib.ts": `export function helper(value: number): number { return value + 1; }`,
        "main.ts": `import { helper } from "./lib";
export function run(value: number): number { return helper(value); }`,
      },
      "main.ts",
      { trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    expect(terminal(result)).toHaveLength(2);
    expect(
      terminal(result).every((outcome) => outcome.kind === "invariant" && outcome.code === "type-map-failure"),
    ).toBe(true);
  });

  it("makes invariant policy independent of diagnostic wording", () => {
    const codes: IrInvariantCode[] = [
      "unknown-function-ref",
      "unknown-global-ref",
      "unknown-type-ref",
      "verifier-failure",
      "backend-legality-failure",
      "missing-function-slot",
      "unpatched-slot",
      "abi-type-index-mismatch",
    ];
    for (const [index, code] of codes.entries()) {
      for (const detail of [`wording A ${index}`, `completely changed diagnostic ${index}`]) {
        const outcome = invariant(code, detail);
        expect(evaluateIrOutcomePolicy([outcome], "hybrid").ready).toBe(false);
        expect(evaluateIrOutcomePolicy([outcome], "ir-only").ready).toBe(false);
        const diagnostic = formatIrPathFallbackDiagnostic({
          func: "f",
          message: detail,
          kind: outcome.stage === "backend-legality" ? "backend-legality" : "lower",
          outcome,
        });
        expect(diagnostic.severity).toBe("error");
      }
    }
  });
});
