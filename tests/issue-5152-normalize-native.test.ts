// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5152 — native Unicode 17 String.prototype.normalize smoke coverage.
 *
 * This deliberately starts with one compact emitted-Wasm matrix rather than a
 * sampled host-ICU oracle. The generator owns exhaustive Unicode-data checking;
 * this fixture proves that the generated tables are actually wired through the
 * standalone direct and reflective call paths, without JS imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const STANDALONE_SMOKE_SOURCE = `
  export function test(): number {
    let checks = 0;

    // Canonical decomposition followed by NFC composition.
    if ("e\\u0301".normalize() === "\\u00e9") checks += 1;

    // Algorithmic Hangul decomposition (LV + trailing T).
    if ("\\uac01".normalize("NFD") === "\\u1100\\u1161\\u11a8") checks += 2;

    // Compatibility-only mapping must be selected for NFKC.
    if ("\\u2460".normalize("NFKC") === "1") checks += 4;

    // The transferred member has a real optional form slot: omitted defaults
    // to NFC in the same body as the direct member call.
    if (String.prototype.normalize.call("e\\u0301") === "\\u00e9") checks += 8;

    // Explicit null is ToString(null) then the form RangeError, never an
    // omitted-form default. This also keeps the public method length at zero.
    try {
      String.prototype.normalize.call("x", null as any);
    } catch (error) {
      if (error instanceof RangeError && String.prototype.normalize.length === 0) checks += 16;
    }

    return checks;
  }
`;

const STANDALONE_VOID_VALUE_SOURCE = `
  // Keep the direct spelling statically recognized while allowing JavaScript's
  // legal, ignored surplus argument below.
  interface String {
    normalize(form?: string, ignored?: unknown): string;
  }

  let callEffects = 0;
  function markVoidCall(): void {
    callEffects += 1;
  }

  export function test(): number {
    let effects = 0;
    let checks = 0;

    // A void-valued direct form is the supplied value undefined, so it
    // defaults to NFC after preserving the expression's effect.
    if ("e\\u0301".normalize((void (effects += 1)) as any) === "\\u00e9" && effects === 1) checks += 1;

    // The transferred closure has the same optional-form behavior.
    if (String.prototype.normalize.call("e\\u0301", (void (effects += 1)) as any) === "\\u00e9" && effects === 2)
      checks += 2;

    // A value-less surplus argument is evaluated and ignored, not treated as
    // a compiler failure or a stack value to drop.
    if ("e\\u0301".normalize("NFC", void (effects += 1)) === "\\u00e9" && effects === 3) checks += 4;

    // These real void-returning calls exercise the value-less result path,
    // rather than VoidExpression's own undefined producer.
    if ("e\\u0301".normalize(markVoidCall() as any) === "\\u00e9" && callEffects === 1) checks += 8;
    if (String.prototype.normalize.call("e\\u0301", markVoidCall() as any) === "\\u00e9" && callEffects === 2)
      checks += 16;
    if ("e\\u0301".normalize("NFC", markVoidCall()) === "\\u00e9" && callEffects === 3) checks += 32;

    return checks;
  }
`;

const HOST_PRESERVATION_SOURCE = `
  export function test(): string {
    // Host/native-first remains on the pre-existing no-argument flatten body.
    return String.prototype.normalize.call("host-control");
  }
`;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-5152-normalize-native-standalone.ts",
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function runHost(source: string): Promise<string> {
  const result = await compile(source, { fileName: "issue-5152-normalize-native-host.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as unknown as { test(): string }).test();
}

describe("#5152 native Unicode String.prototype.normalize", () => {
  it("normalizes direct and reflective standalone calls without imports", async () => {
    expect(await runStandalone(STANDALONE_SMOKE_SOURCE)).toBe(31);
  });

  it("defaults void-valued forms and preserves a void surplus-argument effect", async () => {
    expect(await runStandalone(STANDALONE_VOID_VALUE_SOURCE)).toBe(63);
  });

  it("keeps the reached host normalize bridge on its historical no-arg body", async () => {
    expect(await runHost(HOST_PRESERVATION_SOURCE)).toBe("host-control");
  });
});
