import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

/**
 * #1671 — object-method trampoline / direct dispatch lost the real receiver,
 * leaving the canonical method func an empty stub (completes #1669/#621/#1602).
 *
 * Root cause: an object-literal method's param signature is computed in THREE
 * places that must agree:
 *
 *   1. The canonical `funcMap` pre-registration in `index.ts`
 *      (`ensureStructForType`, the method pre-registration loop) — the func a
 *      *direct* call `obj.method()` dispatches through.
 *   2. The per-literal fork decision in `literals.ts`
 *      (`compileObjectLiteralForStruct`, the `newParams` loop).
 *   3. The actual body compile in `literals.ts` (the `methodParams` loop).
 *
 * Body compile (#3) routes binding-pattern params through the externref
 * destructure path (#1151 Gap B) and widens default-init `ref` params to
 * `ref_null`. The pre-registration (#1) did NEITHER, so for a method with an
 * array/object binding-pattern param (e.g. `async *method([, , ...x] = […])`)
 * the canonical func was registered as `(this, (ref null vec))` while the body
 * compiled to `(this, externref)`. The signature MISMATCH made the body-compile
 * fork a *per-literal* funcIdx and leave the canonical `funcMap` entry an empty
 * stub body (`ref.null extern` for an externref result).
 *
 * A direct call `obj.method()` (dispatched via funcMap, not the per-literal
 * map) then landed on the EMPTY stub: it returned `ref.null extern` instead of
 * the async generator, and the test's `.next()` traps with
 * "dereferencing a null pointer" / "Cannot read properties of null (reading
 * 'next')". The module still VALIDATED (the stub is well-typed), so #621's
 * valid-wasm property held — but ~200 tests under language/expressions/object
 * + class null-deref'd at RUNTIME.
 *
 * Fix: apply the same default-init `ref→ref_null` and binding-pattern
 * `→externref` widening at the pre-registration and the fork-decision sig, so
 * all three computations agree, no spurious fork happens, the real body lands
 * in the canonical func, and `obj.method()` reaches it.
 *
 * These tests RUN the wasm (not just validate) — they null-deref before the
 * fix and return the correct value after.
 */

async function compileAndRun(source: string): Promise<number | undefined> {
  const result = await compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(
    (result as unknown as { imports: unknown[] }).imports as never,
    undefined,
    (result as unknown as { stringPool: unknown }).stringPool as never,
  );
  // Use the sync Module/Instance path so the assertion stays synchronous —
  // these modules have no start-function side effects to await.
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports as WebAssembly.Imports);
  return (instance.exports as { test?: () => number | undefined }).test?.();
}

describe("#1671 object-method trampoline must forward the real receiver", () => {
  it("direct call to an object method with an array-binding-pattern param reads `this` (would null-deref before fix)", async () => {
    // The array-binding-pattern param forces the method's param to externref in
    // the body compile. Before the fix the canonical funcMap entry was a stub,
    // so `obj.run(...)` returned undefined/null and `this.base` was never read.
    const source = `
      const obj = {
        base: 100,
        run([a, b] = [1, 2]): number {
          return (this as any).base + a + b;
        },
      };
      export function test(): number {
        const r = obj.run([10, 20]);
        return r === 130 ? 1 : r;
      }
    `;
    expect(await compileAndRun(source)).toBe(1);
  });

  it("object method with object-binding-pattern param dispatched directly returns the right value", async () => {
    const source = `
      const obj = {
        factor: 3,
        scale({ v } = { v: 7 }): number {
          return (this as any).factor * v;
        },
      };
      export function test(): number {
        const r = obj.scale({ v: 5 });
        return r === 15 ? 1 : r;
      }
    `;
    expect(await compileAndRun(source)).toBe(1);
  });

  it("generator method with a binding-pattern rest param iterates correctly via direct call", async () => {
    // Mirrors the test262 async-gen-meth-dflt-ary-ptrn-rest-id-exhausted shape
    // (sync generator variant so the assertion is synchronous): the rest
    // binding pattern forces an externref param; the canonical func must hold
    // the real body so `obj.gen().next()` yields, not null-deref.
    const source = `
      const obj = {
        seed: 11,
        *gen([, , ...rest] = [1, 2, 3, 4]): any {
          yield (this as any).seed + rest.length;
        },
      };
      export function test(): number {
        const it = obj.gen();
        const first = it.next();
        // seed(11) + rest.length(2) = 13
        return first.value === 13 ? 1 : first.value;
      }
    `;
    expect(await compileAndRun(source)).toBe(1);
  });

  // The exact test262 source that drove the investigation. It's an async
  // generator method, so success is observed via $DONE rather than a sync
  // return; here we assert it COMPILES + instantiates + the synchronous prefix
  // (building the async generator + first .next()) does NOT trap. Before the
  // fix `obj.method()` returned a null async-generator and `.next()` trapped.
  const TEST262 = join(__dirname, "..", "test262", "test");
  const rel = "language/expressions/object/dstr/async-gen-meth-dflt-ary-ptrn-rest-id-exhausted.js";
  const abs = join(TEST262, rel);
  it.skipIf(!existsSync(abs))(`real test262 source runs without null-deref: ${rel}`, async () => {
    const raw = readFileSync(abs, "utf-8");
    const { source } = wrapTest(raw, parseMeta(raw));
    const result = await compile(source, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const imports = buildImports(
      (result as unknown as { imports: unknown[] }).imports as never,
      undefined,
      (result as unknown as { stringPool: unknown }).stringPool as never,
    );
    const mod = new WebAssembly.Module(result.binary);
    const instance = new WebAssembly.Instance(mod, imports as WebAssembly.Imports);
    // Must not throw "dereferencing a null pointer" — the generator + first
    // .next() are driven synchronously inside `test()`.
    expect(() => (instance.exports as { test?: () => unknown }).test?.()).not.toThrow();
  });
});
