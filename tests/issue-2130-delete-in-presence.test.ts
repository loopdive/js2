// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2130 — `delete` / `in` must answer against the RUNTIME object shape, not the
 * static struct shape. (#2130 Stage A + Stage B; spec in plan/issues/2130-*.md.)
 *
 * Root cause: `in` (`__extern_has`) used a `__sget_<key>` "getter-doesn't-throw"
 * probe that is a MODULE-GLOBAL field-name test (any receiver "has" a key if
 * ANY struct in the module declares it) and never consulted the runtime delete
 * tombstone — so `delete o.a; "a" in o` stayed true and object-rest `"e" in
 * rest` wrongly reported the source-struct field present.
 *
 * Fix: one shared `_wasmStructHasOwn` predicate (tombstone + sidecar +
 * descriptors + per-receiver struct fields) backs BOTH `__extern_has` and
 * `__hasOwnProperty`; the `__sget_` probe is deleted. Read/`Object.keys` paths
 * consult the tombstone; `_safeSet` clears it on re-add.
 *
 * KNOWN RESIDUAL (spec A5/A6, out of this stage): reading `o.a` after
 * `delete o.a` on a *statically-struct-shaped local `any`* var still takes the
 * `ref.test`/`struct.get` fast path (the field is physically still in the
 * struct), so it reads the stale field rather than `undefined`. That needs the
 * read and delete to agree on the struct type (a codegen read/delete-symmetry
 * change), distinct from this runtime presence model. The opaque-receiver read
 * (param `any`) IS fixed — see the last test.
 */
async function run(src: string, fn: string): Promise<number> {
  const r = await compile(src, {});
  if (!r.success) throw new Error(r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any)[fn]() as number;
}

describe("#2130 — delete/in vs runtime object shape", () => {
  it('`"a" in o` is false after `delete o.a` (tombstone consulted)', async () => {
    expect(
      await run(`export function test(): number { const o:any={a:1,b:2}; delete o.a; return ("a" in o)?0:1; }`, "test"),
    ).toBe(1);
  });

  it('`"b" in o` stays true after `delete o.a` (no over-deletion)', async () => {
    expect(
      await run(`export function test(): number { const o:any={a:1,b:2}; delete o.a; return ("b" in o)?1:0; }`, "test"),
    ).toBe(1);
  });

  it("dynamic-key `delete o[k]` removes the property from `in`", async () => {
    expect(
      await run(
        `export function test(): number { const o:any={a:1,b:2}; const k="a"; delete o[k]; return ("a" in o)?0:1; }`,
        "test",
      ),
    ).toBe(1);
  });

  it('object-rest `"e" in rest` is false (not the source struct shape)', async () => {
    expect(
      await run(
        `export function test(): number { const {e,...rest}:any={e:3,f:4}; return ("e" in rest)?0:1; }`,
        "test",
      ),
    ).toBe(1);
  });

  it('object-rest `"f" in rest` stays true', async () => {
    expect(
      await run(
        `export function test(): number { const {e,...rest}:any={e:3,f:4}; return ("f" in rest)?1:0; }`,
        "test",
      ),
    ).toBe(1);
  });

  it("delete-then-re-add round-trips `in`", async () => {
    expect(
      await run(
        `export function test(): number { const o:any={a:1}; delete o.a; o.a=5; return ("a" in o)?1:0; }`,
        "test",
      ),
    ).toBe(1);
  });

  it("`Object.keys(o)` omits the deleted key", async () => {
    expect(
      await run(
        `export function test(): number { const o:any={a:1,b:2}; delete o.a; return Object.keys(o).length; }`,
        "test",
      ),
    ).toBe(1);
  });

  it("`Object.keys(rest)` stays ['f'] for object-rest (no regression)", async () => {
    expect(
      await run(
        `export function test(): number { const {e,...rest}:any={e:3,f:4}; const k=Object.keys(rest); return k.length===1 && k[0]==="f" ? 1 : 0; }`,
        "test",
      ),
    ).toBe(1);
  });

  it("present own property `in` stays true (no regression)", async () => {
    expect(await run(`export function test(): number { const o:any={a:1}; return ("a" in o)?1:0; }`, "test")).toBe(1);
  });

  it("opaque (param) receiver: `o.a` reads undefined after `delete o.a`", async () => {
    expect(await run(`export function test(o: any): number { delete o.a; return o.a===undefined?1:0; }`, "test")).toBe(
      1,
    );
  });
});
