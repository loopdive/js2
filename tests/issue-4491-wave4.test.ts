// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4491 wave-4 — the descriptor-MOP residual slice (standalone lane).
 *
 * Four independent roots, each pinned by EXECUTING the operation it guards
 * (define, then write / delete / enumerate / call, and read the result back) —
 * never by asserting a descriptor shape. A pin that asserts a shape is not a
 * pin that exercises the shape.
 *
 * 1. **Identity destroyed at a monomorphic vec parameter.** In a
 *    descriptor-dirty module, narrowing a callee's parameter to a concrete
 *    `__vec_<k>` carrier turns the ARGUMENT boundary into a converting COPY
 *    (`emitVecToVecBody` → a fresh `struct.new`). The #3251 overlay side table
 *    is keyed by vec IDENTITY, so the callee received an array with no
 *    descriptors: accessor get/set and `writable:false` all vanished. This is
 *    the whole `propertyHelper.js` verification family, whose `obj` parameter
 *    is monomorphic on the array under test.
 * 2. **`Object.freeze` was invisible to an array/arguments ELEMENT.** The level
 *    is recorded on the carrier's integrity bag and clears W/C on the BAG's
 *    entries; a vec's elements have no bag entry, so the implicit element
 *    descriptor kept answering `{writable: true, configurable: true}` and the
 *    element stayed writable and deletable.
 * 3. **`var g = undefined` was the NUMBER 0.** `resolveWasmType(undefined)` is
 *    i32 — a lowering convention for a void RESULT, not a claim about a
 *    binding's value — so the slot stored `i32.const 0` and boxed to `i31 0`.
 * 4. **`Date`'s statics were not own properties.** The ctor carrier seeded only
 *    `length`/`name`/`prototype`.
 *
 * The `it.fails` block at the end pins measured RESIDUALS with their owners, so
 * a later lane's fix flips a red test to green rather than landing unnoticed.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4491 wave-4 — vec identity at a monomorphic parameter", () => {
  // The propertyHelper shape, reduced: a THREE-parameter helper called ONCE
  // with the array under test, so call-site inference narrows `obj` to that
  // array's carrier. The key is loop-carried, not a syntactic literal, so no
  // compile-time fold can answer the read; the getter is counted so a pin that
  // "passed" without ever invoking it would still fail.
  //
  // Measured on the campaign base: `0` (the raw backing slot) with the getter
  // never called. Reverting the withdrawal in
  // `declarations/param-return-inference.ts` reproduces it.
  it("reads an array-index ACCESSOR through a narrowed parameter", async () => {
    expect(
      await runStandalone(`
        var calls = 0;
        var arr = [];
        function getFunc() { calls = calls + 1; return 3; }
        function readThrough(obj, name, unused) { return obj[name]; }
        Object.defineProperty(arr, "1", { get: getFunc, configurable: true });
        arr[1] = 4;
        var K = "";
        for (var i = 0; i < 1; i++) K = String(i + 1);
        var V = readThrough(arr, K, getFunc());
        export function main() {
          return (V === 3 && calls === 2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // The write half: a SETTER installed on an array index must run when the
  // element is assigned through the narrowed parameter, and its side effect
  // must be observable on the ORIGINAL array — which a copy could not deliver.
  it("runs an array-index SETTER through a narrowed parameter", async () => {
    expect(
      await runStandalone(`
        var seen = 0;
        var arr = [];
        function writeThrough(obj, name, value) { obj[name] = value; }
        Object.defineProperties(arr, {
          "0": {
            set: function (v) { seen = v; },
            get: function () { return seen; },
            enumerable: true
          }
        });
        arr[0] = 7;
        var K = "";
        for (var i = 0; i < 1; i++) K = String(i);
        writeThrough(arr, K, 101);
        export function main() {
          return (seen === 101 && arr[0] === 101) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

describe("#4491 wave-4 — Object.freeze reaches array/arguments ELEMENTS", () => {
  // Executes both destructive operations `propertyHelper.js` performs — the
  // write (`isWritable`) and the delete (`isConfigurable`) — plus the
  // descriptor read. Measured on the campaign base: the write LANDED, the
  // delete SUCCEEDED, and the descriptor said `{writable: true,
  // configurable: true}`, so this returned 0.
  //
  // The module is an ES module and therefore STRICT, so both refusals are
  // `TypeError`s rather than silent no-ops — the pin asserts BOTH throws AND
  // that the element survives unchanged, which is the stricter of the two spec
  // outcomes and exercises the refusal channel the fix publishes into.
  //
  // `drop` is load-bearing beyond its own assertion: the `delete obj[name]` in
  // it is what sets `vecIndexDeleteDirty`, and without a dirty flag the module
  // is not `overlayRouteActive` at all — the typed lane writes straight through
  // `array.set` and never reaches the guard. That is exactly why the real
  // failing rows include `propertyHelper.js` (which contains that delete), and
  // it is the honest scope of this fix: an array frozen in a module with NO
  // descriptor/delete/proto-index trigger anywhere still accepts the write.
  //
  // Presence is deliberately NOT asserted here: `Object.freeze(arr)` makes
  // `Object.prototype.hasOwnProperty.call(arr, "0")` answer FALSE, and that is
  // PRE-EXISTING — measured on the reverted `vec-overlay.ts` as well, where the
  // element also had no protection at all. It is pinned separately below.
  it("a frozen array element is neither writable nor deletable", async () => {
    expect(
      await runStandalone(`
        function poke(obj, name, value) { obj[name] = value; }
        function drop(obj, name) { return delete obj[name]; }
        export function main() {
          var arr = [7, 8, 9];
          Object.freeze(arr);
          var k = "";
          for (var i = 0; i < 1; i++) k = String(i);
          var wThrew = 0;
          try { poke(arr, k, 42); } catch (e) { wThrew = 1; }
          var afterWrite = arr[0];
          var dThrew = 0;
          try { drop(arr, k); } catch (e) { dThrew = 1; }
          var afterDelete = arr[0];
          var d = Object.getOwnPropertyDescriptor(arr, "0");
          return (wThrew === 1 && dThrew === 1 && afterWrite === 7 && afterDelete === 7 &&
                  d.writable === false && d.configurable === false &&
                  d.enumerable === true && d.value === 7) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // The mapped-arguments carrier takes the same path. Kept separate because it
  // is a different carrier brand, and only the array half was predicted.
  it("a frozen arguments-object index is neither writable nor deletable", async () => {
    expect(
      await runStandalone(`
        function poke(obj, name, value) { obj[name] = value; }
        export function main() {
          var argObj = (function () { return arguments; }(1, 2, 3));
          Object.freeze(argObj);
          var k = "";
          for (var i = 0; i < 1; i++) k = String(i);
          var threw = 0;
          try { poke(argObj, k, 99); } catch (e) { threw = 1; }
          var d = Object.getOwnPropertyDescriptor(argObj, "0");
          return (threw === 1 && argObj[0] === 1 && d.writable === false &&
                  d.configurable === false && d.value === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

describe("#4491 wave-4 — `var x = undefined` holds undefined, not 0", () => {
  // §6.2.5.6 accepts an UNDEFINED accessor half; only a non-callable
  // non-undefined value is a TypeError. The define is executed and the
  // surviving SETTER is then invoked, so the pin fails if the second define
  // either throws or discards the first one's setter.
  //
  // Two spellings are load-bearing, both taken from `15.2.3.6-4-21` itself:
  //
  //  - the bindings are MODULE-SCOPE. A FUNCTION-LOCAL `var g = undefined`
  //    still fails — measured, and NOT fixed here: widening the local slot
  //    alone does not close it (the enclosing literal's field type is decided
  //    separately), so shipping that half would have been a behaviour change
  //    on every `var x = undefined` local with no measured beneficiary. Listed
  //    under Residuals in the issue file.
  //  - the descriptor is passed as a VARIABLE (`desc`), not as an inline
  //    literal. An inline `{get: getter}` argument takes the static
  //    literal-shape define path, which still throws; the variable form is the
  //    dynamic `__obj_define_from_desc` path the test uses and the one the
  //    slot fix reaches. Same defect, two lowerings — worth knowing before
  //    writing the follow-up.
  it("accepts `{get: <var holding undefined>}` and keeps the existing setter", async () => {
    expect(
      await runStandalone(`
        var wrote = 0;
        var o = {};
        var setter = function (x) { wrote = x; };
        var getter = undefined;
        var desc = { get: getter };
        var threw = 0;
        Object.defineProperty(o, "foo", { set: setter });
        try {
          Object.defineProperty(o, "foo", desc);
        } catch (e) {
          threw = 1;
        }
        export function main() {
          o.foo = 5;
          var d = Object.getOwnPropertyDescriptor(o, "foo");
          return (threw === 0 && wrote === 5 && d.set === setter &&
                  d.get === undefined && d.configurable === false) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // The same slot defect on an ordinary binding: `Object.preventExtensions`
  // RETURNS its argument, and the i32 slot turned the object into `0`. The
  // returned reference is then used (a define on it must be refused) so the
  // pin cannot pass on identity alone.
  it("an `undefined`-initialized var can hold an object afterwards", async () => {
    expect(
      await runStandalone(`
        var o = {};
        var o2 = undefined;
        export function main() {
          o2 = Object.preventExtensions(o);
          var same = (o2 === o);
          var ext = Object.isExtensible(o2);
          var threw = 0;
          try {
            Object.defineProperty(o2, "fresh", { value: 1 });
          } catch (e) {
            threw = 1;
          }
          return (same === true && ext === false && threw === 1 &&
                  Object.prototype.hasOwnProperty.call(o, "fresh") === false) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

describe("#4491 wave-4 — Date's statics are own properties", () => {
  // Three independent observers of the same carrier — RUNTIME presence
  // (`Object.prototype.hasOwnProperty.call`, the exact spelling
  // `propertyHelper.js` uses and the one that answered `false`), the own-key
  // LIST (`gOPN(Date)` reported only `length, name, prototype`), and the
  // descriptor — and the descriptor's value must be a callable that is
  // IDENTITY-STABLE across two reads, because a seeded descriptor that minted
  // a fresh closure per query would answer `true` to every shape assertion and
  // still be wrong for any consumer that compares functions.
  //
  // Two things it deliberately does NOT do. `d.value === Date.now`: a
  // syntactic `Date.now` in a value position compiles to `__get_builtin`,
  // which standalone rejects — a compile error is not the failure this pin
  // exists to catch. And `d.value()`: `Date.now` needs the host clock, so
  // CALLING it traps under this harness's `hostBridge` default and would make
  // the pin an environment test rather than a descriptor test.
  it("Date.now is an own, writable, non-enumerable, configurable data property", async () => {
    expect(
      await runStandalone(`
        function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
        export function main() {
          var present = hasOwn(Date, "now");
          var names = Object.getOwnPropertyNames(Date);
          var found = false;
          for (var i = 0; i < names.length; i++) { if (names[i] === "now") { found = true; } }
          var d = Object.getOwnPropertyDescriptor(Date, "now");
          var d2 = Object.getOwnPropertyDescriptor(Date, "now");
          return (present === true && found === true &&
                  typeof d.value === "function" && d.value === d2.value &&
                  d.writable === true && d.enumerable === false &&
                  d.configurable === true) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

/**
 * Measured residuals — each reproduces on this branch. Owners in the comments;
 * the wave-4 census section of `plan/issues/4491-es5-defineproperty-mop-residual.md`
 * carries the full analysis.
 */
describe("#4491 wave-4 — measured residuals", () => {
  // Found while writing the frozen-element pin above, and PRE-EXISTING (it
  // reproduces with `vec-overlay.ts` reverted): `Object.freeze(arr)` flips
  // `Object.prototype.hasOwnProperty.call(arr, "0")` from true to FALSE, while
  // `Object.getOwnPropertyDescriptor(arr, "0")` keeps answering the full
  // descriptor. A descriptor that exists while `hasOwnProperty` says the
  // property does not is the #4010 overlay-vs-bag split, now reachable through
  // the integrity path too.
  it.fails("Object.freeze does not hide an array element from hasOwnProperty", async () => {
    expect(
      await runStandalone(`
        function drop(obj, name) { return delete obj[name]; }
        export function main() {
          var sink = [1, 2];
          var kk = "";
          for (var j = 0; j < 1; j++) kk = String(j);
          drop(sink, kk);
          var arr = [7, 8, 9];
          var before = Object.prototype.hasOwnProperty.call(arr, "0");
          Object.freeze(arr);
          var after = Object.prototype.hasOwnProperty.call(arr, "0");
          return (before === true && after === true) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // #4497. `__obj_index_of_key` still uses a signed sort key, so the upper
  // half of the legal u32 index domain stays out of the i32 element lane. The
  // descriptor sidecar retains the value and the logical length is updated
  // without allocating an unbackable backing array.
  // (`defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179`.)
  it("an array index at 2^32-2 bumps length to 2^32-1", async () => {
    expect(
      await runStandalone(`
        export function main() {
          var arr = [];
          Object.defineProperty(arr, 4294967294, { value: 100 });
          return (arr.length === 4294967295 && arr[4294967294] === 100) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // A data-only descriptor whose VALUE is kind-incompatible with the array's
  // carrier (a string into a `__vec_f64`) must remain authoritative on the
  // typed read path. The narrow fix widens only the affected binding's element
  // carrier; compatible numeric descriptors retain the dense representation.
  // (`defineProperties/15.2.3.7-6-a-183`.)
  it("a string value defined on a numeric array is read back", async () => {
    expect(
      await runStandalone(`
        var arr = [1, 2, 3];
        Object.defineProperty(arr, "length", { writable: false });
        Object.defineProperties(arr, { "1": { value: "abc" } });
        export function main() {
          return (arr[0] === 1 && arr[1] === "abc" && arr[2] === 3) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps a non-index numeric-looking property out of length", async () => {
    expect(
      await runStandalone(`
        export function main() {
          var arr = [];
          Object.defineProperties(arr, { "4294967295": { value: 100 } });
          return (arr.length === 0 && arr[4294967295] === 100) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps compatible data descriptors on the dense numeric carrier", async () => {
    expect(
      await runStandalone(`
        export function main() {
          var arr = [1, 2, 3];
          Object.defineProperties(arr, { "1": { value: 42 } });
          return (arr.length === 3 && arr[0] === 1 && arr[1] === 42 && arr[2] === 3) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // Defining a far index must preserve the intervening slots as holes rather
  // than growing the f64 backing with a non-hole default.
  // (`keys/15.2.3.14-5-13`.)
  it("a far-index define leaves the intervening slots as holes", async () => {
    expect(
      await runStandalone(`
        export function main() {
          var obj = [1, , 3, , 5];
          Object.defineProperty(obj, 5, { value: 7, enumerable: false, configurable: true });
          Object.defineProperty(obj, 10000, { value: "X", enumerable: true, configurable: true });
          var arr = Object.keys(obj);
          return (arr.length === 4 && arr[3] === "10000") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // A String object's index is answered by the String-exotic own-property arm
  // only for a receiver the compiler resolved statically; through a dynamic
  // receiver the read misses. (`freeze/15.2.3.9-2-a-12`,
  // `preventExtensions/15.2.3.10-3-5`.)
  it.fails("a String object's index reads through a dynamic receiver", async () => {
    expect(
      await runStandalone(`
        function readThrough(obj, name) { return obj[name]; }
        export function main() {
          var s = new String("abc");
          var k = "";
          for (var i = 0; i < 1; i++) k = String(i);
          var empty = new String();
          return (readThrough(s, k) === "a" &&
                  typeof readThrough(empty, k) === "undefined") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // §13.5.3: `typeof` of an unresolvable Reference is "undefined". A name the
  // TS DOM lib declares gets an ambient `valueDeclaration`, so the
  // undeclared-fold in `typeof-delete.ts` does not fire and the static type
  // fold answers "object" — then `document.createElement` null-derefs. Closing
  // it needs the standalone PROVIDED-globals set, which no single table holds
  // today (`structuredClone` has a hand-written arm for exactly this).
  // (`defineProperty/S15.2.3.6_A1`.)
  it('typeof a host-only global is "undefined" in standalone', async () => {
    expect(
      await runStandalone(`
        export function main() {
          if (typeof document !== "undefined" &&
              typeof document.createElement === "function") {
            document.createElement("form");
            return 0;
          }
          return 1;
        }
      `),
    ).toBe(1);
  });

  // §6.2.5.6 reads descriptor fields with HasProperty, and `__desc_has_own`
  // walks the prototype chain. An inherited accessor with no getter therefore
  // supplies an explicit `undefined` value to the target descriptor.
  // (`defineProperty/15.2.3.6-3-138`.)
  it("an INHERITED accessor `value` field is honored by ToPropertyDescriptor", async () => {
    expect(
      await runStandalone(`
        export function main() {
          var obj = { property: 120 };
          var proto = {};
          Object.defineProperty(proto, "value", { set: function () {} });
          var ConstructFun = function () {};
          ConstructFun.prototype = proto;
          var child = new ConstructFun();
          Object.defineProperty(obj, "property", child);
          return (Object.prototype.hasOwnProperty.call(obj, "property") &&
                  typeof obj.property === "undefined") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps an inline data descriptor's numeric value on the fast path", async () => {
    expect(
      await runStandalone(`
        export function main() {
          var obj = { property: 120 };
          Object.defineProperty(obj, "property", { value: 42 });
          return (typeof obj.property === "number" && obj.property === 42) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});

const TEST262_HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(TEST262_HARNESS);

describe.skipIf(!TEST262)("#4491 wave-4 — exact defineProperties residuals", () => {
  for (const rel of [
    "built-ins/Object/defineProperties/15.2.3.7-6-a-179.js",
    "built-ins/Object/defineProperties/15.2.3.7-6-a-183.js",
  ]) {
    it(`${rel} passes on the standalone lane`, { timeout: 60_000 }, async () => {
      const result = await runTest262File(
        join(__dirname, "..", "test262", "test", rel),
        "issue-4491-wave4",
        30_000,
        "standalone",
      );
      expect(`${result.status}: ${result.reason ?? ""}`).toBe("pass: ");
    });
  }
});
