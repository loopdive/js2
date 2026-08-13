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

    const native = await compile(source, {
      fileName: "issue-4401-native-first-refusal.ts",
      semanticProviders: "native-first",
    });
    expect(native.success).toBe(false);
    expect(native.binary).toHaveLength(0);
    const diagnostic = native.errors.map((error) => error.message).join("; ");
    expect(diagnostic).toContain("Native-first semantic-provider policy rejected");
    expect(diagnostic).toContain("env::__new_Promise (legacy-semantic");
    expect(diagnostic).toContain("env::__tag_user_class (unknown");
    expect(diagnostic).not.toContain("FileSystemDirectoryHandle_resolve");

    const compatibility = await compile(source, {
      fileName: "issue-4401-compatibility-promise-subclass.ts",
    });
    expect(compatibility.success, compatibility.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(compatibility.hostImportInventory).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "__new_Promise", classification: "legacy-semantic" })]),
    );
  });

  it("preserves target-derived standalone compatibility fallbacks until native-first is explicitly selected", async () => {
    const source = `
      export function run(): number {
        const make = function* () { return arguments.length; };
        return make(1).next().value;
      }
    `;

    const compatibility = await compile(source, {
      fileName: "issue-4401-standalone-generator-fallback.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(compatibility.success, compatibility.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(compatibility.targetProfile?.semanticProviders).toBe("native-first");
    expect(compatibility.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__create_generator", classification: "legacy-semantic" }),
      ]),
    );

    const explicit = await compile(source, {
      fileName: "issue-4401-explicit-native-generator-refusal.ts",
      target: "standalone",
      semanticProviders: "native-first",
      skipSemanticDiagnostics: true,
    });
    expect(explicit.success).toBe(false);
    expect(explicit.errors.map((error) => error.message).join("; ")).toContain(
      "Native-first semantic-provider policy rejected",
    );
  });
});
