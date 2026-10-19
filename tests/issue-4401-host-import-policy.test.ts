// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile, type ImportDescriptor } from "../src/index.js";
import { classifyHostImport } from "../src/host-import-policy.js";

const descriptor = (name: string, intent: ImportDescriptor["intent"]): ImportDescriptor => ({
  module: "env",
  name,
  kind: "func",
  intent,
});

describe("#4401 host import policy inventory", () => {
  it("keeps capability, adapter, semantic, accelerator, and unknown classifications distinct", () => {
    expect(
      classifyHostImport(descriptor("console_log_string", { type: "console_log", variant: "string" })),
    ).toMatchObject({ classification: "platform-capability", family: "console" });
    expect(classifyHostImport(descriptor("__str_to_mem", { type: "builtin", name: "__str_to_mem" }))).toMatchObject({
      classification: "value-adapter",
      family: "js-value-bridge",
    });
    expect(
      classifyHostImport(descriptor("__unwrap_for_wasm", { type: "builtin", name: "__unwrap_for_wasm" })),
    ).toMatchObject({
      classification: "value-adapter",
      family: "js-value-bridge",
      ownerIssue: 4399,
    });
    expect(classifyHostImport(descriptor("string_trim", { type: "string_method", method: "trim" }))).toMatchObject({
      classification: "unknown",
      family: "retired-host-semantics",
      ownerIssue: 6979,
    });
    expect(classifyHostImport(descriptor("Math_sin", { type: "math", method: "sin" }))).toMatchObject({
      classification: "host-accelerator",
      nativeFallback: true,
    });
    expect(
      classifyHostImport(descriptor("__boundary_object_get", { type: "boundary_object", operation: "get" })),
    ).toMatchObject({
      classification: "value-adapter",
      family: "boundary-object",
      ownerIssue: 4399,
    });
    expect(
      classifyHostImport(descriptor("__boundary_callback_call_1", { type: "boundary_callback", arity: 1 })),
    ).toMatchObject({
      classification: "value-adapter",
      family: "callbacks",
      ownerIssue: 4399,
    });
    expect(classifyHostImport(descriptor("mystery", { type: "builtin", name: "mystery" }))).toMatchObject({
      classification: "unknown",
      ownerIssue: 6979,
    });
    expect(classifyHostImport(descriptor("__reflect_get", { type: "builtin", name: "__reflect_get" }))).toMatchObject({
      classification: "unknown",
      family: "retired-host-semantics",
      ownerIssue: 6979,
    });
    expect(classifyHostImport(descriptor("el", { type: "declared_function", name: "el" }))).toMatchObject({
      classification: "platform-capability",
      family: "declared:el",
    });
  });

  it("names exactly three regime-gap families (#6979, #5385)", () => {
    const gap = (name: string, intent: ImportDescriptor["intent"]) => classifyHostImport(descriptor(name, intent));
    expect(gap("__gen_next", { type: "builtin", name: "__gen_next" })).toMatchObject({
      classification: "regime-gap",
      family: "eager-generator-buffer",
      ownerIssue: 5385,
    });
    expect(gap("__create_async_generator", { type: "builtin", name: "__create_async_generator" })).toMatchObject({
      classification: "regime-gap",
      family: "eager-generator-buffer",
    });
    expect(
      gap("SharedArrayBuffer_new", { type: "extern_class", className: "SharedArrayBuffer", action: "new" }),
    ).toMatchObject({ classification: "regime-gap", family: "shared-array-buffer" });
    expect(
      gap("__temporal_plain_date_to_string", { type: "builtin", name: "__temporal_plain_date_to_string" }),
    ).toMatchObject({ classification: "regime-gap", family: "temporal-strings" });
    expect(gap("Map_new", { type: "extern_class", className: "Map", action: "new" })).toMatchObject({
      classification: "unknown",
      ownerIssue: 6979,
    });
  });

  it("publishes a Promise subclass on the native provider with no implicit semantic fallback", async () => {
    const source = `
      class P<T> extends Promise<T> {}
      export async function run(): Promise<number> {
        return await P.resolve(1).then((value) => value + 1);
      }
    `;

    // (#5385 S5) Under the native regime — the default for native-first in a JS
    // environment — this source lowers on the native Promise provider and
    // publishes with zero legacy/unknown imports.
    const native = await compile(source, {
      fileName: "issue-4401-native-first-regime.ts",
      semanticProviders: "native-first",
    });
    expect(native.success, native.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(native.hostImportSummary?.byClassification.unknown).toBe(0);

    // (#6979) The S6 kill switch and the host-assisted profile, the two ways to
    // reach the host Promise semantic fallback, are gone.
  });

  describe("#6707 linker-owned shared exception tag", () => {
    const source = `export function boom(n: number): number { if (n > 0) throw new Error("x"); return n; }`;
    const compileShared = () =>
      compile(source, {
        fileName: "issue-6707-shared-exn.ts",
        semanticProviders: "native-first",
        sharedExceptionTag: true,
      });

    it("keys on the non-func manifest kind, not on the name alone", () => {
      const intent = { type: "builtin", name: "__exn" } as const;
      expect(classifyHostImport({ ...descriptor("__exn", intent), kind: "global" })).toMatchObject({
        classification: "instance-lifecycle",
        family: "shared-exception-tag",
        ownerIssue: 5226,
        nativeFallback: true,
      });
      expect(classifyHostImport(descriptor("__exn", intent))).toMatchObject({ classification: "unknown" });
    });
    it("classifies env.__exn as instance-lifecycle and publishes", async () => {
      const result = await compileShared();
      expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
      expect(result.binary.length).toBeGreaterThan(0);
      const tags = (result.hostImportInventory ?? []).filter((entry) => entry.name === "__exn");
      expect(tags).toEqual([
        expect.objectContaining({
          module: "env",
          kind: "tag",
          classification: "instance-lifecycle",
          family: "shared-exception-tag",
          ownerIssue: 5226,
          nativeFallback: true,
        }),
      ]);
      expect(result.hostImportSummary).toMatchObject({
        byClassification: { "regime-gap": 0, unknown: 0 },
      });
    });
  });

  it("keeps a standalone generator on the native carrier whether or not native-first is spelled out", async () => {
    // Historical note: this test once pinned a transitional state in which the
    // standalone target still leaked `__create_generator` unless native-first
    // was explicit, and the explicit selection was refused. The native
    // generator carrier has since landed (#3178 lineage), so both selections
    // now publish the same host-free module. Kept as a guard against either
    // arm regressing to a host semantic import.
    const source = `
      export function run(): number {
        const make = function* () { return arguments.length; };
        return make(1).next().value;
      }
    `;

    for (const semanticProviders of [undefined, "native-first"] as const) {
      const result = await compile(source, {
        fileName: `issue-4401-standalone-generator-${semanticProviders ?? "auto"}.ts`,
        target: "standalone",
        ...(semanticProviders ? { semanticProviders } : {}),
        skipSemanticDiagnostics: true,
      });
      expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
      expect(result.targetProfile?.semanticProviders).toBe("native-first");
      expect(result.hostImportSummary?.total).toBe(0);
      expect(result.hostImportSummary?.byClassification.unknown).toBe(0);
    }
  });
});

describe("#6979 universal publication gate", () => {
  const retiredHostImport = `export function run(): number { return 1; }`;
  it("publishes a user-declared host function as a platform capability", async () => {
    const source = `declare function el(x: string): number; export function f(): number { return el("a"); }`;
    const result = await compile(source, { fileName: "issue-6979-declared.ts" });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.hostImportInventory?.find((entry) => entry.name === "el")).toMatchObject({
      intentType: "declared_function",
      classification: "platform-capability",
      family: "declared:el",
    });
  });
  it("rejects a retired host-semantic import on every WasmGC profile", () => {
    const string = descriptor("string_trim", { type: "string_method", method: "trim" });
    for (const environment of ["javascript", "wasi", "none"] as const) {
      expect(classifyHostImport(string, environment).classification).toBe("unknown");
    }
  });
  it("moves the strict gc build onto the native regime", async () => {
    const result = await compile(retiredHostImport, { fileName: "issue-6979-strict.ts", strictNoHostImports: true });
    expect(result.success).toBe(true);
    expect(result.targetProfile?.nativeRegime).toBe(true);
  });
});
