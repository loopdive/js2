// (#1930 Slice 3) i32-safety matcher unification guards.
//
//   1. Verdict V1 — the scalar-local Q-CANON matcher (`isI32SafeExpr`,
//      function-body.ts) accepted unary `-x`, collapsing spec `-0` to `+0`
//      when the local was i32-promoted (the #2789 array fix was never
//      propagated). Probed live pre-fix: `Object.is(-x, -0)` → false.
//   2. The Q-TAG syntactic boolean spine is now defined once
//      (`isSyntacticallyBooleanExpr`, src/checker/oracle.ts); the
//      declarations.ts kernel fixpoint delegates — the #2795 boolean-kernel
//      branding must be unchanged.
//
// Doctrine: three DISTINCT questions (Q-CANON / Q-WRAP / Q-TAG) — see the
// divergence-verdict table in plan/issues/1930-*.md.

import { describe, it, expect } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeSource } from "../src/checker/index.js";
import { isSyntacticallyBooleanExpr } from "../src/checker/oracle.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string, fn: string): Promise<unknown> {
  const result = await compile(source, { fileName: "t.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

describe("#1930 Slice 3 — i32-safety doctrine", () => {
  it("V1: scalar -0 survives (Object.is(-x, -0) with x = 0) — was collapsed by i32 promotion", async () => {
    const v = await runHost(
      `// @ts-nocheck
export function test() {
  let x = 0;
  let y = -x;
  return Object.is(y, -0) ? "neg-zero" : "pos-zero";
}
`,
      "test",
    );
    expect(v).toBe("neg-zero");
  });

  it("V1: sign-of-zero read through division stays correct", async () => {
    const v = await runHost(
      `// @ts-nocheck
export function test() {
  let x = 0;
  let y = -x;
  return 1 / y;
}
`,
      "test",
    );
    expect(v).toBe(Number.NEGATIVE_INFINITY);
  });

  it("V1: the -1 sentinel form still promotes (strict-subset check — no over-demotion)", async () => {
    // `-<non-zero int literal>` remains admitted (the #2789 carve-out): the
    // sentinel-heavy pattern must keep compiling and computing correctly.
    const v = await runHost(
      `// @ts-nocheck
export function test() {
  let idx = -1;
  for (let i = 0; i < 4; i++) {
    if (i === 2) idx = i;
  }
  return idx;
}
`,
      "test",
    );
    expect(v).toBe(2);
  });

  it("boolean-kernel branding unchanged through the extracted spine (#2795 shape)", async () => {
    // A mutually-recursive boolean kernel must still brand its i32 result as
    // boolean, so it boxes to `true`/`false` (not 1/0) crossing to the host.
    const v = await runHost(
      `// @ts-nocheck
function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
function isOdd(n) { return n === 0 ? false : isEven(n - 1); }
export function test() {
  var r = isEven(4);
  return typeof r === "boolean" ? "boolean:" + r : "not-boolean:" + r;
}
`,
      "test",
    );
    expect(v).toBe("boolean:true");
  });

  it("isSyntacticallyBooleanExpr accept-set spot checks (the extracted spine)", () => {
    const { sourceFile } = analyzeSource(
      `
      const a = 1 < 2;
      const b = !0;
      const c = (1 < 2) && (3 > 4);
      const d = 1 + 2;
      const e = x instanceof Object;
      declare const x: any;
    `,
      "spine-probe.ts",
    );
    const inits: ts.Expression[] = [];
    for (const stmt of sourceFile.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.initializer) inits.push(decl.initializer);
        }
      }
    }
    const [a, b, c, d, e] = inits;
    expect(isSyntacticallyBooleanExpr(a!)).toBe(true); // comparison
    expect(isSyntacticallyBooleanExpr(b!)).toBe(true); // !x
    expect(isSyntacticallyBooleanExpr(c!)).toBe(true); // && of booleans
    expect(isSyntacticallyBooleanExpr(d!)).toBe(false); // arithmetic
    expect(isSyntacticallyBooleanExpr(e!)).toBe(true); // instanceof
    // Hook: kernel-set membership
    const { sourceFile: sf2 } = analyzeSource(`const k = myKernel(1);`, "spine-probe2.ts");
    const stmt = sf2.statements[0];
    if (stmt && ts.isVariableStatement(stmt)) {
      const init = stmt.declarationList.declarations[0]?.initializer;
      expect(isSyntacticallyBooleanExpr(init!)).toBe(false); // default hook
      expect(isSyntacticallyBooleanExpr(init!, (n) => n === "myKernel")).toBe(true);
    }
  });
});
