// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1551 — SuperCall argument-list evaluation order + spread getter side-effects
 *
 * ECMA-262 §13.3.7.1 step 4: ArgumentListEvaluation must run left-to-right and
 * propagate abrupt completions before the parent constructor is invoked.
 *
 * Before this fix, `super(...)` argument expressions were only evaluated when a
 * parent field slot existed to receive them. For `class C extends Object` the
 * parent (Object) contributes zero recorded fields, so arg expressions were
 * dropped entirely — including any side effects or throws.
 *
 * The fix evaluates every argument expression unconditionally and drops the
 * resulting value when no parent field consumes it, preserving §13.3.7.1's
 * ordered-side-effect requirement.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runReturnNumber(src: string): Promise<number> {
  const r: any = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    const msg = r.errors.map((e: any) => e.message).join("\n");
    throw new Error(`compile failed:\n${msg}`);
  }
  const imports: any = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  return ((instance.exports as any).test as () => number)();
}

describe("#1551 SuperCall argument evaluation", () => {
  it("evaluates argument expressions at top-level of constructor (extends user class, no parent fields)", async () => {
    // Parent has no fields; the super argument expression must still be evaluated
    // for side effects per §13.3.7.1 step 4.
    const src = `
      let evaluated: boolean = false;
      function maker(): number { evaluated = true; return 0; }
      class P {}
      class C extends P {
        constructor() {
          super(maker());
        }
      }
      new C();
      export function test(): number { return evaluated ? 1 : 0; }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("evaluates trailing super(...) arguments even when parent has fewer fields", async () => {
    // P has 1 field; C passes 3 args. All three must be evaluated, only the
    // first stored into the parent slot.
    const src = `
      let count: number = 0;
      function bump(): number { count = count + 1; return count; }
      class P { x: number = 0; constructor(x: number) { this.x = x; } }
      class C extends P {
        constructor() { super(bump(), bump(), bump()); }
      }
      new C();
      export function test(): number { return count; }
    `;
    expect(await runReturnNumber(src)).toBe(3);
  });

  it("propagates abrupt completion (throw) from super arg eval at top-level of constructor", async () => {
    // thrower's exception must reach the user catch — no swallowing inside the
    // implicit super lowering wrapper.
    const src = `
      let evaluated: boolean = false;
      function thrower(): number { evaluated = true; throw {marker: 'thrown'}; }
      let caught: any = null;
      class P { x: number = 0; constructor(x: number) { this.x = x; } }
      class C extends P {
        constructor() {
          super(thrower());
        }
      }
      try { new C(); } catch (e) { caught = e; }
      export function test(): number {
        if (!evaluated) return 10;
        if (caught === null || caught === undefined) return 11;
        if ((caught as any).marker !== 'thrown') return 12;
        return 1;
      }
    `;
    expect(await runReturnNumber(src)).toBe(1);
  });

  it("evaluates super() args left-to-right (order preserved)", async () => {
    const src = `
      let seq: number = 0;
      function a(): number { seq = seq * 10 + 1; return 1; }
      function b(): number { seq = seq * 10 + 2; return 2; }
      function c(): number { seq = seq * 10 + 3; return 3; }
      class P {}
      class C extends P {
        constructor() { super(a(), b(), c()); }
      }
      new C();
      export function test(): number { return seq; }
    `;
    expect(await runReturnNumber(src)).toBe(123);
  });
});
