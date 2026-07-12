// (#3024) A class may declare a STATIC method literally named `constructor`
// (`static * constructor() {}` — legal ES, distinct from the instance
// constructor; the test262 `grammar-static-ctor-{gen,async-gen}-meth-valid`
// family). Reading it as a value — `C.constructor` — must box it like any
// other static method (closure struct → `extern.convert_any`).
//
// The `ClassName.constructor` property-access arm (property-access.ts) instead
// took a raw path: `ref.func <C_constructor>` + `extern.convert_any`. A funcref
// is NOT in the anyref hierarchy, so `extern.convert_any` on it is invalid Wasm,
// surfacing at the CONSUMER as `call[N] expected externref, found ref.func of
// type (ref M)` (the static generator constructor forwarded to an `any`-typed
// param such as `assert.notSameValue(C.prototype.constructor, C.constructor)`).
//
// Fix: skip the raw ctor-ref path when a static method owns the `constructor`
// name (`ctx.staticMethodSet`), letting the static-method closure arm box it.
//
// `WebAssembly.compile` is load-bearing: the regression was a *validation*
// failure.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileValid(source: string) {
  const r = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
}

describe("#3024 static method named `constructor` as a value", () => {
  it("static generator constructor forwarded to an any-typed param validates", async () => {
    await compileValid(`function sink(x: any): void {}
      class C { static * constructor() {} constructor() {} }
      export function test(): number { sink(C.constructor); return 1; }`);
  });

  it("static async-generator constructor as a value validates", async () => {
    await compileValid(`function sink(x: any): void {}
      class C { static async * constructor() {} constructor() {} }
      export function test(): number { sink(C.constructor); return 1; }`);
  });

  it("control: a plain class `C.constructor` value still validates", async () => {
    await compileValid(`function sink(x: any): void {}
      class C { constructor() {} }
      export function test(): number { sink(C.constructor); return 1; }`);
  });

  it("control: an ordinary static method value still validates", async () => {
    await compileValid(`function sink(x: any): void {}
      class C { static m() { return 1; } }
      export function test(): number { sink(C.m); return 1; }`);
  });
});
