// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4606) A function with mixed boolean/number returns lost the boolean tag:
 *
 *     function m(x) { if (x > 5) return true; return x + 1; }
 *     `${m(9)}`   //  node "true" · js2 "1"
 *
 * Root cause: `inferNumericReturnTypes` (the #1121 numeric-kernel analysis in
 * src/codegen/declarations/param-return-inference.ts) counts every
 * boolean-valued expression as numeric — `isNumericExpr` accepts the `true` /
 * `false` keywords, `!x`, and every comparison, because they all lower to i32.
 * A function whose TS return type is implicit `any` and whose returns mix a
 * boolean with a number therefore proved "numeric" and got an **f64** result
 * carrier, so `return true` crossed back out as the number 1.
 *
 * #2795 had already carved out the PURELY-boolean kernels (branded i32, so they
 * box as JS booleans). The fix completes that: a kernel that is neither purely
 * numeric nor purely boolean has no scalar carrier that preserves both tags, so
 * it is not promoted at all and keeps its boxed (externref) carrier. Removal is
 * a fixpoint — dropping a callee can withdraw a caller's own numeric proof.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + run a script-goal source in JS-host mode, returning console output. */
async function runHost(source: string): Promise<string[]> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4606.js",
    skipSemanticDiagnostics: true,
  } as never);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const logs: string[] = [];
  const consoleProxy = {
    log: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    error: (...v: unknown[]) => logs.push(v.map(String).join(" ")),
    warn: () => {},
  };
  const imports = buildImports(result.imports, { console: consoleProxy } as never, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit === "function") (moduleInit as () => void)();
  return logs;
}

const MIXED = "function m(x) { if (x > 5) return true; return x + 1; }";

describe("#4606 — a mixed boolean/number return keeps its boolean tag", () => {
  it("prints 4 for the reported repro", async () => {
    expect(await runHost(`${MIXED} var v = m(9); console.log(\`\${v}\`.length);`)).toEqual(["4"]);
  });

  it("interpolates the boolean arm as `true`", async () => {
    expect(await runHost(`${MIXED} var v = m(9); console.log(\`\${v}\`);`)).toEqual(["true"]);
  });

  it("keeps the boolean tag through String() and a direct log", async () => {
    expect(await runHost(`${MIXED} console.log(String(m(9)));`)).toEqual(["true"]);
    expect(await runHost(`${MIXED} console.log(m(9));`)).toEqual(["true"]);
  });

  it("reports typeof as boolean, not number", async () => {
    expect(await runHost(`${MIXED} var v = m(9); console.log(typeof v);`)).toEqual(["boolean"]);
  });

  it("leaves the numeric arm numeric", async () => {
    expect(await runHost(`${MIXED} console.log(m(1));`)).toEqual(["2"]);
    expect(await runHost(`${MIXED} console.log(\`\${m(1)}\`);`)).toEqual(["2"]);
    expect(await runHost(`${MIXED} console.log(typeof m(1));`)).toEqual(["number"]);
  });

  it("withdraws the proof from a caller that only forwarded the mixed result", async () => {
    // `g` was numeric ONLY because `m` was — the fixpoint must drop it too.
    const src = `${MIXED} function g(y) { return m(y); } console.log(\`\${g(9)}\`);`;
    expect(await runHost(src)).toEqual(["true"]);
  });

  it("keeps a comparison-returning mixed kernel honest", async () => {
    const src = `function p(x) { if (x > 5) return x < 100; return x + 1; } console.log(\`\${p(9)}\`);`;
    expect(await runHost(src)).toEqual(["true"]);
  });

  // ── near-misses that already worked and must keep working ──────────────
  it("still interpolates a directly-assigned boolean", async () => {
    expect(await runHost("var v = true; console.log(`${v}`);")).toEqual(["true"]);
  });

  it("still interpolates a boolean-only function's result", async () => {
    expect(await runHost("function b() { return true; } console.log(`${b()}`);")).toEqual(["true"]);
  });

  it("keeps #2795's purely-boolean kernel branded", async () => {
    // Every return is boolean and the TS return type is implicit `any` (the
    // recursive call keeps it from resolving), so this stays a promoted kernel
    // — with the boolean brand, not the f64 carrier.
    const src = `
      function even(n) { if (n === 0) return true; return odd(n - 1); }
      function odd(n) { if (n === 0) return false; return even(n - 1); }
      console.log(\`\${even(4)}\`);
      console.log(\`\${odd(4)}\`);
    `;
    expect(await runHost(src)).toEqual(["true", "false"]);
  });

  it("keeps a purely arithmetic kernel on f64", async () => {
    const src = `
      function fib(n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
      console.log(fib(10));
      console.log(typeof fib(10));
    `;
    expect(await runHost(src)).toEqual(["55", "number"]);
  });

  it("still boxes a non-numeric mixed return correctly", async () => {
    expect(await runHost('function s(x) { if (x > 5) return "hi"; return x + 1; } console.log(s(9));')).toEqual(["hi"]);
    expect(await runHost("function s(x) { if (x > 5) return null; return x + 1; } console.log(s(9));")).toEqual([
      "null",
    ]);
  });
});
