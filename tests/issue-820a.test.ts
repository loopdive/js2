/**
 * Tests for #820a: RegExp Symbol.match/replace/search/matchAll/RegExpStringIterator
 * null pointer dereference.
 *
 * Root cause: `r[Symbol.match](s)` (and the @@replace/@@search/@@matchAll
 * variants) had no resolved-method-name handler in codegen/expressions/calls.ts.
 * The fallback dropped the receiver and arguments and emitted ref.null.extern,
 * which downstream `result.length`, `iter.next()`, etc. then null-dereffed.
 * Additionally, `matchAll` was missing from WELL_KNOWN_SYMBOLS, so
 * `r[Symbol.matchAll]` could not even resolve to "@@matchAll".
 *
 * Fix: route the four well-known Symbols to host imports that perform the
 * ECMA-262 21.2.5 dispatch (Get(R, "exec") + ToLength(R.lastIndex) via the JS
 * engine's RegExp.prototype[Symbol.X] implementation). Pre-wrap WasmGC-closure
 * `exec` overrides as JS-callable so IsCallable returns true and user
 * overrides actually run.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, CallableFunction>).main?.();
}

describe("#820a — RegExp Symbol.* dispatch (no null-deref, exec override honored)", () => {
  it("r[Symbol.match] returns a match array on success", async () => {
    const r = await run(`
      export function main(): number {
        var re = /./;
        var result: any = re[Symbol.match]('abc');
        if (result === null) return -1;
        if (result.length !== 1) return -2;
        if (result[0] !== 'a') return -3;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("r[Symbol.match] coerces non-integer lastIndex via ToLength (sticky flag)", async () => {
    // test262: built-ins/RegExp/prototype/Symbol.match/builtin-coerce-lastindex.js
    const r = await run(`
      export function main(): number {
        var re = /./y;
        (re as any).lastIndex = '1.9';
        var result: any = re[Symbol.match]('abc');
        if (result === null) return -1;
        if (result.length !== 1) return -2;
        if (result[0] !== 'b') return -3;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("r[Symbol.match] invokes user-provided exec override (callCount)", async () => {
    // test262: built-ins/RegExp/prototype/Symbol.match/exec-invocation.js (core)
    const r = await run(`
      export function main(): number {
        var re = /./;
        var callCount = 0;
        (re as any).exec = function() {
          callCount += 1;
          return null;
        };
        re[Symbol.match]('arg');
        return callCount;
      }
    `);
    expect(r).toBe(1);
  });

  it("r[Symbol.match] propagates user exec throws", async () => {
    // test262: built-ins/RegExp/prototype/Symbol.match/exec-err.js
    const r = await run(`
      export function main(): number {
        var re = /./;
        (re as any).exec = function() { throw new Error('boom'); };
        var threw = 0;
        try { re[Symbol.match](''); } catch (e: any) { threw = 1; }
        return threw;
      }
    `);
    expect(r).toBe(1);
  });

  it("r[Symbol.replace] performs replacement", async () => {
    const r = await run(`
      export function main(): number {
        var re = /b/;
        var out: any = re[Symbol.replace]('abc', 'X');
        return out === 'aXc' ? 1 : -1;
      }
    `);
    expect(r).toBe(1);
  });

  it("r[Symbol.search] returns the match index", async () => {
    const r = await run(`
      export function main(): number {
        var re = /c/;
        return re[Symbol.search]('abcdef');
      }
    `);
    expect(r).toBe(2);
  });

  it("r[Symbol.search] returns -1 when no match", async () => {
    const r = await run(`
      export function main(): number {
        var re = /z/;
        return re[Symbol.search]('abc');
      }
    `);
    expect(r).toBe(-1);
  });

  it("r[Symbol.matchAll] yields a RegExpStringIterator whose .next() works", async () => {
    // test262: built-ins/RegExpStringIteratorPrototype/next/next-iteration.js (essence)
    const r = await run(`
      export function main(): number {
        var re = /\\w/g;
        var iter: any = re[Symbol.matchAll]('*a*b');
        var n1: any = iter.next();
        if (n1.done) return -1;
        if (n1.value[0] !== 'a') return -2;
        var n2: any = iter.next();
        if (n2.done) return -3;
        if (n2.value[0] !== 'b') return -4;
        var n3: any = iter.next();
        if (!n3.done) return -5;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("r[Symbol.match] with global flag returns all matches as an array", async () => {
    const r = await run(`
      export function main(): number {
        var re = /\\w/g;
        var result: any = re[Symbol.match]('a*b*c');
        if (result === null) return -1;
        if (result.length !== 3) return -2;
        if (result[0] !== 'a' || result[1] !== 'b' || result[2] !== 'c') return -3;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });

  it("Symbol.matchAll resolves to '@@matchAll' (well-known symbol table entry)", async () => {
    // Without the WELL_KNOWN_SYMBOLS entry, the codegen path would fall through
    // to the drop-everything fallback and the iterator returned by matchAll
    // would be null. This confirms the dispatch is wired up.
    const r = await run(`
      export function main(): number {
        var re = /a/g;
        var iter: any = re[Symbol.matchAll]('aaa');
        if (iter == null) return 0;
        return 1;
      }
    `);
    expect(r).toBe(1);
  });
});
