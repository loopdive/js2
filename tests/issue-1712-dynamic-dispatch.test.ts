// #1712 — dynamic dispatch fixes that unblock compiled acorn's parse() chain
// (exports.parse → static Parser.parse → new this(…) → getOptions → in-ctor
// prototype-method calls). Four pinned root causes:
//
// 1. Static method on a function-style constructor (`Parser.parse = fn;
//    Parser.parse(input)`): __extern_method_call wrapped the callable closure
//    receiver into a bare JS function bridge, which has no view of sidecar
//    statics — every static call threw "X is not a function". Fixed by a
//    _safeGet sidecar/prototype fallback that dispatches with the RAW closure
//    struct as receiver, so `new this(…)` inside the static body works.
//
// 2. Externref callee whose guarded wrapper-struct cast fails but is non-null
//    (acorn's `var hasOwn = Object.hasOwn || function(){…}` — a host builtin
//    in a JS variable): the dispatch did `struct.get` on the null cast result
//    and trapped "dereferencing a null pointer". Fixed by a host-callable
//    fallback arm routing through __call_function (JS-host mode only).
//
// 3. __call_function passed raw WasmGC struct args to the host callee, so
//    `Object.hasOwn(structArg, "a")` observed no properties; closure args were
//    wrapped at arity 0 (all args dropped). Fixed by __extern_method_call-style
//    host marshaling + arity-aware closure wrapping.
//
// 4. __register_fnctor_instance was emitted at the END of the synthesized
//    fnctor ctor, so prototype-method calls on `this` INSIDE the ctor
//    (acorn's `this.context = this.initialContext()`) could not resolve
//    through the vivified prototype. Fixed by emitting it in the ctor
//    prologue.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "acorn.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#1712 — static methods on function-style constructors", () => {
  it("plain static method call (was: 'parse is not a function')", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.parse = function parse(input) { return "STATIC-" + input; };
      export function parse(input) { return Parser.parse(input); }
    `);
    expect(exp.parse("x")).toBe("STATIC-x");
  });

  it("acorn shape: static method does new this(…).method()", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() { return this.input; };
      Parser.parse = function parse(input) { return new this(input).parse(); };
      export function parse(input) { return Parser.parse(input); }
    `);
    expect(exp.parse("x")).toBe("x");
  });

  it("static data property read-back still works", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.version = "8.16.0";
      export function parse(input) { var p = new Parser(input); return Parser.version + ":" + p.input; }
    `);
    expect(exp.parse("x")).toBe("8.16.0:x");
  });
});

describe("#1712 — host-callable fallback for non-closure-shaped callees", () => {
  it("builtin || closure module var is callable (was: null-deref trap)", async () => {
    const exp = await run(`
      var hasOwn = Object.hasOwn || function (obj, propName) { return Object.prototype.hasOwnProperty.call(obj, propName); };
      export function parse(input) { var o = { a: 1 }; return hasOwn(o, "a") ? "HAS" : "MISSING"; }
    `);
    expect(exp.parse("x")).toBe("HAS");
  });

  it("builtin callee with numeric return feeds arithmetic", async () => {
    const exp = await run(`
      var max = Math.max || function (a, b) { return a > b ? a : b; };
      export function parse(input) { return max(2, 5) + 1; }
    `);
    expect(exp.parse("x")).toBe(6);
  });
});

describe("#1712 — in-ctor prototype-method calls on this", () => {
  it("ctor calls own prototype method (acorn initialContext pattern)", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); this.ctx = this.initialContext(); };
      Parser.prototype.initialContext = function initialContext() { return "CTX-" + this.input; };
      Parser.prototype.parse = function parse() { return this.ctx; };
      export function parse(input) { return new Parser(input).parse(); }
    `);
    expect(exp.parse("x")).toBe("CTX-x");
  });
});

describe("#1712 — fnctor two-shape unification (checker shape never synthesized)", () => {
  it("prototype method RETURNING an instance of the same fnctor (was: null-deref trap)", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() { return new Parser("inner"); };
      export function parse(input) { return new Parser(input).parse(); }
    `);
    expect(exp.parse("x")).toEqual({ input: "inner" });
  });

  it("checker-typed member call routes through the dynamic prototype path", async () => {
    const exp = await run(`
      var Node = function Node(t) { this.type = t; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.startNode = function startNode() { return new Node("Program"); };
      Parser.prototype.finishNode = function finishNode(node) { node.end = 1; return node; };
      Parser.prototype.parse = function parse() { var n = this.startNode(); return this.finishNode(n).type; };
      export function parse(input) { return new Parser(input).parse(); }
    `);
    expect(exp.parse("x")).toBe("Program");
  });
});
