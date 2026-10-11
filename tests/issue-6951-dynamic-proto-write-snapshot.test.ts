// #6951 — standalone: (G2) a DYNAMIC `ctor.prototype = v` write landed in the
// closure's own-property bag, which `new ctor()` never reads; (G3) an
// instance's `[[Prototype]]` was resolved LIVE through the per-fnctor global,
// so reassigning `F.prototype` re-linked every instance already constructed
// (§10.1.14 GetPrototypeFromConstructor reads it once, at `new`). Octane
// deltablue's `inheritsFrom` needs both. Real JS through the public
// `compile()` on standalone, compared with node.
import { describe, expect, it } from "vitest";
import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { compile } from "../src/index.ts";

function runNode(src: string): string {
  const main = new Function(`${src.replace(/^export /gm, "")}\nreturn main;`)() as () => unknown;
  return String(main());
}

async function runStandalone(src: string): Promise<string> {
  const result = await compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const v = (instance.exports.main as () => unknown)();
    return v !== null && typeof v === "object" ? (tryNativeExnRender(instance, v) ?? "[wasm-object]") : String(v);
  } catch (e) {
    return `threw: ${String((e as Error)?.message ?? e)}`;
  }
}

const CASES: Record<string, string> = {
  // G2: the write reaches the constructor through a parameter.
  dynamicWriteThroughParam: `function setp(ctor, p) { ctor.prototype = p; }
function D() { this.own = 1; }
export function main() {
  var proto = Object.create(Object.prototype); proto.t = 7;
  setp(D, proto);
  var d = new D();
  return (D.prototype === proto) + "," + d.t + "," + (Object.getPrototypeOf(d) === proto);
}`,
  // G2: element-key spelling, method inherited through the new prototype.
  dynamicElementWrite: `function D() { this.n = 3; }
function install(c, k) { var p = Object.create(Object.prototype); p.twice = function () { return this.n * 2; }; c[k] = p; }
export function main() { install(D, "prototype"); var d = new D(); return d.twice() + "," + (D.prototype.twice === d.twice); }`,
  // G3: reassigning F.prototype does not re-link an existing instance.
  snapshotAtConstruction: `function F() { this.own = 1; }
export function main() {
  F.prototype = { tag: "A" };
  var a = new F();
  F.prototype = { tag: "B" };
  var b = new F();
  return a.tag + "," + b.tag + "," + (Object.getPrototypeOf(a) === Object.getPrototypeOf(b));
}`,
  // G3: deltablue's nested Inheriter, one prototype per activation.
  nestedInheriterPerActivation: `function mk(p) {
  function Inheriter() { }
  Inheriter.prototype = p;
  return new Inheriter();
}
export function main() {
  var a = mk({ tag: "A" });
  var b = mk({ tag: "B" });
  return a.tag + "," + b.tag + "," + (Object.getPrototypeOf(a) === Object.getPrototypeOf(b));
}`,
  nestedInheriterIdentity: `function mk(p) {
  function Inheriter() { }
  Inheriter.prototype = p;
  return new Inheriter();
}
function obj(t) { var o = Object.create(Object.prototype); o.tag = t; return o; }
export function main() {
  var pa = obj("A"), pb = obj("B");
  var a = mk(pa), b = mk(pb);
  return a.tag + "," + b.tag + "," + (Object.getPrototypeOf(a) === pa) + "," + (Object.getPrototypeOf(b) === pb);
}`,
  // G3 + the per-key method cache: the same method name resolves through two
  // different snapshots; a cache keyed on the live global would answer B for a.
  methodCacheFollowsSnapshot: `function F() { this.k = 1; }
function make(tag) { var p = Object.create(Object.prototype); p.who = function () { return tag + this.k; }; return p; }
function call(x) { return x.who(); }
export function main() {
  F.prototype = make("A");
  var a = new F();
  F.prototype = make("B");
  var b = new F();
  return call(a) + "," + call(b) + "," + call(a) + "," + call(b);
}`,
};

const CONTROLS: Record<string, string> = {
  // Mutating the SAME prototype object stays visible to existing instances.
  mutationAfterConstruction: `function F() { }
export function main() { var a = new F(); F.prototype.x = 5; return a.x + "," + (Object.getPrototypeOf(a) === F.prototype); }`,
  // Static whole-reassign before any construction: unchanged path.
  staticAssignBeforeNew: `function F() { this.v = 2; }
F.prototype = { k: 4, get: function () { return 9; } };
export function main() { var f = new F(); return f.k + "," + f.get() + "," + (Object.getPrototypeOf(f) === F.prototype); }`,
  // A member-held closure has no prototype edge: the bag write stays the
  // answer and the dynamic construct reads it.
  memberHeldClosureBag: `var X = Object.create(Object.prototype); X.init = function () { return 5; };
function create() { return function () { this.y = 1; }; }
var P = create();
P.prototype = X;
export function main() {
  var p = new P();
  var k = "prototype";
  return (Object.getPrototypeOf(p) === X ? 1 : 0) + (P[k] === X ? 10 : 0);
}`,
  // The vivified prototype keeps its identity and constructor back-ref.
  vivifiedIdentity: `function F() { }
export function main() { var a = new F(); var b = new F(); return (Object.getPrototypeOf(a) === F.prototype) + "," + (Object.getPrototypeOf(a) === Object.getPrototypeOf(b)) + "," + (a.constructor === F); }`,
};

describe("#6951 standalone dynamic prototype write and construction-time snapshot", () => {
  for (const [name, src] of Object.entries(CASES)) {
    it(`case ${name} matches node`, async () => {
      expect(await runStandalone(src)).toBe(runNode(src));
    });
  }
  for (const [name, src] of Object.entries(CONTROLS)) {
    it(`control ${name} matches node`, async () => {
      expect(await runStandalone(src)).toBe(runNode(src));
    });
  }
});
