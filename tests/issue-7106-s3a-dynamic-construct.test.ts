// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 3a — `new K(...)` on a dynamic-typed parameter lowers through
// `dyn.construct` (legacy's ordinary `__native_construct_<N>` driver behind the
// `__ir_dyn_construct_<N>` wrapper) instead of demoting the function. The
// sources are untyped script, the test262 harness shape: an untyped parameter
// is the externref carrier in both front-ends, so a legacy caller may keep
// calling the IR body (`legacyCallerAbiIsProjected`).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { IR_DYNAMIC_CONSTRUCT_MAX_ARITY } from "../src/codegen/ir-dynamic-construct.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  trackIrOutcomes: true,
} as const;

async function compileStandalone(source: string, fileName: string) {
  const result = await compile(source, { ...OPTIONS, fileName });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return result;
}

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 S3a — new <dynamic param>(…) through dyn.construct", () => {
  it("constructs a user function value with one dynamic argument (the Test262Error caller shape)", async () => {
    const result = await compileStandalone(
      `
        function E(message) { this.message = message; }
        function mk(K, v) { return new K(v); }
        export function ok() {
          var e = mk(E, "boom");
          var n = 0;
          if (e.message === "boom") n += 1;
          if (e instanceof E) n += 2;
          return n;
        }
      `,
      "issue-7106-s3a-one-arg.js",
    );
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("mk");
    expect(await call(result.binary, "ok")).toBe(3);
  });

  it("boxes a concrete argument and handles arity 0 and 2", async () => {
    const result = await compileStandalone(
      `
        function P(a, b) { this.a = a; this.b = b; }
        function Z() { this.z = 7; }
        function two(K, x) { return new K(x, 5); }
        function zero(K) { return new K(); }
        export function ok() {
          var p = two(P, "s");
          var z = zero(Z);
          var n = 0;
          if (p.a === "s") n += 1;
          if (p.b === 5) n += 2;
          if (z.z === 7) n += 4;
          return n;
        }
      `,
      "issue-7106-s3a-arity.js",
    );
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("two");
    expect(irBodies(result)).toContain("zero");
    expect(await call(result.binary, "ok")).toBe(7);
  });

  it("throws the constructed value (throw new K(m)) from an IR body", async () => {
    const result = await compileStandalone(
      `
        function E(message) { this.message = message; }
        function boom(K, m) { throw new K(m); }
        export function ok() {
          try { boom(E, "x"); } catch (err) { return err.message === "x" ? 1 : 0; }
          return 0;
        }
      `,
      "issue-7106-s3a-throw.js",
    );
    expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("boom");
    expect(await call(result.binary, "ok")).toBe(1);
  });

  it("leaves a spread or over-arity construct to legacy", async () => {
    const args = Array.from({ length: IR_DYNAMIC_CONSTRUCT_MAX_ARITY + 1 }, (_, i) => String(i)).join(", ");
    const result = await compileStandalone(
      `
        function E(message) { this.message = message; }
        function spread(K, a) { return new K(...a); }
        function wide(K) { return new K(${args}); }
        export function ok() {
          var s = spread(E, ["q"]);
          var w = wide(E);
          return s.message === "q" && w.message === 0 ? 1 : 0;
        }
      `,
      "issue-7106-s3a-legacy.js",
    );
    expect(irBodies(result)).not.toContain("spread");
    expect(irBodies(result)).not.toContain("wide");
    expect(await call(result.binary, "ok")).toBe(1);
  });

  it("does not admit the construct on the JS-host lane (gc output unchanged)", async () => {
    // The native regime in a JS environment projects as standalone and admits
    // the construct like standalone does; the HOST-assisted lane is the one
    // whose bytes must not move (CLAUDE.md, 2026-10-10).
    const source = `
      function E(message) { this.message = message; }
      function mk(K, v) { return new K(v); }
      export function ok() { var e = mk(E, "boom"); return e.message === "boom" ? 1 : 0; }
    `;
    const result = await compile(source, {
      experimentalIR: true,
      skipSemanticDiagnostics: true,
      allowJs: true,
      trackIrOutcomes: true,
      semanticProviders: "host-assisted",
      fileName: "issue-7106-s3a-gc.js",
    });
    expect(result.success).toBe(true);
    expect(irBodies(result)).not.toContain("mk");
  });
});
