// #6949 — standalone: a function constructor the escape gate did NOT approve
// (`keep-static` / `keep-typed`) got no prototype object, so its top-level
// `F.prototype.m = …` statements were dropped at module init and an instance
// reaching a dynamic `inst.m()` threw `called value is not a function`
// (Octane richards `packet.addTo`, crypto `rng_state.init`). Real JS source
// through the public `compile()` on standalone, compared with node.
import { describe, expect, it } from "vitest";
import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { compile } from "../src/index.ts";

function runNode(src: string): string {
  const main = new Function(`"use strict";\n${src.replace(/^export /gm, "")}\nreturn main;`)() as () => unknown;
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

// Shapes the escape gate classifies `keep-static`: the instance escapes through
// a JSDoc-typed parameter into a field, and the method is only reached later
// through an untyped (`any`) receiver.
const CASES: Record<string, string> = {
  heldThroughField: `function Packet(id) { this.id = id; }
Packet.prototype.get = function () { return this.id; };
function Holder() { this.q = null; }
/** @param {Packet} q */
Holder.prototype.put = function (q) { this.q = q; };
Holder.prototype.use = function () { var p = this.q; return call(p); };
function call(x) { return x.get(); }
export function main() { var h = new Holder(); h.put(new Packet(7)); return h.use(); }`,
  // crypto's `Arcfour.prototype.init = ARC4init` (function-declaration methods).
  declMethodsHeldInField: `function Arcfour() { this.i = 0; this.j = 0; }
function ARC4init(key) { this.i = key.length; this.j = 7; }
function ARC4next() { this.i = this.i + 1; return this.i + this.j; }
Arcfour.prototype.init = ARC4init;
Arcfour.prototype.next = ARC4next;
function Holder() { this.s = null; }
/** @param {Arcfour} s */
Holder.prototype.put = function (s) { this.s = s; };
function use(x, pool) { x.init(pool); return x.next() + "," + x.next(); }
export function main() { var h = new Holder(); h.put(new Arcfour()); return use(h.s, [1, 2, 3]); }`,
  // The prototype method mutates the instance and returns it; the result is
  // read back through the same dynamic path (richards' `addTo` chain shape).
  chainedThroughField: `function Node(v) { this.v = v; this.next = null; }
Node.prototype.link = function (n) { this.next = n; return this; };
Node.prototype.sum = function () { var s = 0; var p = this; while (p != null) { s = s + p.v; p = p.next; } return s; };
function Box() { this.n = null; }
/** @param {Node} n */
Box.prototype.set = function (n) { this.n = n; };
function total(x) { return x.link(new Node(5)).sum(); }
export function main() { var b = new Box(); b.set(new Node(2)); return total(b.n); }`,
};

const CONTROLS: Record<string, string> = {
  // Inline `new` binding: approved before and after.
  approvedInline: `function Arcfour() { this.i = 0; this.j = 0; }
function ARC4init(key) { this.i = key.length; this.j = 7; }
function ARC4next() { this.i = this.i + 1; return this.i + this.j; }
Arcfour.prototype.init = ARC4init;
Arcfour.prototype.next = ARC4next;
var rng_state;
var rng_pool = [1, 2, 3];
function rng_get_byte() {
  if (rng_state == null) { rng_state = new Arcfour(); rng_state.init(rng_pool); }
  return rng_state.next();
}
export function main() { return rng_get_byte() + "," + rng_get_byte(); }`,
  // A never-constructed function keeps a stable `.prototype` identity.
  neverConstructedIdentity: `function Ctor() {}
Ctor.prototype.tag = "t";
export function main() {
  var p = Ctor.prototype;
  return (p === Ctor.prototype) + "," + Ctor.prototype.tag;
}`,
  // A generator function is not an ordinary fnctor: no auto-minted prototype.
  generatorPrototype: `function* g() { yield 1; }
export function main() {
  var it = g();
  return it.next().value + "," + (Object.getPrototypeOf(it) === g.prototype);
}`,
  // Test262Error-like error constructor (thrown, so not approved) whose
  // prototype `toString` now executes at module init.
  errorCtorToString: `function MyErr(message) { this.message = message || ""; }
MyErr.prototype.toString = function () { return "MyErr: " + this.message; };
function f() { throw new MyErr("boom"); }
export function main() {
  try { f(); } catch (e) { return String(e) + "," + (e instanceof MyErr) + "," + (e.constructor === MyErr); }
  return "none";
}`,
};

describe("#6949 standalone prototype materialization for non-approved fnctors", () => {
  for (const [name, src] of Object.entries({ ...CASES, ...CONTROLS })) {
    it(`${name} matches node`, async () => {
      expect(await runStandalone(src)).toBe(runNode(src));
    });
  }
});
