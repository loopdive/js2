// #6946 — standalone: reading an inherited default (`T.prototype.v = null`)
// before the instance writes `this.v` left every later read stuck on the
// prototype value. The #3673 per-key prototype-lookup cache in `__extern_get`
// checked that the OWNER prototype was unchanged but never that the RECEIVER
// had gained an own property since (§10.1.8.1 OrdinaryGet consults own storage
// first). Real JS source through the public `compile()` on gc and standalone,
// compared with node.
import { describe, expect, it } from "vitest";
import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { buildImports, compile, instantiateWasm } from "../src/index.ts";

type Lane = "gc" | "standalone";

function runNode(src: string): string {
  const main = new Function(`"use strict";\n${src.replace(/^export /gm, "")}\nreturn main;`)() as () => unknown;
  return String(main());
}

async function runLane(src: string, lane: Lane): Promise<string> {
  const result = await compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone", hostBridge: "always" } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const v = (instance.exports.main as () => unknown)();
    return v !== null && typeof v === "object" ? (tryNativeExnRender(instance, v) ?? "[wasm-object]") : String(v);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return String((instance.exports.main as () => unknown)());
}

const CASES: Record<string, string> = {
  // .tmp/sp19.js — inherited default read FIRST, then an own write via a method
  readBeforeOwnWrite: `function T() { }
T.prototype.v = null;
T.prototype.set = function (x) { this.v = x; };
export function main() {
  var t = new T();
  var before = t.v;
  t.set(5);
  return before + "," + t.v + "," + t.hasOwnProperty("v");
}`,
  // .tmp/sp20.js — reads through a method before/after
  readThroughMethod: `function T() { }
T.prototype.v = null;
T.prototype.set = function (x) { this.v = x; };
T.prototype.get = function () { return this.v; };
export function main() {
  var t = new T();
  var a = t.get();
  t.set(5);
  return a + "," + t.get() + "," + t.v + "," + t.hasOwnProperty("v");
}`,
  // .tmp/sp12.js — the splay `isEmpty` shape next to an own-field fnctor
  splayIsEmpty: `function T() { }
T.prototype.v = null;
T.prototype.set = function (x) { this.v = x; };
T.prototype.isEmpty = function () { return !this.v; };
function U() { this.v = null; }
U.prototype.set = function (x) { this.v = x; };
export function main() {
  var t = new T(); var e0 = t.isEmpty(); t.set(5);
  var u = new U(); u.set(7);
  return e0 + "," + t.v + "," + t.isEmpty() + "," + u.v;
}`,
  // control (.tmp/sp14.js): no prior read
  noPriorRead: `function T() { }
T.prototype.v = null;
T.prototype.set = function (x) { this.v = x; };
export function main() {
  var t = new T();
  t.set(5);
  var k = Object.keys(t);
  return t.v + "," + t.v + "," + t.hasOwnProperty("v") + "," + k.join("") + "," + (t.v === 5);
}`,
  // control: a SECOND instance without an own write still reads the default
  // after the cache was populated and the first instance shadowed it
  otherInstanceKeepsDefault: `function T() { }
T.prototype.v = 3;
function put(o, k, val) { o[k] = val; }
export function main() {
  var t = new T();
  var u = new T();
  var a = t.v + u.v;
  put(t, "v", 4);
  return a + "," + t.v + "," + u.v + "," + t.v + "," + u.v;
}`,
};

describe("#6946 own write shadows a previously-read prototype default", () => {
  for (const lane of ["gc", "standalone"] as const) {
    for (const [name, src] of Object.entries(CASES)) {
      it(`${lane}: ${name} matches node`, async () => {
        expect(await runLane(src, lane)).toBe(runNode(src));
      });
    }
  }

  // .tmp/sp11.js (the splay tree shape). Only the first four fields are this
  // issue; the fifth (`r.left === null` on a node whose `left` is inherited)
  // is a separate standalone gap — an own struct field minted for `left` by a
  // write elsewhere in the program reads `undefined` instead of falling to the
  // prototype — and is deliberately not asserted here.
  it("standalone: splay root_ shape — the tree grows after the first isEmpty() read", async () => {
    const src = `function SplayTree() {};
SplayTree.prototype.root_ = null;
SplayTree.prototype.isEmpty = function() { return !this.root_; };
SplayTree.prototype.insert = function(key, value) {
  if (this.isEmpty()) { this.root_ = new SplayTreeNode(key, value); return; }
  var node = new SplayTreeNode(key, value);
  if (key > this.root_.key) { node.left = this.root_; } else { node.right = this.root_; }
  this.root_ = node;
};
SplayTree.prototype.find = function(key) {
  if (this.isEmpty()) return null;
  return this.root_.key == key ? this.root_ : null;
};
function SplayTreeNode(key, value) { this.key = key; this.value = value; }
SplayTreeNode.prototype.left = null;
SplayTreeNode.prototype.right = null;
export function main() {
  var t = new SplayTree();
  var e0 = t.isEmpty();
  t.insert(0.5, "a");
  var n = t.find(0.5);
  var r = t.root_;
  return e0 + "," + t.isEmpty() + "," + (r ? r.key : "noroot") + "," + (n ? n.value : "null");
}`;
    expect(runNode(src)).toBe("true,false,0.5,a");
    expect(await runLane(src, "standalone")).toBe("true,false,0.5,a");
  });
});
