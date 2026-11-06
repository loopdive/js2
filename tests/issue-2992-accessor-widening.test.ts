// #2992 (slice 5) — standalone: an ACCESSOR-descriptor Object.defineProperty on
// an empty-`{}`-widened receiver must stay observable (getter invoked, setter
// routed, gOPD sees accessor-ness).
//
// Root cause (documented in the issue's slice-3/5 findings): the empty-object
// widening pre-pass promoted an all-prop-access `{}` var to a closed nominal
// struct. An accessor define can only store a plain value into the fixed struct
// field — a later read can never INVOKE the getter (it sees null / the closure
// value), assignment never routes through the setter, and gOPD can never
// observe accessor-ness (`hasOwnProperty("get")`). This is the runner-wrapped
// 15.2.3.6-4-75 / 4-82-* test262 family.
//
// Fix: an accessor-descriptor `Object.defineProperty(varName, k, {get/set…})`
// (or a `defineProperties` member descriptor with a get/set key) is now an
// `$Object`-hash consumer for the widening decision (standalone-gated — the
// host lane applies accessor defines through the live-mirror Proxy onto the
// real JS object, byte-identical). The var stays a `$Object`, where the
// slice-3 (#2893) accessor machinery (FLAG_ACCESSOR + live get/set halves +
// §10.1.6.3 merge) serves define → read → gOPD correctly.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, target: "gc" | "standalone"): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    target,
    skipSemanticDiagnostics: true,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  importObject.__setInstance?.(instance);
  return (instance.exports as any).test?.();
}

for (const target of ["gc", "standalone"] as const) {
  describe(`#2992 S5 — accessor define on widened {} receiver (${target})`, () => {
    it("getter is invoked through a dynamic any-param read (harness shape)", async () => {
      const ret = await run(
        `
function readProp(o: any, name: any): any { return o[name]; }
export function test(): number {
  var obj: any = {};
  obj.data = "payload";
  var get_func = function() { return obj.data; };
  Object.defineProperty(obj, "foo", { get: get_func, enumerable: true, configurable: true });
  return readProp(obj, "foo") === "payload" ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("generic-descriptor redefine preserves the live accessor (4-82-10 shape)", async () => {
      const ret = await run(
        `
function readProp(o: any, name: any): any { return o[name]; }
export function test(): number {
  var obj: any = {};
  obj.verifySetFunction = "data";
  var get_func = function() { return obj.verifySetFunction; };
  var set_func = function(value: any) { obj.verifySetFunction = value; };
  Object.defineProperty(obj, "foo", { get: get_func, set: set_func, enumerable: true, configurable: true });
  Object.defineProperty(obj, "foo", { enumerable: true, configurable: false });
  return readProp(obj, "foo") === "data" ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("setter routes a dynamic any-param write (4-75 verifyWritable shape)", async () => {
      const ret = await run(
        `
function writeProp(o: any, name: any, v: any): void { o[name] = v; }
export function test(): number {
  var obj: any = {};
  obj.sink = "";
  var set_func = function(value: any) { obj.sink = value; };
  var get_func = function() { return obj.sink; };
  Object.defineProperty(obj, "foo", { get: get_func, set: set_func });
  writeProp(obj, "foo", "written");
  return obj.sink === "written" ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("gOPD observes accessor identity after define (get === original)", async () => {
      const ret = await run(
        `
export function test(): number {
  var obj: any = {};
  obj.tag = 1;
  var get_func = function() { return 10; };
  Object.defineProperty(obj, "foo", { get: get_func, enumerable: false, configurable: false });
  var d: any = Object.getOwnPropertyDescriptor(obj, "foo");
  if (d === undefined) return 0;
  if (d.get !== get_func) return 2;
  if (d.enumerable !== false) return 3;
  if (d.configurable !== false) return 4;
  return 1;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("defineProperties with an accessor member descriptor", async () => {
      const ret = await run(
        `
function readProp(o: any, name: any): any { return o[name]; }
export function test(): number {
  var obj: any = {};
  obj.base = 5;
  Object.defineProperties(obj, {
    foo: { get: function() { return 42; }, enumerable: true, configurable: true },
    bar: { value: 7, writable: true, enumerable: true, configurable: true }
  });
  if (readProp(obj, "foo") !== 42) return 2;
  if (readProp(obj, "bar") !== 7) return 3;
  if (obj.base !== 5) return 4;
  return 1;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("other widened fields keep working on the poisoned $Object receiver", async () => {
      const ret = await run(
        `
export function test(): number {
  var obj: any = {};
  obj.n = 3;
  obj.s = "x";
  Object.defineProperty(obj, "foo", { get: function() { return 1; } });
  obj.n = obj.n + 1;
  return (obj.n === 4 && obj.s === "x" && obj.foo === 1) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });

    it("control: data-only defines keep the widened fast path (no poison)", async () => {
      const ret = await run(
        `
export function test(): number {
  var obj: any = {};
  obj.k = 1;
  Object.defineProperty(obj, "v", { value: 1001, writable: true, enumerable: true, configurable: true });
  return (obj.v === 1001 && obj.k === 1) ? 1 : 0;
}
`,
        target,
      );
      expect(ret).toBe(1);
    });
  });
}
