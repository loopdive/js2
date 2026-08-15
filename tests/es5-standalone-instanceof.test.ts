// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2916) `instanceof` / `Object.prototype.isPrototypeOf` must not leak a host
 * import under `--target standalone`.
 *
 * Two `env::` imports gated 19 ≤ES5 files on the 2026-08-07 standalone baseline,
 * each as the file's SOLE host import:
 *   - `env::__instanceof_check` (10 files, all `language/expressions/instanceof/`)
 *   - `env::Object_isPrototypeOf` (9 files)
 * A host-free binary cannot satisfy either, so the module does not instantiate
 * and the #2961 leak guard refuses the test.
 *
 * Every case below asserts BOTH halves of the contract:
 *   1. the ANSWER is right (or throws the right error), and
 *   2. the binary carries NO imports — a right answer that still leaks is still
 *      refused, so the import count is part of the contract.
 *
 * The gc / JS-host lane is untouched by all of this (every branch is gated on
 * `noJsHost`), so a JS-host counterpart is asserted where the answer differs in
 * kind (a thrown TypeError).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Outcome {
  result: number;
  imports: string[];
}

/** Compile a standalone SCRIPT, run `__module_init`, read `result`. */
async function run(body: string): Promise<Outcome> {
  const source = `var result = -1;\n${body}\nexport function test(): number { return result as number; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "es5-standalone-instanceof.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((i: unknown) =>
    typeof i === "string" ? i : `${(i as { module: string }).module}::${(i as { name: string }).name}`,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  const result = (instance.exports as Record<string, () => number>).test();
  return { result, imports };
}

describe("#2916 — host-free instanceof in standalone", () => {
  it("throws a catchable TypeError when the RHS is a non-callable object (§7.3.20 step 1)", async () => {
    // `S11.8.6_A6_T4` CHECK#4. `new MyFunct` is an ordinary object, so
    // `__my__funct instanceof __my__funct` must throw — and the `catch` must see
    // a real TypeError, which requires the throw to originate IN wasm.
    const o = await run(
      `var MyFunct = function(){};\nvar __my__funct = new MyFunct;\n` +
        `try { __my__funct instanceof __my__funct; result = 0; }\n` +
        `catch (e) { result = (e instanceof TypeError) ? 1 : 0; }`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("throws for an object-literal RHS", async () => {
    const o = await run(
      `try { ({}) instanceof ({}); result = 0; } catch (e) { result = (e instanceof TypeError) ? 1 : 0; }`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("does NOT throw for a callable RHS reached through a `Function`-typed binding", async () => {
    // Guard against the §7.3.20-step-1 rule over-firing: lib.d.ts models
    // `interface Function` with NO call signature, so a naive
    // "no signatures ⇒ not callable" test would emit an unconditional TypeError
    // for a real function value — a WRONG answer, not a missed conversion.
    //
    // The observable used to be the PRESENCE of `env::__instanceof_check`,
    // i.e. exactly the leak #2916 Slice B retires. Same property, stated by the
    // ANSWER instead: the operator evaluates to `false` (the documented residual
    // for a closure RHS whose prototype object has no runtime edge) rather than
    // throwing, and the binary is host-free.
    const o = await run(
      `var f: Function = function(){};\nvar obj = {};\n` +
        `try { result = (obj instanceof (f as any)) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result, "a Function-typed RHS must not be treated as non-callable").toBe(0);
    expect(o.imports).toEqual([]);
  });

  // The `S15.3.5.3_A1_T1…T8` RHS shape — a binding holding a `Function(…)`
  // value. Those tests run their RHS through the runtime-eval interpreter, so
  // they cannot be executed here (a bare `WebAssembly.instantiate` has no
  // `js2wasm:runtime-eval` module to link); the COMPILE-LEVEL property that
  // keeps them correct is checkable instead. The §7.3.20-step-1 rule must
  // DECLINE — a `new Function(…)` initializer must never be mistaken for the
  // "fresh ordinary object" it syntactically resembles. If the rule ever fired
  // here it would emit an unconditional TypeError where the spec requires a
  // plain `false`, and the failure would surface ONLY in a lane with the
  // interpreter tier linked (`TEST262_FULL_RUNTIME_EVAL=1`).
  //
  // The evidence is that the operator still routes to the §13.10.2 evaluator —
  // `__instanceof_dynamic`, whose name survives into the WAT whether or not the
  // inliner folds it into the caller. A fired rule emits an unconditional throw
  // and never reaches that helper at all. (The pre-Slice-B spelling of this same
  // evidence was "the host import is still there", which the substrate removed.)
  //
  // The LHS is an OBJECT on purpose: the upstream files spell it `1 instanceof
  // FACTORY`, which the #2998 statically-primitive-LHS fold answers `false`
  // before this rule is consulted, so a primitive LHS cannot observe it.
  const declinedRhsShapes: Array<[string, string]> = [
    ["assigned from `Function(…)` after a bare `var`", `var FACTORY;\nFACTORY = Function("name", "this.name=name;");`],
    ["initialized with `new Function(…)`", `var FACTORY = new Function("name", "this.name=name;");`],
    ["initialized with `Function(…)`", `var FACTORY = Function("name", "this.name=name;");`],
  ];
  for (const [name, decl] of declinedRhsShapes) {
    it(`declines the non-callable rule for an RHS ${name}`, async () => {
      const compiled = await compile(
        `${decl}\nvar obj = {};\nexport function test(): number { return (obj instanceof (FACTORY as any)) ? 1 : 0; }\n`,
        {
          allowJs: true,
          fileName: "fnctor-rhs.ts",
          skipSemanticDiagnostics: true,
          target: "standalone",
          emitWat: true,
        },
      );
      expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
      const imports = (compiled.imports ?? []).map((i) => `${i.module}::${i.name}`);
      expect(imports, "the dynamic-RHS operator must stay host-free").toEqual([]);
      expect(
        (compiled as { wat?: string }).wat ?? "",
        "a Function(…)-valued RHS must not be treated as non-callable",
      ).toContain("instanceof_dynamic");
    });
  }

  it("answers `x instanceof <alias of Object>` without the host predicate", async () => {
    // `S11.8.6_A2.1_T1` CHECK#3/#4 — the RHS identifier does not carry the
    // builtin's name, so the builtin dispatch used to be skipped entirely.
    const o = await run(`var OBJECT = Object;\nvar obj = {};\nresult = (obj instanceof OBJECT) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("keeps a user function constructor answering true through the alias rule", async () => {
    // The alias rewrite must never capture a USER constructor (its `typeof F`
    // type is not an `XConstructor` interface) — #3962's native answer stands.
    const o = await run(`function F(){ this.x = 1; }\nvar f = new F();\nresult = (f instanceof F) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });
});

/**
 * (#2916 Slice B) The fully-dynamic RHS substrate — `native-dynamic-instanceof.ts`.
 *
 * Every case here reaches `emitDynamicInstanceOf` (no static rule can resolve
 * the RHS), which used to be the sole remaining `env::__instanceof_check` site.
 * Each asserts BOTH halves: the answer AND a zero-import binary.
 *
 * The `as any` on the RHS is load-bearing — it is what defeats every
 * compile-time classification (the primitive-RHS throw, the builtin-alias
 * rewrite, #3962's user-fnctor arm) and forces the dynamic path.
 */
describe("#2916 Slice B — fully-dynamic instanceof RHS, host-free", () => {
  it("answers a runtime-null RHS `false` rather than throwing", async () => {
    // Host dynamic-path parity (`runtime.ts:2353`). This backend still lowers
    // some `Function(params, body)` forms to null, and `S15.3.5.3_A1_T1…T8`
    // require `primitive instanceof FACTORY === false`, not a TypeError.
    const o = await run(
      `var C: any = null;\nvar obj: any = {};\n` +
        `try { result = (obj instanceof C) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("does NOT throw for a RUNTIME-primitive RHS, even though §13.10.2 step 1 says TypeError", async () => {
    // Pinned as a deliberate divergence, not an oversight. There is no sound
    // runtime primitive test in this backend: an unmodelled builtin constructor
    // is lowered to a boxed-primitive carrier, so the shared classifiers answer
    // `typeof Int8Array === "boolean"` — see the sibling assertion below. A
    // throw arm built on them mistakes real constructors for primitives, which
    // is a WRONG answer observable in a `catch`; a conservative `false` is only
    // a missed conversion.
    //
    // The provable cases are unaffected: a statically-primitive RHS still throws
    // at codegen (asserted by the `S11.8.6_A6_*` family and #2702's tests).
    const o = await run(
      `var C: any = 42;\nvar obj: any = {};\n` +
        `try { result = (obj instanceof C) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("does NOT throw for a builtin constructor reached dynamically", async () => {
    // The measured wrong-throw that removed the arm above:
    // `built-ins/TypedArrayConstructors/ctors/object-arg/iterator-is-null-as-array-like.js`
    // answered "Right-hand side of 'instanceof' is not callable" where the host
    // predicate answers `false`. `Int8Array`'s bare value classifies as
    // `typeof "boolean"` standalone (a separate representation gap), so this
    // shape is the direct regression pin for it.
    const o = await run(
      `var C: any = Int8Array;\nvar a: any = new Int8Array(2);\n` +
        `try { result = (a instanceof C) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result, "a dynamically-reached builtin constructor must not throw").not.toBe(9);
    expect(o.imports).toEqual([]);
  });

  it("answers a primitive LHS `false` before reading the RHS prototype (§7.3.20 step 3)", async () => {
    // Step 3 precedes step 4, so a primitive V short-circuits WITHOUT the
    // `prototype` read — the ordering #2702 documents. Both operands are `any`
    // so neither static fold applies.
    const o = await run(
      `var C: any = function(){};\nvar v: any = 7;\n` +
        `try { result = (v instanceof C) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("answers a callable RHS with an unmodelled prototype `false`, never a throw", async () => {
    // THE DOCUMENTED RESIDUAL. A standalone closure has no runtime edge to its
    // per-fnctor prototype global, so §7.3.20 step 4 is unanswerable. Both
    // alternatives are worse than `false`: `1` asserts membership and `2`
    // asserts "F.prototype really is a non-object" — neither is known.
    const o = await run(
      `function F(){ this.x = 1; }\nvar C: any = F;\nvar f: any = new F();\n` +
        `try { result = (f instanceof C) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("does NOT throw for a non-callable GC struct of unknown callability", async () => {
    // Class VALUES are `typeof "object"` in this backend, so a blanket
    // "not callable ⇒ TypeError" would turn `x instanceof C` — a legitimate
    // true/false — into a spurious catchable TypeError. Host parity
    // (`runtime.ts:2400`). The provably-non-callable cases still throw, one
    // dispatch step earlier, via `tryEmitNonCallableRhsThrow` (asserted above).
    const o = await run(
      `class K { m(): number { return 1; } }\nvar C: any = K;\nvar obj: any = new K();\n` +
        `try { result = (obj instanceof C) ? 1 : 0; } catch (e) { result = 9; }`,
    );
    expect(o.result).not.toBe(9);
    expect(o.imports).toEqual([]);
  });

  it("evaluates BOTH operands, in source order, before answering (§13.10.1)", async () => {
    // The tri-state replaced a two-argument host call, so operand order is a
    // property of the emitter, not of the helper. A RHS-first evaluation would
    // read `order` as "RL".
    //
    // The result is BOUND on purpose. A bare `lhs() instanceof rhs();`
    // expression statement AT TOP LEVEL is dropped whole — including both
    // calls' side effects — by a statement-level elimination that predates this
    // substrate (reproduced on a builtin RHS, which never reaches this code)
    // and is fixed separately by #4433. Binding it isolates the property under
    // test from that defect.
    //
    // Scope note, because the top-level result does NOT generalise: the same
    // statement inside a `try`, or inside a function, evaluates both operands
    // on this branch (measured 0 / 2 / 2 respectively). A top-level
    // `TryStatement` is kept wholesale by `collectDeclarations`, so its body
    // lowers through the ordinary in-function path.
    const o = await run(
      `var order = "";\nfunction lhs(): any { order = order + "L"; return {}; }\n` +
        `function rhs(): any { order = order + "R"; return null; }\n` +
        `var q: any = lhs() instanceof rhs();\nresult = order === "LR" ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });
});

describe("#2916 — host-free Object.prototype.isPrototypeOf in standalone", () => {
  it("answers Object.prototype.isPrototypeOf(objectLiteral) without a host import", async () => {
    // `S8.6.2_A1` CHECK#1. The receiver types as the `Object` INTERFACE, which
    // routed to `compileExternMethodCall` → `env::Object_isPrototypeOf`.
    const o = await run(`var __obj = {};\nresult = Object.prototype.isPrototypeOf(__obj) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("answers Object.prototype.isPrototypeOf(<binding holding a `new`>) without a host import", async () => {
    // `S13.2.2_A3_T1` CHECK#2 — untyped JS infers `any` for `new __FACTORY()`,
    // so the #2994 flag test declines; the binding is provably an object.
    const o = await run(
      `function __FACTORY(){};\n__FACTORY.prototype = 1;\nvar __device = new __FACTORY();\n` +
        `result = Object.prototype.isPrototypeOf(__device) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("declines the object-binding fold when the binding is reassigned", async () => {
    // A reassigned binding could hold a primitive at the call site, so folding
    // to `true` would be a WRONG answer. The runtime walk answers instead.
    const o = await run(`var v: any = new Object();\nv = 5;\nresult = Object.prototype.isPrototypeOf(v) ? 1 : 0;`);
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("answers <Builtin>.prototype.isPrototypeOf(<builtin instance>) without a host import", async () => {
    // `S15.7.2.1_A2` / `S15.10.4.1_A7_T2` — the argument is a BINDING, not the
    // `new` expression itself, so the fold has to go through its static type.
    const o = await run(`var x2 = new Number(2);\nresult = Number.prototype.isPrototypeOf(x2) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("answers a non-descendant receiver as false, host-free", async () => {
    const o = await run(
      `function FooObj(){};\nvar protoObj = {};\nvar obj = new FooObj;\n` +
        `result = protoObj.isPrototypeOf(obj) ? 1 : 0;`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });
});
