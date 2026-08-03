// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — targeted fixtures for the bytecode interpreter: encoder/disasm
// unit checks and feature-group behaviour with exact expected completion values.
// Node-only (no Wasm), parsed with node-acorn.

import { beforeAll, describe, expect, it } from "vitest";
import { Encoder } from "../../src/interp/encoder.js";
import { Op, OP_COUNT, OP_INFO } from "../../src/interp/opcodes.js";
import { compileScript, createDynamicFunction, disassemble, executeIndirectEval } from "../../src/interp/index.js";
import { loadAcorn, parse, runInterp } from "./harness.js";

beforeAll(async () => {
  await loadAcorn();
});

/** Run a body and assert its completion value equals `expected` (deep). */
function expectValue(body: string, expected: unknown): void {
  const r = runInterp(body);
  expect(r.ok, `body threw: ${r.errName} — ${body}`).toBe(true);
  expect(r.value).toEqual(expected);
}

describe("#2928 dynamic Function factory", () => {
  it("constructs a global-scope interpreted function through an injected parser", () => {
    const globalObject: Record<string, unknown> = {};
    const fn = createDynamicFunction((source) => parse(source), "a,b", "return a + b", globalObject) as (
      a: number,
      b: number,
    ) => number;

    expect(fn(1, 2)).toBe(3);
    expect(fn.name).toBe("anonymous");
    expect(fn.length).toBe(2);
  });

  it("substitutes the function realm global object for a bare-call this", () => {
    const globalObject: Record<string, unknown> = {};
    const fn = createDynamicFunction((source) => parse(source), "", "return this", globalObject) as () => unknown;
    expect(fn()).toBe(globalObject);
  });

  it("preserves undefined bare-call this for a strict dynamic function", () => {
    const globalObject: Record<string, unknown> = {};
    const fn = createDynamicFunction(
      (source) => parse(source),
      "",
      '"use strict"; return this',
      globalObject,
    ) as () => unknown;
    expect(fn()).toBeUndefined();
  });

  it("installs one callable realm Function identity for aliases and constructed functions", () => {
    const globalObject: Record<string, unknown> = {};
    const result = executeIndirectEval(
      (source) => parse(source),
      "var F = Function; var fn = F('a', 'return a + 1'); " +
        "(typeof F === 'function' ? 1 : 0) + (fn(2) === 3 ? 2 : 0) + " +
        "(fn.constructor === Function ? 4 : 0)",
      globalObject,
    );

    expect(result).toBe(7);
    expect(globalObject.Function).toBeDefined();
  });
});

describe("#3101 encoder — packing + operand fields", () => {
  it("packs op/a/b into one word and the opcode survives the WIDE mask", () => {
    const enc = new Encoder();
    enc.emitReg(Op.Star, 5); // op=Star, a=5
    const word = enc.code[0]!;
    expect(word & 0x7f).toBe(Op.Star);
    expect((word >>> 8) & 0xfff).toBe(5);
  });

  it("uses a trailing WIDE word when a const index exceeds 12 bits", () => {
    const enc = new Encoder();
    enc.emitConst(Op.LdaConst, 5000); // > 0xfff
    expect(enc.code.length).toBe(2);
    expect(enc.code[0]! & 0x80).toBe(0x80); // WIDE flag set
    expect(enc.code[1]).toBe(5000); // full index in the trailing word
  });

  it("de-duplicates primitive constants but keeps objects by identity", () => {
    const enc = new Encoder();
    expect(enc.internConst("x")).toBe(enc.internConst("x"));
    expect(enc.internConst(42)).toBe(enc.internConst(42));
    const a = {};
    const b = {};
    expect(enc.internConst(a)).not.toBe(enc.internConst(b));
  });

  it("back-patches a forward jump to the resolved target", () => {
    const enc = new Encoder();
    const slot = enc.emitJump(Op.Jump);
    enc.emit0(Op.LdaUndef);
    const target = enc.here();
    enc.patch(slot, enc.here());
    expect(enc.code[slot]).toBe(target);
  });
});

describe("#3101 opcodes — table integrity", () => {
  it("has metadata for every opcode number", () => {
    expect(OP_INFO.length).toBe(OP_COUNT);
    for (let i = 0; i < OP_COUNT; i += 1) expect(OP_INFO[i]!.name.length).toBeGreaterThan(0);
  });
});

describe("#3101 disassembler — the debugging contract", () => {
  it("renders pc, mnemonics, operands and const annotations", () => {
    const meta = compileScript(parse("1 + 2"));
    const text = disassemble(meta);
    expect(text).toContain("FuncMeta");
    expect(text).toMatch(/\bLdaConst\b/);
    expect(text).toMatch(/\bAdd\b/);
    expect(text).toMatch(/\bReturn\b/);
    // Const-annotation comment present.
    expect(text).toContain(";;");
  });

  it("annotates a nested FuncMeta and shows the exn table", () => {
    const meta = compileScript(parse("try { throw 1; } catch (e) { e; }"));
    const text = disassemble(meta);
    expect(text).toContain("exn-table");
    expect(text).toMatch(/\bThrow\b/);
  });
});

describe("#3101 arithmetic + coercion (delegated to generic runtime ops)", () => {
  it("evaluates numeric arithmetic with precedence", () => expectValue("1 + 2 * 3 - 4 / 2", 5));
  it("does string concatenation via +", () => expectValue("'foo' + 'bar'", "foobar"));
  it("mixes number/string coercion like JS +", () => expectValue("1 + '2'", "12"));
  it("computes modulo", () => expectValue("17 % 5", 2));
  it("applies signed left/right shifts with JS coercion", () => {
    expectValue("2 << 3", 16);
    expectValue("16 >> 3", 2);
    expectValue("-8 >> 2", -2);
    expectValue("'2' << 3", 16);
  });
  it("negates and ToNumber-coerces unary +", () => expectValue("-(3) + +'4'", 1));
  it("calls unshadowed Number through CallBuiltin", () => expectValue("Number('4') + Number()", 4));
  it("preserves a shadowed global-coercion binding", () =>
    expectValue("function Number(x){ return x + 1; } Number(4)", 5));
  it("calls the host-free Math CallBuiltin surface", () =>
    expectValue("Math.max(3,7,2) + Math.min(3,7,2) + Math.abs(-5) + Math.floor(2.9) + Math.ceil(2.1)", 19));
  it("preserves Math max/min NaN and signed-zero behavior", () => {
    expectValue("Math.max()", -Infinity);
    expectValue("Math.min()", Infinity);
    expectValue("1 / Math.max(-0, +0)", Infinity);
    expectValue("1 / Math.min(+0, -0)", -Infinity);
  });
});

describe("#3101 comparison desugarings (>, >=, !=, !== via the minimal ISA)", () => {
  it("a > b desugars to b < a", () => expectValue("5 > 3", true));
  it("a >= b desugars to b <= a", () => expectValue("3 >= 3", true));
  it("a != b desugars to !(a == b)", () => expectValue("1 != 2", true));
  it("a !== b desugars to !(a === b)", () => expectValue("1 !== '1'", true));
  it("=== is strict", () => expectValue("1 === '1'", false));
  it("> evaluates operands left→right (side-effect order)", () =>
    expectValue("var s=''; var a=function(){s+='a';return 2}; var b=function(){s+='b';return 1}; a()>b(); s", "ab"));
  // #3356 — COERCION order, one layer below evaluation order: §13.10.1 evaluates
  // `a > b` as IsLessThan(rval, lval, LeftFirst=false); the false flag exists so
  // ToPrimitive still runs in SOURCE order (a first, then b). A LeftFirst=true
  // desugar (native `b < a`) coerces b first — observably wrong ("ba").
  it("> runs ToPrimitive left-then-right (LeftFirst=false, #3356)", () =>
    expectValue(
      "var s=''; var a={valueOf:function(){s+='a';return 1}}; var b={valueOf:function(){s+='b';return 2}}; a>b; s",
      "ab",
    ));
  it(">= runs ToPrimitive left-then-right (LeftFirst=false, #3356)", () =>
    expectValue(
      "var s=''; var a={valueOf:function(){s+='a';return 1}}; var b={valueOf:function(){s+='b';return 2}}; a>=b; s",
      "ab",
    ));
  // IsLessThan undefined-result (NaN arm) → false, and the string arms (§7.2.13).
  it("> with a NaN operand is false", () => expectValue("NaN > 1", false));
  it(">= with a NaN operand is false", () => expectValue("1 >= NaN", false));
  it("> compares two strings lexicographically", () => expectValue("'b' > 'a'", true));
  it(">= coerces a mixed string/number pair numerically", () => expectValue("'10' >= 9", true));
});

describe("#3101 control flow + completion values", () => {
  it("predeclares strict script var, function, lexical, and class bindings", () =>
    expectValue(
      '"use strict"; var a=1; let b=2; const c=3; function f(){return 4;} class C { static value(){return 5;} } a+b+c+f()+C.value()',
      15,
    ));
  it("if/else takes the right branch", () => expectValue("if (2 > 1) 'yes'; else 'no'", "yes"));
  it("if with false test and no else completes undefined", () => expectValue("1; if (false) 2;", undefined));
  it("while accumulates", () => expectValue("var n=5, f=1; while(n>1){f*=n;n--;} f", 120));
  it("for loop sums", () => expectValue("var s=0; for(var i=0;i<5;i++) s+=i; s", 10));
  it("empty-body for resets the completion to undefined", () => expectValue("1; for(var i=0;i<3;i++){}", undefined));
  it("do-while runs once", () => expectValue("var x=0; do { x++; } while(x<1); x", 1));
  it("break exits the loop", () => expectValue("var c=0; for(var i=0;i<9;i++){ if(i===4) break; c++; } c", 4));
  it("continue skips", () => expectValue("var t=0; for(var i=0;i<5;i++){ if(i%2===0) continue; t+=i; } t", 4));
  it("labeled break exits the outer loop", () =>
    expectValue(
      "var hit=0; outer: for(var i=0;i<3;i++){ for(var j=0;j<3;j++){ hit++; if(j===1) break outer; } } hit",
      2,
    ));
  it("ternary + logical short-circuit", () => expectValue("(true ? 1 : 2) + (0 || 5) + (null ?? 7)", 13));
});

describe("#3101 property access + object/array literals (shared MOP)", () => {
  it("reads object properties", () => expectValue("var o = { a: 1, b: 2 }; o.a + o.b", 3));
  it("reads/writes dynamic keys", () => expectValue("var o = {}; var k = 'z'; o[k] = 9; o[k]", 9));
  it("builds and indexes arrays", () => expectValue("var a = [10, 20, 30]; a[0] + a[2]", 40));
  it("array method via shared builtin", () => expectValue("[1,2,3].map(function(x){return x*x;})", [1, 4, 9]));
  it("computed member assignment returns the value", () => expectValue("var o={}; o.x = (o.y = 3) + 1", 4));
});

describe("#3101 calls, closures, recursion, this-binding", () => {
  it("calls a declared function", () => expectValue("function add(a,b){return a+b;} add(4,5)", 9));
  it("recurses (interp→interp, frame stack)", () =>
    expectValue("function fib(n){return n<2?n:fib(n-1)+fib(n-2);} fib(10)", 55));
  it("invokes a function expression immediately", () => expectValue("(function(x){return x*x;})(6)", 36));
  it("invokes an arrow", () => expectValue("((a,b)=>a*b)(6,7)", 42));
  it("binds this via a method call", () => expectValue("var o={n:5}; function g(){return this.n;} g.call(o)", 5));
  it("binds bare interpreted calls to the script global object", () =>
    expectValue("function g(){return this === globalThis ? 1 : 2;} g()", 1));
  it("nested function sees a global var (global resolution, not capture)", () =>
    expectValue("var g=0; function inc(){ g=g+1; return g; } inc(); inc(); inc()", 3));
  it("constructs a non-interpreted callable through the fixed-arity runtime seam", () =>
    expectValue("new Array(1, 2, 3).length", 3));
  it("keeps construction beyond the Phase-1 arity ceiling catchable", () =>
    expectValue("var r; try { new Array(1,2,3,4,5,6,7,8,9); } catch (e) { r=e.name; } r", "RangeError"));
});

describe("#3101 exceptions (side-table, cross-call unwind)", () => {
  it("catches a thrown value", () => expectValue("var r; try { throw 42; } catch(e) { r = e + 1; } r", 43));
  it("runs finally after normal completion", () =>
    expectValue("var o=0; try { o=1; } catch(e) { o=2; } finally { o+=10; } o", 11));
  it("orders throw → catch → finally", () =>
    expectValue("var log=''; try { log+='t'; throw 1; } catch(e){ log+='c'; } finally { log+='f'; } log", "tcf"));
  it("does NOT swallow a throw in try/finally with no catch (propagates)", () =>
    expectValue("var caught='no'; try { try { throw 'x'; } finally {} } catch(e){ caught=e; } caught", "x"));
  it("unwinds a throw across a call boundary into a caller's catch", () =>
    expectValue("function boom(){ throw 'x'; } var r='no'; try { boom(); } catch(e){ r=e; } r", "x"));
  it("host TypeError on a non-callable is catchable", () =>
    expectValue("var r = 'no'; try { var n = 5; n(); } catch(e) { r = e.name; } r", "TypeError"));
  it("constructs an unshadowed native Error through CallBuiltin", () =>
    expectValue("var r; try { throw new Error('x'); } catch(e) { r=e.name + ':' + e.message; } r", "Error:x"));
  it("does not replace a shadowed Error binding with the intrinsic", () =>
    expectValue("function Error(x){ this.value=x; } (new Error(7)).value", 7));
  it("typeof of an undeclared name does not throw", () => expectValue("typeof someUndeclaredThing", "undefined"));
});

describe("#3101 templates", () => {
  it("interpolates via concat", () => expectValue("var x=3; `v=${x*2}!`", "v=6!"));
});
