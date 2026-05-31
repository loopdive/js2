// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1340 — Function-decl closure-singleton cache.
 *
 * A plain `function foo(){}` used in value position was compiled to a fresh
 * `struct.new $closure_struct` at every textual occurrence, so:
 *   - `foo === foo` returned false (each access yielded a distinct ref);
 *   - sidecar writes on `(foo as any).prototype = X` did not round-trip,
 *     because the sidecar map is keyed by externref identity (struct A from
 *     the write site never matched struct B from the read site).
 *
 * The fix wires `emitCachedFuncClosureAccess` for captureless top-level
 * function declarations: one externref global per function, lazily
 * initialised on first read, reused thereafter. Mirrors the per-method
 * cache from #1394 (`emitCachedMethodClosureAccess`).
 *
 * Test262 impact: the `built-ins/Iterator/prototype/*` shim
 * `function Iterator(){}; (Iterator as any).prototype = …` finally
 * round-trips, flipping ~88 misclassified `wasm_compile` failures back
 * to runtime errors that the spec'd helpers handle.
 */

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  const exp = instance.exports as Record<string, unknown>;
  if (typeof (imports as { setExports?: (e: unknown) => void }).setExports === "function") {
    (imports as { setExports: (e: unknown) => void }).setExports(exp);
  }
  const fn = exp.test as (() => unknown) | undefined;
  if (typeof fn !== "function") throw new Error("no test() export");
  return fn();
}

describe("#1340 function-decl closure-singleton cache", () => {
  it("identity: f === f across reads", async () => {
    const src = `
      function foo(): void {}
      export function test(): number {
        const a: any = foo;
        const b: any = foo;
        return a === b ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("prototype round-trip on a function decl", async () => {
    const src = `
      function foo(): void {}
      export function test(): number {
        (foo as any).prototype = { tag: 42 };
        return (foo as any).prototype.tag;
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("Iterator-helper shim: host externref prototype assignment round-trips", async () => {
    // The exact shape used by tests/test262-runner.ts:1705 to materialise the
    // `Iterator` constructor for built-ins/Iterator/prototype/* tests. Before
    // #1340, the prototype assignment was lost because each textual occurrence
    // of `Iterator` produced a distinct closure-struct extern (struct A on the
    // write, struct B on the read; sidecar mirror keyed by A never seen by B).
    // With the singleton cache, the write site and read site share the same
    // externref so the sidecar round-trips. (Whether the JS engine's helper
    // methods on that prototype are individually invokable is a separate
    // host-bridge concern, tracked by downstream issues.)
    const src = `
      function Iterator(this: any): void {}
      export function test(): number {
        (Iterator as any).prototype = Object.getPrototypeOf(
          Object.getPrototypeOf([][Symbol.iterator]())
        );
        const p = (Iterator as any).prototype;
        return p == null ? 0 : 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
