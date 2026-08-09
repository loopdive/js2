// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4265) `"" + f` on a CALLABLE must not answer `"[object Object]"`.
 *
 * §13.15.3 ToPrimitive(f, string) reaches `Function.prototype.toString`
 * (§20.2.3.5), never `Object.prototype.toString`. The standalone concat cascade
 * had no callable arm, so a statically function-typed operand fell through to
 * `$__any_to_string`, whose terminal is the object tag.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runScript(body: string): Promise<void> {
  const src = `function CHK(c, m) { if (!c) { throw new Error("assertion failed: " + m); } }\n${body}\n`;
  const result = await compile(src, {
    allowJs: true,
    fileName: "es5-standalone-callable-tostring.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init: () => void }).__module_init();
}

/**
 * The one `NativeFunction` production this compiler emits — §20.2.3.5 step 3's
 * implementation-defined form, and the string
 * `test262/harness/nativeFunctionMatcher.js` accepts when the exact source text
 * is unavailable. Compared inline (never through a helper) so the LEFT operand
 * is statically string-typed and the comparison takes the content-compare route.
 */
const NATIVE_FN = `"function () { [native code] }"`;

describe("#4265 ToString of a callable (standalone)", () => {
  it("a function declaration does not stringify as [object Object]", async () => {
    // RED before the fix: "[object Object]".
    await runScript(`
      function plain(a, b) { return a; }
      var s = "" + plain;
      CHK(s !== "[object Object]", "function stringified as the object tag: " + s);
      CHK(s === ${NATIVE_FN}, "not NativeFunction syntax: " + s);
    `);
  });

  it("a class value does not stringify as [object Object]", async () => {
    // The object tag is accepted by neither arm of
    // `assertToStringOrNativeFunction`; the NativeFunction form is accepted by
    // the second.
    await runScript(`
      class A { m() { return 1; } }
      var s = "" + A;
      CHK(s !== "[object Object]", "class stringified as the object tag: " + s);
      CHK(s === ${NATIVE_FN}, "not NativeFunction syntax: " + s);
    `);
  });

  it("a class INSTANCE is untouched — it is not callable", async () => {
    // The negative case a naive "anything with a struct ref is a function" fix
    // would break: an instance has neither call nor construct signatures, so it
    // must keep its ordinary object/ToPrimitive stringification.
    await runScript(`
      class B { }
      var s = "" + new B();
      CHK(s === "[object Object]", "instance stringification changed: " + s);
    `);
  });

  it("a class with its own toString still wins over the callable arm", async () => {
    // OrdinaryToPrimitive must still find a user `toString` on an INSTANCE.
    await runScript(`
      class C { toString() { return "mine"; } }
      var s = "" + new C();
      CHK(s === "mine", "user toString was bypassed: " + s);
    `);
  });

  it("ordinary object and array stringification is unchanged", async () => {
    await runScript(`
      var o = { a: 1 };
      CHK(("" + o) === "[object Object]", "object tag changed: " + ("" + o));
      var arr = [1, 2];
      CHK(("" + arr) === "1,2", "array join changed: " + ("" + arr));
    `);
  });
});
