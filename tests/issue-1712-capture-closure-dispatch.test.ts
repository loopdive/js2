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
  // (#6419) Hand `wrapExports` the genuine `WebAssembly.Instance`, not its raw
  // exports record. Only the instance carries the data-struct authority the
  // boundary needs to DECODE a returned struct: with the bare exports record
  // `__struct_field_names` cannot be trusted through the host-bridge export
  // view, `_wasmToPlain` finds no fields, and a returned fnctor instance
  // marshals to `{}` — which is how the acorn-shape row below read
  // `ast.type === undefined` while the raw struct was perfectly well-formed
  // (`__sget_type(raw) === "Program"`). Measured 2026-09-13: same module, same
  // call, `wrapExports(instance, …)` answers `{type:"Program"}` and
  // `wrapExports(instance.exports, …)` answers `{}`. That silent degradation
  // of the raw-exports overload is a real runtime defect and is filed
  // separately; this file's subject is closure dispatch, so it uses the
  // documented preferred input.
  return { exp: wrapExports(instance, { signatures: result.exportSignatures }), raw: instance.exports };
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

  // (#6979 S7-a) Re-pinned from the retired `host-assisted` profile to the
  // native regime. The node graph is built in-module and read in-module: on
  // the regime a fnctor instance returned across the export boundary still
  // marshals to `{}` through `wrapExports` (pre-existing on main's default
  // profile, filed against #5385), which is a boundary question, not the
  // closure-dispatch subject of this file.
  it("prototype method returns a fnctor-instance node graph (acorn shape)", async () => {
    const { exp } = await run(`
      var Node = function Node(type) { this.type = type; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() {
        var n = new Node("Program");
        return n;
      };
      export function parseType(input) { return new Parser(input).parse().type; }
    `);
    expect(exp.parseType("x")).toBe("Program");
  });

  // (#6979 S7-a) The host-assisted profile stored prototype methods through the
  // `__extern_set_strict` host import, which this row used to intercept to
  // capture the closure. The regime stores them natively, so the closure is
  // read back through an export instead; the subject is unchanged: both
  // dispatchers reach a capturing arity-0 closure.
  it("__call_fn_1 dispatches an arity-0 capturing closure (arity <= N coverage)", async () => {
    const { raw } = await run(`
      var Node = function Node(type) { this.type = type; };
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.parse = function parse() { return typeof Node === "function" ? 1 : 0; };
      export function getParse() { return Parser.prototype.parse; }
    `);
    const savedClosure = raw.getParse();
    expect(savedClosure).not.toBeNull();
    expect(typeof savedClosure).toBe("object");
    expect(raw.__is_closure(savedClosure)).toBe(1);
    // Both dispatchers must reach the capturing arity-0 closure.
    expect(raw.__call_fn_0(savedClosure)).toBe(1);
    expect(raw.__call_fn_1(savedClosure, undefined)).toBe(1);
  });
});
