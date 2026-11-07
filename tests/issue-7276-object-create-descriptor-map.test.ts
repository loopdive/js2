// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7276 — `Object.create({}, { <key>: { <literal data descriptor> } })` no
// longer refuses its unit as `expr-ident-not-in-scope(Object)` on the lane with
// the carrier's member read. The IR emits legacy's own construction:
// `__object_create` over a fresh `$Object`, then one `__obj_define_from_desc`
// per key. Any other proto, an accessor, a computed or non-literal flag, an
// index key, `__proto__`, a duplicate key and every source binding named
// `Object` keep the legacy call.
//
// Each case asserts the verdict on standalone, WASI and the default gc target
// against the sloppy JS evaluation of the same source (a source `Object`
// binding against the IR-off compile), and the route of the named units.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// WASI keeps the legacy call: its IR member read does not answer for an open `$Object`.
const LANES: { name: string; options: CompileOptions; irRoute: boolean }[] = [
  { name: "standalone", options: { target: "standalone" }, irRoute: true },
  { name: "wasi", options: { target: "wasi" }, irRoute: false },
  { name: "gc (default)", options: {}, irRoute: true },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7276.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // A script's body runs at instantiation (the start function); its verdict is what it throws.
  try {
    const instance =
      options.target === "standalone"
        ? (await WebAssembly.instantiate(result.binary, {})).instance
        : options.target === "wasi"
          ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
          : await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => unknown>;
    (exports.__module_init ?? exports._start)?.();
    return { result, value: "completed" };
  } catch {
    return { result, value: "threw" };
  }
}

function scriptVerdict(source: string): string {
  try {
    new Function(source)();
    return "completed";
  } catch {
    return "threw";
  }
}

function route(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

interface Case {
  readonly source: string;
  /** Units that take the IR body where the lane claims, and keep legacy's elsewhere. */
  readonly irUnits?: readonly string[];
  /** The lanes whose arm claims `irUnits`, when that is not this admission's lane set; others are unchecked. */
  readonly irRouteOn?: readonly string[];
  /** Units that must keep the legacy body on every lane. */
  readonly legacyUnits?: readonly string[];
  /**
   * Compared with the IR-off compile, not with JS: a source binding named
   * `Object`, a refused shape, or a read legacy itself answers differently
   * from JS (identical on main; not this admission's to fix).
   */
  readonly againstLegacy?: boolean;
  /** The lanes where legacy itself answers differently from JS (identical on main). */
  readonly againstLegacyOn?: readonly string[];
  /** The flag types are deliberately outside the lib's `PropertyDescriptor`. */
  readonly skipSemanticDiagnostics?: boolean;
}

// A string throw keeps the checks themselves on the IR path.
const CASES: Record<string, Case> = {
  "a value descriptor reads back, and an absent key is undefined": {
    source: `var o = Object.create({}, { prop: { value: 100 } });
if (o.prop !== 100) throw "value";
if (typeof o.missing !== "undefined") throw "missing";`,
    irUnits: ["<module-init>"],
  },
  "an empty descriptor defines an undefined own key": {
    source: `var o = Object.create({}, { prop: {} });
if (typeof o.prop !== "undefined") throw "empty";`,
    irUnits: ["<module-init>"],
  },
  "several keys with string-literal names and every flag": {
    source: `var o = Object.create({}, {
  a: { value: "s", writable: true, enumerable: true, configurable: true },
  "b c": { value: 2, writable: false, enumerable: false, configurable: false },
  toString: { value: 7 }
});
if (o.a !== "s") throw "a";
if (o["b c"] !== 2) throw "b c";
if (o.toString !== 7) throw "toString";`,
    irUnits: ["<module-init>"],
  },
  // A statement-position member call enters from-ast through the method-call path, not `lowerCall`.
  "a statement-position call": {
    source: `Object.create({}, { p: { value: 1 } });`,
    irUnits: ["<module-init>"],
  },
  // Writes, deletes and for-in on the result are their own arms: whatever route they take, the verdict holds.
  "non-writable in sloppy mode": {
    source: `var o = Object.create({}, { p: { value: 1 } });
o.p = 2;
if (o.p !== 1) throw "write";`,
  },
  "non-writable in strict mode": {
    source: `"use strict";
var o = Object.create({}, { p: { value: 1 } });
var threw = false;
try { o.p = 2; } catch (e) { threw = true; }
if (!threw) throw "strict";`,
  },
  "writable, ToBoolean of literal flags": {
    skipSemanticDiagnostics: true,
    source: `var o = Object.create({}, { p: { value: 1, writable: "false", enumerable: 0, configurable: "" } });
o.p = 9;
if (o.p !== 9) throw "writable";`,
  },
  "enumerable false hides the key from for-in": {
    source: `var o = Object.create({}, { a: { value: 1, enumerable: true }, b: { value: 2 }, c: { value: 3, enumerable: true } });
var keys = "";
for (var k in o) keys += k;
if (keys !== "ac") throw keys;`,
  },
  "configurable false survives delete": {
    source: `var o = Object.create({}, { p: { value: 1 } });
delete o.p;
if (o.p !== 1) throw "kept";
var q = Object.create({}, { p: { value: 1, configurable: true } });
delete q.p;
if (q.p !== undefined) throw "deleted";`,
  },
  // Known divergence, identical on main: legacy and the IR route both answer
  // `typeof o.hasOwnProperty` wrongly here (JS: "function").
  "known divergence: an inherited method read through the carrier": {
    againstLegacy: true,
    source: `var o = Object.create({}, { p: { value: 1 } });
if (typeof o.hasOwnProperty !== "function") throw "inherited";
if (!o.hasOwnProperty("p")) throw "own";`,
  },
  // An own-key `in` is the native probe's exact answer for an open `$Object`;
  // gc lowers `in` through its own (host) arm, which does not claim this unit.
  "in: own and absent keys": {
    irRouteOn: ["standalone"],
    source: `var o = Object.create({}, { p: { value: 1 } });
if (!("p" in o)) throw "own";
if ("q" in o) throw "absent";`,
    irUnits: ["<module-init>"],
  },
  // A unit whose `in` may name an inherited `%Object.prototype%` key keeps
  // legacy, whose fixed-name helper answers it (#7142 review); legacy WASI
  // answers it wrongly on main.
  "in: an Object.prototype key keeps the unit on legacy": {
    againstLegacyOn: ["wasi"],
    source: `var o = Object.create({}, { p: { value: 1 } });
if (!("toString" in o) || !("valueOf" in o) || !("hasOwnProperty" in o)) throw "inherited";`,
    legacyUnits: ["<module-init>"],
  },
  // Legacy itself misses the inherited key behind a computed `in` key (identical on main).
  "in: a computed key keeps the unit on legacy": {
    againstLegacy: true,
    source: `var o = Object.create({}, { p: { value: 1 } });
var k = "toString";
if (!(k in o)) throw "computed";`,
    legacyUnits: ["<module-init>"],
  },
  // Shapes the admission refuses keep the legacy call.
  "an accessor descriptor": {
    source: `var o = Object.create({}, { p: { get: function () { return 2; } } });
if (o.p !== 2) throw "get";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "value and get together throw a TypeError": {
    source: `var threw = false;
try { Object.create({}, { p: { value: 1, get: function () { return 2; } } }); } catch (e) { threw = e instanceof TypeError; }
if (!threw) throw "TypeError";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "a null proto": {
    source: `var o = Object.create(null, { p: { value: 1 } });
if (o.p !== 1) throw "null";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "a non-empty proto": {
    source: `var o = Object.create({ q: 2 }, { p: { value: 1 } });
if (o.q !== 2) throw "proto";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "a duplicate key": {
    source: `var o = Object.create({}, { p: { value: 1 }, p: { value: 2 } });
if (o.p !== 2) throw "last wins";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "an index key": {
    source: `var o = Object.create({}, { b: { value: 1, enumerable: true }, 1: { value: 2, enumerable: true } });
var keys = "";
for (var k in o) keys += k;
if (keys !== "1b") throw keys;`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "a __proto__ key": {
    source: `var o = Object.create({}, { __proto__: { p: { value: 1 } } });
if (o.p !== 1) throw "inherited map";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  "a non-literal flag": {
    source: `var flag = true;
var o = Object.create({}, { p: { value: 1, enumerable: flag } });
if (o.p !== 1) throw "flag";`,
    legacyUnits: ["<module-init>"],
    againstLegacy: true,
  },
  // Every source binding of the name keeps its own call.
  "a script function Object": {
    againstLegacy: true,
    source: `function Object() {}
Object.create = function () { return 7; };
if (Object.create({}, { p: { value: 1 } }) !== 7) throw 0;`,
  },
  "a script var Object": {
    againstLegacy: true,
    source: `var Object = { create: function () { return 7; } };
if (Object.create({}, { p: { value: 1 } }) !== 7) throw 0;`,
  },
  "an inner-scope Object": {
    againstLegacy: true,
    source: `function f() { var Object = { create: function () { return 7; } }; return Object.create({}, { p: { value: 1 } }); }
if (f() !== 7) throw 0;`,
  },
};

// The #7142 review's receivers: an `in` with an Object.prototype key over a
// null-prototype receiver that is not an open `$Object` must keep main's answer
// (the IR's native `in` is unchanged by this PR). `c` (a plain struct literal)
// answers false on main's standalone and WASI IR route, a pre-existing gap
// tracked separately, so only the null-prototype receivers are asserted.
const REVIEW_SOURCE = `function h(p) { return "toString" in p; }
function G() { this.x = 1; }
G.prototype = Object.create(null);
export function a() { var q = (function () { var q = { x: 1 }; Object.setPrototypeOf(q, null); return q; })(); return h(q) ? 1 : 0; }
export function b() { return h(new G()) ? 1 : 0; }
export function d() { return h(Object.create(null)) ? 1 : 0; }`;

describe("#7276 review: `in` over null-prototype receivers is unchanged", () => {
  for (const lane of LANES.filter((l) => l.name !== "gc (default)")) {
    it(lane.name, async () => {
      const result = await compile(REVIEW_SOURCE, { fileName: "issue-7276-review.js", ...lane.options });
      expect(result.success).toBe(true);
      const imports = lane.options.target === "wasi" ? { wasi_snapshot_preview1: wasiStub } : {};
      const { exports } = (await WebAssembly.instantiate(result.binary, imports)).instance as unknown as {
        exports: Record<string, () => number>;
      };
      expect([exports.a!(), exports.b!(), exports.d!()]).toEqual([0, 0, 0]);
    });
  }
});

/** The verdict of the same source with the IR overlay off: the legacy call a shadow must keep. */
async function legacyVerdict(source: string, options: CompileOptions): Promise<unknown> {
  return (await compileAndRun(source, { ...options, experimentalIR: false })).value;
}

describe("#7276 Object.create with a literal descriptor map on the IR path", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const options = testCase.skipSemanticDiagnostics
          ? { ...lane.options, skipSemanticDiagnostics: true }
          : lane.options;
        const expected =
          testCase.againstLegacy || testCase.againstLegacyOn?.includes(lane.name)
            ? await legacyVerdict(testCase.source, options)
            : scriptVerdict(testCase.source);
        const { result, value } = await compileAndRun(testCase.source, options);
        expect(value).toBe(expected);
        const irRoute = testCase.irRouteOn ? testCase.irRouteOn.includes(lane.name) : lane.irRoute;
        if (!testCase.irRouteOn || irRoute) {
          for (const unit of testCase.irUnits ?? []) expect(route(result, unit), unit).toBe(irRoute);
        }
        for (const unit of testCase.legacyUnits ?? []) expect(route(result, unit), unit).toBe(false);
      });
    }
  }
});
