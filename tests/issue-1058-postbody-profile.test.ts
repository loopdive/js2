// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";
import { getCompileProfile, refreshCompileProfileConfig, resetCompileProfile } from "../src/compile-profile.js";
import { compileMultiSource } from "../src/compiler.js";

const originalProfileMode = process.env.JS2WASM_COMPILE_PROFILE;

afterEach(() => {
  if (originalProfileMode === undefined) Reflect.deleteProperty(process.env, "JS2WASM_COMPILE_PROFILE");
  else process.env.JS2WASM_COMPILE_PROFILE = originalProfileMode;
  refreshCompileProfileConfig();
  resetCompileProfile();
});

describe("#1058 multi-module post-body profiling", () => {
  it("exposes representative finalizers from the first deferred export through the last repair", async () => {
    process.env.JS2WASM_COMPILE_PROFILE = "1";
    refreshCompileProfileConfig();
    resetCompileProfile();

    const result = await compileMultiSource(
      {
        "dep.ts": "export function plusOne(value: number): number { return value + 1; }",
        "entry.ts": 'import { plusOne } from "./dep"; export function test(): number { return plusOne(41); }',
      },
      "entry.ts",
      { skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const paths = getCompileProfile().map((record) => record.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "codegen/deferred-default-exports",
        "codegen/fill-member-get-dispatch",
        "codegen/eliminate-dead-layout",
        "codegen/stack-balance",
        "codegen/fixup-extern-convert-any",
        "codegen/assert-no-leaked-host-imports",
      ]),
    );
  });
});
