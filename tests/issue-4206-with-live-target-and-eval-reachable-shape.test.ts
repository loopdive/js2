// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4206 — two `with`-lane defects measured RED on
// `claude/pull-from-upstream-zgdo0m` @ 88bd2ccf0e, `--target standalone`.
//
// 1. Tier-2 `with` bound a COPY of its target. Asking `compileExpression` for
//    `externref` routes a nominal struct through the #2358 ToPrimitive-boundary
//    arm, which field-copies a literal carrying `valueOf`/`toString` into a
//    fresh `$Object`. Every write made through the object environment record
//    then landed on the copy. It reads plausibly from inside the body — the
//    body's own read of the name answers the value it just wrote — so the loss
//    is silent. test262 `language/statements/with/S12.10_A3.5_T{1,2,4}` are the
//    corpus rows; they enter Tier-2 because the enclosing `for (p in o)` is
//    what makes the target dynamic.
//
// 2. An object literal a DIRECT `eval` can mutate kept its closed-struct
//    representation, so a write through the membrane whose value does not fit
//    the pinned field type was dropped and a `delete` returned `true` without
//    deleting. Corpus rows: `with/S12.10_A4_T{4,5,6}` and `A5_T{1,2,3,6}`.
//    Behavioural coverage for that half needs the QuickJS eval provider (built
//    only in CI / by `scripts/build-quickjs-eval-provider.mjs`), so this file
//    pins the ANALYSIS that selects the representation, plus a compile smoke
//    test, and leaves the end-to-end proof to the test262 lane.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { collectEvalMutableNames } from "../src/codegen/declarations/eval-reachable-object-shape.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  // The verdict crosses as a NUMBER: a native standalone string is a WasmGC
  // array with no host `toPrimitive`, so returning `o.p1` itself would throw
  // "Cannot convert object to primitive value" in the test, not in the module.
  return (instance.exports as { f: () => number }).f();
}

function namesIn(source: string): string[] {
  const file = ts.createSourceFile("t.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return [...collectEvalMutableNames(file as unknown as Parameters<typeof collectEvalMutableNames>[0])].sort();
}

describe("#4206 Tier-2 `with` binds the LIVE target, never a copy", () => {
  it("writes through a target carrying `valueOf` from inside a for-in body", async () => {
    // RED on base: `o.p1` stayed "a" — the write landed on the reified copy.
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 'a', valueOf: function () { return 'ov'; } };
          for (var k in o) { with (o) { p1 = 'x1'; } }
          return o.p1 === 'x1' ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // Control, GREEN on base: without the enclosing `for…in` this target still
  // proves Tier-1, so it never reached the reifying coercion. Measured in the
  // A/B (base with-scope.ts + this file): 1 failure, this case not among them.
  it("writes through a target carrying `toString` outside any loop", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 'a', toString: function () { return 'ts'; } };
          with (o) { p1 = 'x2'; }
          return o.p1 === 'x2' ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps a plain-data target working (control — never used the copy path)", async () => {
    expect(
      await runStandalone(`
        export function f(): number {
          var o = { p1: 'a', n: 5 };
          for (var k in o) { with (o) { p1 = 'x3'; } }
          return o.p1 === 'x3' ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

describe("#4206 direct-eval mutable-name analysis", () => {
  it("names a variable a literal-source eval can mutate", () => {
    expect(namesIn(`var myObj = { p1: 'a' }; eval("with(myObj){p1='b'}");`)).toContain("myObj");
  });

  it("names a variable a literal-source eval can `delete` from", () => {
    expect(namesIn(`var myObj = { p1: 'a' }; eval("with(myObj){del = delete p1}");`)).toContain("myObj");
  });

  it("does NOT name anything for a read-only eval source", () => {
    // Nothing in the source can mutate, so the closed-struct fast path stays.
    expect(namesIn(`var myObj = { p1: 'a' }; eval("myObj.p1 + 1");`)).toEqual([]);
  });

  it("does NOT name a variable that only appears inside a nested string", () => {
    // The scanner tokenizes, so `"myObj"` is a string literal, not an identifier.
    expect(namesIn(`var myObj = { p1: 'a' }; eval("var s = 'myObj'; s = 1;");`)).not.toContain("myObj");
  });

  it("declines a computed eval source rather than opening every literal", () => {
    // Documented residual: an unknown source says nothing about which names it
    // touches, so nothing is promoted.
    expect(namesIn(`var myObj = { p1: 'a' }; var src = "with(myObj){p1=1}"; eval(src);`)).toEqual([]);
  });

  it("ignores a call to something merely NAMED like eval", () => {
    expect(namesIn(`var myObj = {}; obj.eval("myObj = 1");`)).toEqual([]);
  });

  it("still compiles a module whose literal is opened by an eval source", async () => {
    const r = await compile(
      `export function f(): any {
         var myObj = { p1: 'a' };
         eval("with(myObj){p1='b'}");
         return myObj.p1;
       }`,
      { target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
