// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522) Nested classes carrying STATIC METHODS compile once.
//
// Measured on `origin/main` 34e102dc8 before this slice, through the production
// `compile` seam (`experimentalIR: true, trackIrOutcomes: true`): every shape
// below withdrew its WHOLE enclosing function — `body-shape-rejected` on the
// owner, `legacy=1 ir=0` — while the identical static-method shape on a
// TOP-LEVEL class already compiled once (`legacy=0 ir=4`).
//
// Relaxing the member-shape gate alone reproduces the terminal diagnostic the
// previous slice recorded, and ONLY for a class reached exclusively through its
// static side (no `new` anywhere in the transaction):
//
//   run  kind=invariant  code=unexpected-internal-throw  stage=lower
//   "ABI draft …class-implicit-constructor…:body would mutate sealed prepared
//    scope prepared-component:…class-static-method…+…top-level-function…"
//
// `ClassRegistry.resolve` binds the source-owned `_init` callable for EVERY
// class shape the lowering materializes, not only for the ones a `new` reaches.
// With no `new`, nothing planned that binding up front, so it was planned
// lazily during lowering — after the static component sealed. The transaction
// is an ORDERING one: the implicit-constructor reaching set now also reaches a
// bounded nested class through a STATIC MEMBER ACCESS on its identifier, so the
// support pair is planned in the same pre-seal phase as the static member.
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

// node: 42. THE fixture that reproduces the sealing-order invariant — a class
// reached only through its static side, with no `new` anywhere.
const STATIC_ONLY = `
export function run(): number {
  class Box {
    make(): number { return 0; }
    static base(): number { return 42; }
  }
  return Box.base();
}
`;

// node: 40 + 2 === 42
const TWO_STATICS = `
export function run(): number {
  class Box {
    static a(): number { return 40; }
    static b(): number { return 2; }
  }
  return Box.a() + Box.b();
}
`;

// node: 40 + 2 === 42 — a static reached from inside ANOTHER static body, so
// the reaching walk must find it from a class-member owner unit, not only from
// the enclosing function.
const STATIC_CALLS_STATIC = `
export function run(): number {
  class Box {
    static a(): number { return Box.b() + 2; }
    static b(): number { return 40; }
  }
  return Box.a();
}
`;

// node: 40 + 2 === 42
const STATIC_PLUS_INSTANCE = `
export function run(): number {
  class Box {
    static base(): number { return 40; }
    get(): number { return Box.base() + 2; }
  }
  return new Box().get();
}
`;

// node: 40 + 2 === 42 — statics beside an initialized field and an implicit
// constructor, the family the previous slice admitted.
const STATIC_FIELD_METHOD = `
export function run(): number {
  class Box {
    p: number = 40;
    static base(): number { return 2; }
    get(): number { return this.p + Box.base(); }
  }
  return new Box().get();
}
`;

// node: 2 + 40 === 42
const STATIC_EXPLICIT_CTOR = `
export function run(seed: number): number {
  class Box {
    p: number;
    constructor(v: number) { this.p = v; }
    static base(): number { return 40; }
    get(): number { return this.p + Box.base(); }
  }
  return new Box(seed).get();
}
`;

describe("#3522 nested class static-member ownership", () => {
  it.each(TARGETS)("prepares a STATIC-ONLY reached class once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      STATIC_ONLY,
      `nested-static-only-${target}.ts`,
      target,
      ["Box_base", "Box_make"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    // This is the sealing-order case: before the transaction it was
    // `unexpected-internal-throw@lower`, not merely a demotion.
    expectCompiledOnce(prepared, ["run", "Box_base@", "Box_make@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares TWO static methods once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      TWO_STATICS,
      `nested-static-two-${target}.ts`,
      target,
      ["Box_a", "Box_b"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_a@", "Box_b@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a static reached from another STATIC BODY in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      STATIC_CALLS_STATIC,
      `nested-static-chain-${target}.ts`,
      target,
      ["Box_a", "Box_b"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_a@", "Box_b@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a static beside an INSTANCE method in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      STATIC_PLUS_INSTANCE,
      `nested-static-instance-${target}.ts`,
      target,
      ["Box_base", "Box_get"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_base@", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a static beside an INITIALIZED FIELD in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      STATIC_FIELD_METHOD,
      `nested-static-field-${target}.ts`,
      target,
      ["Box_base", "Box_get", "Box_new"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    // The gain is the whole owner plus every member INCLUDING the promoted
    // implicit-constructor terminal the previous slice introduced.
    expectCompiledOnce(prepared, ["run", "Box_base@", "Box_get@", "Box_new@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a static beside an EXPLICIT constructor in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      STATIC_EXPLICIT_CTOR,
      `nested-static-explicit-${target}.ts`,
      target,
      ["Box_base", "Box_get", "Box_new"],
      ["run"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_base@", "Box_get@", "Box_new@"]);
    expect((await instantiate(prepared)).run!(2)).toBe(42);
  });

  it.each(TARGETS)("prepares a MULTI-PARAMETER static in the %s lane", async (target) => {
    // node: 40 + 2 === 42. Arity is carried by the callable ABI, not by a
    // receiver: a static takes no `this` slot.
    const source = `
    export function run(): number {
      class Box { static add(a: number, b: number): number { return a + b; } }
      return Box.add(40, 2);
    }
    `;
    const prepared = await compilePoisoned(source, `nested-static-arity-${target}.ts`, target, ["Box_add"], ["run"]);

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_add@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares a STRING-returning static in the %s lane", async (target) => {
    // node: "abc".length + 39 === 42. Proves the static callable is not
    // restricted to scalar returns — a reference-bearing result reaches the
    // same prepared route.
    const source = `
    export function run(): number {
      class Box { static label(): string { return "abc"; } }
      return Box.label().length + 39;
    }
    `;
    const prepared = await compilePoisoned(source, `nested-static-string-${target}.ts`, target, ["Box_label"], ["run"]);

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["run", "Box_label@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("shares one prepared component across owner and statics in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      STATIC_PLUS_INSTANCE,
      `nested-static-component-${target}.ts`,
      target,
      ["Box_base", "Box_get"],
      ["run"],
    );
    const observed = [outcome(prepared, "run"), outcome(prepared, "Box_base@"), outcome(prepared, "Box_get@")];
    const componentIds = new Set(observed.map((candidate) => candidate.preparedComponentId));
    expect(componentIds.size).toBe(1);
    expect([...componentIds][0]).toMatch(/^prepared-component:/);
    // The component id must name the static-method unit — that is the scope
    // whose seal the implicit-constructor draft used to arrive after.
    expect([...componentIds][0]).toContain("class-static-method");
  });

  it.each(TARGETS)("keeps the prepared static owner free of dynamic dispatch in the %s lane", async (target) => {
    // Parameterised so the static call cannot constant-fold away — the shape
    // under test is the CALL, not a folded literal.
    const source = `
    export function run(seed: number): number {
      class Box {
        make(): number { return 0; }
        static base(v: number): number { return v + 40; }
      }
      return Box.base(seed);
    }
    `;
    const prepared = await compilePoisoned(
      source,
      `nested-static-shape-${target}.ts`,
      target,
      ["Box_base", "Box_make", "Box_new"],
      ["run"],
    );
    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(prepared)).run!(2)).toBe(42);

    const body = (name: string): string => {
      const start = prepared.wat.indexOf(`  (func $${name}`);
      expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
      const next = prepared.wat.indexOf("\n  (func $", start + 1);
      return prepared.wat.slice(start, next < 0 ? prepared.wat.length : next);
    };
    // No ambient `this`, no generic member ladder, no boxing, no indirect
    // dispatch anywhere in the owner or its statics.
    for (const name of ["run", "Box_base", "Box_make"]) {
      expect(body(name)).not.toMatch(
        /externref|any\.convert_extern|extern\.convert_any|call_ref|call_indirect|ref\.test|__call_m_/,
      );
    }
    // The static reach is a DIRECT call, and the STATIC callable carries no
    // receiver slot — the instance method beside it does. That contrast is the
    // ABI proof: `$Box_base` resolves through a shared func type with no
    // leading reference parameter, `$Box_make` declares `(param (ref null …))`.
    expect(body("run")).toMatch(/\b(return_call|call)\b/);
    expect(body("Box_base").split("\n")[0]).not.toMatch(/\(param \(ref/);
    expect(body("Box_make").split("\n")[0]).toMatch(/\(param \(ref/);
    // A class reached only through its static side allocates nothing: the
    // ordering fix plans the `_init` support binding, it does not force a
    // construction into the owner.
    expect(body("run")).not.toMatch(/struct\.new/);
  });

  it("produces identical results on the legacy and IR paths", async () => {
    const cases: readonly (readonly [string, number, number | undefined])[] = [
      [STATIC_ONLY, 42, undefined],
      [TWO_STATICS, 42, undefined],
      [STATIC_CALLS_STATIC, 42, undefined],
      [STATIC_PLUS_INSTANCE, 42, undefined],
      [STATIC_FIELD_METHOD, 42, undefined],
      [STATIC_EXPLICIT_CTOR, 42, 2],
    ];
    for (const [source, expected, argument] of cases) {
      const direct = await compile(source, { fileName: "static-dual-direct.ts", experimentalIR: false });
      const prepared = await compile(source, { fileName: "static-dual-ir.ts", experimentalIR: true });
      expect(direct.success && prepared.success).toBe(true);
      const directRun = (await instantiate(direct)).run!(argument);
      const preparedRun = (await instantiate(prepared)).run!(argument);
      expect(directRun).toBe(expected);
      expect(preparedRun).toBe(directRun);
    }
  });

  it("preserves static-call evaluation ORDER against the direct path", async () => {
    // node: a() * b() === 10 * 4 === 40; the log records 1 then 2, so
    // 40 + 1*100 + 2 === 142. Any reordering or elision of the two static calls
    // gives a different answer — and the DIRECT path is the oracle here, not a
    // hard-coded constant.
    const source = `
    export function run(): number {
      const log: number[] = [];
      class Box {
        static a(): number { log.push(1); return 10; }
        static b(): number { log.push(2); return 4; }
      }
      const v = Box.a() * Box.b();
      return v + log[0] * 100 + log[1];
    }
    `;
    const direct = await compile(source, { fileName: "static-order-direct.ts", experimentalIR: false });
    const prepared = await compile(source, {
      fileName: "static-order-ir.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(direct.success && prepared.success).toBe(true);
    const directRun = (await instantiate(direct)).run!();
    expect(directRun).toBe(142);
    expect((await instantiate(prepared)).run!()).toBe(directRun);
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);
  });
});

describe("#3522 nested class static-member negative boundaries", () => {
  it("keeps a class with a STATIC FIELD direct", async () => {
    // A static field initializer runs at class-definition time IN the
    // containing frame — exactly the inertness the bounded predicate asserts.
    // It is a different ordered contract and stays out of this family.
    const result = await compile(
      `
      export function run(): number {
        class Box { static k: number = 40; static base(): number { return 2; } }
        return Box.k + Box.base();
      }
      `,
      { fileName: "nested-static-field.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a class with a STATIC ACCESSOR direct", async () => {
    // A static accessor's descriptor is not on the ordinary
    // descriptor-by-name-and-kind path this family resolves.
    const result = await compile(
      `
      export function run(): number {
        class Box { static get base(): number { return 42; } }
        return Box.base;
      }
      `,
      { fileName: "nested-static-accessor.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a static with a COMPUTED name direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { static ["k"](): number { return 42; } }
        return Box["k"]();
      }
      `,
      { fileName: "nested-static-computed.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps an ASYNC static direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { static async k(): Promise<number> { return 42; } get(): number { return 42; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-static-async.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a GENERATOR static direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Box { static *k(): Generator<number> { yield 42; } get(): number { return 42; } }
        return new Box().get();
      }
      `,
      { fileName: "nested-static-generator.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a static class with HERITAGE direct (no shadow-identity widening, #4448/#4575)", async () => {
    const result = await compile(
      `
      export function run(): number {
        class Base { static b(): number { return 40; } }
        class Box extends Base { static k(): number { return 2; } }
        return Box.k() + Base.b();
      }
      `,
      { fileName: "nested-static-heritage.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a static that CAPTURES the enclosing frame direct", async () => {
    const result = await compile(
      `
      export function run(): number {
        const seed = 40;
        class Box { static k(): number { return seed + 2; } }
        return Box.k();
      }
      `,
      { fileName: "nested-static-capture.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("keeps a STATIC-ONLY class EXPRESSION direct (the residual of this slice)", async () => {
    // Measured boundary, not an assumption. A nested class EXPRESSION whose
    // binding is consumed by a `new` is already admitted (the accessor and
    // field slices own that), and one carrying a static BESIDE an instance
    // member is admitted here. What stays out is the static-ONLY expression:
    // its `const` binding is proven safe only for construction uses
    // (`boundedClassExpressionBindingHasOnlyStaticConstructionUses`), which a
    // static member access is not, so the binding never reaches the projected
    // local-class set and the owner rejects at `body-shape-rejected`. Widening
    // that proof is a separate transaction from the sealing order.
    const result = await compile(
      `
      export function run(): number {
        const Box = class { static make(): number { return 42; } };
        return Box.make();
      }
      `,
      { fileName: "nested-static-expression.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run"]);
  });

  it("withdraws BOTH owner and class when the class binding is used as a VALUE", async () => {
    // The correctness fix that came with this slice. Admitting statics made a
    // static-side ALIAS reachable, and `ir/from-ast` cannot represent a class
    // binding as a first-class value: measured before the fix, `Box_k` claimed
    // and emitted while `run` fell back, with the post-claim BUILD error
    // 'identifier "Box" is not in scope in run' — split ownership. The
    // equivalent instance-member program was already withdrawn correctly by the
    // `new Alias()` arm; the static side had no such arm.
    const result = await compile(
      `
      export function run(): number {
        class Box { static k(): number { return 42; } }
        const Alias = Box;
        return Alias.k();
      }
      `,
      { fileName: "nested-static-alias.ts", experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expectDirect(result, ["run", "Box_k@"]);
  });

  it("does not change name-shadowed static-class behaviour versus the direct path", async () => {
    // An inner `Box` with a static shadowing an outer `Box` with a static. The
    // DIRECT path is the oracle, not node — this pins that the slice neither
    // introduces nor hides any pre-existing name-resolution difference, and
    // that no post-claim error appears.
    const source = `
    class Box { static k(): number { return 1; } }
    export function run(): number {
      class Box { static k(): number { return 41; } }
      return Box.k() + outer();
    }
    function outer(): number { return Box.k(); }
    `;
    const result = await compile(source, {
      fileName: "nested-static-shadow.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const direct = await compile(source, { fileName: "nested-static-shadow-direct.ts", experimentalIR: false });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe((await instantiate(direct)).run!());
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("still reaches the direct class-body emitter for an unadmitted static class", async () => {
    // Positive control for the poison seam itself: without it every
    // admitted-family assertion above could pass vacuously.
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_base";
      const result = await compile(
        `
        export function run(): number {
          class Box { static k: number = 40; static base(): number { return 2; } }
          return Box.k + Box.base();
        }
        `,
        { fileName: "nested-static-poison-control.ts", experimentalIR: true, trackIrOutcomes: true },
      );
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain("injected direct class-body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});
