// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4438) `new <runtime-eval callable>` in `--target standalone`.
 *
 * The behavioural half of this issue can only be observed with the QuickJS
 * provider linked, which is a test262-runner-scale fixture rather than a unit
 * test (the measured before/after probes live in the issue file). What IS
 * unit-checkable — and is what actually broke in every prior reserve/fill
 * driver (#4196, #3981, #1888) — is the STRUCTURAL contract:
 *
 *  1. the driver is reserved AND filled (an `unreachable` stub reaching the
 *     binary is strictly worse than the null it replaces: an uncatchable trap);
 *  2. the §20.2.1.1 `prototype`/`constructor` seed is emitted at the
 *     `Function(...)` site;
 *  3. every module that cannot reach the runtime-eval lane stays untouched —
 *     the byte-neutrality gate. These are refusal pins: they must hold in BOTH
 *     directions, so they fail if the gate is ever widened by accident.
 */
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const DRIVER = "__construct_runtime_eval";

async function compileWat(source: string, target?: "standalone"): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-4438-runtime-eval-construct.ts",
    skipSemanticDiagnostics: true,
    allowJs: true,
    emitWat: true,
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return result;
}

/**
 * The driver's own `(func $__construct_runtime_eval …)` body text.
 *
 * Sliced to the NEXT `(func $` rather than by paren balance: the WAT printer's
 * indentation is not part of the contract, and an over-wide slice silently
 * imports the next function's opcodes into every assertion (which is exactly
 * how the first cut of this file "found" an `unreachable` that belonged to an
 * unrelated helper).
 */
function driverBody(wat: string): string | undefined {
  const start = wat.indexOf(`(func $${DRIVER}`);
  if (start < 0) return undefined;
  const next = wat.indexOf("(func $", start + 1);
  return wat.slice(start, next < 0 ? undefined : next);
}

describe("#4438 — [[Construct]] through a runtime-eval callable", () => {
  it("reserves AND fills the construct driver for `new <Function(src) value>`", async () => {
    const { wat } = await compileWat(
      `var F = Function("this.p = 1;");
       var i = new F();
       export function probe(): number { return 0; }`,
      "standalone",
    );
    const body = driverBody(wat);
    expect(body, "driver must be reserved at the `new` site").toBeDefined();
    // The whole point of the reserve/fill discipline: a surviving stub traps,
    // which is strictly worse than the null it replaces.
    expect(body).not.toContain("unreachable");
    // The brand pair is the driver's identity gate — without it the driver
    // would construct through ANY carrier-shaped value.
    expect(body).toContain(`i32.const ${0x2928}`);
    expect(body).toContain(`i32.const ${0x414f5443}`);
    // §10.2.2: at least the `prototype` read, `__object_create` and
    // `__apply_closure`. Callee indices are numeric in the WAT, so assert the
    // COUNT — a body that lost one of the three would drop below it.
    expect((body!.match(/^\s*call \d+$/gm) ?? []).length).toBeGreaterThanOrEqual(3);
    // Both refusal arms (not a carrier / prototype is not an Object) must keep
    // the site's pre-#4438 null rather than fall through to a constructed value.
    expect((body!.match(/ref\.null extern/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("seeds `prototype` and `constructor` at the `Function(...)` site", async () => {
    const result = await compileWat(
      `var F = Function("this.p = 1;");
       export function probe(): number { return 0; }`,
      "standalone",
    );
    const pool = JSON.stringify(result.stringPool);
    // Both keys must be interned; without them the bag write has no key.
    expect(pool).toContain('"prototype"');
    expect(pool).toContain('"constructor"');
    // The seed needs both helpers materialized in a module that only creates a
    // function value — it never constructs one, so nothing else pulls them in.
    expect(result.wat).toContain("(func $__new_plain_object");
    expect(result.wat).toContain("(func $__defineProperty_value");
    // The provider entry the seeded value comes from.
    expect(result.wat).toContain("__runtime_new_function");
    // …and the driver is NOT reserved, because there is no `new` site. Reserving
    // it here would mean the gate keys off the wrong thing.
    expect(driverBody(result.wat)).toBeUndefined();
  });

  it("REFUSES to touch a standalone module that cannot reach the eval lane", async () => {
    const { wat } = await compileWat(
      `function G() { this.p = 1; }
       var k: any = G;
       var i = new k();
       export function probe(): number { return 0; }`,
      "standalone",
    );
    expect(driverBody(wat)).toBeUndefined();
  });

  it("REFUSES in the JS-host lane, where the host construct bridge owns `new`", async () => {
    const { wat } = await compileWat(
      `var F = Function("this.p = 1;");
       var i = new F();
       export function probe(): number { return 0; }`,
    );
    expect(driverBody(wat)).toBeUndefined();
    expect(wat).not.toContain("__runtime_new_function");
  });

  it("does not add a host import — the standalone lane stays host-free", async () => {
    const result = await compileWat(
      `var F = Function("this.p = 1;");
       var i = new F();
       export function probe(): number { return 0; }`,
      "standalone",
    );
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    // The runtime-eval provider is the ONLY permitted import module here; a new
    // `env::` entry would make the binary un-instantiable host-free (#2961).
    expect(imports.filter((entry) => entry.module === "env")).toEqual([]);
    expect(imports.some((entry) => entry.module === "js2wasm:runtime-eval")).toBe(true);
  });
});
