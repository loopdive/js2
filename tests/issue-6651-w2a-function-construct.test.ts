/**
 * #6651 slice W2a — `new <%Function% value>()` in `--target standalone`.
 *
 * The realm `%Function%` reached as a VALUE (a realm-global member
 * `other.Function`, an alias `var F = Function`, `var OF = other.Function`)
 * must construct the same ordinary function the bare `new Function()` builds:
 * `typeof` "function", an own writable `prototype` object, and instances
 * whose [[Prototype]] is that object. Before W2a the member/alias spellings
 * failed to compile ("Unsupported new expression for class: Function") and
 * `new C()` on a `Function`-typed binding evaluated to null.
 *
 * The cases build the realm global the way the test262 runtime prelude does
 * (`{ Function: globalThis.Function }`, scripts/test262-fyi-runtime.js) and
 * run host-free. Each check sets one bit, so a failure names its check.
 * `src/codegen/closures/function-intrinsic-construct.ts` is the arm.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(src: string): Promise<{ value: unknown; imports: unknown[] }> {
  const r = (await compile(src, {
    fileName: "t.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { value: (instance.exports as { test: () => unknown }).test(), imports: r.imports ?? [] };
}

const REALM = `function mkRealm() { return { global: { Function: globalThis.Function, Object: globalThis.Object } }; }
var other = mkRealm().global;`;

describe("#6651 W2a · new <%Function% value>() (standalone)", () => {
  it("a realm-global member `new other.Function()` builds an ordinary function", async () => {
    const src = `${REALM}
export function test() {
  var r = 0;
  var C = new other.Function();
  if (typeof C === "function") r |= 1;
  if (typeof C.prototype === "object" && C.prototype !== null) r |= 2;
  if (C.prototype.constructor === C) r |= 4;
  var o = new C();
  if (Object.getPrototypeOf(o) === C.prototype) r |= 8;
  C.prototype = null;
  if (C.prototype === null) r |= 16;
  var D = new other.Function();
  if (D !== C && D.prototype !== null) r |= 32;
  return r;
}`;
    const { value, imports } = await run(src);
    expect(value).toBe(63);
    expect(imports).toEqual([]);
  });

  // (A bare `Function` read links the runtime-eval provider by design, #4442,
  // so the `var F = Function` alias is covered by the test262 probe lane in
  // the issue record rather than here.)
  it("aliases of the member (`var OF = other.Function`, `var F = OF`)", async () => {
    const src = `${REALM}
var OF = other.Function;
var F = OF;
export function test() {
  var r = 0;
  var a = new OF();
  if (typeof a === "function" && typeof a.prototype === "object") r |= 1;
  var b = new F();
  if (typeof b === "function" && typeof b.prototype === "object") r |= 2;
  if (Object.getPrototypeOf(new b()) === b.prototype) r |= 4;
  return r;
}`;
    expect((await run(src)).value).toBe(7);
  });

  it("constant arguments take the same compile-away as the bare spelling", async () => {
    const src = `${REALM}
export function test() {
  var add = new other.Function("a", "b", "return a + b;");
  return add(2, 5) === 7 && add.length === 2 ? 1 : 0;
}`;
    expect((await run(src)).value).toBe(1);
  });

  it("a non-%Function% value behind the same spelling keeps ordinary [[Construct]]", async () => {
    const src = `function K() { this.k = 3; }
var holder = { Function: K };
export function test() {
  var o = new holder.Function();
  return o.k === 3 && Object.getPrototypeOf(o) === K.prototype ? 1 : 0;
}`;
    expect((await run(src)).value).toBe(1);
  });

  it("bare \`new Function()\` results construct through a Function-typed binding", async () => {
    const src = `export function test() {
  var r = 0;
  var K = new Function();
  var k = new K();
  if (Object.getPrototypeOf(k) === K.prototype) r |= 1;
  if (k instanceof K) r |= 2;
  return r;
}`;
    expect((await run(src)).value).toBe(3);
  });
});
