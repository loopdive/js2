// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4622) `delete arguments.length` — the crash-class defect behind #4620's
// family B.
//
// The `arguments` object is an opaque `$Vec` copy of the parameters, so the
// generic delete path routes through `__delete_property`, whose vec arm asks
// `__vec_gopd` for the descriptor. `__vec_gopd` answers with ARRAY rules, where
// `length` is `{configurable: false}` — right for `[1, 2]`, wrong for an
// arguments object, whose `length` is `{writable: true, enumerable: false,
// configurable: true}` in BOTH CreateMappedArgumentsObject and
// CreateUnmappedArgumentsObject (§10.4.4). The refusal surfaced as `false` in
// sloppy code and, via `emitStrictDeleteCheck`, a THROWN TypeError in strict
// code — the "compiler crash" #4620 recorded (a wasm exception whose JS-side
// `.message` is `undefined`, which is why it read as a compiler crash rather
// than a wrong answer).
//
// `__vec_gopd` is shared with real arrays, so the arguments-vs-array distinction
// lives in a WasmGC subtype brand. The syntactic delete arm still declines when
// the object can be reconfigured (`Object.defineProperty`, `Object.seal`, `with`,
// direct `eval`); the generic runtime path then consults the branded descriptor.
// That distinction matters for escaped and dynamic receivers: a fresh arguments
// object's `length` remains configurable, so those deletes must return `true`.
//
// Every case runs in a MODULE, so the code is STRICT — which is the half where
// the defect threw. The sloppy half (`false` instead of `true`) is covered by
// the test262 rows themselves; `language/arguments-object/S10.6_A5_T3` runs in
// both goals and flipped FAIL → PASS with this change.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262", "test");
const EXACT_ARGUMENTS_ROWS = [
  "language/arguments-object/10.6-6-2.js",
  "language/arguments-object/10.6-7-1.js",
] as const;
const TEST262 = existsSync(join(TEST262_ROOT, EXACT_ARGUMENTS_ROWS[0]));

async function runModule(src: string): Promise<number | string> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number | string }).test();
}

/**
 * Run `<body>` as the whole body of `f(a)`, called as `f(7)`, with the call
 * site wrapped so a thrown error becomes a code instead of an escaping wasm
 * exception: `9` = TypeError, `8` = any other throw.
 *
 * The wrapper is at the CALL site on purpose. An in-function `try`/`catch` also
 * catches, but it makes "did the delete throw" and "did the later read throw"
 * indistinguishable, which is exactly the confusion this issue started from.
 */
function fn(body: string): string {
  return `
    function f(a) {
${body}
    }
    var r;
    try { r = f(7); } catch (e) { r = (e instanceof TypeError) ? 9 : 8; }
    export function test() { return r; }`;
}

/** `1` when the delete succeeded, `2` when it was refused, `9` on TypeError. */
const deleteResult = (expr: string): string => fn(`      return (${expr}) ? 1 : 2;`);

describe.skipIf(!TEST262)("§10.6 exact arguments-object residual rows", () => {
  for (const file of EXACT_ARGUMENTS_ROWS) {
    it(`passes the literal Test262 row ${file}`, async () => {
      const result = await runTest262File(join(TEST262_ROOT, file), "language/arguments-object", 120_000, "standalone");
      expect(result.status, result.error ?? file).toBe("pass");
    }, 180_000);
  }
});

describe("#4622 delete arguments.length no longer throws", () => {
  it("evaluates to true instead of throwing a TypeError (§10.4.4: length is configurable)", async () => {
    expect(await runModule(deleteResult("delete arguments.length"))).toBe(1);
  });

  it("answers the same through a bracketed static key", async () => {
    expect(await runModule(deleteResult('delete arguments["length"]'))).toBe(1);
  });

  it("does not throw when the result is discarded (statement position)", async () => {
    expect(await runModule(fn(`      delete arguments.length;\n      return 42;`))).toBe(42);
  });

  it("applies to a nested function's OWN arguments object, not the outer one", async () => {
    expect(
      await runModule(
        fn(`      var g = function () { return (delete arguments.length) ? 1 : 2; };
      return g(1, 2);`),
      ),
    ).toBe(1);
  });

  it("leaves the indexed slots reachable — the vec itself is untouched", async () => {
    expect(await runModule(fn(`      delete arguments.length;\n      return arguments[0];`))).toBe(7);
  });
});

describe("#4622 dynamic descriptor paths preserve the real arguments semantics", () => {
  // Object.defineProperty / Object.seal can make `length` non-configurable. Each
  // passes `arguments` as a VALUE, which is the signal the guard keys on; the
  // generic `__delete_property` path then consults the descriptor and keeps the
  // strict refusal (a TypeError).
  it("declines after Object.defineProperty(arguments, 'length', {configurable:false})", async () => {
    expect(
      await runModule(
        fn(`      Object.defineProperty(arguments, "length", { configurable: false });
      return (delete arguments.length) ? 1 : 2;`),
      ),
    ).toBe(9);
  });

  it("declines after Object.seal(arguments)", async () => {
    expect(
      await runModule(
        fn(`      Object.seal(arguments);
      return (delete arguments.length) ? 1 : 2;`),
      ),
    ).toBe(9);
  });

  it("allows delete after the arguments object escapes into a variable", async () => {
    expect(
      await runModule(
        fn(`      var esc = arguments;
      return (delete arguments.length) ? 1 : 2;`),
      ),
    ).toBe(1);
  });

  it("allows delete through a dynamic key while length is configurable", async () => {
    expect(
      await runModule(
        fn(`      var k = "length";
      return (delete arguments[k]) ? 1 : 2;`),
      ),
    ).toBe(1);
  });
});

describe("#4622 neighbouring delete shapes are unchanged", () => {
  it("keeps `delete arr.length` refused — a real Array's length IS non-configurable", async () => {
    expect(
      await runModule(`
    var arr = [1, 2];
    var r;
    try { r = (delete arr.length) ? 1 : 2; } catch (e) { r = (e instanceof TypeError) ? 9 : 8; }
    export function test() { return r; }`),
    ).toBe(9);
  });

  it("keeps `delete arguments.callee` refused in strict code (unmapped ⇒ configurable:false)", async () => {
    expect(await runModule(deleteResult("delete arguments.callee"))).toBe(9);
  });

  it("keeps `delete arguments[0]` succeeding", async () => {
    expect(await runModule(deleteResult("delete arguments[0]"))).toBe(1);
  });

  it("keeps `delete arguments.<absent>` succeeding", async () => {
    expect(await runModule(deleteResult("delete arguments.zork"))).toBe(1);
  });
});

describe("#4622 arguments length write controls", () => {
  it("updates an escaped arguments object through the dynamic length path", async () => {
    expect(
      await runModule(
        fn(`      var alias = arguments;
      alias.length = 1;
      return alias.length;`),
      ),
    ).toBe(1);
  });

  it("does not apply the arguments override to a real array", async () => {
    expect(
      await runModule(`
    var arr = [1, 2];
    arr.length = 1;
    export function test() { return arr.length; }`),
    ).toBe(1);
  });
});

describe("#4622 remaining measured residual", () => {
  // The delete now REPORTS success, but the property SURVIVES: `arguments.length`
  // folds to the vec's length field and `hasOwnProperty` / `in` / the descriptor
  // all go through the shared vec helpers, none of which has anywhere to record
  // a deleted named key. Making the deletion observable is the descriptor
  // sidecar / [[ParameterMap]] work of #3251 (representation), not delete
  // lowering. Owner: #3251.
  it.fails("(#3251) a re-read of arguments.length still sees the pre-delete value", async () => {
    expect(await runModule(fn(`      delete arguments.length;\n      return arguments.length;`))).toBe(-1);
  });

  // The runtime brand now supplies the §10.4.4 default, while an existing
  // companion entry preserves an explicit configurable:false override.
  it("(#4620 family B) the fresh length descriptor reports configurable:true", async () => {
    expect(
      await runModule(
        fn(`      var d = Object.getOwnPropertyDescriptor(arguments, "length");
      return d.configurable ? 1 : 2;`),
      ),
    ).toBe(1);
  });

  // An ESCAPED arguments object (`var a = arguments; delete a.length`) uses the
  // generic runtime path. Its fresh length is configurable, so the delete
  // succeeds; the runtime brand makes this safe without widening the syntactic
  // fast path. Owner: #4620 family B.
  it("(#4620 family B) delete through an escaped alias succeeds", async () => {
    expect(
      await runModule(`
    function f() { return arguments; }
    var a = f(1, 2);
    var r;
    try { r = (delete a.length) ? 1 : 2; } catch (e) { r = (e instanceof TypeError) ? 9 : 8; }
    export function test() { return r; }`),
    ).toBe(1);
  });
});
