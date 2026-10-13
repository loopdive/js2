// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6944 — an inherited lookup must walk THROUGH a prototype that is itself a
// function-constructor instance (`Derived.prototype = new Inheriter()`, the
// pre-ES6 inheritance idiom Octane deltablue uses). Host lane: the
// `_fnctorProtoLookup` walk resolves a struct ancestor's user [[Prototype]]
// (`_structUserProto`) instead of the native one (null). Standalone: the
// `__extern_get` / `__extern_has` walkers re-enter on a struct link, the
// per-key method caches no longer `ref.cast` it, and `isPrototypeOf` steps over
// it. Every expectation below is node's output for the same source.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

const PRELUDE = `
function Inheriter() { }
Inheriter.prototype.hello = function () { return "hello" + this.x; };
function Derived() { this.x = 2; }
Derived.prototype = new Inheriter();
`;

const CASES: Record<string, { src: string; expected: string }> = {
  // .tmp/db12.js: the method call itself
  methodCall: {
    src: `${PRELUDE}export function main() { var d = new Derived(); return d.hello(); }`,
    expected: "hello2",
  },
  // .tmp/db13.js: through a variable (passed before on standalone; must keep passing)
  viaVariable: {
    src: `function Inheriter() { }
Inheriter.prototype.hello = function () { return "hello" + this.x; };
function Derived() { this.x = 2; }
var p = new Inheriter();
Derived.prototype = p;
export function main() { var d = new Derived(); return d.hello() + "," + (Object.getPrototypeOf(d) === p); }`,
    expected: "hello2,true",
  },
  // .tmp/db15.js: read, call, computed key, dot call
  readForms: {
    src: `${PRELUDE}export function main() {
  var d = new Derived();
  var f = d.hello;
  var out = typeof f;
  try { out += "," + f.call(d); } catch (e) { out += ",call-threw"; }
  try { out += "," + d["hello"](); } catch (e) { out += ",elem-threw"; }
  try { out += "," + d.hello(); } catch (e) { out += ",dot-threw"; }
  return out;
}`,
    expected: "function,hello2,hello2,hello2",
  },
  // .tmp/db18.js: the struct link's identity is preserved
  identity: {
    src: `${PRELUDE}export function main() {
  var d = new Derived();
  var dp = Derived.prototype;
  return (typeof d.hello) + "," + (Object.getPrototypeOf(d) === dp) + "," + (typeof dp.hello) + "," +
    (Object.getPrototypeOf(dp) === Inheriter.prototype) + "," + (dp instanceof Inheriter) + "," + (typeof Inheriter.prototype.hello);
}`,
    expected: "function,true,function,true,true,function",
  },
  // .tmp/db25.js: `in`, computed keys (was an `illegal cast` trap on standalone)
  hasAndComputed: {
    src: `${PRELUDE}export function main() {
  var d = new Derived();
  var dp = Derived.prototype;
  var pd = Object.getPrototypeOf(d);
  var k = "hel" + "lo";
  return (typeof pd.hello) + "," + (typeof d[k]) + "," + ("hello" in d) + "," + ("hello" in dp) + "," + (typeof dp[k]) + "," + (pd === dp);
}`,
    expected: "function,function,true,true,function,true",
  },
  inOperator: {
    src: `${PRELUDE}export function main() { var d = new Derived(); return ("hello" in d) + "," + ("x" in d) + "," + ("nope" in d); }`,
    expected: "true,true,false",
  },
  // .tmp/db20.js: two levels, inherited method called inside the ctor
  twoLevelsInCtor: {
    src: `function Constraint(strength) { this.strength = strength; }
Constraint.prototype.addConstraint = function () { this.added = true; };
function UnaryConstraint(v, strength) {
  Constraint.call(this, strength);
  this.myOutput = v;
  this.addConstraint();
}
function Inheriter() { }
Inheriter.prototype = Constraint.prototype;
UnaryConstraint.prototype = new Inheriter();
export function main() { var s = new UnaryConstraint(1, 2); return s.added + "," + s.strength + "," + s.myOutput; }`,
    expected: "true,2,1",
  },
  // .tmp/db21.js: same, called after construction
  twoLevelsAfter: {
    src: `function Constraint(strength) { this.strength = strength; }
Constraint.prototype.addConstraint = function () { this.added = true; };
function UnaryConstraint(v, strength) {
  Constraint.call(this, strength);
  this.myOutput = v;
}
function Inheriter() { }
Inheriter.prototype = Constraint.prototype;
UnaryConstraint.prototype = new Inheriter();
export function main() { var s = new UnaryConstraint(1, 2); s.addConstraint(); return s.added + "," + s.strength + "," + s.myOutput; }`,
    expected: "true,2,1",
  },
  // Own fields of a struct ancestor are found, and an inherited accessor
  // receives the ORIGINAL receiver as `this` (§10.1.8.1 Receiver).
  structAncestorOwnFieldsAndReceiver: {
    src: `function Base() { this.name = "base"; }
Base.prototype.greet = function () { return "hi " + this.name + "/" + this.own; };
Object.defineProperty(Base.prototype, "who", { get: function () { return "who:" + this.own; } });
function Mid() { }
Mid.prototype = new Base();
function Leaf() { this.own = "leaf"; }
Leaf.prototype = new Mid();
export function main() {
  var l = new Leaf();
  return [l.greet(), l.name, l.who, ("name" in l), ("greet" in l), ("zzz" in l), typeof l.zzz, l instanceof Base].join(",");
}`,
    expected: "hi base/leaf,base,who:leaf,true,true,false,undefined,true",
  },
  // Negative controls: a link cycle (js2's per-name prototype storage makes
  // one here, node does not) and a null-prototype node both end in a miss.
  cycleAndNullProtoTerminate: {
    src: `function A() { }
function B() { }
var a = new A();
var b = new B();
A.prototype = b;
B.prototype = a;
export function main() {
  var x = new A();
  var nul = Object.create(null);
  function C() { }
  C.prototype = nul;
  var c = new C();
  return typeof x.missing + "," + ("missing" in x) + "," + typeof c.foo + "," + ("foo" in c);
}`,
    expected: "undefined,false,undefined,false",
  },
};

async function runLane(src: string, lane: "gc" | "standalone"): Promise<string> {
  const result = await compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return renderStandalone(instance, (instance.exports.main as () => unknown)());
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return String((instance.exports.main as () => unknown)());
}

/** A standalone module returns a native string; decode it with the module's own renderer. */
function renderStandalone(instance: WebAssembly.Instance, value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const prep = instance.exports.__exn_render_prepare as (v: unknown) => number;
  const chr = instance.exports.__exn_render_char as (i: number) => number;
  const len = prep(value);
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(chr(i));
  return out;
}

describe("#6944 prototype chain through a constructor-instance prototype", () => {
  for (const lane of ["gc", "standalone"] as const) {
    for (const [name, { src, expected }] of Object.entries(CASES)) {
      it(`${lane}: ${name}`, async () => {
        expect(await runLane(src, lane)).toBe(expected);
      });
    }
  }
});
