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
    // The observable proof that the rule DECLINED is that the shape keeps the
    // documented-not-covered host predicate (a runtime `.prototype` read off an
    // arbitrary callable is not modelled yet), rather than becoming a throw.
    const compiled = await compile(
      `var f: Function = function(){};\nvar obj = {};\nexport function test(): number { return (obj instanceof (f as any)) ? 1 : 0; }\n`,
      { allowJs: true, fileName: "fn-typed-rhs.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(compiled.success).toBe(true);
    const imports = (compiled.imports ?? []).map((i) => `${i.module}::${i.name}`);
    expect(imports, "a Function-typed RHS must not be treated as non-callable").toContain("env::__instanceof_check");
  });

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
