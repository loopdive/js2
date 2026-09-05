// #5161 — the Error family is constructible in the `nativeStrings` and `fast`
// host configs.
//
// The issue was FILED as "`new Error(msg, {cause})` throws under nativeStrings
// and fast". The mandated boundary measurement showed that framing is a
// mis-attribution: the throw is at the CONSTRUCTOR's message slot and it fires
// with no options at all. Measured on `origin/main` 02b050f8f0, host-observed:
//
//   nativeStrings / fast, base:  `throw new Error("m")`
//                                -> TypeError: Cannot convert object to primitive value
//
// In those lanes a string literal is a WasmGC `array i16` carrier rather than a
// host string, so `_errorMessageToString` received a struct that HOLDS a
// string. Both #3481 cause-2 ToPrimitive walkers look for coercion methods,
// find none on a string carrier, and bottom out — and the whole construction
// died there, long before `__error_install_cause` (#5159) could run.
//
// The fix is two parts, both narrow:
//   1. `src/runtime.ts` — decode a native-string carrier with the module's own
//      `__str_is_native` / `__str_to_extern` discriminator BEFORE either walker
//      runs. §7.1.1 step 1 returns a String argument unchanged, so this value
//      never reaches ToPrimitive and the walker contract is untouched.
//   2. `src/codegen/expressions/new-builtin-globals.ts` — request that
//      discriminator bridge at the three host Error-ctor sites. Without this
//      the exports exist only when some UNRELATED part of the module happens to
//      need them, so the same source compiled to a throw or not depending on
//      whether it also did `String(e.message)` somewhere. Measured, and the
//      reason the runtime half alone is not enough.
//
// STILL BROKEN in these lanes, deliberately out of scope and pinned below as
// the current behaviour so a future fix has to update this file:
//   - `options.cause` is not installed. `_installErrorCause` needs
//     `__struct_field_names` to answer HasProperty on an opaque options struct;
//     that export is deliberately not emitted in native-string lanes (#3912),
//     and the per-field `__sget_cause` fallback is unusable — under `fast` it
//     answers `null` even for a struct that HAS the field.
//   - Reading any property back off a genuine host object is broken in these
//     lanes generally (`typeof o.s` -> null under nativeStrings, `illegal cast`
//     under fast), which is why every assertion here observes the error
//     HOST-side rather than reading `e.message` from inside wasm.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

type Config = { name: string; options: Record<string, unknown> };

const CONFIGS: Config[] = [
  { name: "default", options: {} },
  { name: "nativeStrings", options: { nativeStrings: true } },
  { name: "fast", options: { fast: true } },
];

/** Compile + instantiate + brand, exactly as `tests/test262-runner.ts` does. */
async function run(src: string, options: Record<string, unknown>): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...options,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/**
 * Run `body` and return whatever it threw, observed HOST-side.
 *
 * Host-side is not a stylistic choice: in the native-string lanes a property
 * read back into wasm is independently broken, so `return String(e.message)`
 * would measure that defect instead of this one.
 */
async function thrown(body: string, options: Record<string, unknown>): Promise<any> {
  const exports = await run(`export function f(): number { ${body} }`, options);
  try {
    exports.f();
  } catch (e) {
    return e;
  }
  throw new Error("expected the module to throw, but it returned");
}

const ERROR_CTORS = ["Error", "TypeError", "RangeError", "SyntaxError", "URIError", "EvalError", "ReferenceError"];

describe.each(CONFIGS)("#5161 Error construction — $name host config", ({ options }) => {
  for (const ctor of ERROR_CTORS) {
    it(`${ctor}: a string-literal message survives the host boundary`, async () => {
      const e = await thrown(`throw new ${ctor}("m");`, options);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).constructor.name).toBe(ctor);
      expect((e as Error).message).toBe("m");
    });
  }

  it("AggregateError: the same message decode (third caller of the helper)", async () => {
    const e = await thrown(`throw new AggregateError([], "am");`, options);
    expect((e as Error).constructor.name).toBe("AggregateError");
    expect((e as Error).message).toBe("am");
  });

  it("a COMPUTED string message decodes too — not just literals", async () => {
    const e = await thrown(`const a: string = "a"; throw new Error(a + "b");`, options);
    expect((e as Error).message).toBe("ab");
  });

  it("a message held in a variable decodes", async () => {
    const e = await thrown(`const m: string = "held"; throw new Error(m);`, options);
    expect((e as Error).message).toBe("held");
  });

  it("constructing WITHOUT throwing does not raise — the ctor itself was the failure", async () => {
    // The base failure was in construction, so a module that merely builds an
    // Error and never throws it died too. This is the non-vacuity anchor: it
    // has no `String(e.message)` anywhere, which is what made the runtime-only
    // half of the fix insufficient (the bridge exports were absent).
    const exports = await run(`export function f(): number { const e: any = new Error("m"); return 7; }`, options);
    expect(exports.f()).toBe(7);
  });

  it("an absent message still renders the bare name (unchanged on every lane)", async () => {
    const e = await thrown(`throw new Error();`, options);
    expect((e as Error).message).toBe("");
  });

  it("the message survives alongside an options bag", async () => {
    const e = await thrown(`const c: any = { k: 1 }; throw new Error("om", { cause: c } as any);`, options);
    expect((e as Error).message).toBe("om");
  });
});

describe("#5161 residuals — pinned as CURRENT behaviour, not as correct", () => {
  it("default host: options.cause IS installed (the #5159 lane, unchanged)", async () => {
    const e = await thrown(`const c: any = { k: 1 }; throw new Error("om", { cause: c } as any);`, {});
    expect(Object.prototype.hasOwnProperty.call(e, "cause")).toBe(true);
  });

  for (const { name, options } of CONFIGS.filter((c) => c.name !== "default")) {
    it(`${name}: options.cause is still NOT installed — the #3912 introspection gap`, async () => {
      // `_installErrorCause` cannot answer HasProperty on the opaque options
      // struct without `__struct_field_names`, which these lanes do not emit.
      // Pinned so that whoever closes that gap sees this line go red.
      const e = await thrown(`const c: any = { k: 1 }; throw new Error("om", { cause: c } as any);`, options);
      expect(Object.prototype.hasOwnProperty.call(e, "cause")).toBe(false);
    });

    it(`${name}: an OBJECT message still throws — the module-walker gap`, async () => {
      // `{toString(){...}}` needs the compiled module's own method dispatch,
      // which is a separate boundary from the native-string decode fixed here.
      const e = await thrown(`const o: any = { toString() { return "TS"; } }; throw new Error(o as any);`, options);
      expect((e as Error).message).toBe("Cannot convert object to primitive value");
    });
  }

  it("default host: an object message DOES stringify (#3481 cause 2 stays green)", async () => {
    const e = await thrown(`const o: any = { toString() { return "TS"; } }; throw new Error(o as any);`, {});
    expect((e as Error).message).toBe("TS");
  });
});
