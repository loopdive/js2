// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4181 — `**=` was missing from the module-init assignment-operator list.
 *
 * `collectDeclarations` decides which top-level ExpressionStatements reach
 * `__module_init` from an allow-list of assignment operator kinds. All fifteen
 * siblings were present (`=`, `+=`, `-=`, `*=`, `/=`, `%=`, `&=`, `|=`, `^=`,
 * `<<=`, `>>=`, `>>>=`, `??=`, `||=`, `&&=`) — `**=` was not. So a top-level
 * `x **= 3` compiled to NOTHING and the variable kept its previous value.
 *
 * Sixth instance of one family: #2992 (top-level `delete`), #3592 (`throw`),
 * #3615 (bare property read), #4179 (`with`), #4176 (`<Builtin>.prototype.<k> =`)
 * and this. All silent wrong answers — the same statement inside a function
 * body always worked; only the top-level collection dropped it.
 *
 * The same PR routes non-assignment binary statements through the #3623 drop
 * classifier before skipping them, so a future omission of this kind is
 * COUNTED rather than silent. That is a telemetry change with no behavioural
 * effect, so it is not asserted here; the behavioural half is.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  return (instance.exports as { main: () => unknown }).main();
}

describe("#4181 — top-level `**=` reaches __module_init", () => {
  // The headline repro: measured returning 2 (the statement vanished) before the fix.
  it("top-level `x **= 3` on x = 2 yields 8", async () => {
    expect(
      await runStandalone(`
        let x: number = 2;
        x **= 3;
        export function main(): number { return x; }
      `),
    ).toBe(8);
  });

  it("top-level `x **= 0` yields 1 — not a no-op that happens to look right", async () => {
    expect(
      await runStandalone(`
        let x: number = 7;
        x **= 0;
        export function main(): number { return x; }
      `),
    ).toBe(1);
  });

  // The asymmetry that identifies this as a COLLECTION gap rather than an
  // operator-lowering gap: the identical statement inside a function always
  // worked. If this ever fails while the top-level case passes, the diagnosis
  // has changed.
  it("the same statement inside a function body still works", async () => {
    expect(
      await runStandalone(`
        export function main(): number {
          let x: number = 2;
          x **= 3;
          return x;
        }
      `),
    ).toBe(8);
  });

  // Guards for two siblings that were already in the list, so a future edit
  // cannot fix `**=` by breaking its neighbours.
  it("sibling `*=` is unaffected", async () => {
    expect(
      await runStandalone(`
        let x: number = 5;
        x *= 4;
        export function main(): number { return x; }
      `),
    ).toBe(20);
  });

  it("sibling `>>>=` is unaffected", async () => {
    expect(
      await runStandalone(`
        let x: number = 256;
        x >>>= 4;
        export function main(): number { return x; }
      `),
    ).toBe(16);
  });

  it("a sequence of top-level compound assignments composes", async () => {
    expect(
      await runStandalone(`
        let x: number = 2;
        x **= 3;
        x += 1;
        x **= 2;
        export function main(): number { return x; }
      `),
    ).toBe(81);
  });
});
