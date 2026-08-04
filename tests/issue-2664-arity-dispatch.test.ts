// #2664 — acorn parse() deeper hang: dynamic method calls under-applied (called
// with FEWER args than the method's declared param count) silently returned null
// instead of running the method body.
//
// Root cause: the host method-call bridge `_wrapWasmClosureUnknownArity`
// (src/runtime.ts) selected the wasm dispatcher by the JS caller's `args.length`:
// `__call_fn_method_<args.length>`. But `__call_fn_method_N`
// (emitClosureMethodCallExportN, src/codegen/index.ts) only dispatches closures
// of arity ≤ N — a closure whose declared arity EXCEEDS N is omitted and the
// dispatcher falls through to `ref.null.extern` (null). So a method with 2
// declared params invoked with 0 args (acorn's `this.parseExpression()`) routed
// to `__call_fn_method_0`, which omits the arity-2 closure → the method body
// never ran → acorn's `parseTopLevel` loop never advanced the token → infinite
// hang (the post-#2674 deeper wall).
//
// Fix: for the METHOD path the bridge now dispatches at the MAX available
// `__call_fn_method_N` (which includes every closure of arity ≤ N) and pads the
// missing args with `undefined` (JS missing-argument semantics). Each closure
// still receives exactly its OWN declared arity — `__call_fn_method_N` passes
// `closureArity` args per closure and drops the extra padding — so over-
// dispatching is safe.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.ts" });
  expect(result.success).toBe(true);
  const io: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, io);
  io.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2664 — under-applied dynamic method dispatch (arity mismatch)", () => {
  it("does not inherit argc from a getter when a known-arity setter runs next", async () => {
    // Test262 propertyHelper.js invokes a zero-argument accessor getter before
    // assigning through its one-argument setter. Both callbacks use the
    // known-arity host bridge. The setter must seed argc=1 for its own call,
    // rather than inheriting the getter's stale argc=0 and receiving undefined.
    const exp = await run(`
      // @ts-nocheck
      export function probe() {
        var obj = {};
        obj.value = "before";
        var getValue = function() { return obj.value; };
        var setValue = function(next) { obj.value = next; };
        Object.defineProperty(obj, "field", {
          get: getValue,
          set: setValue,
          enumerable: true,
          configurable: true
        });
        if (obj.field !== "before") return 0;
        obj.field = "after";
        return obj.value === "after" && obj.field === "after" ? 1 : 0;
      }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("dispatches a 3-formal CommonJS export called with 2 args and preserves arguments.length", async () => {
    // React's production bundle assigns createElement to an open CommonJS
    // exports object. That object crosses the host mirror, whose old local
    // closureBridge only knew arities 0..2. Calling the 3-formal function with
    // two args therefore selected __call_fn_method_2, matched no closure, and
    // returned null. The widened transport must still report the source argc.
    const exp = await run(`
      // @ts-nocheck
      var exports = {};
      exports.create = function(type, config, children) {
        return { type: type, argc: arguments.length };
      };
      export function probe() {
        var result = exports.create("div", null);
        return result.type === "div" && result.argc === 2 ? 1 : 0;
      }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("calls an immediately bound object-field closure through its host callable", async () => {
    // In JS-host mode `fn.bind(...)` returns a real host bound-function
    // externref. A chained invocation must not ref.test that value as a Wasm
    // closure struct and dereference the resulting null.
    const exp = await run(`
      // @ts-nocheck
      function F() {
        this.af = _ => this;
      }
      export function probe() {
        var f = new F();
        f.af.bind({})();
        return 1;
      }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("a 2-param method invoked via this.m() with 0 args RUNS (not null)", async () => {
    // The acorn shape: `this.parseExpression()` — a 2-param method called with 0
    // args through a dynamic (any-receiver) dispatch. Before the fix the bridge
    // picked __call_fn_method_0, omitting the arity-2 closure → returned null.
    const exp = await run(`
      // @ts-nocheck
      function C(n) { this.n = n; }
      var pp = C.prototype;
      var pp2 = C.prototype;
      pp.outer = function() { return this.inner(); };
      pp2.inner = function(a, b) { if (a === undefined && b === undefined) return 99; return 0; };
      export function probe() { var c = new C(1); return c.outer(); }
    `);
    expect(exp.probe()).toBe(99);
  });

  it("a deep under-applied chain (1 arg into a 3-param, then 0 into a 2-param) runs end to end", async () => {
    const exp = await run(`
      // @ts-nocheck
      function C(n) { this.n = n; }
      var pp = C.prototype;
      pp.outer = function() { return this.mid(7); };
      pp.mid = function(a, b, c) { return this.inner() + (a | 0); };
      pp.inner = function(x, y) { return 90; };
      export function probe() { var c = new C(1); return c.outer(); }
    `);
    expect(exp.probe()).toBe(97);
  });

  it("an EXACTLY-applied method call is unchanged (control)", async () => {
    const exp = await run(`
      // @ts-nocheck
      function C(n) { this.n = n; }
      var pp = C.prototype;
      pp.outer = function() { return this.inner(5, 6); };
      pp.inner = function(a, b) { return a + b; };
      export function probe() { var c = new C(1); return c.outer(); }
    `);
    expect(exp.probe()).toBe(11);
  });

  it("an OVER-applied method call still receives only its declared arity", async () => {
    // Extra args are dropped at the wasm dispatch arm; the method sees exactly
    // its declared params. (b stays the 2nd arg; the 3rd is ignored.)
    const exp = await run(`
      // @ts-nocheck
      function C(n) { this.n = n; }
      var pp = C.prototype;
      pp.outer = function() { return this.inner(5, 6, 7); };
      pp.inner = function(a, b) { return a * 100 + b; };
      export function probe() { var c = new C(1); return c.outer(); }
    `);
    expect(exp.probe()).toBe(506);
  });

  it("the parser-loop shape terminates: an under-applied tokenizer-style advance runs", async () => {
    // Mirrors the acorn parseTopLevel/parseExpression hang shape: a loop whose
    // body calls a multi-param method with no args to advance state. If the
    // under-applied call returns null without running, the loop never advances.
    const exp = await run(`
      // @ts-nocheck
      function P() { this.pos = 0; }
      var pp = P.prototype;
      pp.advance = function(unusedA, unusedB) { this.pos = this.pos + 1; return this.pos; };
      pp.run = function() {
        var guard = 0;
        while (this.pos < 3 && guard < 1000) { this.advance(); guard = guard + 1; }
        return this.pos * 1000 + guard;
      };
      export function probe() { return new P().run(); }
    `);
    // pos reaches 3 in 3 iterations (guard 3); if advance() returned null without
    // running, pos stays 0 and guard hits 1000.
    expect(exp.probe()).toBe(3003);
  });
});
