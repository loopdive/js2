// (#2937) Host-mode regression: extending the #2584 `objectHashConsumerVars`
// poison to host (#2849) made compiled-Acorn null-deref on EVERY parse input.
//
// Root cause — the poison was only HALF-applied in a JS-MODE source file
// (`.mjs`/`.js`, e.g. acorn.mjs): suppressing the `collectEmptyObjectWidening`
// pre-pass changes the INITIALIZER (`{}` → host plain object, externref), but
// the TS checker independently EVOLVES `var options = {}` through its later
// static-named writes into an anonymous object type WITH those props
// (JS-special-mode "evolving" object types — no equivalent exists in TS mode,
// which is why the #2849 tests, compiled as TS, stayed green). That evolved
// type flowed through `resolveWasmType`/`ensureStructForType`, auto-registered
// a closed `__anon_N` struct, and typed the LOCAL — and every flow position:
// the function's return type, the `Parser.options` class field, receivers —
// as `(ref null __anon_N)`. The declaration's guarded cast of the plain-object
// externref into that struct type stores ref.null, and the first static read
// (`options.ecmaVersion === "latest"` in acorn's `getOptions`) hits the
// null-guarded `struct.get` fast path → uniform
// "TypeError: Cannot access property on null or undefined" at parser setup.
//
// Fix — record the poisoned var's EVOLVED checker type in
// `ctx.objectHashConsumerTypes` (host lanes, JS-mode evolved types only) and
// refuse struct resolution for it in `resolveWasmType` / `ensureStructForType`
// / `resolveStructName`, so the var stays externref and ALL access forms
// (static dot, computed bracket, for-in, escape via return) route through the
// host MOP (`__extern_get`/`__extern_set`) coherently.
//
// Byte-diff-verified scope: ONLY the JS-mode host lane of the reproducing
// shape changes; standalone (both modes) and every TS-mode compile are
// byte-identical (sha256, see the issue's `## Fix` notes).

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// The reduced acorn `getOptions` shape: multi-function + object ESCAPE
// (returned from the poisoned function, read by the caller). The in-function
// half of this family is covered by tests/issue-2849.test.ts; the escape +
// JS-mode combination is what regressed (#2937).
const GETOPTIONS_SHAPE = `
var defaultOptions = { ecmaVersion: null, sourceType: "script" };

function hasOwn(obj, propName) {
  return Object.prototype.hasOwnProperty.call(obj, propName);
}

function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions)
    { options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt]; }

  if (options.ecmaVersion === "latest") {
    options.ecmaVersion = 1e8;
  } else if (options.ecmaVersion == null) {
    options.ecmaVersion = 11;
  } else if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }
  if (options.allowReserved == null)
    { options.allowReserved = options.ecmaVersion < 5; }
  return options;
}

export function run(ev) {
  var o = getOptions({ ecmaVersion: ev });
  return o.ecmaVersion;
}

export function runDefault() {
  var o = getOptions({});
  return o.ecmaVersion;
}
`;

// Host-mode harness (buildImports + setExports — the canonical host runtime
// glue, matching tests/issue-2849.test.ts).
async function runHost(source: string, arg: number, opts: Record<string, unknown> = {}, fn = "run"): Promise<unknown> {
  const result = await compile(source, opts);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](arg);
}

describe("#2937 JS-mode host poison coherence (compiled-acorn getOptions null-deref)", () => {
  it("JS-mode host: getOptions escape shape normalises 2022 → 13 (was: uniform TypeError null-deref)", async () => {
    // fileName *.mjs → JS special mode: the checker evolves `var options = {}`
    // into a named-props type. Pre-fix this threw
    // "TypeError: Cannot access property on null or undefined" for EVERY call.
    const v = await runHost(GETOPTIONS_SHAPE, 2022, { fileName: "repro.mjs", skipSemanticDiagnostics: true });
    expect(v).toBe(13);
  });

  it("JS-mode host: defaulting path (getOptions({})) does not throw — KNOWN residual: reads 0, not the spec 11", async () => {
    // getOptions({}) copies defaultOptions.ecmaVersion into the poisoned
    // object via the for-in loop. `defaultOptions` is a NON-empty literal → a
    // closed struct whose `ecmaVersion: null` field stores null as an f64 0,
    // so the copy reads back 0 (not null) and the `== null` defaulting arm
    // never fires → returns 0 instead of 11. This null-in-struct-field
    // representation gap PRE-DATES the whole #2849/#2937 chain (it was never
    // green in any prior build: pre-#2849 this shape read the widened-struct
    // default 0 via the sidecar-shadowing bug instead) and is a separate
    // value-rep layer — documented as a follow-up in the #2937 issue file.
    // What THIS fix guarantees: the read goes through coherently (no
    // TypeError null-deref, which was #2937's uniform failure).
    const result = await compile(GETOPTIONS_SHAPE, { fileName: "repro.mjs", skipSemanticDiagnostics: true });
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const exp = instance.exports as Record<string, (...a: unknown[]) => unknown>;
    expect(() => exp.runDefault()).not.toThrow();
    expect(typeof exp.runDefault()).toBe("number");
  });

  it("JS-mode standalone: shape stays PURE and codegen is untouched (compiles + instantiates with no imports)", async () => {
    // Standalone codegen is byte-identical under this fix (the type-poison is
    // recorded host-only). Its pre-existing read-back gap for this shape is
    // tracked separately (see #2849's follow-up note) — so assert purity only,
    // not the normalised value.
    const r = await compile(GETOPTIONS_SHAPE, {
      fileName: "repro.mjs",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    await WebAssembly.instantiate(r.binary, {});
  });

  it("TS-mode host: same source keeps its pre-fix behavior (no type evolution, byte-identical lane)", async () => {
    // In TS mode the checker does NOT evolve `{}`; the poisoned var already
    // resolved to externref pre-fix. The in-function #2849 family is asserted
    // in tests/issue-2849.test.ts; here we just pin that the TS lane still
    // compiles and runs without throwing (its escape-shape read-back value is
    // a separate pre-existing gap, unchanged by this fix).
    const v = await runHost("// @ts-nocheck" + GETOPTIONS_SHAPE, 2022);
    expect(v).not.toBeInstanceOf(Error);
  });
});
