// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — throw-message string imports minted during the body phase are
// registered in one batch; each placeholder read must resolve to its own
// message and module globals emitted before and after must keep their slots.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1058 deferred throw-message string constants", () => {
  it("each positioned throw keeps its own message and module globals stay intact", async () => {
    const ex = (await compileToWasm(`
      let g1 = 5;
      let g2 = "x";
      function a(): string { const o: any = null; return o.p1; }
      function b(): string { const o: any = null; return o.p2; }
      let g3 = "late";
      function c(): string { const o: any = null; return o.p3; }
      export function run(which: number): string {
        try {
          if (which === 0) return a();
          if (which === 1) return b();
          return c();
        } catch (e) {
          return String(e) + "|" + g2 + g1 + g3;
        }
      }
      export function ok(): number { return g1 + g3.length; }
    `)) as { run(n: number): string; ok(): number };
    expect(ex.run(0)).toBe("TypeError: Cannot access property on null or undefined at 4:58|x5late");
    expect(ex.run(1)).toBe("TypeError: Cannot access property on null or undefined at 5:58|x5late");
    expect(ex.run(2)).toBe("TypeError: Cannot access property on null or undefined at 7:58|x5late");
    expect(ex.ok()).toBe(9);
  });
});
