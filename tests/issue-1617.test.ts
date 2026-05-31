import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1617: the #1589 loop pre-box pass wrongly boxed body-local `let`/`const`
// names captured by a closure, conflating the hoisted f64 value slot with the
// ref cell and emitting `ref.is_null` over an f64 local — invalid wasm. The
// flagship playground calendar example (a closure capturing a per-cell `day`
// number inside the day-render loop) failed to instantiate as a result.
//
// These tests assert the binary VALIDATES (the bug was a validation failure)
// and, where the runtime path is supported, that the value is correct. We keep
// to inline closure invocation; arrays-of-closures have a separate, pre-existing
// runtime null-deref limitation unrelated to this fix.

async function compileValid(source: string) {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  // The original bug produced a module that failed WebAssembly validation.
  expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  return result;
}

async function run(source: string, fn: string) {
  const result = await compileValid(source);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, Function>)[fn]!();
}

describe("#1617 — loop pre-box must not box body-local let/const captured by a closure", () => {
  it("compiles a body-local number const captured by a closure inside a for-loop", async () => {
    // Minimal repro: previously emitted `ref.is_null` over an f64 local.
    expect(
      await run(
        `
      export function test(): number {
        let count = 0;
        for (let d = 1; d <= 3; d++) {
          const day = d;
          const f = (): number => day;
          count = count + f();
        }
        return count;
      }
    `,
        "test",
      ),
    ).toBe(6); // 1 + 2 + 3
  });

  it("validates a body-local number const captured by two closures in the same iteration", async () => {
    // Two captures of differently-typed body locals (number → f64, string → ref)
    // — the calendar's click/mouseenter handler shape. Validation-only: the
    // closures escape into DOM-like sinks, exercising the boxing path.
    await compileValid(`
      let sink: HTMLElement | null = null;
      function el(t: string): HTMLElement { return document.createElement(t); }
      export function render(): void {
        if (sink === null) return;
        for (let d = 1; d <= 31; d++) {
          const day = d;
          const bg = "x";
          const cell = el("div");
          cell.addEventListener("click", () => { onDay(day); });
          cell.addEventListener("mouseenter", () => { if (bg === "x") cell.style.background = "#222"; });
          sink.appendChild(cell);
        }
      }
      function onDay(d: number): void {}
    `);
  });

  it("validates the playground calendar example (renderCal regression)", async () => {
    // Direct guard for the reported failure: function #25 "renderCal" must
    // produce a module that validates.
    const src = readFileSync(resolve(__dirname, "../playground/examples/dom/calendar.ts"), "utf-8");
    await compileValid(src);
  });

  it("does not regress #1589 var/enclosing capture in a for-loop", async () => {
    // `var i` shares a single binding across iterations; the pre-box pass must
    // still box it so the loop condition sees mutations. Validation-only.
    await compileValid(`
      export function test(): number {
        var sum = 0;
        var fns: (() => void)[] = [];
        for (var i = 0; i < 3; i++) {
          fns.push(() => { sum = sum + i; });
        }
        return sum;
      }
    `);
  });
});
