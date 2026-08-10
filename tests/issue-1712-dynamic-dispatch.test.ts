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
  importObject.__setInstance?.(instance);
  return wrapExports(instance, { signatures: result.exportSignatures });
}

async function runStandalone(src: string): Promise<WebAssembly.Instance> {
  const result = await compile(src, {
    fileName: "acorn-standalone.mjs",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
  return WebAssembly.instantiate(module, {});
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

  it("uses one fixed-arity host crossing without changing callback semantics", async () => {
    const source = `
      function identity(value) { return value; }
      function invoke(callback, value) { return callback(value); }
      export function test(callback, value) { return invoke(callback, value); }
      export function local() { return invoke(identity, 13); }
    `;
    const result = await compile(source, {
      fileName: "fixed-arity-host-call.js",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    const importNames = WebAssembly.Module.imports(module).map((entry) => entry.name);
    expect(importNames).toContain("__call_function_1");
    expect(importNames).not.toContain("__call_function");
    expect(importNames).not.toContain("__js_array_new");
    expect(importNames).not.toContain("__js_array_push");

    const importObject: any = result.importObject ?? {};
    const instance = await WebAssembly.instantiate(module, importObject);
    importObject.__setInstance?.(instance);
    const exp = wrapExports(instance, { signatures: result.exportSignatures }) as any;
    expect(exp.test((value: number) => value + 1, 10)).toBe(11);
    expect(exp.local()).toBe(13);
  });

  it("keeps the legacy argument-array ABI available as a kill switch", async () => {
    const previous = process.env.JS2WASM_FIXED_ARITY_HOST_CALLS;
    process.env.JS2WASM_FIXED_ARITY_HOST_CALLS = "0";
    try {
      const result = await compile(
        `
          function identity(value) { return value; }
          function invoke(callback, value) { return callback(value); }
          export function test(callback, value) { return invoke(callback, value); }
          export function local() { return invoke(identity, 13); }
        `,
        { fileName: "legacy-host-call.js", skipSemanticDiagnostics: true },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = await WebAssembly.compile(result.binary);
      const importNames = WebAssembly.Module.imports(module).map((entry) => entry.name);
      expect(importNames).toContain("__call_function");
      expect(importNames).toContain("__js_array_new");
      expect(importNames).toContain("__js_array_push");
      expect(importNames).not.toContain("__call_function_1");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FIXED_ARITY_HOST_CALLS");
      else process.env.JS2WASM_FIXED_ARITY_HOST_CALLS = previous;
    }
  });
});

describe("#1712 — standalone first-class Object.hasOwn", () => {
  it("invokes a returned nested closure through an erased dynamic callable", async () => {
    const result = await compile(
      `
        /** @returns {*} */
        function makeDynamicFunction() {
          return function (a, b) { return (a + b) | 0; };
        }
        export function probe() {
          var fn = makeDynamicFunction();
          return fn(1, 2) | 0;
        }
      `,
      { fileName: "dynamic-function-like-call.mjs", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.probe as () => number)()).toBe(3);
  });

  it("reads a computed key from a closed standalone struct", async () => {
    const result = await compile(
      `function read(o, k) { return o[k]; } export function probe() { var o = { ecmaVersion: 2025 }; return (read(o, "ecmaVersion") - 2009) | 0; }`,
      { fileName: "closed-computed-read.mjs", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.probe as () => number)()).toBe(16);
  });

  it("coerces a numeric computed key for a mixed closed-struct table", async () => {
    const result = await compile(
      `function read(o, k) { return o[k]; } var table = { 3: "a", 5: "bb", 6: "ccc", strict: "x" }; export function probe() { return read(table, 6).length | 0; }`,
      { fileName: "mixed-numeric-read.mjs", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.probe as () => number)()).toBe(3);
  });

  it("calls Object.hasOwn stored behind Acorn's builtin-or-fallback variable", async () => {
    const result = await compile(
      `
        var direct = Object.hasOwn;
        var fallback = function (obj, propName) {
          return Object.prototype.hasOwnProperty.call(obj, propName);
        };
        var hasOwn = Object.hasOwn || fallback;
        export function probe() {
          var options = { ecmaVersion: 2025 };
          return (direct(options, "ecmaVersion") ? 1 : 0) +
            (direct(options, "sourceType") ? 2 : 0) +
            (fallback(options, "ecmaVersion") ? 4 : 0) +
            (fallback(options, "sourceType") ? 8 : 0) +
            (hasOwn(options, "ecmaVersion") ? 16 : 0) +
            (hasOwn(options, "sourceType") ? 32 : 0) +
            (Object.hasOwn(options, "ecmaVersion") ? 64 : 0);
        }
      `,
      { fileName: "acorn-has-own.mjs", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.probe as () => number)()).toBe(85);
  });

  it("keeps Acorn's for-in-populated options bag on one open-object representation", async () => {
    const result = await compile(
      `
        var defaults = { ecmaVersion: null, sourceType: "script", onToken: null };
        var hasOwn = Object.hasOwn || function (obj, propName) {
          return Object.prototype.hasOwnProperty.call(obj, propName);
        };
        function getOptions(opts) {
          var options = {};
          for (var opt in defaults) {
            options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaults[opt];
          }
          if (options.ecmaVersion >= 2015) options.ecmaVersion -= 2009;
          return options;
        }
        export function probe() { return (getOptions({ ecmaVersion: 2025 }).ecmaVersion - 0) | 0; }
      `,
      { fileName: "acorn-options.mjs", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.probe as () => number)()).toBe(16);
  });

  it("keeps computed-access implicit-any parameters on an inferred Uint8Array carrier", async () => {
    const result = await compile(
      `
        function writeByte(buf, index, value) {
          buf[index] = value;
        }
        export function probe() {
          var out = new Uint8Array(4);
          writeByte(out, 1, 7);
          writeByte(out, 2, 11);
          return out[0] + out[1] * 10 + out[2] * 100 + out[3] * 1000;
        }
      `,
      { fileName: "implicit-any-uint8-index.mjs", target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).filter((entry) => entry.kind === "function")).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.probe as () => number)()).toBe(1170);
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

describe("#1712 — dynamic prototype accessors outrank inferred struct fields", () => {
  it("acorn-style chained getters observe the runtime Parser receiver", async () => {
    const exp = await run(`
      var prototypeAccessors = {
        inFunction: { configurable: true },
        allowReturn: { configurable: true },
      };
      var Parser = function Parser() { this.flags = 2; };
      prototypeAccessors.inFunction.get = function () { return (this.flags & 2) > 0; };
      prototypeAccessors.allowReturn.get = function () { return this.inFunction; };
      Object.defineProperties(Parser.prototype, prototypeAccessors);
      export function probe() { return new Parser().allowReturn ? 1 : 0; }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("preserves the receiver across chained accessors in standalone mode", async () => {
    const instance = await runStandalone(`
      var prototypeAccessors = {
        inFunction: { configurable: true },
        allowReturn: { configurable: true },
      };
      var Parser = function Parser() { this.flags = 2; };
      prototypeAccessors.inFunction.get = function () { return (this.flags & 2) > 0; };
      prototypeAccessors.allowReturn.get = function () { return this.inFunction; };
      Object.defineProperties(Parser.prototype, prototypeAccessors);
      export function probe() { return new Parser().allowReturn ? 1 : 0; }
    `);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("reads a late-assigned prototype method through an Acorn-style accessor", async () => {
    const instance = await runStandalone(`
      var SCOPE_TOP = 1, SCOPE_FUNCTION = 2, SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION;
      var Scope = function Scope(flags) { this.flags = flags; };
      var Parser = function Parser() { this.scopeStack = []; this.enterScope(SCOPE_TOP); };
      Parser.prototype.enterScope = function (flags) { this.scopeStack.push(new Scope(flags)); };
      Object.defineProperty(Parser.prototype, "inFunction", {
        configurable: true,
        get: function () { return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0; },
      });
      Parser.prototype.currentVarScope = function () {
        for (var i = this.scopeStack.length - 1;; i--) {
          var scope = this.scopeStack[i];
          if (scope.flags & SCOPE_VAR) return scope;
        }
      };
      export function probe() {
        var parser = new Parser();
        parser.enterScope(SCOPE_FUNCTION);
        return parser.inFunction ? 1 : 0;
      }
    `);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("preserves Acorn's prototype accessors across standalone table growth", async () => {
    const instance = await runStandalone(`
      var SCOPE_TOP = 1, SCOPE_FUNCTION = 2, SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION;
      var Scope = function Scope(flags) { this.flags = flags; };
      var Parser = function Parser() { this.scopeStack = []; this.enterScope(SCOPE_TOP); };
      var prototypeAccessors = {
        inFunction: { configurable: true },
        inGenerator: { configurable: true },
        inAsync: { configurable: true },
        canAwait: { configurable: true },
        allowReturn: { configurable: true },
        allowSuper: { configurable: true },
        allowDirectSuper: { configurable: true },
        treatFunctionsAsVar: { configurable: true },
        allowNewDotTarget: { configurable: true },
        allowUsing: { configurable: true },
        inClassStaticBlock: { configurable: true },
      };
      prototypeAccessors.inFunction.get = function () {
        return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0;
      };
      prototypeAccessors.inGenerator.get = function () { return true; };
      prototypeAccessors.inAsync.get = function () { return true; };
      prototypeAccessors.canAwait.get = function () { return true; };
      prototypeAccessors.allowReturn.get = function () { return this.inFunction; };
      prototypeAccessors.allowSuper.get = function () { return true; };
      prototypeAccessors.allowDirectSuper.get = function () { return true; };
      prototypeAccessors.treatFunctionsAsVar.get = function () { return true; };
      prototypeAccessors.allowNewDotTarget.get = function () { return true; };
      prototypeAccessors.allowUsing.get = function () { return true; };
      prototypeAccessors.inClassStaticBlock.get = function () { return true; };
      Object.defineProperties(Parser.prototype, prototypeAccessors);
      var pp = Parser.prototype;
      pp.enterScope = function (flags) { this.scopeStack.push(new Scope(flags)); };
      pp.currentVarScope = function () {
        for (var i = this.scopeStack.length - 1;; i--) {
          var scope = this.scopeStack[i];
          if (scope.flags & SCOPE_VAR) return scope;
        }
      };
      export function probe() {
        var parser = new Parser();
        parser.enterScope(SCOPE_FUNCTION);
        return parser.inFunction ? 1 : 0;
      }
      export function accessorMask() {
        var parser = new Parser();
        parser.enterScope(SCOPE_FUNCTION);
        return (parser.inFunction ? 1 : 0)
          | (parser.inGenerator ? 2 : 0)
          | (parser.inAsync ? 4 : 0)
          | (parser.canAwait ? 8 : 0)
          | (parser.allowReturn ? 16 : 0)
          | (parser.allowSuper ? 32 : 0)
          | (parser.allowDirectSuper ? 64 : 0)
          | (parser.treatFunctionsAsVar ? 128 : 0)
          | (parser.allowNewDotTarget ? 256 : 0)
          | (parser.allowUsing ? 512 : 0)
          | (parser.inClassStaticBlock ? 1024 : 0);
      }
    `);
    expect((instance.exports.accessorMask as () => number)()).toBe(2047);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("keeps widened Object.defineProperty data values on their exact struct field", async () => {
    const exp = await run(`
      var state = {};
      Object.defineProperty(state, "answer", { value: 42, configurable: true });
      export function probe() { return state.answer; }
    `);
    expect(exp.probe()).toBe(42);
  });
});

describe("#2847 — acorn AST marshalling fidelity", () => {
  it("preserves the boolean brand returned by an untyped prototype method", async () => {
    const exp = await run(`
      var Node = function Node() { this.type = "MemberExpression"; };
      var Parser = function Parser() { this.type = 1; };
      Parser.prototype.eat = function eat(type) {
        if (this.type === type) return true;
        return false;
      };
      Parser.prototype.parse = function parse() {
        var node = new Node();
        node.computed = this.eat(1);
        return node;
      };
      export function parse() { return new Parser().parse(); }
    `);
    const node = exp.parse();
    expect(node.computed).toBe(true);
    expect(typeof node.computed).toBe("boolean");
  });

  it("does not infer a boolean brand when the same property also stores numbers", async () => {
    const exp = await run(`
      var Flag = function Flag() { this.computed = true; };
      var Counter = function Counter() { this.computed = 1; };
      export function flag() { return new Flag(); }
      export function counter() { return new Counter(); }
    `);
    expect(exp.flag().computed).toBe(true);
    expect(typeof exp.flag().computed).toBe("boolean");
    expect(exp.counter().computed).toBe(1);
    expect(typeof exp.counter().computed).toBe("number");
  });

  it("does not conflate same-named builtin and user boolean calls", async () => {
    const exp = await run(`
      function find() { return true; }
      var Holder = function Holder() {
        this.result = [0, 1].find(function (value) { return value === 1; });
      };
      export function holder() { find(); return new Holder(); }
    `);
    expect(exp.holder().result).toBe(1);
    expect(typeof exp.holder().result).toBe("number");
  });

  it("distinguishes a never-assigned conditional field from explicit null", async () => {
    const exp = await run(`
      var Node = function Node(withSource) {
        this.id = null;
        if (withSource) {
          this.sourceFile = "input.js";
        }
      };
      export function absent() { return new Node(false); }
      export function present() { return new Node(true); }
    `);
    expect(exp.absent()).toEqual({ id: null });
    expect(exp.present()).toEqual({ id: null, sourceFile: "input.js" });
  });
});
