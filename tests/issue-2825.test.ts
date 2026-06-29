// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2825 — Bug C (class-method half): a class nested in a BLOCK inside a function
// captured an outer block-`let` as `0`/`null` instead of the live value.
//
// Root cause was a class-body-compile ORDERING defect. Class methods capture an
// enclosing local by promotion to a `__captured_<name>` global
// (`promoteAccessorCapturesToGlobals`). That promotion runs at the textual,
// in-scope position only when the class body is DEFERRED
// (`ctx.deferredClassBodies`) — which `compileClassesFromStatements`
// (`src/codegen/declarations.ts`) does for a class that is `insideFunction`. The
// function-body recursion set `insideFunction = true`, but the block / `if` /
// loop / `switch` / `try` / labeled recursions DROPPED it, so a class nested in a
// block-inside-a-function was compiled EAGERLY in the pre-pass — before the
// enclosing function ran and before the block-`let` was a promotable local. The
// method then resolved the captured name to the `ref.null` graceful default and
// `compileNestedClassDeclaration` early-returned (struct already collected AND
// eagerly compiled, never deferred), skipping the in-scope promotion + body
// compile. Net: the method read `0`/`null`.
//
// Fix: forward the current `insideFunction` flag through every control-flow
// recursion in `compileClassesFromStatements` so a block-nested-in-function class
// is DEFERRED, reusing the proven path that already makes direct-function-body
// nested classes work. A top-level (module) control-flow scope stays
// `insideFunction = false` → still eager (no enclosing fctx to defer into).

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function runNum(src: string, exp = "test", ...args: number[]): Promise<number> {
  const exports = (await compileAndInstantiate(src)) as Record<string, (...a: number[]) => number>;
  return exports[exp]!(...args);
}

async function runStr(src: string, exp = "test"): Promise<string> {
  const exports = (await compileAndInstantiate(src)) as Record<string, () => string>;
  return exports[exp]!();
}

describe("#2825 block-nested class method captures an outer block-let", () => {
  it("method reads the captured numeric block-let (was 0)", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 42; class C { m(): number { return s; } } return new C().m(); }
      }`),
    ).toBe(42);
  });

  it("arrow inside the method also resolves the captured local (was 0)", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 42; class C { m(): number { const g = () => s; return g(); } } return new C().m(); }
      }`),
    ).toBe(42);
  });

  it("method reads a captured string block-let (was null)", async () => {
    expect(
      await runStr(`export function test(): string {
        { let s = "hi"; class C { m(): string { return s; } } return new C().m(); }
      }`),
    ).toBe("hi");
  });

  it("static method captures the block-let", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 7; class C { static sm(): number { return s; } } return C.sm(); }
      }`),
    ).toBe(7);
  });

  it("generator method captures the block-let", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 9; class C { *g(): Generator<number> { yield s; } } return new C().g().next().value; }
      }`),
    ).toBe(9);
  });

  it("private method captures the block-let", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 5; class C { #p(): number { return s; } call(): number { return this.#p(); } } return new C().call(); }
      }`),
    ).toBe(5);
  });

  it("param-default initializer captures the block-let (-dflt cluster)", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 42; class C { m(x: number = s): number { return x; } } return new C().m(); }
      }`),
    ).toBe(42);
  });

  it("constructor captures the block-let", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 13; class C { v: number; constructor() { this.v = s; } } return new C().v; }
      }`),
    ).toBe(13);
  });

  it("get accessor captures the block-let", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 21; class C { get x(): number { return s; } } return new C().x; }
      }`),
    ).toBe(21);
  });
});

describe("#2825 block-nested class in every control-flow scope inside a function", () => {
  it("if-then block", async () => {
    expect(
      await runNum(
        `export function test(b: boolean): number {
          if (b) { let s = 11; class C { m(): number { return s; } } return new C().m(); }
          return -1;
        }`,
        "test",
        1,
      ),
    ).toBe(11);
  });

  it("else block", async () => {
    expect(
      await runNum(
        `export function test(b: boolean): number {
          if (b) { return -1; } else { let s = 17; class C { m(): number { return s; } } return new C().m(); }
        }`,
        "test",
        0,
      ),
    ).toBe(17);
  });

  it("for-loop body block", async () => {
    expect(
      await runNum(`export function test(): number {
        for (let i = 0; i < 1; i++) { let s = 23; class C { m(): number { return s; } } return new C().m(); }
        return -1;
      }`),
    ).toBe(23);
  });

  it("while-loop body block", async () => {
    expect(
      await runNum(`export function test(): number {
        let i = 0;
        while (i < 1) { let s = 29; class C { m(): number { return s; } } return new C().m(); }
        return -1;
      }`),
    ).toBe(29);
  });

  it("try block", async () => {
    expect(
      await runNum(`export function test(): number {
        try { let s = 31; class C { m(): number { return s; } } return new C().m(); } catch (e) { return -1; }
      }`),
    ).toBe(31);
  });

  it("switch clause block", async () => {
    expect(
      await runNum(
        `export function test(n: number): number {
          switch (n) {
            case 0: { let s = 37; class C { m(): number { return s; } } return new C().m(); }
            default: return -1;
          }
        }`,
        "test",
        0,
      ),
    ).toBe(37);
  });

  it("doubly-nested block", async () => {
    expect(
      await runNum(`export function test(): number {
        { { let s = 41; class C { m(): number { return s; } } return new C().m(); } }
      }`),
    ).toBe(41);
  });
});

describe("#2825 mutation after the class declaration re-syncs the captured global (#1672)", () => {
  it("a write to the captured local after the class decl is observed by the method", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 1; class C { m(): number { return s; } } s = 50; return new C().m(); }
      }`),
    ).toBe(50);
  });
});

describe("#2825 reachability: deferral does not strand the deferred body", () => {
  it("an uncalled NESTED function containing a block-nested class still compiles (no missing body)", async () => {
    // `inner` is never called; before the fix its block-nested class compiled
    // eagerly, after the fix it is deferred. `inner`'s body is still compiled
    // (function declarations are compiled regardless of being called), so the
    // deferred class body is reached and the module instantiates + runs.
    expect(
      await runNum(`export function test(): number {
        function inner(): number { { let s = 77; class C { m(): number { return s; } } return new C().m(); } }
        return 100;
      }`),
    ).toBe(100);
  });

  it("a CALLED nested function's block-nested class captures correctly", async () => {
    expect(
      await runNum(`export function test(): number {
        function inner(): number { { let s = 88; class C { m(): number { return s; } } return new C().m(); } }
        return inner();
      }`),
    ).toBe(88);
  });

  it("an uncalled CAPTURING nested function (lifted-capture path) with a block-nested class compiles", async () => {
    expect(
      await runNum(`export function test(): number {
        let outer = 5;
        function inner(): number { { let s = 70; class C { m(): number { return s + outer; } } return new C().m(); } }
        return 200;
      }`),
    ).toBe(200);
  });

  it("a called capturing nested function's block-nested class sees both captures", async () => {
    expect(
      await runNum(`export function test(): number {
        let outer = 5;
        function inner(): number { { let s = 70; class C { m(): number { return s + outer; } } return new C().m(); } }
        return inner();
      }`),
    ).toBe(75);
  });

  it("block-nested class inside an arrow-function body", async () => {
    expect(
      await runNum(`export function test(): number {
        const f = (): number => { let s = 12; class C { m(): number { return s; } } return new C().m(); };
        return f();
      }`),
    ).toBe(12);
  });

  it("block-nested class inside a function-expression body", async () => {
    expect(
      await runNum(`export function test(): number {
        const f = function (): number { { let s = 16; class C { m(): number { return s; } } return new C().m(); } };
        return f();
      }`),
    ).toBe(16);
  });

  it("a loop that re-instantiates the same block-nested class on each iteration", async () => {
    expect(
      await runNum(`export function test(): number {
        let acc = 0;
        for (let i = 1; i <= 2; i++) { let s = i * 10; class C { m(): number { return s; } } acc += new C().m(); }
        return acc;
      }`),
    ).toBe(30);
  });
});

describe("#2825 controls — pre-existing behavior must be unchanged", () => {
  it("fn-scope class-method capture still works (#1672 path — direct function-body class)", async () => {
    expect(
      await runNum(`export function test(): number {
        let s = 42; class C { m(): number { return s; } } return new C().m();
      }`),
    ).toBe(42);
  });

  it("top-level class capturing a module global still works", async () => {
    expect(
      await runNum(
        `let g = 3; class T { m(): number { return g; } } export function test(): number { return new T().m(); }`,
      ),
    ).toBe(3);
  });

  it("a module-top-level block class stays eager (unchanged) and does not break the module", async () => {
    expect(
      await runNum(
        `{ let s = 8; class C { m(): number { return s; } } } export function test(): number { return 99; }`,
      ),
    ).toBe(99);
  });

  it("a simple non-capturing class is unaffected", async () => {
    expect(
      await runNum(`class P { v: number; constructor(x: number) { this.v = x; } m(): number { return this.v * 2; } }
        export function test(): number { return new P(5).m(); }`),
    ).toBe(10);
  });

  it("a block-nested class that captures nothing still works", async () => {
    expect(
      await runNum(`export function test(): number { { class C { m(): number { return 64; } } return new C().m(); } }`),
    ).toBe(64);
  });
});

describe("#2825 captured-global must NOT leak past the block scope (merge_group regression guard)", () => {
  // A block-nested class's capture-promotion registers a name-keyed
  // `__captured_<name>` module global. Without block-scoping that registration,
  // it LEAKED past the block: a later same-named (outer / sibling-block) binding's
  // class capture hit the `capturedGlobals.has(name)` short-circuit and reused the
  // inner block's global. These are clean pass->fail regressions on the merged
  // baseline (they were correct before the deferral change). The block-scope
  // reconciliation in `restoreBlockScopedShadows` (#2825) fixes them.

  it("a block-let capture does not leak to a LATER fn-scope class of the same name", async () => {
    // C captures inner block s=2; D (fn-scope) must capture the OUTER s=1.
    expect(
      await runNum(`export function test(): number {
        let s = 1;
        { let s = 2; class C { m(): number { return s; } } }
        class D { m(): number { return s; } }
        return new D().m();
      }`),
    ).toBe(1);
  });

  it("sibling-block captures of the same name resolve to their own block's binding", async () => {
    expect(
      await runNum(`export function test(): number {
        let a = 0;
        { let s = 2; class C { m(): number { return s; } } a = new C().m(); }
        { let s = 3; class D { m(): number { return s; } } return a * 10 + new D().m(); }
      }`),
    ).toBe(23);
  });

  it("inner shadow capture is correct AND the post-block fn-scope capture sees the outer", async () => {
    // C captures inner s=2 (→ r=2); D captures outer s=1.  r*10 + D.m() = 21.
    expect(
      await runNum(`export function test(): number {
        let s = 1;
        let r = 0;
        { let s = 2; class C { m(): number { return s; } } r = new C().m(); }
        class D { m(): number { return s; } }
        return r * 10 + new D().m();
      }`),
    ).toBe(21);
  });

  it("captured-global does not leak across sibling functions in the same module", async () => {
    expect(
      await runNum(`function a(): number { let s = 5; { let s = 9; class C { m(): number { return s; } } return new C().m(); } }
        export function test(): number { let s = 1; class D { m(): number { return s; } } return a() * 100 + new D().m(); }`),
    ).toBe(901);
  });

  it("a fn-scope class capture before a shadowing block stays correct", async () => {
    expect(
      await runNum(`export function test(): number {
        let s = 1;
        class C { m(): number { return s; } }
        { let s = 2; let inner = new C().m(); s + inner; }
        return new C().m();
      }`),
    ).toBe(1);
  });
});

describe("#2825 known pre-existing limitation (out of scope — documented, not fixed here)", () => {
  // `structMap` / `deferredClassBodies` are name-keyed, so two same-named classes
  // in sibling blocks collide: the second `C`'s deferral is consumed by the
  // first's `delete`. This is a PRE-EXISTING name-collision limitation (the value
  // was already wrong before #2825), not introduced by the deferral change. See
  // the #2825 spec "Same-named classes in sibling blocks".
  it.skip("same-named classes in sibling blocks (name-collision — pre-existing)", async () => {
    expect(
      await runNum(`export function test(): number {
        { let s = 1; class C { m(): number { return s; } } }
        { let s = 2; class C { m(): number { return s; } } return new C().m(); }
      }`),
    ).toBe(2);
  });
});
