// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

// #6881 (S3-k of #5385) — `Array.prototype.includes` on an eval-widened
// receiver must not reach the legacy host array builders under the regime.
//
// A live `eval` makes every eval-visible script `var` representation-neutral
// (index.ts `runtimeEvalConsumer` retypes its global to externref), so
// `sample.includes(x)` arrives at the array dispatcher with an externref
// receiver. The `includes` arm sent every such receiver to the host method
// bridge, which builds its argument list with `env::__js_array_new` /
// `env::__js_array_push`; the native-first policy gate rejected the module.
// That is how ten `built-ins/Array/prototype/includes` rows failed on the
// regime lane: the test262 `$262.evalScript` shim mentions `eval`.

const HARNESS_SHAPED = `
var assert = {
  sameValue: function (actual, expected, message) {
    if (actual !== expected) throw new Error(message);
  },
};
var $262 = {
  evalScript: function (sourceText) { return eval(sourceText); },
};
var sample = [, , , 42, , ];
assert.sameValue([, , , ].includes(undefined), true, "a");
assert.sameValue([, , , 42, ].includes(undefined, 4), false, "b");
assert.sameValue(sample.includes(undefined), true, "c");
assert.sameValue(sample.includes(undefined, 4), true, "d");
assert.sameValue(sample.includes(42, 3), true, "e");
assert.sameValue(sample.includes(42, 4), false, "f");
var values = [1, NaN, 0];
assert.sameValue(values.includes(NaN), true, "g");
assert.sameValue(values.includes(-0), true, "h");
assert.sameValue(values.includes(2), false, "i");
`;

type Compiled = Awaited<ReturnType<typeof compile>>;

function importNames(result: Compiled): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => `${i.module}.${i.name}`);
}

async function run(result: Compiled): Promise<void> {
  const imports = buildCompiledImports(result) as ReturnType<typeof buildCompiledImports> &
    Record<string, Record<string, unknown>>;
  // The evalScript shim is never called; satisfy its provider imports.
  for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
    if (imp.module !== "js2wasm:runtime-eval") continue;
    imports[imp.module] ??= {};
    imports[imp.module]![imp.name] = () => {
      throw new Error("runtime eval is not exercised by this test");
    };
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (imports as { runStart?: () => void }).runStart?.();
  (instance.exports as { __module_init?: () => void }).__module_init?.();
}

describe("#6881 includes on an eval-widened receiver under the native regime", () => {
  it("compiles without legacy host array builders and answers per §23.1.3.16", async () => {
    const result = await compile(HARNESS_SHAPED, {
      fileName: "issue-6881.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      semanticProviders: "native-first",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(importNames(result).filter((name) => name.includes("__js_array_"))).toEqual([]);
    await expect(run(result)).resolves.toBeUndefined();
  });

  it("still compiles on the default gc lane (no runtime-eval widening there)", async () => {
    const result = await compile(HARNESS_SHAPED, {
      fileName: "issue-6881.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
