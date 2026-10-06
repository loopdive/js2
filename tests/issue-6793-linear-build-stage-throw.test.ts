// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6793 — the linear IR overlay's build-stage catch used to swallow EVERY throw
 * from `lowerFunctionAstToIr` (only `IrPlanningIdentityInvariantError` was
 * rethrown). A bare `TypeError` or an `IrInvariantError` — a compiler bug —
 * silently demoted the function to the direct path with no diagnostic, while
 * the WasmGC lane hard-errors the same case.
 *
 * Only a typed `IrUnsupportedError` is a designed demote. Everything else is
 * classified with `classifyIrFailure` (as the WasmGC lane does) and fails the
 * compile with the invariant diagnostic.
 *
 * ESM namespace exports cannot be `vi.spyOn`-ed, so the build hook is wrapped
 * with a partial `vi.mock` (the pattern of issue-4113's monomorphize wrapper):
 * it throws only for an armed function name and otherwise delegates.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { injected } = vi.hoisted(() => ({
  injected: new Map<string, () => unknown>(),
}));

vi.mock("../src/ir/from-ast.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/from-ast.js")>();
  return {
    ...actual,
    lowerFunctionAstToIr(...args: Parameters<typeof actual.lowerFunctionAstToIr>) {
      const makeError = injected.get(args[1].funcName ?? "");
      if (makeError) throw makeError();
      return actual.lowerFunctionAstToIr(...args);
    },
  };
});

import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { IrInvariantError, IrUnsupportedError } from "../src/ir/outcomes.js";

const ORIGINAL_LINEAR_IR = process.env.JS2WASM_LINEAR_IR;

afterEach(() => {
  injected.clear();
  if (ORIGINAL_LINEAR_IR === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LINEAR_IR");
  else process.env.JS2WASM_LINEAR_IR = ORIGINAL_LINEAR_IR;
});

const SOURCE = `
  export function victim(a: number): number { return a * 2 + 1; }
  export function other(a: number): number { return a - 1; }
`;

async function compileLinear() {
  process.env.JS2WASM_LINEAR_IR = "1";
  return compile(SOURCE, { fileName: "test.ts", target: "linear" });
}

describe("#6793 linear build-stage catch", () => {
  it("control: without an injected throw, victim is IR-compiled (the hook reaches the build stage)", async () => {
    const r = await compileLinear();
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(getLastLinearIrReport()?.compiled).toContain("victim");
  });

  it("an untyped TypeError in the build stage is a hard compile error, not a silent demote", async () => {
    injected.set("victim", () => new TypeError("injected build-hook TypeError"));
    const r = await compileLinear();
    expect(r.success).toBe(false);
    const errors = r.errors.filter((e) => e.severity === "error");
    expect(errors.map((e) => e.message)).toEqual([
      "Codegen error: linear-ir: IR build of victim hit invariant unexpected-internal-throw: injected build-hook TypeError",
    ]);
    expect(r.errors.some((e) => e.severity === "warning" && e.message.includes("injected"))).toBe(false);
  });

  it("an IrInvariantError in the build stage keeps its code and fails the compile", async () => {
    injected.set(
      "victim",
      () => new IrInvariantError("selection-preparation-mismatch", "build", "injected build-hook invariant"),
    );
    const r = await compileLinear();
    expect(r.success).toBe(false);
    expect(r.errors.find((e) => e.severity === "error")?.message).toBe(
      "Codegen error: linear-ir: IR build of victim hit invariant selection-preparation-mismatch: injected build-hook invariant",
    );
  });

  it("a genuine IrUnsupportedError still demotes to the direct path and the module runs", async () => {
    injected.set(
      "victim",
      () => new IrUnsupportedError("body-shape-rejected", "build", "injected build-hook unsupported"),
    );
    const r = await compileLinear();
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);

    const report = getLastLinearIrReport();
    expect(report?.compiled).not.toContain("victim");
    expect(report?.compiled).toContain("other");
    const rejection = report?.rejected.find((entry) => entry.func === "victim");
    expect(rejection?.reason).toBe("build");
    expect(rejection?.outcome?.kind).toBe("unsupported");
    expect(rejection?.detail).toBe("injected build-hook unsupported");

    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const exports = instance.exports as { victim(a: number): number; other(a: number): number };
    expect(exports.victim(5)).toBe(11);
    expect(exports.other(5)).toBe(4);
  });
});
