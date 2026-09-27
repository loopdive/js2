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
      classification: "legacy-semantic",
      family: "strings",
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
      ownerIssue: 4401,
    });
    expect(classifyHostImport(descriptor("__reflect_get", { type: "builtin", name: "__reflect_get" }))).toMatchObject({
      classification: "legacy-semantic",
      family: "ecmascript-runtime",
      ownerIssue: 4397,
    });
  });

  it("reports the compatibility string provider as legacy semantics", async () => {
    const result = await compile(`export function size(): number { return " x ".trim().length; }`, {
      fileName: "issue-4401-legacy-string.ts",
    });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.hostImportInventory).toEqual(
      expect.arrayContaining([expect.objectContaining({ classification: "legacy-semantic", family: "strings" })]),
    );
    expect(result.hostImportSummary).toMatchObject({
      total: result.hostImportInventory?.length,
      byClassification: { "legacy-semantic": expect.any(Number), unknown: 0 },
    });
    expect(result.hostImportSummary!.byClassification["legacy-semantic"]).toBeGreaterThan(0);
  });

  it("fails native-first compilation before publishing an implicit semantic fallback", async () => {
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
    expect(native.hostImportSummary?.byClassification["legacy-semantic"]).toBe(0);
    expect(native.hostImportSummary?.byClassification.unknown).toBe(0);

    // The kill switch restores the pre-regime per-family reroute, where the
    // same source is refused BEFORE publication rather than silently recovering
    // the host Promise semantic fallback.
    const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
    process.env.JS2WASM_NATIVE_REGIME_JS = "0";
    try {
      const refused = await compile(source, {
        fileName: "issue-4401-native-first-refusal.ts",
        semanticProviders: "native-first",
      });
      expect(refused.success).toBe(false);
      expect(refused.binary).toHaveLength(0);
      const diagnostic = refused.errors.map((error) => error.message).join("; ");
      expect(diagnostic).toContain("Native-first semantic-provider policy rejected");
      expect(diagnostic).toContain("env::__new_Promise (legacy-semantic");
      expect(diagnostic).toContain("env::__tag_user_class (unknown");
      expect(diagnostic).not.toContain("FileSystemDirectoryHandle_resolve");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
      else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
    }

    const compatibility = await compile(source, {
      fileName: "issue-4401-compatibility-promise-subclass.ts",
    });
    expect(compatibility.success, compatibility.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(compatibility.hostImportInventory).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "__new_Promise", classification: "legacy-semantic" })]),
    );
  });

  describe("#6707 linker-owned shared exception tag", () => {
    const source = `export function boom(n: number): number { if (n > 0) throw new Error("x"); return n; }`;
    const compileShared = async (regime: "1" | "0") => {
      const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
      process.env.JS2WASM_NATIVE_REGIME_JS = regime;
      try {
        return await compile(source, {
          fileName: `issue-6707-shared-exn-${regime}.ts`,
          semanticProviders: "native-first",
          sharedExceptionTag: true,
        });
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
        else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
      }
    };

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

    for (const regime of ["1", "0"] as const) {
      it(`classifies env.__exn as instance-lifecycle and publishes (JS2WASM_NATIVE_REGIME_JS=${regime})`, async () => {
        const result = await compileShared(regime);
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
          byClassification: { "legacy-semantic": 0, unknown: 0 },
        });
      });
    }
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
      expect(result.hostImportSummary?.byClassification["legacy-semantic"]).toBe(0);
      expect(result.hostImportSummary?.byClassification.unknown).toBe(0);
    }
  });
});
