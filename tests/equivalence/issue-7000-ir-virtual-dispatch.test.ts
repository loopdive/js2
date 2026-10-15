// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7000 — the IR lowered an instance-method call on a BASE-typed receiver to a
// static `call $<DeclaredClass>_<m>`, so a subclass override was skipped:
// `callV(new B())` and `this.v()` inside `A.w` ran `A.v`. Legacy dispatches on
// `__tag` (#1299). Until the IR has its own virtual-dispatch intent, the
// selector refuses the shape (`class-method-virtual`) and the unit keeps its
// legacy body; a call with no override below the receiver's class stays a
// direct IR call.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc (default)", options: {} },
];

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7000.ts", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = options.target
    ? (await WebAssembly.instantiate(result.binary, {})).instance
    : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, value: exports.test!() };
}

function outcomeOf(result: Awaited<ReturnType<typeof compile>>, name: string) {
  return result.irOutcomes?.find((o) => o.displayName === name);
}

const CASES: Record<string, string> = {
  "base-typed parameter receiver + `this.v()` (the audit repro)": `
class A { v(): number { return 1; } w(): number { return this.v() * 10; } }
class B extends A { v(): number { return 2; } }
function callV(a: A): number { return a.v(); }
export function test(): number { const b = new B(); return callV(b) + b.w(); }`,
  "`this.v()` inside an inherited base method": `
class A { v(): number { return 1; } w(): number { return this.v() * 10; } }
class B extends A { v(): number { return 2; } }
export function test(): number { return new B().w() + new A().w(); }`,
  "three-level chain, override only on the grandchild": `
class A { v(): number { return 1; } }
class B extends A { u(): number { return 7; } }
class C extends B { v(): number { return 3; } }
function callV(a: A): number { return a.v(); }
function callVB(b: B): number { return b.v(); }
export function test(): number { return callV(new C()) * 100 + callVB(new C()) * 10 + callV(new B()); }`,
  "`const` annotated with the base class but bound to a subclass instance": `
class A { v(): number { return 1; } }
class B extends A { v(): number { return 2; } }
export function test(): number { const a: A = new B(); return a.v(); }`,
};

describe("#7000 IR instance calls on a base-typed receiver honour overrides", () => {
  for (const [label, source] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const expected = evaluateAsJs(source).test!();
        const { value } = await compileAndRun(source, lane.options);
        expect(value).toBe(expected);
      }, 120_000);
    }
  }

  it("the overriding call site is refused with `class-method-virtual`", async () => {
    const { result } = await compileAndRun(CASES["base-typed parameter receiver + `this.v()` (the audit repro)"]!, {
      target: "standalone",
    });
    expect(outcomeOf(result, "callV")).toMatchObject({ kind: "unsupported", code: "class-method-virtual" });
    expect(outcomeOf(result, "A_w")).toMatchObject({ kind: "unsupported", code: "class-method-virtual" });
    // The override bodies themselves have no virtual call and stay IR.
    expect(outcomeOf(result, "B_v")?.kind).toBe("emitted");
  }, 120_000);

  it("a receiver known to be exactly its static class keeps the direct IR call", async () => {
    const source = `
class A { v(): number { return 1; } }
class B extends A { v(): number { return 2; } }
export function test(): number { const a = new A(); return a.v() * 10 + new B().v(); }`;
    const { result, value } = await compileAndRun(source, { target: "standalone" });
    expect(value).toBe(evaluateAsJs(source).test!());
    expect(outcomeOf(result, "test")?.kind).toBe("emitted");
  }, 120_000);

  for (const lane of LANES) {
    it(`negative control: no override below the receiver class keeps the direct IR call — ${lane.name}`, async () => {
      const source = `
class A { v(): number { return 1; } }
class B extends A { u(): number { return 5; } }
export function callV(a: A): number { return a.v(); }
export function test(): number { return callV(new B()) + new B().u(); }`;
      const { result, value } = await compileAndRun(source, lane.options);
      expect(value).toBe(evaluateAsJs(source).test!());
      expect(outcomeOf(result, "callV")?.kind).toBe("emitted");
      const wat = result.wat ?? "";
      const body = wat.slice(wat.indexOf("(func $callV"), wat.indexOf("(func $test"));
      expect(body).toMatch(/\b(return_)?call (\$A_v|\d+)\b/);
      // A `__tag` dispatch cascade would branch; the devirtualised call does not.
      expect(body).not.toMatch(/\b(if|br_if)\b/);
    }, 120_000);
  }
});
