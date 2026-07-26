// #1712 — capture-carrying closures must be dispatchable through the
// __call_fn_<N> / __call_fn_method_<N> exports.
//
// Root cause pinned here: capture-carrying closure structs are emitted as
// standalone Wasm struct types with NO subtype relation to the 1-field base
// wrapper, so the dispatchers' single representative-base-wrapper `ref.test`
// excluded them from funcref extraction and silently returned null. Acorn's
// prototype methods all capture their fnctor (`Node`, `Parser`, …), which
// made every compiled `exports.parse()` return null at the AST root.
//
// Also pins the `_maybeWrapCallableUnknownArity` contract: the runtime wraps
// property-stored closures with the HIGHEST available `__call_fn_<arity>`
// export, so __call_fn_1 must be able to invoke a zero-arg closure (it
// covered exactly-arity-1 only before #1712 delegated it to the generic
// arity<=N emitter).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "acorn.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return { exp: wrapExports(instance.exports, { signatures: result.exportSignatures }), raw: instance.exports };
}

describe("#1712 — fnctor-capturing closure dispatch through the host bridge", () => {
  it("prototype method capturing another fnctor runs (was: null)", async () => {
    const { exp } = await run(`
      var Node = function Node(type) { this.type = type; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() { return typeof Node; };
      export function parse(input) { return new Parser(input).parse(); }
    `);
    expect(exp.parse("x")).toBe("function");
  });

  it("prototype method returns a fnctor-instance node graph (acorn shape)", async () => {
    const { exp } = await run(`
      var Node = function Node(type) { this.type = type; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() {
        var n = new Node("Program");
        return n;
      };
      export function parse(input) { return new Parser(input).parse(); }
    `);
    const ast = exp.parse("x");
    expect(ast).not.toBeNull();
    expect(ast.type).toBe("Program");
  });

  it("__call_fn_1 dispatches an arity-0 capturing closure (arity <= N coverage)", async () => {
    const { exp } = await run(`
      var Node = function Node(type) { this.type = type; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() { return typeof Node; };
      export function parse(input) { return new Parser(input).parse(); }
    `);
    // Reach the raw dispatcher exports directly: grab the closure stored on
    // the vivified prototype via a fresh compile+instrumentation pass.
    const result: any = await compile(
      `
      var Node = function Node(type) { this.type = type; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() { return typeof Node; };
      export function parse(input) { return new Parser(input).parse(); }
      `,
      { fileName: "acorn.mjs" },
    );
    const io: any = result.importObject ?? {};
    let savedClosure: any = null;
    const origSet = io.env.__extern_set_strict;
    expect(origSet).toBeTypeOf("function");
    io.env.__extern_set_strict = (o: any, k: any, v: any) => {
      if (k === "parse") savedClosure = v;
      return origSet(o, k, v);
    };
    const { instance } = await WebAssembly.instantiate(result.binary, io);
    io.__setExports?.(instance.exports);
    const raw: any = instance.exports;
    raw.parse("x");
    expect(savedClosure).not.toBeNull();
    expect(typeof savedClosure).toBe("object");
    expect(raw.__is_closure(savedClosure)).toBe(1);
    // Both dispatchers must reach the capturing arity-0 closure.
    expect(raw.__call_fn_0(savedClosure)).toBe("function");
    expect(raw.__call_fn_1(savedClosure, undefined)).toBe("function");
  });
});
