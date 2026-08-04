// #2029 (local-index sub-bucket) — a tagged-template whose tag is a function
// expression that CLOSES OVER an outer local must compile under
// `--target standalone` (was: `Binary emit error: local index out of range`).
//
// Root cause: every `compileExpression` runs inside a speculative
// snapshot/rollback (`snapshotSpeculative`/`rollbackSpeculative`, #1919). The
// tagged-template lowering, while compiling the IIFE tag, triggers closure-
// capture boxing which RE-POINTS the captured outer local in `fctx.localMap`
// (`localMap.set(name, boxedSlot)`). When the enclosing expression rolled back,
// `restoreLocals` (#1847) only DELETED localMap names added since the snapshot —
// it did not RESTORE a re-pointed *existing* name. So the captured variable kept
// pointing at the truncated box slot, and a later read of it (`return calls`)
// emitted a `local.get <stale slot>` past the function's local count → emit
// crash. Fix: `snapshotLocals` now records full localMap ENTRIES (name→slot)
// and `restoreLocals` rebuilds the map exactly, also dropping probe-added
// `boxedCaptures` markings.
//
// This flips the template-literal + tagged-template standalone test262 cluster
// (tv-* / tagged-template/*) from compile_error back to pass.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return (await compile(src, { target: "standalone" })) as any;
}

async function runStandalone(src: string): Promise<number> {
  const r = await compileStandalone(src);
  expect(r.success).toBe(true);
  // Standalone: empty import object must instantiate (no host env leak).
  expect(WebAssembly.Module.imports(new WebAssembly.Module(r.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2029 — tagged template + outer-local-capturing tag (standalone emit)", () => {
  it("IIFE tag capturing an outer local compiles standalone (was: local index out of range)", async () => {
    const r = await compileStandalone(`
      // @ts-nocheck
      export function test(): number {
        var calls = 0;
        (function (s: any) { calls++; })\`foo\`;
        return calls;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.errors.some((e: any) => /index out of range/.test(e.message))).toBe(false);
  });

  it("the captured local reads back correctly at runtime (re-pointed map restored)", async () => {
    // `calls` is captured+mutated by the tag IIFE; after compilation the OUTER
    // read of `calls` must resolve to its real slot, not the rolled-back box slot.
    expect(
      await runStandalone(`
        // @ts-nocheck
        export function test(): number {
          var calls = 7;
          (function (s: any) { return s; })\`foo\`;
          return calls;
        }
      `),
    ).toBe(7);
  });

  it("tagged template with substitutions + capture compiles standalone", async () => {
    const r = await compileStandalone(`
      // @ts-nocheck
      export function test(): number {
        var calls = 0;
        (function (s: any) { calls++; })\`a\${1}b\${2}c\`;
        return calls;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.errors.some((e: any) => /index out of range/.test(e.message))).toBe(false);
  });

  it("the test262 tv-template-head shape (two IIFE tags sharing an outer local) compiles", async () => {
    // Mirrors language/expressions/template-literal/tv-template-head.js after the
    // runner wrap: two function-expression tags each capturing the outer `calls`.
    const r = await compileStandalone(`
      // @ts-nocheck
      export function test(): number {
        var calls = 0;
        (function (s: any) { calls++; return s[0]; })\`\${1}\`;
        calls = 0;
        (function (s: any) { calls++; return s[0]; })\`foo\${1}\`;
        return calls;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.errors.some((e: any) => /index out of range/.test(e.message))).toBe(false);
  });

  it("gc/host mode unaffected — same shape still compiles", async () => {
    const r = (await compile(
      `
      // @ts-nocheck
      export function test(): number {
        var calls = 0;
        (function (s: any) { calls++; })\`foo\`;
        return calls;
      }
    `,
      {},
    )) as any;
    expect(r.success).toBe(true);
  });

  it("a recursive named tag threads its current capture cell", async () => {
    const r = await compileStandalone(`
      // @ts-nocheck
      export function test(): number {
        var finished = 0;
        function tag(_strings: any, n: number): void {
          if (n === 0) {
            finished = 1;
            return;
          }
          tag\`\${n - 1}\`;
        }
        tag(null, 3);
        return finished;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.errors.some((error: any) => /local index out of range/.test(error.message))).toBe(false);
  });

  it("materializes a forward capturing sibling returned as a callable", async () => {
    expect(
      await runStandalone(`
        // @ts-nocheck
        export function test(): number {
          var finished = 0;
          function getF() {
            return f;
          }
          function f(_strings, n) {
            if (n === 0) {
              finished = 1;
              return;
            }
            return getF()(null, n - 1);
          }
          f(null, 4);
          return finished;
        }
      `),
    ).toBe(1);
  });
});
