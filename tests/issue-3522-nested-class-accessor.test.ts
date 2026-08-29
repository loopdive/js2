// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522) Nested classes carrying an instance GET/SET accessor compile once.
//
// Measured on `origin/main` 793b5c0e before this slice: a nested class with an
// accessor withdrew its WHOLE enclosing function
// (`body-shape-rejected [nontail-class-unprepared:ClassDeclaration]`, owner
// `legacy=3..5 ir=0`) — including its constructor and every method — while the
// identical accessor shape on a TOP-LEVEL class already compiled once. The gap
// was two structural gates, not a missing lowering:
//
//  1. `isBoundedPreparedNestedOrdinaryClass` counted only methods.
//  2. `exactAccessorClass` forced every nested accessor onto the accessor-only
//     WRITEBACK ABI (string getters / `dynamic` setters), which has no evidence
//     for a numeric getter.
//
// Every expected value below was cross-checked against the same program
// evaluated by node.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const TARGETS = ["gc", "standalone"] as const;

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter((candidate) => candidate.displayName.startsWith(name));
  expect(observed, `terminal outcome count for ${name}`).toHaveLength(1);
  return observed[0]!;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

/**
 * Compile with the direct class/function body emitters poisoned, so a hidden
 * direct compile followed by an IR patch cannot satisfy a positive assertion.
 */
async function compilePoisoned(
  source: string,
  fileName: string,
  target: (typeof TARGETS)[number],
  classBodies: readonly string[],
  functionBodies: readonly string[],
): Promise<CompileResult> {
  const previousClass = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  const previousFunction = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = classBodies.join(",");
    process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = functionBodies.join(",");
    return await compile(source, {
      fileName,
      experimentalIR: true,
      trackIrOutcomes: true,
      emitWat: true,
      target,
    });
  } finally {
    if (previousClass === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previousClass;
    if (previousFunction === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
    else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunction;
  }
}

function expectCompiledOnce(result: CompileResult, names: readonly string[]): void {
  for (const name of names) {
    expect(outcome(result, name), `${name} must be prepared IR`).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
  }
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

function expectDirect(result: CompileResult, names: readonly string[]): void {
  for (const name of names) {
    expect(outcome(result, name), `${name} must remain direct`).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  }
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

// node: 3 + 39 === 42
const METHOD_AND_GETTER = `
export function run(): number {
  class Box {
    get(): number { return 3; }
    get v(): number { return 39; }
  }
  const b = new Box();
  return b.get() + b.v;
}
`;

// node: b.v = 20; b.v = b.v + 22 === 42
const GETTER_AND_SETTER = `
export function run(): number {
  class Box {
    p: number;
    get v(): number { return this.p; }
    set v(x: number) { this.p = x; }
  }
  const b = new Box();
  b.v = 20;
  b.v = b.v + 22;
  return b.v;
}
`;

// node: 2 + 40 === 42
const CLASS_EXPRESSION = `
export function run(): number {
  const Box = class {
    get(): number { return 2; }
    get v(): number { return 40; }
  };
  const b = new Box();
  return b.get() + b.v;
}
`;

describe("#3522 nested class accessor ownership", () => {
  it.each(TARGETS)("prepares a nested method+getter DECLARATION once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      METHOD_AND_GETTER,
      `nested-accessor-decl-${target}.ts`,
      target,
      ["Box_new", "Box_get", "Box_get_v"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    // The whole owner is the gain: `run` AND both members, not one accessor.
    expectCompiledOnce(prepared, ["run", "Box_get@", "Box_get_v@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a getter/setter pair that reads and writes `this` in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      GETTER_AND_SETTER,
      `nested-accessor-pair-${target}.ts`,
      target,
      ["Box_new", "Box_get_v", "Box_set_v"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_get_v@", "Box_set_v@"]);
    // A `this`-reading/writing accessor body is exactly what the accessor-only
    // WRITEBACK family forbids; the ordinary path handles it.
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a nested class EXPRESSION with an accessor in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      CLASS_EXPRESSION,
      `nested-accessor-expr-${target}.ts`,
      target,
      ["Box_new", "Box_get", "Box_get_v"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "<anonymous-class>_get@", "<anonymous-class>_get_v@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)(
    "prepares an EXPLICIT-constructor class whose getter reads a field in the %s lane",
    async (target) => {
      // Before this slice the accessor ALONE withdrew this class — the explicit
      // constructor and every method fell back with it (legacy=3, ir=0).
      const source = `
    export function run(p: number): number {
      class Box {
        p: number;
        constructor(p: number) { this.p = p; }
        get v(): number { return this.p * 2; }
      }
      return new Box(p).v;
    }
    `;
      const prepared = await compilePoisoned(
        source,
        `nested-accessor-ctor-${target}.ts`,
        target,
        ["Box_new", "Box_get_v"],
        ["run"],
      );

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expectCompiledOnce(prepared, ["run", "Box_new@", "Box_get_v@"]);
      expect((await instantiate(prepared)).run!(21)).toBe(42); // node: 21 * 2
    },
  );

  it.each(TARGETS)("prepares TWO sibling accessor classes as one component in the %s lane", async (target) => {
    // node: 2 + 38 + 1 + 1 === 42
    const source = `
    export function run(): number {
      class A { get(): number { return 2; } get a(): number { return 38; } }
      class B { get(): number { return 1; } get b(): number { return 1; } }
      const x = new A();
      const y = new B();
      return x.get() + x.a + y.get() + y.b;
    }
    `;
    const prepared = await compilePoisoned(
      source,
      `nested-accessor-siblings-${target}.ts`,
      target,
      ["A_new", "A_get", "A_get_a", "B_new", "B_get", "B_get_b"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "A_get@", "A_get_a@", "B_get@", "B_get_b@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("keeps the prepared accessor owner free of dynamic dispatch in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      GETTER_AND_SETTER,
      `nested-accessor-shape-${target}.ts`,
      target,
      ["Box_new", "Box_get_v", "Box_set_v"],
      ["run"],
    );
    const body = (name: string): string => {
      const start = prepared.wat.indexOf(`  (func $${name}`);
      expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
      const next = prepared.wat.indexOf("\n  (func $", start + 1);
      return prepared.wat.slice(start, next < 0 ? prepared.wat.length : next);
    };
    // Typed receiver, no ambient `this`, no generic member ladder, no boxing.
    for (const name of ["run", "Box_get_v", "Box_set_v"]) {
      expect(body(name)).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.test|__call_m_/,
      );
    }
  });

  it.each(TARGETS)("shares one prepared component across owner and accessors in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      METHOD_AND_GETTER,
      `nested-accessor-component-${target}.ts`,
      target,
      ["Box_new", "Box_get", "Box_get_v"],
      ["run"],
    );
    const observed = [outcome(prepared, "run"), outcome(prepared, "Box_get@"), outcome(prepared, "Box_get_v@")];
    const componentIds = new Set(observed.map((candidate) => candidate.preparedComponentId));
    expect(componentIds.size).toBe(1);
    expect([...componentIds][0]).toMatch(/^prepared-component:/);
  });

  it("produces identical results on the legacy and IR paths", async () => {
    for (const source of [METHOD_AND_GETTER, GETTER_AND_SETTER, CLASS_EXPRESSION]) {
      const direct = await compile(source, { fileName: "dual-direct.ts", experimentalIR: false });
      const prepared = await compile(source, { fileName: "dual-ir.ts", experimentalIR: true });
      expect(direct.success && prepared.success).toBe(true);
      const directRun = (await instantiate(direct)).run!();
      const preparedRun = (await instantiate(prepared)).run!();
      expect(directRun).toBe(42);
      expect(preparedRun).toBe(directRun);
    }
  });

  it("preserves setter evaluation ORDER against the direct path", async () => {
    // node: total=1; v=3 -> 1*2+3 = 5; v=4 -> 5*2+4 = 14.
    // A setter that reads its own field proves the write is not reordered or
    // elided; the answer differs for every wrong ordering.
    const source = `
    export function run(): number {
      class Acc {
        total: number;
        get v(): number { return this.total; }
        set v(x: number) { this.total = this.total * 2 + x; }
      }
      const a = new Acc();
      a.total = 1;
      a.v = 3;
      a.v = 4;
      return a.v;
    }
    `;
    const direct = await compile(source, { fileName: "order-direct.ts", experimentalIR: false });
    const prepared = await compile(source, { fileName: "order-ir.ts", experimentalIR: true });
    expect(direct.success && prepared.success).toBe(true);
    expect((await instantiate(direct)).run!()).toBe(14);
    expect((await instantiate(prepared)).run!()).toBe(14);
  });

  it("does not grow the optimized binary versus the direct control", async () => {
    for (const source of [METHOD_AND_GETTER, GETTER_AND_SETTER, CLASS_EXPRESSION]) {
      const direct = await compile(source, { fileName: "size-direct.ts", experimentalIR: false, optimize: true });
      const prepared = await compile(source, { fileName: "size-ir.ts", experimentalIR: true, optimize: true });
      expect(prepared.success && direct.success).toBe(true);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    }
  });
});

describe("#3522 nested class accessor negative boundaries", () => {
  // Each shape below was measured direct on main and must STAY direct. They
  // are the boundaries this slice deliberately does not move.

  it("keeps a nested accessor class with HERITAGE direct (no shadow-identity widening, #4448/#4575)", async () => {
    const result = await compile(
      `
      export function run(): number {
        class A { v: number; constructor(v: number) { this.v = v; } get a(): number { return this.v; } }
        class B extends A { get b(): number { return 2; } }
        return new B(40).a + new B(40).b;
      }
      `,
      { fileName: "nested-accessor-heritage.ts", experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42); // node: 40 + 2
    // The bounded predicate rejects heritage outright, so admitting accessors
    // moves no inheritance surface whatsoever.
    expectDirect(result, ["run", "A_get_a@"]);
  });

  it("keeps a nested class with a STATIC accessor direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { get(): number { return 42; } static get k(): number { return 1; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-accessor-static.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a nested class with a COMPUTED accessor name direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { get(): number { return 42; } get ["v"](): number { return 1; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-accessor-computed.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  // (#3522) A plain initialized instance field is admitted since the nested
  // initialized-field slice; the boundary moved to a CALL EDGE inside the
  // initializer (two owners plan the same call). See
  // `tests/issue-3522-nested-class-field.test.ts` for the positive family.
  it("keeps a nested accessor class whose field initializer CALLS a local function direct", async () => {
    const result = await compile(
      `
      function seed(): number { return 42; }
      export function run(): number {
        class Box { v: number = seed(); get w(): number { return this.v; } }
        return new Box().w;
      }
      `,
      { fileName: "nested-accessor-field.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a MUTABLE accessor class-expression binding direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        let Box = class { get(): number { return 3; } get v(): number { return 39; } };
        const b = new Box();
        return b.get() + b.v;
      }
      `,
      { fileName: "nested-accessor-mutable.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps an accessor that CAPTURES the enclosing frame direct", async () => {
    const result = await compile(
      `
      export function run(seed: number): number {
        class Box { get(): number { return 0; } get v(): number { return seed; } }
        return new Box().get() + new Box().v;
      }
      `,
      { fileName: "nested-accessor-capture.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(42)).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps the pre-existing accessor-only WRITEBACK family claiming unchanged", async () => {
    // A `this`-free, string-returning, accessor-ONLY nested class routes
    // through `isBoundedPreparedAccessorClass` and its own ABI evidence. This
    // slice must not divert it onto the ordinary path.
    const result = await compile(
      `
      export function run(): string {
        class Box { get v(): string { return "ok"; } }
        return new Box().v;
      }
      `,
      { fileName: "nested-accessor-writeback.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectCompiledOnce(result, ["run", "Box_get_v@"]);
  });

  it("gives an inner accessor class its OWN identity when it shadows an outer name", async () => {
    const result = await compile(
      `
      class Box { constructor() {} get outer(): number { return 1; } }
      export function run(): number {
        class Box { get(): number { return 0; } get inner(): number { return 42; } }
        const b = new Box();
        return b.get() + b.inner;
      }
      export function outerRun(): number { return new Box().outer; }
      `,
      { fileName: "nested-accessor-shadow.ts", experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const exports = await instantiate(result);
    // The load-bearing assertion is SEMANTIC: each `Box` resolves to its own
    // class and its own accessor, whichever path compiled it.
    expect(exports.run!()).toBe(42);
    expect(exports.outerRun!()).toBe(1);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("still reaches the direct class-body emitter for an unadmitted accessor class", async () => {
    // Positive control for the poison seam: if it were dead, every
    // admitted-family assertion above would pass vacuously.
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_get_w";
      const result = await compile(
        // A STATIC member keeps this class outside the bounded family, so it
        // must still reach the direct emitter. An initialized instance field
        // no longer works as this control — it is now admitted.
        `
        export function run(): number {
          class Box { static k: number = 1; get w(): number { return 42; } }
          return new Box().w;
        }
        `,
        { fileName: "nested-accessor-poison-control.ts", experimentalIR: true, trackIrOutcomes: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain("injected direct class-body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});
