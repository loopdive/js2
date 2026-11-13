// #2998 — eliminate the `env::__instanceof_check` sole-import leak for a
// STATICALLY-primitive left-hand operand in standalone / WASI.
//
// The fully-dynamic `instanceof` path (`emitDynamicInstanceOf`) routed EVERY
// `<value> instanceof <dynamic-RHS>` to the `__instanceof_check` host predicate,
// so legacy `language/expressions/instanceof/S15.3.5.3_A1_*`
// (`<primitive> instanceof Function(...)`) and
// `primitive-prototype-with-primitive` / `prototype-getter-with-primitive`
// (`0 instanceof Function.prototype`) each leaked that import in the standalone
// lane despite passing.
//
// Fix: when the LHS is statically and exclusively a primitive, §13.10.2 →
// §7.3.20 OrdinaryHasInstance step 3 ("If Type(O) is not Object, return false")
// resolves the operator to `false` with no prototype read and no proto-chain
// walk — a compile-time constant. Both operands are still compiled (spec
// evaluates LHS then RHS before any check, preserving side effects / a RHS
// throw), then discarded. Gated on `noJsHost` so the gc/host lane — where the
// import is satisfiable and still throws a spec TypeError for a genuine-primitive
// RHS — stays byte-identical. The object-LHS dynamic path (a real proto-chain
// membership walk) is deferred to the #2916 Slice B substrate.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  return r;
}

function envImports(r: Awaited<ReturnType<typeof compile>>): string[] {
  return r.imports.filter((i) => i.module === "env").map((i) => i.name);
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#2998 static-primitive-LHS instanceof drops __instanceof_check in standalone", () => {
  // `f` is a user identifier (declared `any`), so the RHS reaches the fully
  // dynamic path — exactly the shape that used to leak the host predicate.
  const primitiveLhs: Array<[string, string]> = [
    ["number", "1"],
    ["string", '"1"'],
    ["boolean true", "true"],
    ["boolean false", "false"],
    ["void 0", "void 0"],
    ["null", "null"],
    ["undefined", "undefined"],
  ];

  for (const [label, lhs] of primitiveLhs) {
    it(`${label} instanceof <user fn> → false, host-free`, async () => {
      const src = `export function test(): number {
        const F: any = function () {};
        return (${lhs} instanceof F) === false ? 1 : 0;
      }`;
      const r = await compileStandalone(src);
      expect(envImports(r), `leaked: ${envImports(r).join(",")}`).not.toContain("__instanceof_check");
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      expect((instance.exports as { test?: () => number }).test?.()).toBe(1);
    });
  }

  it("0 instanceof <member-access RHS> → false, host-free (prototype-getter shape)", async () => {
    // A non-identifier RHS (member access) also reaches the dynamic path.
    const src = `export function test(): number {
      const holder: any = { p: function () {} };
      return (0 instanceof holder.p) === false ? 1 : 0;
    }`;
    const r = await compileStandalone(src);
    expect(envImports(r), `leaked: ${envImports(r).join(",")}`).not.toContain("__instanceof_check");
    expect(await runStandalone(src)).toBe(1);
  });

  it("does NOT fold an object/any LHS — proto-chain path is still host-backed (#2916 Slice B)", async () => {
    // `obj` is a real object value: its membership answer needs the deferred
    // proto-chain walk, so the dynamic predicate must remain in place (not
    // wrongly short-circuited to false).
    const src = `export function test(): number {
      const F: any = function () {};
      const obj: any = new F();
      return (obj instanceof F) ? 1 : 0;
    }`;
    // When this was pinned the object-LHS path still routed to the HOST
    // `__instanceof_check` (the leak was deferred), so the pin asserted that
    // import. The proto-chain walk is native in standalone now — the deferred
    // leak is closed — so pin what the guard is about: the fold did NOT fire
    // (a real object answers `true`, which a short-circuited `false` cannot)
    // and the module stays host-free.
    const r = await compileStandalone(src);
    expect(envImports(r)).not.toContain("__instanceof_check");
    expect(await runStandalone(src)).toBe(1);
  });

  it("gc/host lane keeps the dynamic predicate (byte-behaviour unchanged)", async () => {
    const src = `export function test(): number {
      const F: any = function () {};
      return (1 instanceof F) === false ? 1 : 0;
    }`;
    const r = await compile(src, { skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    // Host lane still emits the predicate — the fold is standalone-only.
    expect(r.imports.filter((i) => i.module === "env").map((i) => i.name)).toContain("__instanceof_check");
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
    expect((instance.exports as { test?: () => number }).test?.()).toBe(1);
  });
});
