// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — a dynamic call over many registered closure signatures is emitted as
// one shared helper per ladder shape instead of an inline ladder per call site.
// Every call site must still select the right closure, arity and result.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

function source(): string {
  const shapes: string[] = [];
  // 24 distinct funcref signatures (parameter count × result kind).
  for (let n = 0; n < 8; n++) {
    const params = Array.from({ length: n }, (_, i) => `p${i}: number`).join(", ");
    const sum = n === 0 ? "0" : Array.from({ length: n }, (_, i) => `p${i}`).join(" + ");
    shapes.push(`export const num${n} = (${params}): number => ${sum} + ${n};`);
    shapes.push(`export const str${n} = (${params}): string => "s" + (${sum});`);
    shapes.push(`export const bool${n} = (${params}): boolean => (${sum}) > ${n};`);
  }
  return `
    ${shapes.join("\n    ")}
    function call2(f: any, a: any, b: any): any { return f(a, b); }
    function call1(f: any, a: any): any { return f(a); }
    function call0(f: any): any { return f(); }
    export function run(): string {
      return [
        call2(num2, 3, 4),
        call2(str2, 3, 4),
        call2(bool2, 3, 4),
        call2(num1, 5, 99),
        call1(num1, 5),
        call1(str3, 1),
        call0(num0),
        call0(str0),
        call2((a: number, b: number) => a * b, 6, 7),
      ].join(",");
    }
  `;
}

describe("#1058 outlined dynamic-call ladder", () => {
  it("dispatches every shape through the shared helper", async () => {
    const src = source();
    const ex = (await compileToWasm(src)) as { run(): string };
    expect(ex.run()).toBe(
      new Function(`${src.replace(/export /g, "").replace(/: (number|string|boolean|any)/g, "")}; return run();`)(),
    );
    const result = await compile(src, { emitWat: true });
    const helpers = result.wat?.match(/\(func \$__dyn_call_\d+/g) ?? [];
    expect(helpers.length).toBeGreaterThan(0);
    // One helper per (arity, candidate set) shape, not one ladder per call.
    expect(helpers.length).toBeLessThanOrEqual(3);
  });
});
