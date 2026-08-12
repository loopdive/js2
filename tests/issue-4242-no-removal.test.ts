// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4242 — the QuickJS default is a selector flip, never an interpreter
 * retirement. Keep this guard deliberately structural: a future cleanup must
 * not delete the native bytecode engine, its pinned Acorn input, or its build
 * entrypoint merely because the default path no longer selects them.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as interpreter from "../src/interp/index.js";
import { selectCachedRuntimeEvalProvider } from "../scripts/runtime-eval-provider.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const INTERPRETER_FILES = [
  "src/interp/disasm.ts",
  "src/interp/dynamic-function.ts",
  "src/interp/emitter.ts",
  "src/interp/encoder.ts",
  "src/interp/eval-environment.ts",
  "src/interp/index.ts",
  "src/interp/loop.ts",
  "src/interp/opcodes.ts",
  "src/interp/runtime-ops.ts",
  "src/interp/types.ts",
];

function withEngine<T>(engine: string, fn: () => T): T {
  const saved = process.env.JS2WASM_EVAL_ENGINE;
  process.env.JS2WASM_EVAL_ENGINE = engine;
  try {
    return fn();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EVAL_ENGINE");
    else process.env.JS2WASM_EVAL_ENGINE = saved;
  }
}

describe("#4242 — native bytecode interpreter no-removal contract", () => {
  it("keeps every interpreter source module and a resolvable entrypoint", () => {
    for (const path of INTERPRETER_FILES) expect(existsSync(resolve(ROOT, path)), path).toBe(true);
    expect(Object.keys(interpreter).length).toBeGreaterThan(0);
  });

  it("keeps the pinned Acorn source and interpreter provider builder", () => {
    const pinPath = resolve(ROOT, "tests/dogfood/acorn-pin.json");
    const pin = JSON.parse(readFileSync(pinPath, "utf8")) as { tarball: string };
    expect(existsSync(resolve(ROOT, "tests/dogfood", pin.tarball))).toBe(true);
    expect(existsSync(resolve(ROOT, "tests/dogfood/setup-acorn.mjs"))).toBe(true);
    expect(existsSync(resolve(ROOT, "scripts/build-runtime-eval-provider.mjs"))).toBe(true);
  });

  it("keeps interpreter as an explicit accepted engine without QuickJS fallback", () => {
    const selection = withEngine("interpreter", () => selectCachedRuntimeEvalProvider());
    expect(selection.engine).not.toBe("quickjs");
    expect(["interpreter", "refusal", "none"]).toContain(selection.engine);
    expect(selection.message).toContain("JS2WASM_EVAL_ENGINE=interpreter");
    expect(selection.message).toContain("kept native bytecode engine");
  });

  it("keeps the accepted-engine diagnostic naming both choices", () => {
    expect(() => withEngine("unknown", () => selectCachedRuntimeEvalProvider())).toThrow(/interpreter.*quickjs/);
  });
});
