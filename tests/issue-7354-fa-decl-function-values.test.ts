// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 S4 (a) — a top-level function declaration read as a value on the Prepared whole-program path. The value is a
// closure over a trampoline that calls the declaration directly; module-init creates it once, before its first
// statement, into the declaration's immutable dynamic home, which every read of the name reads. A call of the name
// stays the declaration's direct call.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ts } from "../src/ts-api.js";
import * as globals from "../src/ir/program-source-globals.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import { functionDeclarationsReadAsValues } from "../src/ir/program-source-function-values.js";
import { bindingHoldsItsDeclaration } from "../src/shared/intrinsic-prototype-writes.js";
import { preparedScriptRefusal, runPreparedScript } from "./helpers/prepared-script-run.js";

afterEach(() => vi.restoreAllMocks());

/** A closure pulls in the native realm, whose emission takes tens of seconds on a loaded box. */
const SLOW = 240_000;

function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

describe("#7354 S4 (a) — a function declaration read as a value", () => {
  // Each program runs twice: with node's answer (returns) and with a wrong one (throws), so a pass cannot come
  // from a check that never ran. Node agrees with the first.
  it.each([
    ["copied, and equal to itself", "function f(a) { return a; } var g = f;", "g !== f || !g", "g === f"],
    ["read inside its own body", "function f() { return f; }", "f() !== f", "f() === f"],
    ["read and called directly", "function f(x) { return x * 2; } var g = f;", "f(2) !== 4 || g !== f", "f(2) !== 5"],
    [
      "called as a statement from another function",
      "var n = 0; function f(x) { n = x; } var g = f; function h() { f(3); } h();",
      "n !== 3 || g !== f",
      "n === 3",
    ],
    [
      "as the `opts || verifyProperty` fallback",
      "function vp() { return 1; } function h(opts) { return opts || vp; }",
      "h(undefined) !== vp || h(vp) !== vp",
      "h(undefined) === vp",
    ],
    [
      "returning a number, a Boolean or nothing",
      "function n(x) { return x * 2; } function b(x) { return x === 1; } function v() {} var p = n, q = b, r = v;",
      "p !== n || q !== b || r !== v || n(1) !== 2 || b(1) !== true",
      "q === b",
    ],
    ["thrown and caught", "function f() {} var c; try { throw f; } catch (e) { c = e; }", "c !== f || !c", "c === f"],
  ])(
    "runs a declaration %s",
    async (_, program, holds, fails) => {
      const right = `${program} if (${holds}) throw 1;`;
      expect(node(right)).toBe("returned");
      expect(await runPreparedScript(right)).toBe("returned");
      expect(await runPreparedScript(`${program} if (${fails}) throw 1;`)).toBe("threw");
    },
    SLOW,
  );

  it(
    "keeps a call of the name the declaration's direct call",
    async () => {
      const instantiate = vi.spyOn(globals, "instantiateProgramSourceGlobals");
      const source = "function f(x) { return x * 2; } var g = f; if (f(1) !== 2 || g !== f) throw 1;";
      expect(await runPreparedScript(source)).toBe("returned");
      const functions = instantiate.mock.calls[0]![0] as readonly IrFunction[];
      const instrs = (fn: IrFunction): IrInstr[] => {
        const out: IrInstr[] = [];
        for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (i) => out.push(i));
        return out;
      };
      const callsOfF = (fn: IrFunction) =>
        instrs(fn).filter((i) => i.kind === "call" && i.target.binding.kind === "unit" && i.target.name === "f");
      const moduleInit = functions.find((fn) => fn.name === "<module-init>")!;
      const trampoline = functions.find((fn) => fn.name === "f__value")!;
      expect(callsOfF(moduleInit)).toHaveLength(1);
      expect(callsOfF(trampoline)).toHaveLength(1);
      expect(instrs(moduleInit).filter((i) => i.kind === "intrinsic" && i.id.startsWith("js.closure.call"))).toEqual(
        [],
      );
      // The value is created once, before the first statement.
      const created = instrs(moduleInit).filter((i) => i.kind === "closure.new");
      expect(created).toHaveLength(1);
      expect(moduleInit.blocks[0]!.instrs[0]).toBe(created[0]);
    },
    SLOW,
  );

  // What (a) leaves to its neighbours, each pinned by its name so the slice that admits it updates this list.
  it.each([
    // A binding that may not hold its declaration has no home: the read stays unresolved (R1).
    ["a write to the name", "function f() {} var g = f; f = function () {};", 'identifier "f" is not in scope'],
    [
      "a write through `globalThis`",
      "function f() {} var g = f; globalThis.f = function () {};",
      'identifier "f" is not in scope',
    ],
    ["a write through `this`", "function f() {} var g = f; this.f = function () {};", 'identifier "f" is not in scope'],
    ["`eval` in the source", 'function f() {} var g = f; eval("1");', 'identifier "f" is not in scope'],
    ["`with` in the source", "function f() {} var g = f; with ({}) {}", "'with' statements are not allowed"],
    // A call through a value (Fb), `typeof` of a function value, a dynamic `+`: their own slices.
    [
      "a call through a copy",
      "function f(a) { return a; } var g = f; if (g !== f || g(1) !== 1) throw 1;",
      'direct call to "g" has no exact AST-site plan in <module-init>',
    ],
    [
      "a call through a parameter",
      "function f(x) { return x * 2; } function t(fn) { return fn(2); } if (t(f) !== 4) throw 1;",
      "__ir_dyn_call_argument has no Prepared intrinsic",
    ],
    [
      "a call of the `opts || verifyProperty` fallback",
      "function vp() { return 1; } function h(opts) { return (opts || vp)(); } if (h(undefined) !== 1) throw 1;",
      "only direct calls supported in Phase 2 (h)",
    ],
    [
      "`typeof` of the value",
      'function f() {} if (typeof f !== "function") throw 1;',
      "dyn.typeof has no Prepared intrinsic",
    ],
    [
      "a dynamic `+` in the body",
      "function f(x) { return x + 1; } if (f(1) !== 2) throw 1;",
      "__ir_dyn_add has no Prepared intrinsic",
    ],
    // S4's next walls: a direct call inside a lifted closure (R7), a home's call result as a `+` operand (R5).
    [
      "a direct call inside a function expression (R7)",
      "function a(x) { return x; } var g = a; var o = function (x) { return a(x); }; o(1);",
      'direct call to "a" has no exact AST-site plan in <module-init>__closure_0',
    ],
    // Not (a)'s top-level case: a nested or block-level declaration.
    [
      "a nested declaration",
      "function g() { function f() {} return f; } g();",
      "nested func must have a return type annotation (g)",
    ],
    ["a block-level declaration", "{ function f() {} } var g = f;", "unsupported body statement FunctionDeclaration"],
  ])(
    "refuses %s by name",
    async (_, program, refusal) => {
      expect(await preparedScriptRefusal(program)).toContain(refusal);
    },
    SLOW,
  );

  it("refuses a declaration with a typed parameter as a value", async () => {
    const source = "function f(a: number): number { return a; } function h(x) { return x; } h(f);";
    expect(await preparedScriptRefusal(source, "test.ts")).toContain(
      "function f read as a value has a parameter that is not the dynamic value",
    );
  });
});

describe("#7354 S4 (a) — which declarations are read as values", () => {
  const parse = (text: string) => ts.createSourceFile("/probe.js", text, ts.ScriptTarget.ES2015, true);
  const names = (text: string) => functionDeclarationsReadAsValues(parse(text)).map((fn) => fn.name!.text);

  it("counts every reference but a call's or a `new`'s callee, in any function", () => {
    expect(names("function a() {} function b() {} function c() {} a(); new b(); var x = c;")).toEqual(["c"]);
    expect(names("function a() {} function h() { return a; }")).toEqual(["a"]);
    expect(names("function a() { return typeof a; }")).toEqual(["a"]);
    expect(names("function a() {} a(a);")).toEqual(["a"]);
  });

  it("does not count a member name, a property name, an export specifier or a nested declaration", () => {
    expect(names("function a() {} export { a as b };")).toEqual([]);
    expect(names("function a() {} var o = { a: 1 }; o.a;")).toEqual([]);
    expect(names("function h() { function a() {} return a; }")).toEqual([]);
  });

  it("proves the binding holds its declaration only with all three conjuncts", () => {
    const holds = (text: string) => {
      const declaration = parse(text).statements.find(ts.isFunctionDeclaration)!;
      return bindingHoldsItsDeclaration(declaration.name!, declaration);
    };
    expect(holds("function f() {} var g = f;")).toBe(true);
    expect(holds("function f() {} f = 1;")).toBe(false); // an identifier write
    expect(holds("function f() {} var f;")).toBe(false); // a second binding site
    expect(holds("function f() {} this.f = 1;")).toBe(false); // a write by another route
    expect(holds("function f() {} var o = globalThis;")).toBe(false); // the global object escapes
  });
});
