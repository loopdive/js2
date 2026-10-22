// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 S3c — test262's self-guarded `Test262Error`
// (`if (!(this instanceof F)) return new F(m)`) ships an IR body on the
// host-free lanes. Legacy keeps the constructor out of the fnctor machinery
// (no `__fnctor_F` struct: its `new F` sites take the native construct
// driver), so F's own signature stays plain externref; the IR reads `this`
// through `dyn.current_this` (legacy's `__current_this` ladder), tests the
// guard through `dyn.instanceof_fn` (legacy's per-function prototype), builds
// `new F(m)` through `dyn.construct` with F's function value, and stores
// `this.message` through `dyn.member_set` with the function's own strictness.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const OPTIONS = {
  experimentalIR: true,
  skipSemanticDiagnostics: true,
  allowJs: true,
  target: "standalone",
  inferModuleStrictArguments: false,
  trackIrOutcomes: true,
  emitWat: true,
} as const;

const HARNESS = `
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}
Test262Error.prototype.toString = function () { return "Test262Error: " + this.message; };
function thrower(m) { throw new Test262Error(m); }
var seven = 7;
`;

const PROBE = `
export function ok() {
  var n = 0;
  var e = new Test262Error("x");
  var f = Test262Error("y");
  if (e instanceof Test262Error) n += 1;
  if (f instanceof Test262Error) n += 2;
  if (String(e) === "Test262Error: x") n += 4;
  if (e.message === "x") n += 8;
  if (e.constructor === Test262Error) n += 16;
  try { thrower("t"); } catch (x) { if (x instanceof Test262Error && x.message === "t") n += 32; }
  if (new Test262Error(seven).message === 7) n += 64;
  if (new Test262Error().message === "") n += 128;
  if (!({} instanceof Test262Error)) n += 256;
  return n;
}
`;

async function call(binary: Uint8Array, name: string): Promise<number> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (instance.exports[name] as () => number)();
}

function irBodies(result: Awaited<ReturnType<typeof compile>>): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 S3c — the self-guarded Test262Error ships an IR body", () => {
  for (const mode of ["sloppy", "strict"] as const) {
    it(`constructs, guards and stores exactly as legacy (${mode})`, async () => {
      const prologue = mode === "strict" ? '"use strict";\n' : "";
      const result = await compile(prologue + HARNESS + PROBE, {
        ...OPTIONS,
        fileName: `issue-7106-s3c-${mode}.js`,
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(irBodies(result), JSON.stringify(result.irOutcomes, null, 2)).toContain("Test262Error");
      // Legacy never builds the bespoke fnctor struct for a self-guarded ctor.
      expect(result.wat ?? "").not.toContain("__fnctor_Test262Error");
      expect(result.wat ?? "").toContain(mode === "strict" ? "__ir_current_this_strict" : "__ir_current_this_sloppy");
      expect(result.wat ?? "").toContain("__ir_instanceof_fn_Test262Error");
      expect(await call(result.binary, "ok")).toBe(511);
    });
  }

  it("a sloppy store keeps going past a failed [[Set]]; a strict one throws", async () => {
    const body = (strict: boolean) => `${strict ? '"use strict";\n' : ""}
      function Guarded(message) {
        if (!(this instanceof Guarded)) return new Guarded(message);
        this.message = message || "";
      }
      var seven = 7;
      Object.defineProperty(Guarded.prototype, "message", { value: "frozen", writable: false });
      export function ok() {
        try {
          new Guarded(seven);
          return new Guarded("x").message === "frozen" ? 1 : 2;
        } catch (e) {
          return e instanceof TypeError ? 3 : 4;
        }
      }`;
    const sloppy = await compile(body(false), { ...OPTIONS, fileName: "issue-7106-s3c-sloppy-set.js" });
    const strict = await compile(body(true), { ...OPTIONS, fileName: "issue-7106-s3c-strict-set.js" });
    for (const result of [sloppy, strict]) {
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(irBodies(result)).toContain("Guarded");
    }
    expect(await call(sloppy.binary, "ok")).toBe(1);
    expect(await call(strict.binary, "ok")).toBe(3);
  });

  it("leaves an ordinary fnctor (no self-guard) on its typed struct", async () => {
    const result = await compile(
      `
        function Point(x) { this.x = x; }
        export function ok() { var p = new Point(3); return p.x === 3 && p instanceof Point ? 1 : 0; }
      `,
      { ...OPTIONS, fileName: "issue-7106-s3c-plain-fnctor.js" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat ?? "").toContain("__fnctor_Point");
    expect(result.wat ?? "").not.toContain("__ir_current_this");
    expect(await call(result.binary, "ok")).toBe(1);
  });
});
