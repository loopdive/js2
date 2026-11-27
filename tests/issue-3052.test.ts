// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3052 — IR `class.call`: void instance method in STATEMENT position.
//
// BANKED in #3000-C's Implementation Notes: a class (ctor or plain method) body
// calling a VOID instance method as a STATEMENT (`this.add(x);` / `obj.tick();`)
// demoted the WHOLE caller post-claim with
//   `ir/from-ast: void method <Class>.<m> used in expression position`.
// The selector already CLAIMS this shape (a statement-expression whose
// expression is a method call), so it reaches `from-ast` — which then threw
// unconditionally in the class-method arm, ignoring statement position. The
// caller fell back to legacy (byte-inert, correct runtime, but no IR emission).
//
// This slice makes the void class-method call IR-emit in statement position by
// honouring `statementPosition` in the class-method arm of `lowerMethodCall`
// (mirroring the already-correct `super.method()` and extern-class arms). The
// `class.call` builder + lowering already carry a null result through — a void
// method's Wasm slot leaves nothing on the operand stack, and `emitBlockBody`'s
// `result === null` in-place path emits it balanced (no drop). A NON-void method
// call whose result is discarded in statement position was already handled by
// the `useCount === 0 && isSideEffecting` emit+drop path; only the void case
// was blocked at the from-ast gate.
//
// PROOF OF GENUINE EMISSION (non-vacuity): `CompileResult.irCompiledFuncs` lists
// the members whose slots were ACTUALLY patched with an IR body. Measure-first
// on `upstream/main` recorded `Counter_run` ABSENT from `irCompiledFuncs` and
// PRESENT in `irPostClaimErrors` with the exact "used in expression position"
// message. Post-fix it is PRESENT in `irCompiledFuncs` with zero demotions, in
// BOTH string lanes (host externref + native `$AnyString`), and the chained
// void-call runtime (`run()` → `tickTwice()` → `add()`) round-trips exactly.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// A flat class whose method calls a VOID instance method in statement position
// (`this.add(...)`), including a CHAIN (`run` → `tickTwice` → `add`).
const COUNTER = `
  class Counter {
    #n: number;
    constructor(start: number) { this.#n = start; }
    add(delta: number): void { this.#n = this.#n + delta; }
    tickTwice(): void { this.add(5); this.add(3); }
    run(): number {
      this.tickTwice();
      return this.#n;
    }
  }
  export function test(): number {
    const c = new Counter(10);
    return c.run();
  }
`;

// The host (externref) string lane was removed by #6979 (S7): `nativeStrings:
// false` is now a compile error, asserted below. The standalone lane is the
// other `$AnyString` environment the native lane's label already names.
const LANES = [
  { lane: "native/standalone ($AnyString)", options: { nativeStrings: true } },
  { lane: "standalone target ($AnyString)", options: { target: "standalone" } },
] as const;

describe("#3052 — IR class.call void method in statement position — genuine emission", () => {
  it("host (externref): nativeStrings: false is rejected since #6979 removed the host lane", async () => {
    await expect(compile(COUNTER, { fileName: "test.ts", experimentalIR: true, nativeStrings: false })).rejects.toThrow(
      "Compile option nativeStrings: false selected the host-assisted semantic profile, which #6979 removed",
    );
  });

  for (const { lane, options } of LANES) {
    it(`Counter_run (void this.method() statement) is IR-emitted, not demoted — ${lane}`, async () => {
      const r = await compile(COUNTER, { fileName: "test.ts", experimentalIR: true, ...options });
      expect(r.success).toBe(true);
      const compiled = new Set(r.irCompiledFuncs ?? []);
      // THE acceptance criterion: the caller with the void statement-position
      // method call is ACTUALLY patched with an IR body. Before this slice it
      // was ABSENT (demoted post-claim to legacy).
      expect(compiled.has("Counter_run"), `Counter_run should be IR-emitted in ${lane}`).toBe(true);
      // The chained intermediate is also emitted (it too calls a void method).
      expect(compiled.has("Counter_tickTwice"), `Counter_tickTwice should be IR-emitted in ${lane}`).toBe(true);
      // No post-claim demotion citing the void-in-expression-position error.
      const demoted = (r.irPostClaimErrors ?? []).filter(
        (e) => e.func === "Counter_run" || e.func === "Counter_tickTwice",
      );
      expect(demoted).toEqual([]);
    });
  }

  it("chained void statement-position calls round-trip correctly through the runtime", async () => {
    const exports = await compileAndInstantiate(COUNTER);
    // 10 + 5 + 3 = 18
    expect((exports.test as () => number)()).toBe(18);
  });

  it("a void method call on a non-`this` class receiver also IR-emits + runs", async () => {
    const src = `
      class Acc {
        #sum: number;
        constructor() { this.#sum = 0; }
        push(v: number): void { this.#sum = this.#sum + v; }
        total(): number { return this.#sum; }
      }
      export function test(): number {
        const a = new Acc();
        a.push(4);
        a.push(6);
        return a.total();
      }
    `;
    const r = await compile(src, { fileName: "acc.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    // The `main`-level `a.push(...)` statements live in the exported `test`
    // function — which IR-claims — and must not demote on the void call.
    const demoted = (r.irPostClaimErrors ?? []).filter((e) => e.message.includes("used in expression position"));
    expect(demoted).toEqual([]);
    const exports = await compileAndInstantiate(src);
    expect((exports.test as () => number)()).toBe(10);
  });

  it("a void method used in EXPRESSION position still cleanly demotes (guard unchanged)", async () => {
    // `const x = this.add(1)` — void in expression position — must still reject.
    // The caller falls back to legacy; runtime is unaffected (void → undefined).
    const src = `
      class C {
        #n: number;
        constructor() { this.#n = 0; }
        bump(): void { this.#n = this.#n + 1; }
        weird(): number {
          const y = this.bump();
          return this.#n;
        }
      }
      export function test(): number { const c = new C(); return c.weird(); }
    `;
    const r = await compile(src, { fileName: "expr.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    // `C_weird` uses the void result in expression position → still demotes.
    const demoted = (r.irPostClaimErrors ?? []).filter(
      (e) => e.func === "C_weird" && e.message.includes("used in expression position"),
    );
    expect(demoted.length).toBe(1);
    // Legacy fallback still produces the correct value.
    const exports = await compileAndInstantiate(src);
    expect((exports.test as () => number)()).toBe(1);
  });
});
