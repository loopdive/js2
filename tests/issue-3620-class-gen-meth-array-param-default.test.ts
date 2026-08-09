// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3620 — a class generator method whose parameter is an ARRAY binding pattern
// WITH a parameter default trapped `illegal cast` in the standalone lane.
//
// Root cause: for `*m([x] = [1])` the checker infers the parameter as the tuple
// `[number]`, so `resolveWasmType` minted a `$__tuple_N` struct for the
// generator state field. But a DEFAULTED parameter is widened to `externref` at
// the wasm boundary (the callee must be able to see "argument absent"), which
// removes the call site's tuple conversion, and the in-callee default
// materialization emits the array literal in its natural `$__vec_f64` shape.
// The state field still claimed `$__tuple_N`, so the factory's param→field
// coercion emitted an unconditional `ref.cast` over a value that is never a
// tuple — an uncatchable trap that aborts the whole module.
//
// Same defect shape as #3610: a `ref.cast` justified by a static type that no
// longer describes the runtime value.
//
// Every assertion below checks the observable BOUND VALUE of the destructured
// parameter — not "it compiles", and not merely "it did not trap".
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  const ex = instance.exports as Record<string, unknown>;
  (ex.__module_init as (() => void) | undefined)?.();
  return (ex.test as () => unknown)();
}

const prog = (decl: string, call: string) => `let cc = 0;
${decl}
export function test() { ${call} return cc; }`;

describe("#3620 class generator method + array binding pattern + parameter default", () => {
  it("binds from the parameter default when no argument is passed", async () => {
    expect(await runStandalone(prog(`class C { *m([x] = [1]) { cc = x; } }`, `new C().m().next();`))).toBe(1);
  });

  it("binds from the argument when one is passed", async () => {
    expect(await runStandalone(prog(`class C { *m([x] = [1]) { cc = x; } }`, `new C().m([4]).next();`))).toBe(4);
  });

  it("works on a static generator method", async () => {
    expect(await runStandalone(prog(`class C { static *m([x] = [1]) { cc = x; } }`, `C.m().next();`))).toBe(1);
  });

  it("applies the ELEMENT default through an elided parameter default", async () => {
    // `[x = 23] = [,]` — the parameter default supplies a hole, so the element
    // default must win. This is the exact shape of the test262
    // `gen-meth-dflt-ary-ptrn-elem-id-init-hole` family.
    expect(await runStandalone(prog(`class C { *m([x = 23] = [,]) { cc = x; } }`, `new C().m().next();`))).toBe(23);
  });

  it("binds a multi-element pattern from the default", async () => {
    expect(
      await runStandalone(prog(`class C { *m([a, b] = [7, 9]) { cc = a * 10 + b; } }`, `new C().m().next();`)),
    ).toBe(79);
  });

  it("the binding survives the state-machine round trip across yields", async () => {
    // The parameter rides a state-struct field between resumes, so the binding
    // must still be correct AFTER a yield — not just at factory-call time.
    // Observed through a module-level accumulator rather than `.next().value`:
    // reading `.value` off a `const g = …` binding is a separate pre-existing
    // standalone gap (it returns undefined for a NON-destructured generator
    // too, so it is not this issue's subject and must not be asserted here).
    const src = `let cc = 0;
      class C { *m([x] = [5]) { yield x; cc = cc + x; yield x + 1; cc = cc + x + 1; } }
      export function test() { const g = new C().m(); g.next(); g.next(); g.next(); return cc; }`;
    expect(await runStandalone(src)).toBe(11); // 5 + 6
  });
});

describe("#3620 neighbouring shapes are unaffected", () => {
  it("element default only (no parameter default)", async () => {
    expect(await runStandalone(prog(`class C { *m([x = 23]) { cc = x; } }`, `new C().m([undefined]).next();`))).toBe(
      23,
    );
  });
  it("scalar parameter default", async () => {
    expect(await runStandalone(prog(`class C { *m(x = 7) { cc = x; } }`, `new C().m().next();`))).toBe(7);
  });
  it("object binding pattern with a parameter default", async () => {
    expect(await runStandalone(prog(`class C { *m({ a } = { a: 9 }) { cc = a; } }`, `new C().m().next();`))).toBe(9);
  });
  it("non-generator class method, same parameter shape", async () => {
    expect(await runStandalone(prog(`class C { m([x] = [1]) { cc = x; } }`, `new C().m();`))).toBe(1);
  });
  it("object-literal generator method, same parameter shape", async () => {
    expect(await runStandalone(prog(`const o = { *m([x] = [1]) { cc = x; } };`, `o.m().next();`))).toBe(1);
  });
  it("plain generator function, same parameter shape", async () => {
    expect(await runStandalone(prog(`function* g([x] = [1]) { cc = x; }`, `g().next();`))).toBe(1);
  });
  it("class generator method with no destructuring", async () => {
    expect(await runStandalone(prog(`class C { *m(x) { cc = x; } }`, `new C().m(5).next();`))).toBe(5);
  });
});
