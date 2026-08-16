// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522) Nested classes with an IMPLICIT constructor compile once.
//
// Measured on `origin/main` before this slice: a nested class whose
// constructor is implicit withdrew its WHOLE enclosing function
// (`body-shape-rejected@select`, owner `legacy=1 ir=0`) and never inventoried
// its members, while the identical shape at TOP level already compiled once.
// The gap was five top-level-only gates, not a missing lowering — so these
// tests pin ownership, runtime semantics, and the exact boundaries that must
// stay direct.

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
 * Compile with the direct class/function body emitters poisoned. A hidden
 * direct compile followed by an IR patch therefore cannot satisfy any
 * positive assertion below.
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
  const observed = names.map((name) => outcome(result, name));
  for (const candidate of observed) {
    expect(candidate, `${candidate.displayName} must be prepared IR`).toMatchObject({
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

const DECLARATION_SOURCE = `
export function run(): number {
  class Box {
    get(): number { return 42; }
  }
  return new Box().get();
}
`;

const EXPRESSION_SOURCE = `
export function run(): number {
  const Box = class {
    get(): number { return 42; }
  };
  return new Box().get();
}
`;

describe("#3522 nested implicit-constructor class ownership", () => {
  it.each(TARGETS)("prepares a nested implicit-constructor DECLARATION once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      DECLARATION_SOURCE,
      `nested-implicit-decl-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_get"]);
    // Runtime semantics, compared against the same program evaluated by node.
    expect((await instantiate(prepared)).run!()).toBe(42);

    // The implicit support pair is installed, and the allocation lives in `_new`
    // while `_init` only returns the receiver.
    expect(prepared.wat).toContain("$Box_new");
    expect(prepared.wat).toContain("$Box_init");
  });

  it.each(TARGETS)("prepares a nested implicit-constructor EXPRESSION once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      EXPRESSION_SOURCE,
      `nested-implicit-expr-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "<anonymous-class>_get"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("keeps the prepared owner free of dynamic dispatch in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      DECLARATION_SOURCE,
      `nested-implicit-shape-${target}.ts`,
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
    // Typed receiver, no ambient `this`, no generic member ladder, no boxing.
    for (const name of ["run", "Box_get", "Box_init"]) {
      expect(body(name)).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.test|__call_m_/,
      );
    }
  });

  it.each(TARGETS)(
    "prepares a mixed component whose sibling class has an explicit constructor in the %s lane",
    async (target) => {
      // Before this slice the implicit-constructor sibling withdrew the whole
      // component: `run`, `A_new` and `A_a` all fell back (legacy=3, ir=0).
      const source = `
      export function run(): number {
        class A { v: number; constructor(v: number) { this.v = v; } a(): number { return this.v; } }
        class B { b(): number { return 2; } }
        return new A(40).a() + new B().b();
      }
      `;
      const prepared = await compilePoisoned(
        source,
        `nested-implicit-sibling-${target}.ts`,
        target,
        ["A_new", "A_a", "B_new", "B_b"],
        ["run"],
      );

      expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(prepared.binary)).toBe(true);
      expectCompiledOnce(prepared, ["run", "A_new", "A_a", "B_b"]);
      expect((await instantiate(prepared)).run!()).toBe(42);
    },
  );

  it.each(TARGETS)("shares one prepared component across owner and members in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      DECLARATION_SOURCE,
      `nested-implicit-component-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run"],
    );
    const observed = [outcome(prepared, "run"), outcome(prepared, "Box_get")];
    const componentIds = new Set(observed.map((candidate) => candidate.preparedComponentId));
    expect(componentIds.size).toBe(1);
    expect([...componentIds][0]).toMatch(/^prepared-component:/);
  });

  it("produces identical results on the legacy and IR paths", async () => {
    for (const source of [DECLARATION_SOURCE, EXPRESSION_SOURCE]) {
      const direct = await compile(source, { fileName: "dual-direct.ts", experimentalIR: false });
      const prepared = await compile(source, { fileName: "dual-ir.ts", experimentalIR: true });
      expect(direct.success && prepared.success).toBe(true);
      const directRun = (await instantiate(direct)).run!();
      const preparedRun = (await instantiate(prepared)).run!();
      expect(directRun).toBe(42);
      expect(preparedRun).toBe(directRun);
    }
  });

  it("does not grow the optimized binary versus the direct control", async () => {
    for (const source of [DECLARATION_SOURCE, EXPRESSION_SOURCE]) {
      const direct = await compile(source, { fileName: "size-direct.ts", experimentalIR: false, optimize: true });
      const prepared = await compile(source, { fileName: "size-ir.ts", experimentalIR: true, optimize: true });
      expect(prepared.success && direct.success).toBe(true);
      expect(prepared.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
    }
  });
});

describe("#3522 nested implicit-constructor negative boundaries", () => {
  // Each of these still reaches the direct class-body emitter. They are the
  // measured shapes that must NOT move with this slice.

  it("keeps a nested class with heritage direct (no shadow-identity widening, #4448)", async () => {
    const result = await compile(
      `
      export function run(): number {
        class A { v: number; constructor(v: number) { this.v = v; } a(): number { return this.v; } }
        class B extends A { b(): number { return 2; } }
        return new B(40).a() + new B(40).b();
      }
      `,
      { fileName: "nested-implicit-heritage.ts", experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    // The implicit DERIVED constructor is unreachable from this admission
    // because the bounded predicate rejects heritage outright.
    expectDirect(result, ["run", "A_new", "A_a"]);
  });

  it("keeps a nested class that SHADOWS an outer class name direct", async () => {
    // A nested implicit-constructor class whose name shadows a top-level class
    // must not inherit the outer class's identity or layout.
    const result = await compile(
      `
      class Box { outer(): number { return 1; } }
      export function run(): number {
        class Box { inner(): number { return 42; } }
        return new Box().inner();
      }
      export function outerRun(): number { return new Box().outer(); }
      `,
      { fileName: "nested-implicit-shadow.ts", experimentalIR: true, trackIrOutcomes: true },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const exports = await instantiate(result);
    // The load-bearing assertion is SEMANTIC: each name resolves to its own
    // class, whichever path compiled it.
    expect(exports.run!()).toBe(42);
    expect(exports.outerRun!()).toBe(1);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps a nested class with a static member direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { get(): number { return 42; } static k(): number { return 1; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-implicit-static.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  // (#3522) A plain initialized instance field is no longer a boundary — the
  // nested initialized-field slice admits it, and
  // `tests/issue-3522-nested-class-field.test.ts` owns that positive family.
  // The boundary MOVED to the call edge inside the initializer: the field's
  // support unit belongs to the containing executable while the constructor
  // terminal that runs it belongs to the class, so a call is planned under two
  // owners. It must stay direct rather than reach that disagreement.
  it("keeps a nested class whose field initializer CALLS a local function direct", async () => {
    const result = await compile(
      `
      function seed(): number { return 42; }
      export function run(): number {
        class Box { v: number = seed(); get(): number { return this.v; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-implicit-field-call.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a nested class with no method direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { v: number; }
        const b = new Box(); b.v = 42; return b.v;
      }
      `,
      { fileName: "nested-implicit-nomethod.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a MUTABLE class-expression binding direct", async () => {
    // Only the exact immutable `const C = class { … }` form is admitted; a
    // `let` binding can be reassigned, so its construction target is not
    // statically the projected class.
    const result = await compile(
      `
      export function run(): number {
        let Box = class { get(): number { return 42; } };
        return new Box().get();
      }
      `,
      { fileName: "nested-implicit-mutable.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a nested implicit-constructor class whose method captures the enclosing frame direct", async () => {
    const result = await compile(
      `
      export function run(seed: number): number {
        class Box { get(): number { return seed; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-implicit-capture.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!(42)).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("still reaches the direct class-body emitter for an unadmitted nested class", async () => {
    // Positive control for the poison seam itself: if the seam were dead, the
    // admitted-family tests above would pass vacuously.
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new";
      const result = await compile(
        // A STATIC member is still outside the bounded family (its definition
        // evaluation is not inert in the containing frame), so this class must
        // still reach the direct emitter. An initialized instance field no
        // longer works as this control — it is now admitted.
        `
        export function run(): number {
          class Box { static k: number = 1; get(): number { return 42; } }
          return new Box().get();
        }
        `,
        { fileName: "nested-implicit-poison-control.ts", experimentalIR: true, trackIrOutcomes: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain("injected direct class-body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});
