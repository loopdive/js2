// #2663 Slice 4 — `with` statement Tier 2: @@unscopables-aware HasBinding.
//
// Slices 1-3 gated every dynamic-`with` name resolution on the value-independent
// HasProperty (`__extern_has`), treating "present on the object" as HasBinding.
// That is incomplete: ECMA-262 §9.1.1.2.1 HasBinding for a `with` Object
// Environment Record filters a present property through the receiver's
// @@unscopables blocklist — a name whose `@@unscopables[name]` ToBoolean-coerces
// to true does NOT shadow the outer binding.
//
// Slice 4 routes the three HOST-mode with-gates (read / write / delete
// resolution) through the new `__with_has_binding` host helper, which applies
// the full predicate: HasProperty THEN the @@unscopables filter. Standalone is
// unchanged (the dynamic-`with` path is host-only — `__extern_has` is refused
// under --target standalone, #1472).
//
// NOTE: the test262 `binding-blocked-by-unscopables.js` mutates
// `env[Symbol.unscopables].x` across heterogeneous types (true → 'string' → 86 →
// {} → Symbol); the `{ x: true }` literal lowers to a typed struct whose numeric
// `x` field cannot hold those later values (the object-representation ceiling,
// #2580). The HasBinding LOGIC below is correct and isolated; flipping that
// specific corpus file additionally needs the dynamic any-typed representation.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  // (#7014) setInstance: raw setExports(instance.exports) lost data-struct authority in 708ebbd56d (#5337).
  importObject.__setInstance?.(instance);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2663 Slice 4 — with @@unscopables HasBinding", () => {
  it("a true-valued @@unscopables entry blocks the object binding (read falls to outer)", async () => {
    const exp = await run(
      `var x = 0; var env = { x: 1 }; env[Symbol.unscopables] = { x: true }; var r; with (env) { r = x; } return r;`,
    );
    expect(exp.test()).toBe(0);
  });

  it("a truthy non-boolean @@unscopables entry (number) also blocks the binding", async () => {
    const exp = await run(
      `var x = 0; var env = { x: 1 }; env[Symbol.unscopables] = { x: 86 }; var r; with (env) { r = x; } return r;`,
    );
    expect(exp.test()).toBe(0);
  });

  it("a false-valued @@unscopables entry does NOT block (object property wins)", async () => {
    const exp = await run(
      `var x = 0; var env = { x: 1 }; env[Symbol.unscopables] = { x: false }; var r; with (env) { r = x; } return r;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("an empty @@unscopables object does not block any name", async () => {
    const exp = await run(
      `var x = 0; var env = { x: 1 }; env[Symbol.unscopables] = {}; var r; with (env) { r = x; } return r;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("a non-object @@unscopables (string) is ignored — own property wins", async () => {
    const exp = await run(
      `var marker = 0; var env = { y: 7 }; env[Symbol.unscopables] = ''; var r; with (env) { r = y; } return r;`,
    );
    expect(exp.test()).toBe(7);
  });

  it("@@unscopables only blocks the named property, not siblings", async () => {
    const exp = await run(
      `var y = 0; var env = { x: 1, y: 2 }; env[Symbol.unscopables] = { x: true }; var r; with (env) { r = y; } return r;`,
    );
    expect(exp.test()).toBe(2);
  });

  it("@@unscopables is not consulted when the property is absent (getter not invoked)", async () => {
    const exp = await run(
      `var x = 0; var env = {}; var cc = 0; Object.defineProperty(env, Symbol.unscopables, { get: function () { cc += 1; } }); with (env) { x; } return cc;`,
    );
    expect(exp.test()).toBe(0);
  });

  it("a blocked WRITE falls through to the outer binding", async () => {
    const exp = await run(
      `var x = 0; var env = { x: 1 }; env[Symbol.unscopables] = { x: true }; with (env) { x = 9; } return x;`,
    );
    expect(exp.test()).toBe(9);
  });

  it("an unblocked WRITE still targets the object property (no regression)", async () => {
    const exp = await run(`var env = { x: 1 }; with (env) { x = 9; } return env.x;`);
    expect(exp.test()).toBe(9);
  });

  it("nested with: a blocked name on the inner object cascades to the outer with", async () => {
    const exp = await run(
      `var a = { v: 1 }; var b = { v: 2 }; b[Symbol.unscopables] = { v: true }; var r; with (a) { with (b) { r = v; } } return r;`,
    );
    expect(exp.test()).toBe(1);
  });

  it("Slice 1 dynamic read (no @@unscopables) still works — no regression", async () => {
    const exp = await run(`var o = { x: 42 }; var r; with (o) { r = x; } return r;`);
    expect(exp.test()).toBe(42);
  });
});
