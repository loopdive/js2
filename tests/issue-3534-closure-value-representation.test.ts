/**
 * #3534 / #3533 — unified closure-value representation (option a, step 2).
 *
 * Root defect (single, seen from three sites): a closure binding is declared
 * type-erased (`externref` module global / externref pre-hoist local), then the
 * declaration compile RETRO-narrows it to the precise closure struct:
 *
 *  - module global (`$__mod_<name>`): the narrow retroactively invalidated
 *    every already-emitted `global.get` whose consumer took externref at face
 *    value — `class C { c = fn }` → `struct.set expected externref, found
 *    (ref null N)` invalid Wasm (#3533, 34-file
 *    `language/expressions/class/elements/*-literal-names.js` cluster).
 *
 *  - function-local slot: forward-referencing sibling closures box the binding
 *    into an externref ref cell and re-aim `localMap[name]` at the CELL local;
 *    the declaration then reused that slot, retyped it to the closure struct
 *    and raw-stored the closure over it. stack-balance's fixLocalSetCoercion
 *    "repaired" the earlier `struct.new <cell>; local.tee` with a statically
 *    impossible unguarded `ref.cast_null` — a GUARANTEED `illegal cast` trap
 *    at runtime (#3534: nativeFunctionMatcher's mutually-referencing
 *    `eat`/`test` closures; 67 illegal-cast rows across the
 *    built-ins/Function/prototype/toString dir).
 *
 * The same retype also re-registered the closure STRUCT itself as the ref cell
 * (`boxedCaptures[name].refCellTypeIdx` = the closure struct, whose field 0 is
 * funcref) — which is what #3024's call-site slice observed as a "bare funcref
 * cell". One defect, three symptoms.
 *
 * Fix (variables.ts, arrow/function-expression declaration path):
 *  - NEVER retro-narrow the externref `$__mod_<name>` global; box on store
 *    (`extern.convert_any`). Calls take `compileClosureCall`'s existing guarded
 *    externref arm; value-reads are valid as-emitted.
 *  - When the binding was boxed-before-declared, write the closure value
 *    THROUGH the ref cell (`boxedForInitStore` convention) instead of retyping
 *    the cell slot, and flip the (possibly boxed) local TDZ flag.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSource } from "../src/compiler.ts";
import { buildImports } from "../src/runtime.ts";
import { instantiateWasm } from "../src/runtime-instantiate.ts";
import { runTest262File } from "./test262-runner.ts";

const T262 = join(process.cwd(), "test262");

async function run(source: string): Promise<unknown> {
  const r = await compileSource(source);
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const binary = new Uint8Array(r.binary);
  // Must validate (the #3533 signature was an instantiate-time validation error).
  await WebAssembly.compile(binary as BufferSource);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await instantiateWasm(binary, imports.env, imports.string_constants, imports.string_constants16);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#3534/#3533 — closure-value representation (never-narrow + box-on-store)", () => {
  it("#3533: class field initialized to a module-const function value runs (was invalid Wasm)", async () => {
    const got = await run(`const fn = function (): number { return 4; };
class C { c = fn; }
export function test(): number { const o = new C(); return o.c(); }`);
    expect(got).toBe(4);
  });

  it("module-const closure still callable through the boxed global (call arm)", async () => {
    const got = await run(`const f = (x: number): number => x + 1;
export function test(): number { return f(41); }`);
    expect(got).toBe(42);
  });

  it("mutually-recursive module consts still work (boxed global, guarded cast)", async () => {
    const got = await run(`const even = (n: number): boolean => n === 0 ? true : odd(n - 1);
const odd = (n: number): boolean => n === 0 ? false : even(n - 1);
export function test(): number { return even(10) && !odd(10) ? 1 : 0; }`);
    expect(got).toBe(1);
  });

  it("boxed-before-declared local closure initializes THROUGH the cell (no slot retype)", async () => {
    // Forward-referencing sibling closures force the `check` binding into a
    // ref cell before its declaration compiles — the #3534 construct shape.
    const got = await run(`const outer = function (s: string): number {
  let pos = 0;
  const eat = (tok: string): number => { pos += tok.length; return check(tok); };
  const check = (tok: string): number => (tok.length > 0 ? pos : eat("x"));
  return eat(s);
};
export function test(): number { return outer("ab"); }`);
    expect(got).toBe(2);
  });

  it.runIf(existsSync(T262))(
    "#3534: matcher-invoking toString files no longer trap (bound-function.js passes)",
    async () => {
      const abs = join(T262, "test/built-ins/Function/prototype/toString/bound-function.js");
      if (!existsSync(abs)) return;
      const r = await runTest262File(abs, "built-ins/Function", 30000);
      const msg = String((r as { error?: unknown }).error ?? "");
      expect(msg).not.toMatch(/illegal cast/);
      expect(r.status).toBe("pass");
    },
    120000,
  );

  it.runIf(existsSync(T262))(
    "#3534: validateNativeFunctionSource construct site reaches a genuine verdict (no illegal cast)",
    async () => {
      for (const f of ["arrow-function.js", "Function.js"]) {
        const abs = join(T262, "test/built-ins/Function/prototype/toString", f);
        if (!existsSync(abs)) continue;
        const r = await runTest262File(abs, "built-ins/Function", 30000);
        const msg = String((r as { error?: unknown }).error ?? "");
        // Pass or a genuine Test262Error oracle verdict — never the construct trap.
        expect(msg, `${f}: ${r.status} — ${msg}`).not.toMatch(/illegal cast/);
      }
    },
    180000,
  );
});
