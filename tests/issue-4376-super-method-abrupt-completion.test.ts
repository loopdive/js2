// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent native controls for abrupt GetThisBinding completion before super-method lookup.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runProbe(body: string, expected: number): Promise<void> {
  const source = `var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const nodeResult = runInNewContext(source.replace("export function", "function") + "readResult();");
  expect(nodeResult, "independent Node source oracle").toBe(expected);
  const result = await compile(source, {
    target: "standalone",
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports ?? [], "compiler imports").toEqual([]);
  const module = await WebAssembly.compile(new Uint8Array(result.binary));
  expect(WebAssembly.Module.imports(module), "actual native imports").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { __module_init?: () => void; readResult: () => unknown };
  expect(exports.__module_init, "deferred initialization must execute").toBeTypeOf("function");
  exports.__module_init!();
  expect(exports.readResult()).toBe(expected);
}

describe("#4376 super-method abrupt completion", () => {
  it("isolated-missing-parent-method", async () => {
    await runProbe(
      `
class Base { constructor(a){} }
try { class C extends Base { constructor(){ super(super.method()); } } new C(); }
catch (e) { __r = (e instanceof ReferenceError) ? 16 : 0; }
    `,
      16,
    );
  });
  it("missing-method-error-identity", async () => {
    await runProbe(
      `
class Base { constructor(a){} }
var caught;
try { class C extends Base { constructor(){ super(super.method()); } } new C(); } catch(e) { caught = e; }
var alias = caught;
__r = (caught instanceof ReferenceError ? 1 : 0) + (caught.name === "ReferenceError" ? 2 : 0) + (typeof caught === "object" ? 4 : 0) + (caught === alias ? 8 : 0) + (caught !== new ReferenceError() ? 16 : 0);
    `,
      31,
    );
  });
  it("same-six-fifth-error-identity", async () => {
    await runProbe(
      `
var diagnostic = 0;

        class Base { constructor(a){} }
        var r = 0;
        try { class C extends Base { constructor(){ super(this.x); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 1 : 0; }
        try { class C extends Base { constructor(){ super(this); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 2 : 0; }
        try { class C extends Base { constructor(){ super(super()); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 4 : 0; }
        try { class C extends Base { constructor(){ super.method(); super(this); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 8 : 0; }
        try { class C extends Base { constructor(){ super(super.method()); } } new C(); diagnostic = 1024; } catch (e) { r += (e instanceof ReferenceError) ? 16 : 0; diagnostic = (e instanceof ReferenceError?1:0)+(e instanceof TypeError?2:0)+(e instanceof Error?4:0)+(typeof e === "object"?8:0)+(typeof e === "string"?16:0)+(e.name === "ReferenceError"?32:0); }
        try { class C extends Base { constructor(){ super(1, 2, Object.getPrototypeOf(this)); } } new C(); } catch (e) { r += (e instanceof ReferenceError) ? 32 : 0; }
        __r = diagnostic;
      
    `,
      45,
    );
  });
  it("get-this-binding-precedes-all-effects", async () => {
    await runProbe(
      `
var baseCalls = 0, argumentCalls = 0, getterCalls = 0;
class Base { constructor(){ baseCalls++; } get method(){ getterCalls++; return function(x){ return x; }; } }
function argument(){ argumentCalls++; return 3; }
try { class Before_super extends Base { constructor(){ super(super.method(argument())); } } new Before_super(); }
catch(e) { __r = (e instanceof ReferenceError ? 1 : 0); }
__r += (baseCalls === 0 ? 2 : 0) + (argumentCalls === 0 ? 4 : 0) + (getterCalls === 0 ? 8 : 0);
    `,
      15,
    );
  });
  it("healthy-resolved-method-once", async () => {
    await runProbe(
      `
var baseCalls = 0, methodCalls = 0, argumentCalls = 0;
class Base { constructor(){ baseCalls++; } method(x){ methodCalls++; return x + 4; } }
function argument(){ argumentCalls++; return 3; }
class After_super extends Base { constructor(){ super(); this.answer = super.method(argument()); } }
var value = new After_super();
__r = (value.answer === 7 ? 1 : 0) + (baseCalls === 1 ? 2 : 0) + (methodCalls === 1 ? 4 : 0) + (argumentCalls === 1 ? 8 : 0);
    `,
      15,
    );
  });
  it("computed-literal-missing-method", async () => {
    await runProbe(
      `
class Base { constructor(a){} }
try { class C extends Base { constructor(){ super(super["method"]()); } } new C(); }
catch(e) { __r = (e instanceof ReferenceError) ? 16 : 0; }
    `,
      16,
    );
  });
  it("anonymous-class-identity", async () => {
    await runProbe(
      `
class Base { constructor(a){} }
try { new (class extends Base { constructor(){ super(super.method()); } })(); }
catch(e) { __r = (e instanceof ReferenceError) ? 16 : 0; }
    `,
      16,
    );
  });
});
