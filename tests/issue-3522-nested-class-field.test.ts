// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522) Nested classes carrying INITIALIZED instance fields compile once.
//
// Measured on `origin/main` 49df493a before this slice, through the production
// `compile` seam (`experimentalIR: true, trackIrOutcomes: true`): every shape
// below withdrew its WHOLE enclosing function — `body-shape-rejected` on the
// owner, members never inventoried, `legacy=1 ir=0` — while the identical
// initialized-field shape on a TOP-LEVEL class already compiled once
// (`legacy=0 ir=3`, the #4402 checkpoint). The gap was three top-level-only
// assumptions, not a missing lowering:
//
//  1. `isBoundedPreparedNestedOrdinaryClass` rejected any initialized property.
//  2. `identity.ts` made a nested implicit constructor WITH initialized fields
//     a SUPPORT unit, where top level makes it a terminal. Relaxing only (1)
//     left the member claimed and the owner failing
//     `late-preparation-unsupported` — split ownership, which R3 forbids.
//  3. `selectImplicitConstructorClaim` required `topLevelSourceClass`.
//
// The residual is a CALL EDGE inside the initializer: the field's support unit
// belongs to the containing executable while the constructor terminal that runs
// it belongs to the class, so a call is planned under two owners. Measured
// without the gate that keeps it out, `p: number = seed()` is a hard compile
// failure (`selection-preparation-mismatch`), not a demotion — so the predicate
// fails closed on every callable form. Pinned as a negative boundary below.
//
// Every expected value was cross-checked against the same program in node.

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

// node: 40 + 2 === 42
const IMPLICIT_CTOR_FIELD = `
export function run(): number {
  class Box {
    p: number = 40;
    get(): number { return this.p + 2; }
  }
  return new Box().get();
}
`;

// node: new Box(400) -> p=100, q=100*400=40000; 40000 + 100 === 40100
const EXPLICIT_CTOR_FIELD_ORDER = `
export function run(seed: number): number {
  class Box {
    p: number = 100;
    q: number;
    constructor(q: number) { this.q = this.p * q; }
    get(): number { return this.q + this.p; }
  }
  return new Box(seed).get();
}
`;

// node: 40 + 2 === 42
const CLASS_EXPRESSION_FIELD = `
export function run(): number {
  const Box = class {
    p: number = 40;
    get(): number { return this.p + 2; }
  };
  return new Box().get();
}
`;

// node: 10 + 2 === 12, in declaration order
const TWO_FIELDS = `
export function run(): number {
  class Box {
    a: number = 10;
    b: number = 2;
    get(): number { return this.a + this.b; }
  }
  return new Box().get();
}
`;

describe("#3522 nested class initialized-field ownership", () => {
  it.each(TARGETS)("prepares an IMPLICIT-constructor field class once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      IMPLICIT_CTOR_FIELD,
      `nested-field-implicit-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    // The gain is the whole owner: `run` AND the promoted `_new` terminal AND
    // the method — not one field.
    expectCompiledOnce(prepared, ["run", "Box_new@", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares an EXPLICIT-constructor field class once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      EXPLICIT_CTOR_FIELD_ORDER,
      `nested-field-explicit-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_new@", "Box_get@"]);
    // Field initializers must run BEFORE the constructor body: `q` reads `p`.
    // Every wrong ordering yields a different answer (0, or NaN).
    expect((await instantiate(prepared)).run!(400)).toBe(40100);
  });

  it.each(TARGETS)("prepares a class EXPRESSION with an initialized field in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      CLASS_EXPRESSION_FIELD,
      `nested-field-expr-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "<anonymous-class>_new@", "<anonymous-class>_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares TWO initialized fields in declaration order in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      TWO_FIELDS,
      `nested-field-two-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_new@", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(12);
  });

  it.each(TARGETS)("prepares a STRING-carrier initialized field in the %s lane", async (target) => {
    // node: "abc".length === 3. Proves the field carrier is not restricted to
    // scalars — a reference-bearing layout reaches the same prepared route.
    const source = `
    export function run(): number {
      class Box {
        s: string = "abc";
        len(): number { return this.s.length; }
      }
      return new Box().len();
    }
    `;
    const prepared = await compilePoisoned(
      source,
      `nested-field-string-${target}.ts`,
      target,
      ["Box_new", "Box_len"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_new@", "Box_len@"]);
    expect((await instantiate(prepared)).run!()).toBe(3);
  });

  it.each(TARGETS)("shares one prepared component across owner, ctor and members in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      IMPLICIT_CTOR_FIELD,
      `nested-field-component-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );
    const observed = [outcome(prepared, "run"), outcome(prepared, "Box_new@"), outcome(prepared, "Box_get@")];
    const componentIds = new Set(observed.map((candidate) => candidate.preparedComponentId));
    expect(componentIds.size).toBe(1);
    expect([...componentIds][0]).toMatch(/^prepared-component:/);
  });

  it.each(TARGETS)("keeps the prepared field owner free of dynamic dispatch in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      IMPLICIT_CTOR_FIELD,
      `nested-field-shape-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );
    const body = (name: string): string => {
      const start = prepared.wat.indexOf(`  (func $${name}`);
      expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
      const next = prepared.wat.indexOf("\n  (func $", start + 1);
      return prepared.wat.slice(start, next < 0 ? prepared.wat.length : next);
    };
    // Typed receiver + typed struct field write; no ambient `this`, no generic
    // member ladder, no boxing, no indirect dispatch.
    for (const name of ["run", "Box_get"]) {
      expect(body(name)).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.test|__call_m_/,
      );
    }
    // The initializer lands in the constructor `_init`, as a typed struct.set.
    expect(prepared.wat).toMatch(/struct\.set/);
  });

  it("produces identical results on the legacy and IR paths", async () => {
    const cases: readonly (readonly [string, number, number | undefined])[] = [
      [IMPLICIT_CTOR_FIELD, 42, undefined],
      [EXPLICIT_CTOR_FIELD_ORDER, 40100, 400],
      [CLASS_EXPRESSION_FIELD, 42, undefined],
      [TWO_FIELDS, 12, undefined],
    ];
    for (const [source, expected, argument] of cases) {
      const direct = await compile(source, { fileName: "dual-direct.ts", experimentalIR: false });
      const prepared = await compile(source, { fileName: "dual-ir.ts", experimentalIR: true });
      expect(direct.success && prepared.success).toBe(true);
      const directRun = (await instantiate(direct)).run!(argument);
      const preparedRun = (await instantiate(prepared)).run!(argument);
      expect(directRun).toBe(expected);
      expect(preparedRun).toBe(directRun);
    }
  });

  it("preserves field-initializer ORDER against the direct path", async () => {
    // node: p=2; q = p*3 = 6; r = q + p = 8; 8*10 + 6 = 86. Each field reads
    // the previous one, so any reordering, elision, or hoist gives a different
    // answer — and the direct path is the oracle, not a hard-coded constant.
    const source = `
    export function run(): number {
      class Chain {
        p: number = 2;
        q: number = 0;
        r: number = 0;
        constructor() { this.q = this.p * 3; this.r = this.q + this.p; }
        get(): number { return this.r * 10 + this.q; }
      }
      return new Chain().get();
    }
    `;
    const direct = await compile(source, { fileName: "field-order-direct.ts", experimentalIR: false });
    const prepared = await compile(source, {
      fileName: "field-order-ir.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(direct.success && prepared.success).toBe(true);
    expect((await instantiate(direct)).run!()).toBe(86);
    expect((await instantiate(prepared)).run!()).toBe(86);
    expectCompiledOnce(prepared, ["run", "Chain_new@", "Chain_get@"]);
  });
});

describe("#3522 nested class initialized-field negative boundaries", () => {
  it("keeps a class whose field initializer CALLS a local function direct", async () => {
    // THE residual of this slice. The field's support unit is attributed to
    // `run` while the constructor terminal that runs it is attributed to `Box`,
    // so the call is planned under two owners. Without the call-edge gate this
    // is a hard `selection-preparation-mismatch` compile failure, not a
    // demotion — so the boundary must stay verified, not assumed.
    const result = await compile(
      `
      function seed(): number { return 40; }
      export function run(): number {
        class Box { p: number = seed(); get(): number { return this.p + 2; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-field-call.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a class whose field initializer CONSTRUCTS another class direct", async () => {
    const result = await compile(
      `
      class Other { v: number = 40; }
      export function run(): number {
        class Box { o: Other = new Other(); get(): number { return this.o.v + 2; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-field-new.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a class with a STATIC initialized field direct", async () => {
    // A static field initializer runs at class-definition time IN the
    // containing frame — exactly the inertness the bounded predicate asserts.
    // It is a different ordered contract and stays out of this family.
    const result = await compile(
      `
      export function run(): number {
        class Box { static k: number = 40; get(): number { return 2; } }
        return Box.k + new Box().get();
      }
      `,
      { fileName: "nested-field-static.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a field class with HERITAGE direct (no shadow-identity widening, #4448/#4575)", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Base { b: number = 40; }
        class Box extends Base { p: number = 2; get(): number { return this.b + this.p; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-field-heritage.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a field initializer that CAPTURES the enclosing frame direct", async () => {
    const source = `
      export function run(): number {
        const base = 40;
        class Box { p: number = base; get(): number { return this.p + 2; } }
        return new Box().get();
      }
      `;
    const result = await compile(source, {
      fileName: "nested-field-capture.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectDirect(result, ["run"]);
    // The DIRECT path is the oracle here, not node. A field initializer that
    // reads an enclosing `const` yields 2, not node's 42 — measured identical
    // on this branch and on unmodified `origin/main`, and identical on the
    // direct and IR paths. That is a pre-existing legacy capture defect, not
    // this slice; what this test owns is that the shape stays direct and that
    // the two paths still agree.
    const direct = await compile(source, { fileName: "nested-field-capture-direct.ts", experimentalIR: false });
    expect((await instantiate(result)).run!()).toBe((await instantiate(direct)).run!());
  });

  it("keeps a MUTABLE class-expression binding with a field direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        let Box = class { p: number = 40; get(): number { return this.p + 2; } };
        return new Box().get();
      }
      `,
      { fileName: "nested-field-mutable.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("does not change name-shadowed field-class behaviour versus the direct path", async () => {
    // An inner `Box` with a field shadowing an outer `Box` with a field. node
    // gives 41 + 1 = 42; BOTH compiler paths give 82 (the outer `outer()` call
    // resolves to the inner class), identically on this branch and on
    // unmodified `origin/main`. That is a pre-existing name-resolution defect
    // and is deliberately NOT fixed here — this test pins that the slice
    // neither introduces nor hides it, and that no post-claim error appears.
    const source = `
    class Box { p: number = 1; get(): number { return this.p; } }
    export function run(): number {
      class Box { p: number = 41; get(): number { return this.p; } }
      return new Box().get() + outer();
    }
    function outer(): number { return new Box().get(); }
    `;
    const result = await compile(source, {
      fileName: "nested-field-shadow.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const direct = await compile(source, { fileName: "nested-field-shadow-direct.ts", experimentalIR: false });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe((await instantiate(direct)).run!());
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("still reaches the direct class-body emitter for an unadmitted field class", async () => {
    // Positive control for the poison seam itself: without it every
    // admitted-family assertion above could pass vacuously.
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new";
      const result = await compile(
        `
        function seed(): number { return 40; }
        export function run(): number {
          class Box { p: number = seed(); get(): number { return this.p + 2; } }
          return new Box().get();
        }
        `,
        { fileName: "nested-field-poison-control.ts", experimentalIR: true, trackIrOutcomes: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain("injected direct class-body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});
