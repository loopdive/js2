// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti, type CompileOptions, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileGraph(files: Record<string, string>, options: CompileOptions = {}): Promise<CompileResult> {
  return compileMulti(files, "./entry.ts", {
    experimentalIR: true,
    trackFallbacks: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
}

async function runMain(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.main as () => number)();
}

describe("#3214 A+B1 — imported HOF calls", () => {
  it("runs a checker-certified imported HOF with one cached bare function value", async () => {
    const result = await compileGraph({
      "./hof.ts": `
        export function apply(fn: () => number): number { return fn() + 1; }
        export function identical(a: () => number, b: () => number): number {
          try { return a === b ? 1 : 0; } catch (_) { return 0; }
        }
      `,
      "./entry.ts": `
        import { apply, identical } from "./hof.ts";
        function fortyOne(): number { return 41; }
        export function main(): number { return apply(fortyOne) + identical(fortyOne, fortyOne); }
      `,
    });

    expect(await runMain(result)).toBe(43);
    expect(result.irCompiledFuncs ?? []).toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat.match(/\(global \$__fn_closure_fortyOne\b/g)).toHaveLength(1);
  });

  it("demotes safely when a user function occupies the cached trampoline name", async () => {
    const result = await compileGraph({
      "./hof.ts": `export function apply(fn: () => number): number { return fn() + 1; }`,
      "./entry.ts": `
        import { apply } from "./hof.ts";
        function fortyOne(): number { return 41; }
        function __fn_tramp_fortyOne_cached(): number { return -1; }
        export function main(): number { return apply(fortyOne); }
      `,
    });

    expect(await runMain(result)).toBe(42);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).not.toContain("(global $__fn_closure_fortyOne");
  });

  it("seeds a reassigned live function through the per-site fallback on collision", async () => {
    const result = await compileGraph({
      "./entry.ts": `
        function value(): number { return 41; }
        function __fn_tramp_value_cached(): number { return -1; }
        export function main(): number {
          const before: any = value;
          value = function (): number { return 1; };
          return before() + (value as any)();
        }
      `,
    });

    expect(await runMain(result)).toBe(42);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.wat).not.toContain("(global $__fn_closure_value");
  });

  it.each([
    ["renamed", `import { apply as run } from "./barrel.ts";`, "run"],
    ["default", `import run from "./barrel.ts";`, "run"],
  ] as const)("resolves %s imports through a barrel", async (_label, importLine, callee) => {
    const result = await compileGraph({
      "./hof.ts": `export default function (fn: () => number): number { return fn() + 1; }`,
      "./barrel.ts": `export { default, default as apply } from "./hof.ts";`,
      "./entry.ts": `
        ${importLine}
        function fortyOne(): number { return 41; }
        export function main(): number { return ${callee}(fortyOne); }
      `,
    });

    expect(await runMain(result)).toBe(42);
    expect(result.irCompiledFuncs ?? []).toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it.each([false, true])("preserves void calls and constant defaults (optimize=%s)", async (optimize) => {
    const result = await compileGraph(
      {
        "./hof.ts": `
          export function apply(fn: () => number, add: number = 1): number { return fn() + add; }
          export function consume(fn: () => number): void { fn(); }
        `,
        "./entry.ts": `
          import { apply, consume } from "./hof.ts";
          function fortyOne(): number { return 41; }
          export function main(): number { consume(fortyOne); return apply(fortyOne); }
        `,
      },
      { optimize },
    );

    expect(await runMain(result)).toBe(42);
    expect(result.irCompiledFuncs ?? []).toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("preserves wrapped imported void-call effects in final and loop early returns", async () => {
    const result = await compileGraph({
      "./hof.ts": `
        export function consume(fn: () => number): void { fn(); }
      `,
      "./entry.ts": `
        import { consume } from "./hof.ts";
        let total: number = 0;
        function bump(): number { total += 21; return total; }
        function finalReturn(): void { return (void consume(bump)); }
        function loopEarlyReturn(): void {
          while (true) { return ((consume(bump))); }
          return;
        }
        function conditionalReturn(flag: boolean): void {
          return flag ? consume(bump) : consume(bump);
        }
        export function main(): number {
          finalReturn();
          loopEarlyReturn();
          conditionalReturn(true);
          return total;
        }
      `,
    });

    expect(await runMain(result)).toBe(63);
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining(["finalReturn", "loopEarlyReturn", "conditionalReturn"]),
    );
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("rejects an imported void result used by a value composite before claiming", async () => {
    const result = await compileGraph({
      "./hof.ts": `export function consume(fn: () => number): void { fn(); }`,
      "./entry.ts": `
        import { consume } from "./hof.ts";
        function value(): number { return 41; }
        export function main(): number { return !consume(value) ? 42 : 0; }
      `,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps fast-mode numeric imported HOF calls representation-safe", async () => {
    const result = await compileGraph(
      {
        "./hof.ts": `
          export function apply(fn: (value: number) => number, value: number): number {
            return fn(value) + 1;
          }
        `,
        "./entry.ts": `
          import { apply } from "./hof.ts";
          function double(value: number): number { return value * 2; }
          export function main(): number { return apply(double, 20) + 1; }
        `,
      },
      { fast: true },
    );

    expect(await runMain(result)).toBe(42);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("preserves expression-default sentinels, host undefined, and arguments.length", async () => {
    const result = await compileGraph({
      "./hof.ts": `
        function one(): number { return 1; }
        export function expressionDefault(fn: () => number, add: number = one()): number {
          return arguments.length * 10 + fn() + add;
        }
        export function optionalLabel(fn: () => number, label?: string): number {
          return arguments.length * 100 + (label === undefined ? fn() + 1 : 0);
        }
      `,
      "./entry.ts": `
        import { expressionDefault, optionalLabel } from "./hof.ts";
        function fortyOne(): number { return 41; }
        export function main(): number {
          return expressionDefault(fortyOne) + optionalLabel(fortyOne);
        }
      `,
    });

    expect(await runMain(result)).toBe(194);
    expect(result.irCompiledFuncs ?? []).toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.imports.some((entry) => entry.name === "__get_undefined")).toBe(true);
  });

  it.each([
    [
      "namespace import",
      `import * as hof from "./hof.ts"; function fortyOne(): number { return 41; } export function main(): number { return hof.apply(fortyOne); }`,
    ],
    [
      "stored import",
      `import { apply } from "./hof.ts"; const stored = apply; function fortyOne(): number { return 41; } export function main(): number { return stored(fortyOne); }`,
    ],
    [
      "arrow callback",
      `import { apply } from "./hof.ts"; export function main(): number { return apply((): number => 41); }`,
    ],
    [
      "reassigned callback",
      `import { apply } from "./hof.ts"; function value(): number { return 41; } value = function (): number { return 40; }; export function main(): number { return apply(value); }`,
    ],
    [
      "spread arguments",
      `import { apply } from "./hof.ts"; function value(): number { return 41; } export function main(): number { return apply(...[value]); }`,
    ],
    [
      "extra arguments",
      `import { apply } from "./hof.ts"; function value(): number { return 41; } export function main(): number { return apply(value, 1); }`,
    ],
  ] as const)("rejects %s before claiming", async (_label, entry) => {
    const result = await compileGraph({
      "./hof.ts": `export function apply(fn: () => number): number { return fn() + 1; }`,
      "./entry.ts": entry,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("rejects an imported overload set before claiming", async () => {
    const result = await compileGraph({
      "./hof.ts": `
        function apply(fn: () => number): number;
        function apply(fn: () => number): number { return fn() + 1; }
        export { apply };
      `,
      "./entry.ts": `
        import { apply } from "./hof.ts";
        function fortyOne(): number { return 41; }
        export function main(): number { return apply(fortyOne); }
      `,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("rejects an imported live/reassigned target before claiming", async () => {
    const result = await compileGraph({
      "./hof.ts": `
        export function apply(fn: () => number): number { return fn() + 1; }
        [apply] = [function (fn: () => number): number { return fn() + 2; }];
      `,
      "./entry.ts": `
        import { apply } from "./hof.ts";
        function fortyOne(): number { return 41; }
        export function main(): number { return apply(fortyOne); }
      `,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps the imported-function widening disabled for standalone", async () => {
    const result = await compileGraph(
      {
        "./hof.ts": `export function apply(fn: () => number): number { return fn() + 1; }`,
        "./entry.ts": `
          import { apply } from "./hof.ts";
          function fortyOne(): number { return 41; }
          export function main(): number { return apply(fortyOne); }
        `,
      },
      { target: "standalone" },
    );

    expect(await runMain(result)).toBe(42);
    expect(result.irCompiledFuncs ?? []).not.toContain("main");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
