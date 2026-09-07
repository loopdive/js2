import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildCompiledAdapterImports, instantiateWasm, wrapExports } from "../src/runtime.js";
import {
  engineCanonicalizesExportedFunctions,
  installFreshDataStructAssociationToken,
  sameAssociationToken,
  sameExportedFunction,
} from "../src/runtime/exported-function-identity.js";

// (#5337) iOS Safari / JavaScriptCore: `table.get(i)` and `instance.exports.f`
// yield DIFFERENT function objects for the same Wasm function, and an imported
// Global re-exported comes back as a new object. Under strict `===` every
// closure and data-struct helper then failed authentication and was masked —
// `__call_fn_0 is not available`, compiled object literals enumerating as `{}`.
//
// V8 canonicalizes both, so a plain run here exercises the strict path only.
// To cover the JSC path without a WebKit engine, the wrapper split is
// simulated with a funcref table that holds the same function under two
// distinct exported-function objects taken from two instances of one module.

const ACORN_DIR = path.resolve("website/public/acorn");

// (module (func $f (export "f")) (table (export "t") 1 1 funcref) (elem (i32.const 0) $f))
const PROBE = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 4, 5, 1, 112, 1, 1, 1, 7, 9, 2, 1, 102, 0, 0, 1, 116, 1,
  0, 9, 7, 1, 0, 65, 0, 11, 1, 0, 10, 4, 1, 2, 0, 11,
]);

describe("#5337 exported-function identity across table and export views", () => {
  it("V8 canonicalizes, so the strict identity path is what runs in CI", () => {
    const { exports } = new WebAssembly.Instance(new WebAssembly.Module(PROBE));
    const { f, t } = exports as { f: Function; t: WebAssembly.Table };
    expect(t.get(0)).toBe(f);
    expect(engineCanonicalizesExportedFunctions()).toBe(true);
    expect(sameExportedFunction(f, t.get(0))).toBe(true);
  });

  it("never accepts a JS impostor or a different Wasm function for a helper", () => {
    const a = new WebAssembly.Instance(new WebAssembly.Module(PROBE)).exports as { f: Function };
    const b = new WebAssembly.Instance(new WebAssembly.Module(PROBE)).exports as { f: Function };
    // Same index in another instance is the one case the name fallback cannot
    // split — on a canonicalizing engine it is still rejected outright.
    expect(sameExportedFunction(a.f, b.f)).toBe(false);
    const impostor = Object.defineProperty(() => 1, "name", { value: a.f.name });
    expect(sameExportedFunction(a.f, impostor)).toBe(false);
    expect(sameExportedFunction(impostor, a.f)).toBe(false);
    expect(sameExportedFunction(undefined, a.f)).toBe(false);
  });

  it("association tokens compare by identity first and by per-build value only as a fallback", () => {
    const constants: Record<string, WebAssembly.Global> = {
      "\0token": new WebAssembly.Global({ value: "externref" }, "\0token"),
    };
    installFreshDataStructAssociationToken(constants, "\0token");
    const token = constants["\0token"]!;
    const value = token.value;
    const mint = () => new WebAssembly.Global({ value: "externref", mutable: false }, value);
    expect(sameAssociationToken(token, token)).toBe(true);
    // Two Globals over the same value: identity fails, and on a canonicalizing
    // engine there is no reason to look further — the export IS the import.
    expect(sameAssociationToken(mint(), token)).toBe(false);
    // Distinct buildImports mint distinct values, so the value fallback can
    // never confuse two builds even where it does run.
    installFreshDataStructAssociationToken(constants, "\0token");
    expect(constants["\0token"]!.value).not.toBe(value);
    expect(constants["\0token"]!.value.token).toBe("\0token");
    // Absent token (no data-struct bridge in the module): nothing is minted.
    const none: Record<string, WebAssembly.Global> = {};
    installFreshDataStructAssociationToken(none, "\0token");
    expect(none["\0token"]).toBeUndefined();
    expect(sameAssociationToken("not a global", token)).toBe(false);
  });

  it("the shipped acorn module authenticates its helpers through the live boundary", async () => {
    const bytes = readFileSync(path.join(ACORN_DIR, "acorn.wasm"));
    const manifest = JSON.parse(readFileSync(path.join(ACORN_DIR, "acorn.manifest.json"), "utf-8"));
    const imports = buildCompiledAdapterImports(manifest);
    // The token is a per-build object, the shape JSC's value fallback relies on.
    const token = imports.string_constants["\0js2_data_struct_host_bridge_token"];
    expect(token).toBeInstanceOf(WebAssembly.Global);
    expect(typeof token.value).toBe("object");

    const { instance } = await instantiateWasm(
      bytes,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setInstance?.(instance);
    const compiled = wrapExports(instance, {
      signatures: manifest.exportSignatures,
      boundaryPolicies: manifest.exportBoundaries,
    }) as { parse: (src: string, opts: object) => { body: Array<{ expression: { value: unknown } }> } };
    // acorn's `getOptions` enumerates its compiled `defaultOptions` literal via
    // `__for_in_keys` → `__struct_field_names`; a masked helper yields `{}`,
    // the ecmaVersion warning, and then the null `.replace` seen on iOS.
    const ast = compiled.parse("0", { ecmaVersion: 2022, sourceType: "module" });
    expect(ast.body[0].expression.value).toBe(0);
  }, 120_000);
});
