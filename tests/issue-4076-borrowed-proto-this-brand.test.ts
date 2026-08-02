// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4076 — `<Builtin>.prototype.<m>.call(<invalid this>, …)` answered a VALUE in
// standalone where the spec demands a TypeError.
//
// Root cause (measured, not inferred). In JS-host mode the borrowed call rides
// the `__proto_method_call` host import, and the JS engine runs
// `RequireObjectCoercible` / `IsCallable` for us. Standalone has no host, so
// `expressions/calls.ts` either synthesises a bare `undefined.<m>()` — which
// constant-folds an answer without running step 1 — or reaches its refuse-loud
// `reportError`. **The refuse-loud is not loud**: that diagnostic is not
// `sticky`, so `compileExpressionBody`'s null-result unwind
// (`rollbackSpeculative`) discards it and substitutes `pushDefaultValue`.
// `Object.prototype.valueOf.call(undefined)` therefore compiled clean, with ZERO
// imports, to `global.get $undefined; extern.convert_any; drop` — a placeholder
// standing in for a refusal that had already been erased.
//
// Same family as #4017: a static path that knows the answer degrades to a
// silent wrong answer once its vehicle is unavailable. The fix decides
// statically and throws statically.
//
// Every assertion below checks an OBSERVABLE VALUE returned from the compiled
// module: `2` means the module itself caught the throw and `e instanceof
// TypeError` was true INSIDE Wasm. "It compiles" is never asserted.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function run(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const r = await compile(src, { target, skipSemanticDiagnostics: true, allowJs: true, fileName: "t.js" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = (r.importObject ?? {}) as WebAssembly.Imports & {
    __setExports?: (e: Record<string, unknown>) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { test(): unknown }).test();
}

/** 1 = no throw, 2 = caught a TypeError (spec), 3 = caught something else. */
const guarded = (body: string) =>
  `export function test() { try { ${body} return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; } }`;

const NULLISH = ["undefined", "null", "void 0"] as const;

describe("#4076 Object.prototype borrowed call — ToObject(this) rejects a nullish receiver", () => {
  // §20.1.3.7 valueOf s1 · §20.1.3.5 toLocaleString (Invoke → GetV → ToObject) ·
  // §20.1.3.2 hasOwnProperty s2 · §20.1.3.4 propertyIsEnumerable s2.
  const CASES: [string, string][] = [
    ["valueOf", "Object.prototype.valueOf.call(R);"],
    ["toLocaleString", "Object.prototype.toLocaleString.call(R);"],
    ["hasOwnProperty", 'Object.prototype.hasOwnProperty.call(R, "foo");'],
    ["propertyIsEnumerable", 'Object.prototype.propertyIsEnumerable.call(R, "foo");'],
  ];
  for (const [name, tmpl] of CASES) {
    for (const recv of NULLISH) {
      it(`Object.prototype.${name}.call(${recv}) throws a catchable TypeError`, async () => {
        expect(await run(guarded(tmpl.replace("R", recv)), "standalone")).toBe(2);
      });
    }
  }
});

describe("#4076 Function.prototype borrowed call — IsCallable(func) rejects a non-callable receiver", () => {
  // §20.2.3.{1,2,3,5} all begin "Let func be the this value. If IsCallable(func)
  // is false, throw a TypeError exception."
  const CASES: [string, string][] = [
    ["toString", "Function.prototype.toString.call(R);"],
    ["call", "Function.prototype.call.call(R, {});"],
    ["apply", "Function.prototype.apply.call(R, {}, []);"],
    ["bind", "Function.prototype.bind.call(R, {});"],
  ];
  // Nullish, plus the SYNTACTICALLY non-callable literals. `{}`/`[]`/`/re/`/a
  // string/number/boolean can never carry [[Call]] — a syntax fact, so no type
  // inference is involved and it cannot be wrong under allowJs.
  const INVALID = [...NULLISH, "{}", "[]", "/re/", '"s"', "1", "true"] as const;
  for (const [name, tmpl] of CASES) {
    for (const recv of INVALID) {
      it(`Function.prototype.${name}.call(${recv}) throws a catchable TypeError`, async () => {
        expect(await run(guarded(tmpl.replace("R", recv)), "standalone")).toBe(2);
      });
    }
  }
});

describe("#4076 the gate must NOT fire — positive controls", () => {
  // Each of these is a spec-legal call. A gate that threw here would be trading
  // a missing throw for a manufactured one, which is strictly worse.
  const LEGAL: [string, string][] = [
    ["valueOf on a plain object", "Object.prototype.valueOf.call({});"],
    ["hasOwnProperty own key", 'Object.prototype.hasOwnProperty.call({a:1}, "a");'],
    // §20.1.3.6 steps 1-2: toString is the ONE Object.prototype method that
    // must NOT throw on a nullish this — it returns "[object Undefined]"/"[object Null]".
    ["toString.call(undefined)", "Object.prototype.toString.call(undefined);"],
    ["toString.call(null)", "Object.prototype.toString.call(null);"],
    // §20.1.3.3 step 1 ("If V is not an Object, return false") runs BEFORE
    // ToObject(this), so the receiver alone cannot decide this one.
    ["isPrototypeOf.call(undefined, {})", "Object.prototype.isPrototypeOf.call(undefined, {});"],
    ["Function.prototype.toString on a function", "Function.prototype.toString.call(function f(){});"],
    ["Function.prototype.call on a function", "Function.prototype.call.call(function f(){}, {});"],
    // #3254 already handles RequireObjectCoercible for the String family; the
    // gate must not shadow a legal string receiver.
    ["String.prototype.trim on a string", 'String.prototype.trim.call(" a ");'],
  ];
  for (const [name, body] of LEGAL) {
    it(`does not throw: ${name}`, async () => {
      expect(await run(guarded(body), "standalone")).toBe(1);
    });
  }

  it("declines on a user-shadowed `Object` binding (shadow safety)", async () => {
    // `builtinPrototypeReceiver` requires the base identifier's declared type to
    // be the lib `ObjectConstructor`. A local shadow retypes it, so the gate
    // must fall through and let the user's own method run.
    const src = guarded(
      "var Object = { prototype: { valueOf: function () { return 7; } } };\n" +
        "  Object.prototype.valueOf.call(undefined);",
    );
    expect(await run(src, "standalone")).toBe(1);
  });
});

describe("#4076 host lane is untouched", () => {
  // The gate is `noJsHost`-gated. In JS-host mode the host import already
  // produces a genuine TypeError, so behaviour there must be unchanged — this
  // asserts the OBSERVED host verdict, which is also 2 but by a different route.
  it("host mode still throws TypeError for Object.prototype.valueOf.call(undefined)", async () => {
    expect(await run(guarded("Object.prototype.valueOf.call(undefined);"), "gc")).toBe(2);
  });
  it("host mode still returns a value for Object.prototype.valueOf.call({})", async () => {
    expect(await run(guarded("Object.prototype.valueOf.call({});"), "gc")).toBe(1);
  });
});

describe("#4076 the emitted standalone module stays host-free", () => {
  // The whole point is a compile-away decision: the fix must not reintroduce a
  // host import to carry the throw (#2961 refuses any standalone import).
  it("emits zero imports for every gated shape", async () => {
    const shapes = [
      "Object.prototype.valueOf.call(undefined);",
      'Object.prototype.hasOwnProperty.call(null, "foo");',
      "Function.prototype.toString.call(undefined);",
      "Function.prototype.bind.call(true);",
    ];
    for (const body of shapes) {
      const r = await compile(guarded(body), {
        target: "standalone",
        skipSemanticDiagnostics: true,
        allowJs: true,
        fileName: "t.js",
      } as never);
      expect(r.success).toBe(true);
      expect(r.imports ?? []).toEqual([]);
    }
  });
});
