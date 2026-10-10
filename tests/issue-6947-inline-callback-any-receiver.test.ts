// #6947 — an inline `function (node) {…}` passed to a prototype method through
// an `any` receiver (Octane splay's `this.root_.traverse_(function (node) {…})`)
// was host-wrapped (`__make_callback`), and the callee's JSDoc-typed callable
// parameter (`@param {function(SplayTree.Node)} f`) guard-cast the host
// function to the closure root, got null, and trapped `dereferencing a null
// pointer` on the gc lane. The trigger is the JSDoc type: an untyped `f` takes
// the generic dynamic call and was never affected. Real JS source through the
// public `compile()`, compared with node.
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
  try {
    if (lane === "standalone") {
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      const v = (instance.exports.main as () => unknown)();
      return v !== null && typeof v === "object" ? (tryNativeExnRender(instance, v) ?? "[wasm-object]") : String(v);
    }
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    return String((instance.exports.main as () => unknown)());
  } catch (e) {
    return `trap:${(e as Error).message}`;
  }
}

// A reduced `exportKeys` / `traverse_` pair (the splay shape; not the Octane source).
const TREE = (jsdoc: boolean, callSites: string) => `function N(k) { this.key = k; }
N.prototype.left = null;
N.prototype.right = null;
${jsdoc ? "/**\n * @param {function(N)} f Visitor function.\n */\n" : ""}N.prototype.traverse_ = function (f) {
  var current = this;
  while (current) {
    var left = current.left;
    if (left) left.traverse_(f);
    f(current);
    current = current.right;
  }
};
function Tree() { }
Tree.prototype.root_ = null;
Tree.prototype.exportKeys = function () {
  var result = [];
  if (this.root_) this.root_.traverse_(function (node) { result.push(node.key); });
  return result;
};
function id(x) { return x; }
export function main() {
  var n = new N(1);
  var c = 0;
  var out = "";
${callSites}
  var t = new Tree(); t.root_ = n; out += ",keys:" + t.exportKeys().join("+");
  return out;
}`;

const INLINE = `  id(n).traverse_(function (node) { c += 100; }); out += "inline:" + c;`;
const HELD = `  var cb = function (node) { c += 100; }; id(n).traverse_(cb); out += "held:" + c;`;

describe("#6947 inline callback to a method called through an any receiver", () => {
  it("gc: JSDoc-typed callee, inline callback (the splay trigger)", async () => {
    const src = TREE(true, INLINE);
    expect(runNode(src)).toBe("inline:100,keys:1");
    expect(await runLane(src, "gc")).toBe("inline:100,keys:1");
  });

  it("gc: JSDoc-typed callee, variable-held callback", async () => {
    const src = TREE(true, HELD);
    expect(await runLane(src, "gc")).toBe(runNode(src));
  });

  for (const lane of ["gc", "standalone"] as const) {
    it(`${lane}: untyped callee keeps working (control)`, async () => {
      const src = TREE(false, INLINE);
      expect(await runLane(src, lane)).toBe(runNode(src));
    });
  }

  it("gc: a host array HOF still receives a JS-callable inline callback", async () => {
    const src = `export function main() {
  var acc = [];
  var xs = [3, 1, 2];
  xs.forEach(function (x) { acc.push(x * 2); });
  var ys = xs.map(function (x) { return x + 1; });
  return acc.join("+") + "|" + ys.join("+");
}`;
    expect(await runLane(src, "gc")).toBe(runNode(src));
  });

  it("gc: an any-receiver host method keeps its callback callable", async () => {
    const src = `function id(x) { return x; }
export function main() {
  var arr = id([1, 2, 3]);
  var s = 0;
  arr.forEach(function (x) { s += x; });
  var found = arr.find(function (x) { return x > 1; });
  return s + "," + found;
}`;
    expect(await runLane(src, "gc")).toBe(runNode(src));
  });

  it("gc: a user method on an object literal through an any receiver", async () => {
    const src = `var obj = { each: function (f) { f(1); f(2); return "ok"; } };
function id(x) { return x; }
export function main() {
  var s = 0;
  var r = id(obj).each(function (v) { s += v; });
  return r + "," + s;
}`;
    expect(await runLane(src, "gc")).toBe(runNode(src));
  });
});
