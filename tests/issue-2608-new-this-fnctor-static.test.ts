// #2608 — `new this(...)` inside an fnctor (function-style constructor) STATIC
// method does not resolve `this` to the constructor and/or mis-forwards its
// args. This is compiled acorn's 4th dogfood blocker: acorn's
// (re-allocated from a hand-picked #2586 that collided with
//  2586-standalone-arrayfrom-map.md on main — #2531 hand-pick race)
// `Parser.parse = function(input, options){ return new this(options, input).parse() }`
// produces a Parser with an EMPTY `this.input`, so the tokenizer scans no
// characters and `parseTopLevel` loops forever.
//
// Minimal repro: a static method `Fn.make = function(x,y){ return new this(x,y) }`.
// `new Fn(x,y)` (by identifier) works; `new this(x,y)` used to throw
// "is not a constructor". Root cause: the checker types the `this` callee as the
// bare `function`-value (CALL sigs, NO construct sigs) and resolves it to NO
// className, so (1) the `callSigs>0 && constructSigs===0` Pattern-2 guard threw,
// and (2) the #1679 ThisKeyword arm — gated on a resolved fnctor className — was
// skipped. The callee then dropped to the generic dynamic-`new` path on a
// non-constructible wrapped-closure externref.
//
// FIX (#2608): `this` IS a constructable function-value at runtime (`this === Fn`,
// a WasmGC closure struct), so exclude a `this` callee from the Pattern-2 throw and
// route `new this(...)` through the landed #56 `__construct_closure` host bridge
// (JS-host) — the bridge detects `__is_closure`, wraps with `_wrapCallableForHost`,
// and `Reflect.construct`s it with the args in order.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

async function runStandalone(src: string): Promise<any> {
  const result: any = await compile(src, {
    fileName: "probe.mjs",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors?.map((error: any) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(module, {});
  return exports;
}

describe("#2586 — `new this(...)` in an fnctor static method", () => {
  it("baseline: static method with `new Fn(x,y)` (by identifier) works", async () => {
    const exp = await run(`
      // @ts-nocheck
      var Parser = function Parser(a, b) { this.a = a; this.b = b; };
      Parser.makeIdent = function (x, y) { return new Parser(x, y); };
      export function probe() { return Parser.makeIdent("opt", "inp").b; }
    `);
    expect(exp.probe()).toBe("inp");
  });

  it("`new this(x, y)` in a static method constructs with both args (acorn shape)", async () => {
    const exp = await run(`
      // @ts-nocheck
      var Parser = function Parser(a, b) { this.a = a; this.b = b; };
      Parser.makeNew = function (x, y) { return new this(x, y); };
      Parser.parse = function (input, options) { return new this(options, input).b; };
      export function probeNewThis() { return Parser.makeNew("opt", "inp").b; }
      export function probeAcornShape() { return Parser.parse("theInput", { v: 1 }); }
    `);
    // new this(x,y).b must equal the SECOND arg, and the acorn-shape
    // parse(input,options) → new this(options,input) must put `input` in field b.
    expect(exp.probeNewThis()).toBe("inp");
    expect(exp.probeAcornShape()).toBe("theInput");
  });

  it("constructs natively in standalone and preserves both arguments", async () => {
    const exp = await runStandalone(`
      var Parser = function Parser(options, input) {
        this.first = options.value;
        this.second = String(input);
      };
      Parser.make = function (input, options) {
        var parser = new this(options, input);
        return (parser.first + parser.second.length) | 0;
      };
      export function probe() { return Parser.make("abcd", { value: 7 }); }
    `);
    expect(exp.probe()).toBe(11);
  });

  it("invokes a prototype method with arguments on inline `new this()`", async () => {
    const exp = await runStandalone(`
      var Parser = function Parser(options, input) {
        this.input = String(input);
        this.offset = options.offset;
      };
      Parser.prototype.parse = function (suffix) {
        return (this.input.length + suffix + this.offset) | 0;
      };
      Parser.parse = function (input, options) {
        return new this(options, input).parse(3);
      };
      export function probe() { return Parser.parse("abcd", { offset: 7 }); }
    `);
    expect(exp.probe()).toBe(14);
  });

  it("keeps the constructed instance as `this` for prototype accessors", async () => {
    const exp = await runStandalone(`
      var Parser = function Parser(options, input) {
        this.input = String(input);
        this.offset = options.offset;
      };
      Object.defineProperty(Parser.prototype, "size", {
        get: function () { return (this.input.length + this.offset) | 0; }
      });
      Parser.readSize = function (input, options) {
        var parser = new this(options, input);
        return parser.size | 0;
      };
      export function probe() { return Parser.readSize("abcd", { offset: 7 }); }
    `);
    expect(exp.probe()).toBe(11);
  });

  it("keeps native field carriers inside a constructed instance method", async () => {
    const exp = await runStandalone(`
      var spaces = /(?:\\s|\\/\\/.*|\\/\\*[^]*?\\*\\/)*/g;
      var Parser = function Parser(options, input) { this.input = String(input); };
      Parser.prototype.scan = function () {
        spaces.lastIndex = 0;
        return spaces.exec(this.input)[0].length | 0;
      };
      Parser.scan = function (input) { return new this({}, input).scan(); };
      export function probe() { return Parser.scan("let x"); }
    `);
    expect(exp.probe()).toBe(0);
  });

  it("normalizes a JSDoc-string argument after the dynamic static-method boundary", async () => {
    const exp = await runStandalone(`
      var spaces = /(?:\\s|\\/\\/.*|\\/\\*[^]*?\\*\\/)*/g;
      /**
       * @param {object} options
       * @param {string} input
      */
      var Parser = function Parser(options, input) { this.input = String(input); };
      var pp = Parser.prototype;
      pp.scan = function () {
        spaces.lastIndex = 0;
        spaces.exec(this.input)[0].length;
        return this;
      };
      /**
       * @param {string} input
       * @param {object} options
      */
      Parser.scan = function (input, options) { new this(options, input).scan(); };
      function scan(input, options) { Parser.scan(input, options); }
      export function probe() { scan("let x", {}); return 1; }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("preserves a constructed fnctor instance through an object-literal field", async () => {
    const exp = await runStandalone(`
      var TokenType = function TokenType(label, conf) {
        this.label = label;
        this.keyword = conf.keyword;
        this.beforeExpr = !!conf.beforeExpr;
      };
      var startsExpr = { beforeExpr: true };
      var types = {
        num: new TokenType("num", startsExpr),
        name: new TokenType("name", startsExpr),
        eof: new TokenType("eof", {})
      };
      export function probe() { return types.name.label === "name" ? 1 : 0; }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("preserves a nested fnctor field through an aliased prototype method", async () => {
    const exp = await runStandalone(`
      var TokenType = function TokenType(label, conf) {
        if (conf === void 0) conf = {};
        this.label = label;
        this.keyword = conf.keyword;
        this.beforeExpr = !!conf.beforeExpr;
        this.startsExpr = !!conf.startsExpr;
        this.isLoop = !!conf.isLoop;
        this.isAssign = !!conf.isAssign;
        this.prefix = !!conf.prefix;
        this.postfix = !!conf.postfix;
        this.binop = conf.binop || null;
        this.updateContext = null;
      };
      function kw(name, options) {
        if (options === void 0) options = {};
        options.keyword = name;
        return new TokenType(name, options);
      }
      var types = {
        name: new TokenType("name", { startsExpr: true }),
        _if: kw("if"),
        _return: kw("return", { beforeExpr: true })
      };
      var Parser = function Parser() { this.type = types.name; };
      var pp = Parser.prototype;
      var reached = 0;
      pp.read = function () {
        var type = this.type;
        if (!type.keyword && type.label === "name") reached = 1;
      };
      Parser.read = function () { new this().read(); };
      export function probe() { Parser.read(); return reached | 0; }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("preserves an inline fnctor instance stored in a computed object slot", async () => {
    const exp = await runStandalone(`
      var TokenType = function TokenType(label, conf) {
        if (conf === void 0) conf = {};
        this.label = label;
        this.keyword = conf.keyword;
      };
      var keywords = {};
      function kw(name) {
        return keywords[name] = new TokenType(name, { keyword: name });
      }
      kw("let");
      export function probe() {
        var type = keywords["let"];
        return type.keyword === "let" && type.label === "let" ? 1 : 0;
      }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("preserves a bound fnctor instance stored in a computed object slot", async () => {
    const exp = await runStandalone(`
      var TokenType = function TokenType(label) { this.label = label; };
      var tokens = {};
      function install(name) {
        var token = new TokenType(name);
        tokens[name] = token;
      }
      install("name");
      export function probe() { return tokens["name"].label === "name" ? 1 : 0; }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("matches standalone fnctor instances in an object-identity switch", async () => {
    const exp = await runStandalone(`
      var TokenType = function TokenType(label) { this.label = label; };
      var types = { num: new TokenType("num"), name: new TokenType("name") };
      function classify(type) {
        switch (type) {
        case types.num: return 1;
        case types.name: return 2;
        default: return 0;
        }
      }
      export function probe() { return classify(types.num); }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("pads omitted trailing arguments for dynamically dispatched prototype methods", async () => {
    const exp = await runStandalone(`
      var Parser = function Parser() {};
      Parser.prototype.read = function (value, optional, trailing) {
        return value === 7 && optional === void 0 && trailing === void 0 ? 1 : 0;
      };
      Parser.run = function () { return new this().read(7); };
      export function probe() { return Parser.run(); }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("preserves arguments.length while padding omitted dynamic-call formals", async () => {
    const exp = await runStandalone(`
      var Parser = function Parser() {};
      Parser.prototype.read = function (value, optional, trailing) {
        return arguments.length;
      };
      Parser.run = function () { return new this().read(7); };
      export function probe() { return Parser.run(); }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("does not pin polymorphic field growth to the first constructor shape", async () => {
    const exp = await runStandalone(`
      var A = function A() {};
      var B = function B() {};
      function stamp(node, value) { node.extra = value; }
      export function probe() {
        var a = new A();
        var b = new B();
        stamp(a, 10);
        stamp(b, 20);
        return (a.extra * 100 + b.extra) | 0;
      }
    `);
    expect(exp.probe()).toBe(1020);
  });

  it("returns undefined when a presence-tracked fnctor field was never assigned", async () => {
    const exp = await runStandalone(`
      var Node = function Node(withValue) {
        if (withValue) this.foo = null;
      };
      export function probe() {
        var absent = new Node(false);
        var present = new Node(true);
        return absent.foo === void 0 && !Object.hasOwn(absent, "foo") &&
          present.foo === null && Object.hasOwn(present, "foo") ? 1 : 0;
      }
    `);
    expect(exp.probe()).toBe(1);
  });

  it("treats a fnctor field assigned by both if/else arms as always present", async () => {
    const exp = await runStandalone(`
      var Cursor = function Cursor(fromOffset) {
        if (fromOffset) {
          this.pos = 7;
          this.lineStart = 4;
        } else {
          this.pos = this.lineStart = 0;
        }
      };
      Cursor.prototype.read = function () {
        return this.pos === 0 && this.lineStart === 0 ? 1 : 0;
      };
      Cursor.readStart = function () {
        return new this(false).read();
      };
      export function probe() {
        var start = new Cursor(false);
        var offset = new Cursor(true);
        return start.pos === 0 && start.lineStart === 0 &&
          offset.pos === 7 && offset.lineStart === 4 &&
          Object.hasOwn(start, "pos") && Object.hasOwn(start, "lineStart") &&
          Object.hasOwn(offset, "pos") && Object.hasOwn(offset, "lineStart") &&
          Cursor.readStart() === 1 ? 1 : 0;
      }
    `);
    expect(exp.probe()).toBe(1);
  });
});
