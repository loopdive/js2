// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6984 — the value of a `yield*` expression is the delegate's return value
 * (§15.5.5 step 9 / §27.5.3.7) in EVERY position, under the native semantic
 * regime (`semanticProviders: "native-first"` in a JS environment) and in
 * `target: "standalone"` alike. Both run the host-free native generator state
 * machine (#680); the host-assisted lane that used to answer these delegated to
 * the host generator protocol, which S7 deletes.
 *
 * Before this fix:
 *   - a `yield*` nested inside an expression (`yield (yield* g())`,
 *     `"o:" + (yield* g())`, `id(yield* g())`, a template substitution, a
 *     `return` operand) was a #680 refusal: the evaluation-order walk refused
 *     every `yield*`;
 *   - spreading a generator whose boxed-any carrier differed from the literal's
 *     element type (`[...o8()]` with `o8` delegating) silently produced `[]`;
 *   - a native-generator delegate never saw `.next(v)`'s argument.
 *
 * Every case is checked against the JS oracle (the same source run as JS).
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

const HEAD = `
function* inner() { yield 1; return "r"; }
function* innerN() { yield 1; return 7; }
function* undef() { yield 1; }
function id(x: any): any { return x; }
`;

function jsOracle(src: string): string {
  const js = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exp: Record<string, () => string> = {};
  new Function("exports", "module", js)(exp, { exports: exp });
  return exp.test!();
}

async function runNativeFirst(src: string): Promise<string> {
  const r = await compile(src, {
    fileName: "test.ts",
    semanticProviders: "native-first",
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const built = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setExports?: (exports: WebAssembly.Exports) => void;
  };
  const imports: WebAssembly.Imports = {
    env: built.env as WebAssembly.ModuleImports,
    string_constants: built.string_constants as WebAssembly.ModuleImports,
  };
  if (built["wasm:js-string"]) imports["wasm:js-string"] = built["wasm:js-string"] as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports);
  return String(wrapCompiledExports(r, instance).test());
}

// Standalone returns a native string ref; read it back char by char from a
// memoised copy so `test()` runs exactly once.
const READBACK = `
let __memo: string | undefined = undefined;
function __get(): string { if (__memo === undefined) __memo = test(); return __memo; }
export function __len(): number { return __get().length; }
export function __ch(i: number): number { return __get().charCodeAt(i); }
`;

async function runStandalone(src: string): Promise<string> {
  const r = await compile(src + READBACK, {
    fileName: "test.ts",
    target: "standalone",
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { __len(): number; __ch(i: number): number };
  let out = "";
  for (let i = 0, n = ex.__len(); i < n; i++) out += String.fromCharCode(ex.__ch(i));
  return out;
}

async function expectBothLanes(body: string, expected: string): Promise<void> {
  const src = `${HEAD}\n${body}`;
  expect(jsOracle(src)).toBe(expected);
  expect(await runNativeFirst(src)).toBe(expected);
  expect(await runStandalone(src)).toBe(expected);
}

describe("#6984 — the yield* expression's value is the delegate's return value", () => {
  it("the #6798 equivalence row: statement, assignment, argument, binary, return positions", async () => {
    await expectBothLanes(
      `
      function* o1() { yield (yield* inner()); }
      function* o2() { const rv = yield* inner(); yield "o:" + rv; }
      function* o3() { return yield* inner(); }
      function* o4() { yield "o:" + (yield* inner()); }
      function* o5() { yield id(yield* inner()); }
      function* o6() { const rv: string = yield* inner(); yield rv.length; }
      function* o7() { let rv = ""; rv = yield* inner(); yield rv.length; }
      function* o8() { const n = yield* innerN(); yield n * 2; }
      export function test(): string {
        const g = o3(); g.next(); const r3 = g.next();
        return [
          [...o1()].join(","), [...o2()].join(","), String(r3.value) + "/" + r3.done, [...o4()].join(","),
          [...o5()].join(","), [...o6()].join(","), [...o7()].join(","), [...o8()].join(","),
        ].join("|");
      }`,
      "1,r|1,o:r|r/true|1,o:r|1,r|1,1|1,1|1,14",
    );
  });

  it("template substitution, numeric operand, two delegations in one expression, return operand", async () => {
    await expectBothLanes(
      `
      function* tpl() { const s = \`<\${yield* inner()}>\`; yield s; }
      function* arith() { yield 10 + (yield* innerN()); }
      function* two() { yield (yield* inner()) + (yield* innerN()); }
      function* ret() { return "R" + (yield* inner()); }
      function* member() { const o = { x: "" }; o.x = yield* inner(); yield o.x; }
      export function test(): string {
        const r = ret(); r.next(); const r2 = r.next();
        return [[...tpl()].join(","), [...arith()].join(","), [...two()].join(","),
          String(r2.value) + "/" + r2.done, [...member()].join(",")].join("|");
      }`,
      "1,<r>|1,17|1,1,r7|Rr/true|1,r",
    );
  });

  it("a delegate that returns undefined, and non-generator iterables (completion value undefined)", async () => {
    await expectBothLanes(
      `
      function* und() { yield "u:" + String(yield* undef()); }
      function* arr() { yield "a:" + String(yield* [5, 6]); }
      function* str() { yield "s:" + String(yield* "ab"); }
      function* ident() { yield (yield* [5]) === undefined; yield typeof (yield* "ab"); yield (yield* undef()) === undefined; }
      export function test(): string {
        return [[...und()].join(","), [...arr()].join(","), [...str()].join(","), [...ident()].join(",")].join("|");
      }`,
      "1,u:undefined|5,6,a:undefined|a,b,s:undefined|5,true,a,b,undefined,1,true",
    );
  });

  it("a delegate that throws propagates out of the outer generator, which then completes", async () => {
    await expectBothLanes(
      `
      function* thrower(): Generator<number, string, unknown> { yield 1; throw new Error("boom"); }
      function* g() { yield id(yield* thrower()); }
      export function test(): string {
        const t = g(); const a = t.next(); let m = "none";
        try { t.next(); } catch (e) { m = (e as Error).message; }
        return String(a.value) + ";" + m + ";" + String(t.next().done);
      }`,
      "1;boom;true",
    );
  });

  it("next(v) is forwarded to the delegate; throw()/return() reach it mid-delegation", async () => {
    await expectBothLanes(
      `
      function* echoN() { const a = yield 1; return a * 2; }
      function* nested() { yield "got:" + (yield* echoN()); }
      function* direct() { const r = yield* echoN(); yield r; }
      function* thrIn() { yield "x" + (yield* innerN()); }
      function* early() { yield "got:" + (yield* inner()); }
      export function test(): string {
        const f = nested(); const f1 = f.next(); const f2 = f.next(5);
        const d = direct(); d.next(); const d2 = d.next(4);
        const t = thrIn(); t.next(); let m = "none";
        try { t.throw(new Error("in")); } catch (e) { m = (e as Error).message; }
        const c = early(); c.next(); const c2 = c.return("early" as any);
        return [String(f1.value) + ";" + String(f2.value) + ";" + String(f.next().done),
          String(d2.value), m + ";" + String(t.next().done),
          String(c2.value) + ";" + String(c2.done) + ";" + String(c.next().done)].join("|");
      }`,
      "1;got:10;true|8|in;true|early;true;true",
    );
  });

  it("a yield* argument of a plain call statement runs the call once, after the delegation", async () => {
    await expectBothLanes(
      `
      const logged: string[] = [];
      function log(x: any): void { logged.push(String(x)); }
      function* g() { log(yield* inner()); yield 0; }
      export function test(): string { return [...g()].join(",") + "/" + logged.join(","); }`,
      "1,0/r",
    );
  });

  it("spreading a boxed-carrier generator into a number[] keeps its elements", async () => {
    await expectBothLanes(
      `
      function* o9() { yield* innerN(); yield 5; }
      export function test(): string {
        const a = [...o9()].join(",");
        return a + "|" + [...o9()].length;
      }`,
      "1,5|2",
    );
  });

  it("a yield* inside an array-literal statement (formerly the #680 'yield-star operand' refusal) runs", async () => {
    await expectBothLanes(
      `
      function* g(): Generator<number, void, unknown> { [yield* [1]]; }
      export function test(): string {
        const it = g(); const a = it.next(); const b = it.next();
        return String(a.value) + ";" + String(a.done) + ";" + String(b.done);
      }`,
      "1;false;true",
    );
  });

  it("CONTROL: a nested yield* the planner cannot order (inside a loop body) refuses, never miscompiles", async () => {
    const src = `${HEAD}
      function* g() { let i = 0; while (i < 1) { yield "x" + (yield* inner()); i++; } }
      export function test(): number { return [...g()].length; }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /#680/.test(e.message))).toBe(true);
  });
});
