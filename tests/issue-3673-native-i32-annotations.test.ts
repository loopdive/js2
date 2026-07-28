import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3673 — `type i32 = number` annotations were INERT outside `fast` mode.
 *
 * The original #323 detection read `tsType.aliasSymbol?.name`, but TypeScript
 * never populates `aliasSymbol` for an alias of an intrinsic primitive, so the
 * annotation resolved to `null` at every site and every `i32`-annotated binding
 * came out `f64`. These pins assert the syntactic resolution actually reaches
 * the emitted module, and that the surrounding guard rails hold.
 */

async function wat(source: string, opts: Record<string, unknown> = {}): Promise<string> {
  const result = await compile(source, { fileName: "t.ts", optimize: 0, ...opts });
  expect(result.success, (result.errors ?? []).map((e) => e.message ?? String(e)).join("\n")).toBe(true);
  return result.wat ?? "";
}

/** Body of the named function in a compiled WAT, up to the next top-level func. */
function funcBody(source: string, name: string): string {
  const start = source.indexOf(`(func $${name} `);
  expect(start, `function $${name} not found`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\n  (func $", start + 5);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

describe("#3673 — native i32 annotations take effect outside fast mode", () => {
  it("emits i32 locals for an annotated local (gc target, not fast)", async () => {
    const w = await wat(`type i32 = number;
      export function f(): number { let n: i32 = 0; n = n + 1; return n; }`);
    const body = funcBody(w, "f");
    expect(body).toMatch(/\(local \$n i32\)|\(local i32\)/);
    expect(body).not.toMatch(/\(local \$n f64\)/);
  });

  it("emits an i32 parameter and i32 result for an annotated signature", async () => {
    const w = await wat(`type i32 = number;
      export function f(a: i32): i32 { return a; }`);
    expect(funcBody(w, "f")).toMatch(/\(func \$f \(param i32\) \(result i32\)/);
  });

  it("emits an i32 struct field for an annotated class property, f64 for an unannotated one", async () => {
    // The Lexer-shaped case: the fields are BOTH declared and
    // constructor-assigned, which is the ordering that used to mint the slot
    // from the constructor assignment before the declaration was consulted.
    const w = await wat(`type i32 = number;
      class C { p: i32; q: number; constructor() { this.p = 0; this.q = 0; } }
      export function f(): number { const c: C = new C(); return c.p; }`);
    expect(w).toContain("(field $p (mut i32))");
    expect(w).toContain("(field $q (mut f64))");
  });

  it("leaves unannotated `number` bindings as f64", async () => {
    const w = await wat(`export function f(): number { let n = 0; n = n + 1; return n; }`);
    const body = funcBody(w, "f");
    expect(body).toMatch(/f64/);
    expect(body).not.toMatch(/\(local \$n i32\)/);
  });

  it("does not hijack a same-named type that is not `= number`", async () => {
    // A user type literally called `i32` that aliases something else must not
    // be treated as a native annotation.
    const w = await wat(`type i32 = string;
      export function f(a: i32): number { return a.length; }`);
    expect(funcBody(w, "f")).not.toMatch(/\(param i32\)/);
  });

  it("keeps the declared value semantics of an i32 binding", async () => {
    const result = await compile(
      `type i32 = number;
       export function f(): number { let a: i32 = 7; let b: i32 = 3; return a - b + a * b; }`,
      { fileName: "t.ts" },
    );
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary!, {
      env: {},
      string_constants: {},
      string_constants16: {},
    });
    expect((instance.exports as Record<string, () => number>).f!()).toBe(25);
  });
});

describe("#3673 — IR path accepts a class whose fields are i32-annotated", () => {
  it("lowers `this.p = 0` into an i32 field instead of throwing out of from-ast", async () => {
    // Before this change the IR lowering rejected the assignment with
    // `ir/from-ast: assignment to C.p (i32) got f64`, which the #2138 IR-first
    // gate promotes to a hard compile error. It must compile now.
    const result = await compile(
      `type i32 = number;
       class C { p: i32; constructor() { this.p = 0; } }
       export function f(): number { const c: C = new C(); return c.p; }`,
      { fileName: "t.ts", trackIrOutcomes: true },
    );
    expect(result.success, (result.errors ?? []).map((e) => e.message ?? String(e)).join("\n")).toBe(true);
    const outcomes = result.irOutcomes ?? [];
    const ctorOutcome = outcomes.find((o) => o.displayName === "C_new");
    expect(ctorOutcome?.kind).toBe("emitted");
  });
});
