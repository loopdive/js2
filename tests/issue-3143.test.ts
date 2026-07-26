// #3143 — IR-first default flip: the ALLOWLIST skip predicate + end-to-end.
//
// The IR-first skip set is an ALLOWLIST (`irFirstBodyIsProvenLowerable`): a
// claimed function's legacy body is skipped ONLY when its body is the
// proven-lowerable numeric/boolean subset. This test locks:
//   1. The allowlist predicate accepts pure-numeric bodies and rejects anything
//      outside the subset (strings, method calls, param mutation, TypedArray
//      stores/construction, `??`, etc. — all stay COMPILE-TWICE, safe).
//   2. End-to-end: programs with out-of-subset shapes (TypedArray stores, Map +
//      boxing) compile with ZERO hard errors under the IR-first default and run
//      correctly (parity with the escape-hatch legacy order).
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { irFirstBodyIsProvenLowerable } from "../src/codegen/ir-first-gate.js";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function fnDecl(src: string): ts.FunctionDeclaration {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("no function declaration in source");
  return fn;
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return instance.exports as Record<string, Function>;
}

// Arity map covering common callee names used in the fixtures below, so the
// allowlist's exact-arity call check can accept them.
const ARITY = new Map<string, number>([
  ["f", 1],
  ["g", 1],
  ["add", 2],
  ["fib", 1],
  ["helper0", 0],
]);

describe("#3143 — irFirstBodyIsProvenLowerable (ALLOWLIST) predicate", () => {
  it.each([
    ["pure add", `function add(a: number, b: number): number { return a + b; }`],
    [
      "recursive fib (self-call, exact arity)",
      `function fib(n: number): number { if (n < 2) return n; return fib(n-1) + fib(n-2); }`,
    ],
    [
      "loop with local mutation",
      `function f(n: number): number { let t = 0; for (let i=1;i<=n;i++){ t += i; } return t; }`,
    ],
    [
      "compare in condition, logical &&",
      `function f(a: number, b: number): number { if (a > 0 && b > 0) return 1; return 0; }`,
    ],
    ["ternary with numeric branches", `function f(n: number): number { return n < 0 ? -n : n; }`],
    [
      "while + do-while, local decrement",
      `function f(n: number): number { let c=0; let m=n; while(m>0){ c++; m--; } return c; }`,
    ],
    ["bitwise + shift arithmetic", `function f(n: number): number { return (n & 0xff) ^ (n >> 2); }`],
    ["void body, no return value", `function f(n: number): void { let x = n + 1; }`],
  ])("accepts (skip-eligible): %s", (_label, src) => {
    expect(irFirstBodyIsProvenLowerable(fnDecl(src), ARITY)).toBe(true);
  });

  it.each([
    // out-of-subset value domains / ops — must stay compile-twice.
    ["param mutation", `function f(n: number): number { n--; return n; }`],
    ["string literal", `function f(): number { const s = "x"; return s.length; }`],
    ["method call on receiver", `function f(a: number[]): number { return a.indexOf(2); }`],
    ["element access", `function f(a: number[], i: number): number { return a[i]; }`],
    ["property access", `function f(o: { v: number }): number { return o.v; }`],
    ["new expression", `function f(): number { const b = new Uint8Array(4); b[0]=1; return b[0]; }`],
    ["boolean literal operand", `function f(): number { return 0 === (false as unknown as number) ? 1 : 0; }`],
    ["logical && of numbers (not bool operands)", `function f(a: number, b: number): number { return (a && b); }`],
    ["nullish coalescing", `function f(a: number): number { return a ?? 0; }`],
    ["call to non-claimed / unknown-arity callee", `function f(n: number): number { return unknownFn(n); }`],
    ["wrong-arity call", `function f(n: number): number { return add(n); }`],
    ["nested function declaration", `function f(n: number): number { function g(){ return 1; } return g(); }`],
    ["try/throw statement", `function f(n: number): number { try { return n; } catch { return 0; } }`],
  ])("rejects (compile-twice): %s", (_label, src) => {
    expect(irFirstBodyIsProvenLowerable(fnDecl(src), ARITY)).toBe(false);
  });
});

describe("#3143 — end-to-end IR-first default (no hard error, correct bytes)", () => {
  // The native-messaging class-4 shape, reduced: a typed-param writer whose
  // element store stays legacy (gate 8a) plus a caller that constructs a view
  // (gate 8b). Both must compile cleanly under the IR-first default.
  const SRC = `
    function fill(out: Uint8Array, base: number): void {
      for (let i = 0; i < 4; i++) { out[i] = base + i; }
    }
    export function run(): number {
      const buf = new Uint8Array(4);
      fill(buf, 10);
      return buf[0] + buf[1] + buf[2] + buf[3]; // 10+11+12+13 = 46
    }
  `;

  it("compiles with ZERO hard errors under IR-first default", async () => {
    const r = await compile(SRC, { fileName: "nm.ts", experimentalIR: true });
    const hard = (r.errors ?? []).filter((e) => e.severity === "error");
    expect(hard.map((e) => e.message)).toEqual([]);
    expect(r.binary.length).toBeGreaterThan(0);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("runs correctly under the IR-first default", async () => {
    const r = await compile(SRC, { fileName: "nm.ts", experimentalIR: true });
    const exports = await instantiate(r);
    expect((exports.run as () => number)()).toBe(46);
  });

  it("parity: escape-hatch legacy order (JS2WASM_IR_FIRST=0) gives the same result", async () => {
    const prev = process.env.JS2WASM_IR_FIRST;
    process.env.JS2WASM_IR_FIRST = "0";
    try {
      const r = await compile(SRC, { fileName: "nm.ts", experimentalIR: true });
      const hard = (r.errors ?? []).filter((e) => e.severity === "error");
      expect(hard.map((e) => e.message)).toEqual([]);
      const exports = await instantiate(r);
      expect((exports.run as () => number)()).toBe(46);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_FIRST");
      else process.env.JS2WASM_IR_FIRST = prev;
    }
  });
});

describe("#3143 — __box_number / __extern_is_undefined union-import pre-registration", () => {
  // fibMemo: a memoized recursion over a module-level Map. Its IR body emits a
  // __box_number funcref (boxing f64→externref for the Map) and __extern_is_undefined
  // (`hit !== undefined`), both of which legacy used to register as a side effect.
  // Under IR-first that side effect is gone; preregisterDynamicSupport must
  // register them. Regression guard for the funcIdx-shift fix (a stale shift
  // desynced a sibling IR function's funcIdx — "out of local range").
  const SRC = `
    const memo = new Map<number, number>();
    function fibMemo(n: number): number {
      if (n < 2) return n;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      const v = fibMemo(n - 1) + fibMemo(n - 2);
      memo.set(n, v);
      return v;
    }
    function fibIter(n: number): number {
      let a = 0, b = 1;
      for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; }
      return a;
    }
    export function run(): number { return fibMemo(10) + fibIter(10); } // 55 + 55 = 110
  `;

  it("compiles with ZERO hard errors and a VALID binary under IR-first default", async () => {
    const r = await compile(SRC, { fileName: "fib.ts", experimentalIR: true });
    const hard = (r.errors ?? []).filter((e) => e.severity === "error");
    expect(hard.map((e) => e.message)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });

  it("runs correctly under the IR-first default", async () => {
    const r = await compile(SRC, { fileName: "fib.ts", experimentalIR: true });
    const exports = await instantiate(r);
    expect((exports.run as () => number)()).toBe(110);
  });
});
