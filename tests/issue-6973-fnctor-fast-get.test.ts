// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6973 — `__extern_get` reads on function-constructor INSTANCES take a short
 * arm (`__fnctor_fast_get`): own `$bag` data property, else the `[[Prototype]]`
 * walk through struct links (`Child.prototype = new Inheriter()`, the Octane
 * deltablue idiom) and `$Object` prototypes, DATA properties only. The
 * `__call_m_*` direct-call arm consults it too, so such a method call skips the
 * `$ObjVec` / `__extern_method_call` / `__apply_closure` round trip.
 *
 * Nothing is cached: every read re-walks live state, so a prototype write, an
 * own shadowing write, a delete or an `Object.setPrototypeOf` is seen by the
 * very next read. The cases below pin exactly those transitions, plus the
 * declines (accessors, `Reflect.get` receivers, `constructor`, declared fields),
 * against node's answer for the same source.
 *
 * Standalone-only (the arm is installed only on `--target standalone`).
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { compile } from "../src/index.js";

const INHERITS = `
Object.defineProperty(Object.prototype, "inheritsFrom", {
  value: function (shuper) {
    function Inheriter() { }
    Inheriter.prototype = shuper.prototype;
    this.prototype = new Inheriter();
    this.superConstructor = shuper;
  }
});
function Base(s) { this.strength = s; }
Base.prototype.satisfy = function () { return this.output() + 1; };
Base.prototype.kind = 3;
Base.prototype.three = function (a, b, c) { return a + (b === undefined ? 10 : b) + (c === undefined ? 100 : c); };
function Unary(v, s) { Unary.superConstructor.call(this, s); this.myOutput = v; }
Unary.inheritsFrom(Base);
Unary.prototype.output = function () { return this.myOutput; };
function Stay(v, s) { Stay.superConstructor.call(this, v, s); }
Stay.inheritsFrom(Unary);
Stay.prototype.execute = function () { return 7; };
`;

async function build(src: string, emitWat = false) {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-6973.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    runtimeEvalProvider: false,
    emitWat,
  } as never);
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return r;
}

async function runStandalone(src: string): Promise<{ value: unknown; exports: Record<string, unknown> }> {
  const r = await build(src);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const ex = instance.exports as Record<string, unknown>;
  (ex.__module_init as (() => void) | undefined)?.();
  return { value: (ex.test as () => unknown)(), exports: ex };
}

/** node's answer, in a fresh realm (the prelude patches Object.prototype). */
function runNode(src: string): unknown {
  return vm.runInNewContext(`${src.replace(/export function/g, "function")}\ntest();`);
}

async function same(src: string): Promise<void> {
  const expected = runNode(src);
  expect(typeof expected).toBe("number");
  expect((await runStandalone(src)).value).toBe(expected);
}

describe("#6973 — fnctor-instance property reads take the short arm", () => {
  it("own bag fields, struct-link methods at every depth, and the $Object prototype", async () => {
    await same(`${INHERITS}
export function test() {
  var c = new Stay(5, 2);
  var acc = 0;
  for (var i = 0; i < 50; i++) acc += c.satisfy() + c.execute() + c.strength + c.output() + c.kind + c.myOutput;
  return acc;
}`);
  });

  it("a prototype write after reads is seen by the next read (every link level)", async () => {
    await same(`${INHERITS}
export function test() {
  var c = new Stay(5, 2);
  var r = c.output();
  Stay.prototype.output = function () { return 40; }; // the nearest link gains a shadowing member
  r = r * 100 + c.output();
  Base.prototype.satisfy = function () { return 9; }; // $Object prototype value write
  r = r * 100 + c.satisfy();
  Base.prototype.kind = 4;
  return (r * 10 + c.kind) | 0;
}`);
  });

  it("own shadowing, and a deleted link member falling back down the chain", async () => {
    await same(`${INHERITS}
export function test() {
  var c = new Stay(5, 2);
  var d = new Stay(6, 2);
  var r = c.output();
  c.output = function () { return 77; };
  r = r * 100 + c.output();
  r = r * 100 + d.output();
  delete Unary.prototype.output;
  Base.prototype.output = function () { return 33; };
  r = r * 100 + d.output();
  return (r * 10 + c.output() % 10) | 0;
}`);
  });

  it("Object.setPrototypeOf / __proto__ re-link an instance after reads", async () => {
    const OTHER = `
function Other() { }
Other.prototype.output = function () { return 61; };
Other.prototype.execute = function () { return 62; };`;
    // Read-then-call: the method READ is what this arm serves. (Combining both
    // re-links in one program throws on the base compiler too — not this arm.)
    await same(`${INHERITS}${OTHER}
export function test() {
  var c = new Stay(5, 2);
  var r = c.execute();
  Object.setPrototypeOf(c, Other.prototype);
  var f = c.execute;
  return (r * 100 + f.call(c)) | 0;
}`);
    await same(`${INHERITS}${OTHER}
export function test() {
  var d = new Stay(6, 2);
  var r = d.output();
  d.__proto__ = Other.prototype;
  var g = d.output;
  return (r * 100 + g.call(d)) | 0;
}`);
  });

  it("an inherited accessor runs with the original receiver (the arm declines it)", async () => {
    await same(`${INHERITS}
Object.defineProperty(Base.prototype, "twice", { get: function () { return this.myOutput * 2; }, configurable: true });
export function test() {
  var c = new Stay(21, 2);
  var other = { myOutput: 4 };
  var r = c.twice;
  r = r * 100 + Reflect.get(Base.prototype, "twice", other);
  // A Reflect.get the arm answers (a DATA property) must still consume the
  // explicit receiver: the accessor read after it binds \`this\` to c.
  r = r * 100 + Reflect.get(c, "strength", other);
  return (r * 100 + c.twice) | 0;
}`);
  });

  it("under-applied method calls keep their padded arguments", async () => {
    await same(`${INHERITS}
export function test() {
  var c = new Stay(5, 2);
  return (c.three(1) + c.three(1, 2) * 1000 + c.three(1, 2, 3) * 1000000) | 0;
}`);
  });

  it("negative controls: constructor, a declared field over a prototype member, computed keys", async () => {
    await same(`
function P(x) { this.x = x; }
P.prototype.x = 5;
P.prototype.getX = function () { return this.x; };
P.prototype.y = 8;
export function test() {
  var p = new P(1);
  var o = { y: 2 };
  var k = "ge" + "tX";
  var r = (p.constructor === P ? 1 : 0) + p.x * 10 + p.getX() * 100 + p.y * 1000 + o.y * 10000;
  return (r + p[k]() * 100000 + ("getX" in p ? 1000000 : 0)) | 0;
}`);
  });

  it("work done: a depth-1 struct-link method call no longer re-enters __extern_get", async () => {
    const prev = process.env.JS2WASM_EXEC_CENSUS;
    process.env.JS2WASM_EXEC_CENSUS = "__extern_get,__fnctor_fast_get";
    try {
      const { value, exports } = await runStandalone(`${INHERITS}
export function test() {
  var c = new Stay(5, 2);
  var acc = 0;
  for (var i = 0; i < 1000; i++) acc += c.output();
  return acc;
}`);
      expect(value).toBe(5000);
      const count = (name: string) => (exports[`__exec_count_${name}`] as WebAssembly.Global | undefined)?.value ?? -1;
      expect(count("__fnctor_fast_get")).toBeGreaterThanOrEqual(1000);
      // Before: __extern_method_call → __extern_get on the instance, then the
      // #6944 re-entry on the struct link and on its bag: 6010 for this loop.
      expect(count("__extern_get")).toBeLessThan(2500);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EXEC_CENSUS");
      else process.env.JS2WASM_EXEC_CENSUS = prev;
    }
  });
});
