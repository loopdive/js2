// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — `Reflect.construct(target, args, newTarget)` must distinguish an
 * OMITTED newTarget from an explicit `null` one.
 *
 * §26.1.2 treats them oppositely:
 *   step 2 — newTarget not present ⇒ let newTarget be target
 *   step 3 — else, if IsConstructor(newTarget) is false ⇒ throw a TypeError
 *
 * The wasm import boundary is fixed-arity and pads an omitted third argument
 * with a null externref, so the runtime shim could not tell the two apart and
 * collapsed both to the 2-argument form — meaning
 * `Reflect.construct(fn, [], null)` quietly CONSTRUCTED instead of throwing.
 * Presence is therefore encoded in the import NAME
 * (`__reflect_construct_newtarget`), because arity is a compile-time fact and
 * the boundary cannot carry it any other way.
 *
 * This was invisible until the #4394 callback-bridge change made an ordinary
 * compiled function constructible: before that, the TARGET of
 * `built-ins/Reflect/construct/newtarget-is-not-constructor-throws.js` was
 * itself un-constructible, so the call threw at step 1 and the test passed for
 * the wrong reason and never reached step 3.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<string[]> {
  const result = await compile(source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as any;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports);
    const exports = instance.exports as Record<string, unknown>;
    if (typeof exports.__module_init === "function") (exports.__module_init as () => void)();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

describe("#4394 — Reflect.construct newTarget presence", () => {
  it("throws for a PRESENT non-constructor newTarget (§26.1.2 step 3)", async () => {
    // The exact assertions of
    // built-ins/Reflect/construct/newtarget-is-not-constructor-throws.js.
    const logged = await runJs(`
function threw(f) { try { f(); return "no"; } catch (e) { return e instanceof TypeError ? "TypeError" : "other"; } }
console.log("number: " + threw(function () { Reflect.construct(function () {}, [], 1); }));
console.log("null: " + threw(function () { Reflect.construct(function () {}, [], null); }));
console.log("object: " + threw(function () { Reflect.construct(function () {}, [], {}); }));
console.log("method: " + threw(function () { Reflect.construct(function () {}, [], Date.now); }));
`);
    expect(logged).toContain("number: TypeError");
    // `null` is the case the collapse silently swallowed.
    expect(logged).toContain("null: TypeError");
    expect(logged).toContain("object: TypeError");
    expect(logged).toContain("method: TypeError");
  });

  it("still constructs when newTarget is OMITTED (§26.1.2 step 2)", async () => {
    // Inline function EXPRESSIONS on purpose. A named top-level declaration
    // referenced as a value still arrives as a raw WasmGC closure struct
    // ("[object Object] is not a constructor") — that is the separate
    // closure-as-an-ARGUMENT gap recorded in plan/issues/4394, not this fix.
    const logged = await runJs(`
var o = Reflect.construct(function () { this.tag = "pt"; }, []);
console.log("built: " + (typeof o === "object"));
`);
    expect(logged).toContain("built: true");
  });

  it("honours a PRESENT constructor newTarget", async () => {
    const logged = await runJs(`
var built = "no";
try { Reflect.construct(function () {}, [], function () {}); built = "yes"; } catch (e) { built = "threw"; }
console.log("built: " + built);
`);
    // A present, genuinely-constructible newTarget must NOT be rejected — the
    // presence encoding must not turn every 3-argument call into a throw.
    expect(logged).toContain("built: yes");
  });
});
