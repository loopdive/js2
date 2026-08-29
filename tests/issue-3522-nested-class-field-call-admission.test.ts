// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3522 F4) The exact prepared field-call family compiles ONCE.
//
// Measured on `origin/main` 81e54a98e, through the production `compile` seam
// (`experimentalIR: true, trackIrOutcomes: true`), for
// `class Box { p: number = seed(40); get(): number { return this.p; } }`
// inside `run`:
//
//   gc/standalone: seed=emitted(ir)  run=unsupported(legacy)
//                  Box_new@=unsupported(legacy)  Box_get@=unsupported(legacy)
//
// F3 had already minted the constructor terminal, the field support unit, and
// the dormant source-qualified proof; the selector deliberately normalized the
// whole class to `class-member-unsupported@select`. F4 consumes that proof:
// `codegen/index.ts` validates it once, derives ONE immutable admitted-class
// marker before local class-expression resolution and identity selection, and
// threads that same object through class shapes, module bindings, the
// selector, prepared free functions, class bodies and nested executable
// syntax. No consumer re-runs a syntax predicate, and
// `boundedPreparedInstanceFieldInitializer` still rejects `CallExpression`, so
// nothing outside the proved family becomes admissible.
//
// Every expected value below was cross-checked against the same program in
// node, and every negative control was measured identical on `origin/main`.

import { describe, expect, it } from "vitest";

import { compile, compileMulti, type CompileResult, type IrObservedOutcome } from "../src/index.js";
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
  inline?: "off",
): Promise<CompileResult> {
  const previousClass = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  const previousFunction = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
  const previousInline = process.env.JS2WASM_IR_INLINE;
  try {
    process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = classBodies.join(",");
    process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = functionBodies.join(",");
    if (inline === "off") process.env.JS2WASM_IR_INLINE = "0";
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
    if (previousInline === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
    else process.env.JS2WASM_IR_INLINE = previousInline;
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
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  }
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

/**
 * Map a WAT function name to its module function index.
 *
 * Emitted call sites carry the numeric index (`call 3`), not the symbolic name,
 * so a `call $seed` regex silently matches nothing and any "the call is there"
 * assertion passes vacuously.
 */
function watFunctionIndex(wat: string, name: string): number {
  const importedFunctions = [...wat.matchAll(/^\s*\(import\b.*\(func\b/gm)].length;
  const defined = [...wat.matchAll(/^\s{2}\(func \$([A-Za-z0-9_$@:]+)/gm)].map((match) => match[1]!);
  const at = defined.indexOf(name);
  expect(at, `missing defined function $${name}`).toBeGreaterThanOrEqual(0);
  return importedFunctions + at;
}

/** Slice one top-level WAT function body by name. */
function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

/** Compile a negative control with NO poison; the direct route must own it. */
async function compileDirectControl(source: string, fileName: string): Promise<CompileResult> {
  return compile(source, { fileName, experimentalIR: true, trackIrOutcomes: true, emitWat: true });
}

// node: seed(40) === 42
const IMPLICIT = `
function seed(v: number): number { return v + 2; }
export function run(): number {
  class Box {
    p: number = seed(40);
    get(): number { return this.p; }
  }
  return new Box().get();
}
`;

// node: sum(0..8) === 36, + 6 === 42. The loop keeps the callee out of reach of
// constant folding, so the emitted call edge is observable in WAT. With the
// foldable `seed(v) => v + 2` above the whole initializer folds to `f64.const
// 42` even with `JS2WASM_IR_INLINE=0` (measured), which would make a
// "call is present" assertion vacuous.
const IMPLICIT_UNFOLDABLE = `
function seed(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s += i; } return s + 6; }
export function run(): number {
  class Box {
    p: number = seed(9);
    get(): number { return this.p; }
  }
  return new Box().get();
}
`;

// node: p = seed(98) = 100; q = 100 * 400 = 40000; 40000 + 100 === 40100.
// Every wrong initializer/constructor ordering gives 0 or NaN instead.
const EXPLICIT_ORDER = `
function seed(v: number): number { return v + 2; }
export function run(q: number): number {
  class Box {
    p: number = seed(98);
    q: number;
    constructor(q: number) { this.q = this.p * q; }
    get(): number { return this.q + this.p; }
  }
  return new Box(q).get();
}
`;

// node: 42
const EXPRESSION = `
function seed(v: number): number { return v + 2; }
export function run(): number {
  const Box = class {
    p: number = seed(40);
    get(): number { return this.p; }
  };
  return new Box().get();
}
`;

// node: first(9) = 10, second(1) = 2, 10 + 2 === 12, in declaration order
const TWO_FIELDS = `
function first(v: number): number { return v + 1; }
function second(v: number): number { return v * 2; }
export function run(): number {
  class Box {
    a: number = first(9);
    b: number = second(1);
    get(): number { return this.a + this.b; }
  }
  return new Box().get();
}
`;

// The F2 positive control: a nested METHOD calling a top-level function was
// already admitted before F4 and must stay admitted.
const METHOD_CALL = `
function seed(v: number): number { return v + 2; }
export function run(): number {
  class Box {
    get(): number { return seed(40); }
  }
  return new Box().get();
}
`;

// A TOP-LEVEL initialized-field call already compiled once before F4.
const TOP_LEVEL_FIELD = `
function seed(v: number): number { return v + 2; }
class Box {
  p: number = seed(40);
  get(): number { return this.p; }
}
export function run(): number { return new Box().get(); }
`;

describe("#3522 F4 prepared nested class field-call admission", () => {
  it.each(TARGETS)("prepares an IMPLICIT-constructor field call once in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      IMPLICIT,
      `field-call-implicit-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["seed", "run", "Box_new@", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares an EXPLICIT constructor whose body reads the field in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      EXPLICIT_ORDER,
      `field-call-explicit-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["seed", "run", "Box_new@", "Box_get@"]);
    // Field initialization must precede the constructor body: `q` reads `p`.
    expect((await instantiate(prepared)).run!(400)).toBe(40100);
  });

  it.each(TARGETS)("prepares an IMMUTABLE class EXPRESSION binding in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      EXPRESSION,
      `field-call-expression-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["seed", "run", "<anonymous-class>_new@", "<anonymous-class>_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("prepares TWO source-ordered call-bearing fields in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      TWO_FIELDS,
      `field-call-two-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "first", "second"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["first", "second", "run", "Box_new@", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(12);
  });

  it.each(TARGETS)("keeps the already-admitted nested METHOD call prepared in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      METHOD_CALL,
      `field-call-method-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    // A field-less nested class has no promoted implicit-constructor terminal,
    // so it publishes no `Box_new@` outcome — measured identical before F4.
    expectCompiledOnce(prepared, ["seed", "run", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("leaves the TOP-LEVEL initialized-field call unchanged in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      TOP_LEVEL_FIELD,
      `field-call-toplevel-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expectCompiledOnce(prepared, ["seed", "run", "Box_new", "Box_get"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("emits ONE exact constructor call target with inlining OFF in the %s lane", async (target) => {
    const prepared = await compilePoisoned(
      IMPLICIT_UNFOLDABLE,
      `field-call-noinline-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
      "off",
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expectCompiledOnce(prepared, ["seed", "run", "Box_new@", "Box_get@"]);
    const seedIndex = watFunctionIndex(prepared.wat, "seed");
    const init = watFunctionBody(prepared.wat, "Box_init");
    // The field initializer lowers through the retained IrFuncRef into ONE
    // exact Program ABI unit call, inside the constructor `_init`.
    expect([...init.matchAll(new RegExp(`call ${seedIndex}\\b`, "g"))]).toHaveLength(1);
    expect(init).not.toMatch(/call_ref|call_indirect|__call_m_/);
    // ...and nowhere else: the owner never re-runs the initializer.
    expect(watFunctionBody(prepared.wat, "run")).not.toMatch(new RegExp(`call ${seedIndex}\\b`));
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("stays semantically valid with inlining ON in the %s lane", async (target) => {
    // The optimizer may legitimately remove the call edge entirely. Semantics
    // and the final prepared component evidence must survive either way.
    const prepared = await compilePoisoned(
      IMPLICIT_UNFOLDABLE,
      `field-call-inline-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );

    expect(prepared.success, prepared.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(prepared.binary)).toBe(true);
    expectCompiledOnce(prepared, ["seed", "run", "Box_new@", "Box_get@"]);
    expect((await instantiate(prepared)).run!()).toBe(42);
  });

  it.each(TARGETS)("shares ONE prepared component across owner, callee, ctor and members (%s)", async (target) => {
    const prepared = await compilePoisoned(
      IMPLICIT,
      `field-call-component-${target}.ts`,
      target,
      ["Box_new", "Box_get"],
      ["run", "seed"],
    );
    const observed = [outcome(prepared, "run"), outcome(prepared, "Box_new@"), outcome(prepared, "Box_get@")];
    const componentIds = new Set(observed.map((candidate) => candidate.preparedComponentId));
    expect(componentIds.size).toBe(1);
    const [componentId] = [...componentIds];
    expect(componentId).toMatch(/^prepared-component:/);
    // The component evidence names the CONSTRUCTOR terminal, not just the outer
    // function — the call is attributed to the class, which is the whole point.
    expect(componentId).toContain("class-implicit-constructor");
    expect(componentId).toContain("class-instance-method");
    // The callee keeps its own single-unit component and stays prepared.
    expect(outcome(prepared, "seed").preparedComponentId).toBeDefined();
    expect(outcome(prepared, "seed").preparedComponentId).not.toBe(componentId);
  });

  it("produces identical results on the direct, IR and node paths", async () => {
    const cases: readonly (readonly [string, number, number | undefined])[] = [
      [IMPLICIT, 42, undefined],
      [EXPLICIT_ORDER, 40100, 400],
      [EXPRESSION, 42, undefined],
      [TWO_FIELDS, 12, undefined],
      [METHOD_CALL, 42, undefined],
    ];
    for (const [source, expected, argument] of cases) {
      const direct = await compile(source, { fileName: "field-call-direct.ts", experimentalIR: false });
      const prepared = await compile(source, { fileName: "field-call-ir.ts", experimentalIR: true });
      expect(direct.success && prepared.success).toBe(true);
      const directRun = (await instantiate(direct)).run!(argument);
      const preparedRun = (await instantiate(prepared)).run!(argument);
      expect(directRun).toBe(expected);
      expect(preparedRun).toBe(directRun);
    }
  });

  it("preserves exact field EVALUATION ORDER against the direct path", async () => {
    // node: a = tag(1) -> log 1, b = tag(2) -> log 2, c = a * 100 + b * 10 + 3.
    // Any reordering, elision or hoist of the two call-bearing initializers
    // changes the answer, and the direct path is the oracle.
    const source = `
    function tag(v: number): number { return v; }
    export function run(): number {
      class Chain {
        a: number = tag(1);
        b: number = tag(2);
        c: number = 0;
        constructor() { this.c = this.a * 100 + this.b * 10 + 3; }
        get(): number { return this.c; }
      }
      return new Chain().get();
    }
    `;
    const direct = await compile(source, { fileName: "field-call-order-direct.ts", experimentalIR: false });
    const prepared = await compile(source, {
      fileName: "field-call-order-ir.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    expect(direct.success && prepared.success).toBe(true);
    expect((await instantiate(direct)).run!()).toBe(123);
    expect((await instantiate(prepared)).run!()).toBe(123);
    expectCompiledOnce(prepared, ["tag", "run", "Chain_new@", "Chain_get@"]);
  });
});

describe("#3522 F4 unpreparable-callee control", () => {
  // The callee is a real same-source top-level function, so F3 mints the
  // inventory candidate and the syntax gate passes — but its `number[]` return
  // has no stable prepared signature, so no proof is minted and the class is
  // never admitted. Successful execution alone is NOT acceptance evidence:
  // the class functions must be byte-identical to the direct build, the
  // outcomes typed Unsupported, and the direct constructor emitter provably
  // still live.
  const SOURCE = `
  function* pump(): Generator<number> { yield 40; }
  function seed(v: number): number[] { return [pump().next().value! + v]; }
  export function run(): number {
    class Box {
      p: number[] = seed(0);
      get(): number { return this.p[0]! + 2; }
    }
    return new Box().get();
  }
  `;

  it("executes directly and emits byte-identical class bodies", async () => {
    const direct = await compile(SOURCE, { fileName: "field-call-unprep.ts", experimentalIR: false, emitWat: true });
    const attempted = await compileDirectControl(SOURCE, "field-call-unprep.ts");
    expect(direct.success && attempted.success).toBe(true);
    expect((await instantiate(attempted)).run!()).toBe(42);
    expect((await instantiate(direct)).run!()).toBe(42);
    // Neither the class nor its callee can be prepared, so enabling the IR
    // must change nothing at all: exact WAT and exact binary parity.
    expect(attempted.wat).toBe(direct.wat);
    expect(Buffer.from(attempted.binary).equals(Buffer.from(direct.binary))).toBe(true);
  });

  it("records a typed Unsupported outcome for the owner and every class member", async () => {
    const attempted = await compileDirectControl(SOURCE, "field-call-unprep-outcome.ts");
    expect(attempted.success).toBe(true);
    expectDirect(attempted, ["run", "Box_new@", "Box_get@"]);
  });

  it("keeps the DIRECT constructor emitter live (poison must fire)", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = "Box_new";
      const result = await compile(SOURCE, {
        fileName: "field-call-unprep-poison.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n")).toContain("injected direct class-body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_CLASS_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY = previous;
    }
  });
});

describe("#3522 F4 negative source controls", () => {
  // Each control was measured identical on `origin/main` 81e54a98e and on this
  // branch: the whole enclosing owner stays direct. Where the value differs
  // from node it is a PRE-EXISTING divergence unrelated to F4 (noted inline),
  // so those rows are anchored to the direct compiler rather than to a node
  // constant.
  const controls: readonly (readonly [string, string, string, number | undefined])[] = [
    [
      "member call",
      "neg-member.ts",
      `export function run(): number {
         class Box { p: number = Math.floor(40.5); get(): number { return this.p + 2; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      "construction",
      "neg-new.ts",
      `class Other { v: number = 40; }
       export function run(): number {
         class Box { o: Other = new Other(); get(): number { return this.o.v + 2; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      "generic call",
      "neg-generic.ts",
      `function seed<T>(v: T): T { return v; }
       export function run(): number {
         class Box { p: number = seed<number>(42); get(): number { return this.p; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      // Pre-existing: the direct path evaluates the spread call to NaN (gc) /
      // 0 (standalone). Anchored to the direct compiler, not to node.
      "spread call",
      "neg-spread.ts",
      `function seed(v: number, w: number): number { return v + w; }
       export function run(): number {
         const args: [number, number] = [40, 2];
         class Box { p: number = seed(...args); get(): number { return this.p; } }
         return new Box().get();
       }`,
      undefined,
    ],
    [
      // Pre-existing: the direct path resolves the OUTER `seed`, so this
      // returns 42 rather than node's 140. Anchored to the direct compiler.
      "lexical shadowing",
      "neg-shadow.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         function inner(): number {
           function seed(v: number): number { return v + 100; }
           class Box { p: number = seed(40); get(): number { return this.p; } }
           return new Box().get();
         }
         return inner();
       }`,
      undefined,
    ],
    [
      // Pre-existing: the direct path yields 0 for the captured arrow.
      "enclosing-frame capture",
      "neg-capture.ts",
      `export function run(): number {
         const seed = (v: number): number => v + 2;
         class Box { p: number = seed(40); get(): number { return this.p; } }
         return new Box().get();
       }`,
      undefined,
    ],
    [
      "overloaded target",
      "neg-overloaded.ts",
      `function seed(v: number): number;
       function seed(v: string): string;
       function seed(v: number | string): number | string { return typeof v === "number" ? v + 2 : v; }
       export function run(): number {
         class Box { p: number = seed(40); get(): number { return this.p; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      "static field",
      "neg-static-field.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         class Box { static s: number = 1; p: number = seed(40); get(): number { return this.p; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      "heritage",
      "neg-heritage.ts",
      `function seed(v: number): number { return v + 2; }
       class Base { b: number = 0; constructor() { this.b = 1; } }
       export function run(): number {
         class Box extends Base { p: number = seed(40); get(): number { return this.p; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      "dynamic computed field name",
      "neg-computed.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         const key = "p";
         class Box { [key]: number = seed(40); get(): number { return (this as unknown as { p: number }).p; } }
         return new Box().get();
       }`,
      42,
    ],
    [
      "mutable class-expression binding",
      "neg-mutable-binding.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         let Box = class { p: number = seed(40); get(): number { return this.p; } };
         return new Box().get();
       }`,
      42,
    ],
    [
      // Accessors are EXCLUDED from the first admitted family. F3 mints their
      // terminals as inventory candidates and leaves them unclaimed, and the
      // accessor family's optimized lane is already broken on `origin/main`
      // independently of any field call: wasm-opt aborts on the accessor-only
      // fixture in `issue-3522-nested-class-accessor` and `optimize` silently
      // returns the UNoptimized module (1,007 bytes vs 588 direct, measured
      // byte-identical before and after F4). Admitting the field-call variant
      // would add instances of a known-broken shape.
      "instance accessor in the class",
      "neg-accessor.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         class Box { p: number = seed(40); get w(): number { return this.p; } }
         return new Box().w;
       }`,
      42,
    ],
    [
      "getter/setter pair in the class",
      "neg-accessor-pair.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         class Box {
           p: number = seed(40);
           get w(): number { return this.p; }
           set w(x: number) { this.p = x; }
         }
         return new Box().w;
       }`,
      42,
    ],
    [
      // A nested executable in a member body is EXCLUDED from the first
      // admitted family on purpose: measured on `origin/main`, the CALL-FREE
      // bounded variant of this exact shape is already a hard compile failure
      // (`'this' reference outside an instance method body`). Admitting the
      // field-call variant would add instances of a known-broken family.
      "nested executable in a member",
      "neg-nested-executable.ts",
      `function seed(v: number): number { return v + 2; }
       export function run(): number {
         class Box {
           p: number = seed(40);
           get(): number { const f = (): number => this.p; return f(); }
         }
         return new Box().get();
       }`,
      42,
    ],
    [
      // `seed` calls a generator, which the R2 signature proofs never admit, so
      // the callee leaves the prepared denominator. The admitted marker is
      // evidence, not a bypass: the whole class withdraws with it.
      "callee removed by the final prepared fixed point",
      "neg-withdrawn-callee.ts",
      `function* gen(): Generator<number> { yield 40; }
       function seed(v: number): number { return gen().next().value! + v; }
       export function run(): number {
         class Box { p: number = seed(2); get(): number { return this.p; } }
         return new Box().get();
       }`,
      42,
    ],
  ];

  it.each(controls)("keeps %s direct", async (_name, fileName, source, expected) => {
    const result = await compileDirectControl(source, fileName);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectDirect(result, ["run"]);
    const direct = await compile(source, { fileName: `direct-${fileName}`, experimentalIR: false });
    expect(direct.success).toBe(true);
    const irRun = (await instantiate(result)).run!();
    expect(irRun).toBe((await instantiate(direct)).run!());
    if (expected !== undefined) expect(irRun).toBe(expected);
  });

  it("keeps a tagged-template field call direct", async () => {
    // Split out because the tag callee itself carries a pre-existing
    // `TypeReference could not be lowered` post-claim resolve error, which the
    // shared `expectDirect` helper (rightly) refuses to tolerate.
    const result = await compileDirectControl(
      `function tag(parts: TemplateStringsArray): number { return parts.length + 41; }
       export function run(): number {
         class Box { p: number = tag\`x\`; get(): number { return this.p; } }
         return new Box().get();
       }`,
      "neg-tagged.ts",
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expect(outcome(result, "run")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("keeps a same-spelled CROSS-SOURCE target direct", async () => {
    // The importing module's `seed` resolves to another SOURCE. The proof
    // requires the declaration, its source file, and its source-qualified unit
    // to all belong to this exact source, so no marker is minted.
    const result = await compileMulti(
      {
        "/repo/entry.ts": `
        import { seed } from "./other.js";
        export function run(): number {
          class Box { p: number = seed(40); get(): number { return this.p; } }
          return new Box().get();
        }
        `,
        "/repo/other.ts": `export function seed(v: number): number { return v + 2; }`,
      },
      "/repo/entry.ts",
      { experimentalIR: true, trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect((await instantiate(result)).run!()).toBe(42);
    expect(outcome(result, "run")).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
  });
});
