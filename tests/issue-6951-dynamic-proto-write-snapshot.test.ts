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

async function runStandalone(src: string, opts: { sloppy?: boolean } = {}): Promise<string> {
  const result = await compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    // A source with `export` is module code (always strict) unless the caller
    // says otherwise; the sloppy controls need the script-goal strictness that
    // node's `new Function` runs them under.
    ...(opts.sloppy ? { inferModuleStrictArguments: false } : {}),
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

// Review finding (PR #6644, P1): the edge write stored the canonical per-fnctor
// prototype global BEFORE the own `prototype` descriptor was consulted, so a
// `writable: false` prototype was silently replaced and `new F()` observed it
// (head answered 20 for both of these). The descriptor now decides first.
const PROTO_WRITE_ARGS = `function F(){this.x=1;}
function set(c,p){c.prototype=p;}`;
const NON_WRITABLE_BODY = `export function main(){
 F.prototype={tag:1};
 Object.defineProperty(F,"prototype",{writable:false});
 var caught=0;
 try{set(F,{tag:2});}catch(e){caught=e instanceof TypeError?1:2;}
 var a=new F();
 return caught*100+a.tag*10;
}`;
const DESCRIPTOR_CASES: { name: string; src: string; sloppy: boolean; expected: string }[] = [
  // strict: TypeError, and the constructor keeps the old prototype.
  {
    name: "strictNonWritableThrows",
    src: `"use strict";\n${PROTO_WRITE_ARGS}\n${NON_WRITABLE_BODY}`,
    sloppy: false,
    expected: "110",
  },
  // sloppy: silent no-op, no throw, the old prototype stays.
  { name: "sloppyNonWritableNoop", src: `${PROTO_WRITE_ARGS}\n${NON_WRITABLE_BODY}`, sloppy: true, expected: "10" },
  // The four ordinary writes keep working, strict and sloppy.
  {
    name: "dynamicWrite",
    src: `${PROTO_WRITE_ARGS}
export function main(){ F.prototype={tag:1}; set(F,{tag:2}); var a=new F(); return a.tag*10+a.x; }`,
    sloppy: false,
    expected: "21",
  },
  {
    name: "dynamicWriteSloppy",
    src: `${PROTO_WRITE_ARGS}
export function main(){ F.prototype={tag:1}; set(F,{tag:2}); var a=new F(); return a.tag*10+a.x; }`,
    sloppy: true,
    expected: "21",
  },
  {
    name: "snapshot",
    src: `${PROTO_WRITE_ARGS}
export function main(){ F.prototype={tag:1}; var a=new F(); set(F,{tag:2}); var b=new F(); return a.tag*10+b.tag; }`,
    sloppy: false,
    expected: "12",
  },
  {
    name: "setPrototypeOf",
    src: `${PROTO_WRITE_ARGS}
export function main(){ F.prototype={tag:1}; set(F,{tag:2}); var a=new F(); Object.setPrototypeOf(a,{tag:3}); return a.tag*10+a.x; }`,
    sloppy: false,
    expected: "31",
  },
  {
    name: "nullPrototype",
    src: `${PROTO_WRITE_ARGS}
export function main(){ F.prototype={tag:1}; set(F,null); var a=new F();
 return (a.tag===undefined?10:0)+a.x+(typeof a.hasOwnProperty==="function"?100:0); }`,
    sloppy: false,
    expected: "111",
  },
];

describe("#6951 standalone dynamic prototype write and construction-time snapshot", () => {
  for (const { name, src, sloppy, expected } of DESCRIPTOR_CASES) {
    it(`descriptor ${name} answers ${expected}`, async () => {
      expect(runNode(src)).toBe(expected);
      expect(await runStandalone(src, { sloppy })).toBe(expected);
    });
  }
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
