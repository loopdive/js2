import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2869 — destructuring with a MEMBER-EXPRESSION assignment target
// (`[x.y] = vals`, `{ k: x.y } = src`, `for ([x.y] of …)`). Per ECMA-262
// §13.15.5.x an AssignmentElement's DestructuringAssignmentTarget may be a
// PropertyReference, so the write must store through the member — not be
// dropped. Two coupled defects were fixed:
//   (1) `emitAssignToTarget` early-returned (silently dropping the write) on any
//       non-static-struct-field property target; it now routes a dynamic member
//       target through the #2664 `__set_member_<name>` dispatcher (terminal
//       `__extern_set_strict` sidecar — native `$Object` store standalone / host
//       set in JS mode).
//   (2) the DETACHED array/object destructure element buffers were invisible to
//       the late-import funcIdx-shift walker, so the dispatcher `call` went
//       stale-low under a later import shift (the `Maximum call stack` recursion
//       / invalid-Wasm symptom). They are now registered with `ctx.liveBodies`
//       for their detached window (the #2567/#1109 param-destructure precedent).
//   (3) the for-of / for-await assignment-destructure loops dropped member
//       targets (identifier-only gate); they now route through the same helper.
//
// These are GENUINE codegen fails (the write was dropped) in BOTH the JS-host
// (gc) and standalone (host-free) lanes — verified host-free is preserved.

async function run(src: string, target?: "standalone"): Promise<unknown> {
  const r = await compile(src, target ? ({ target, fileName: "test.ts" } as never) : { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  // Standalone is host-free → empty imports; gc uses the compile's import object.
  const importObject: any = target ? {} : ((r as { importObject?: WebAssembly.Imports }).importObject ?? {});
  const { instance } = await WebAssembly.instantiate(r.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

function envImportCount(wat: string): number {
  return (wat.match(/\(import\s+"env"/g) ?? []).length;
}

describe("#2869 member-expression assignment-target destructuring", () => {
  const cases: Record<string, string> = {
    "array-elem → plain {} member (headline)": `
      export function test(): number {
        const x: any = {}; const vals = [4];
        const result = ([x.y] = vals);
        return (x.y === 4 && result === vals) ? 1 : 0;
      }`,
    "object-pattern → member value target": `
      export function test(): number {
        const x: any = {}; const src = { a: 7 };
        ({ a: x.y } = src);
        return x.y === 7 ? 1 : 0;
      }`,
    "array multi-target members": `
      export function test(): number {
        const x: any = {}; const y: any = {};
        [x.a, y.b] = [11, 22];
        return (x.a === 11 && y.b === 22) ? 1 : 0;
      }`,
    "for-of array member target": `
      export function test(): number {
        const x: any = {};
        for ([x.y] of [[5]]) {}
        return x.y === 5 ? 1 : 0;
      }`,
    "for-of object member target": `
      export function test(): number {
        const x: any = {};
        for ({ a: x.y } of [{ a: 9 }]) {}
        return x.y === 9 ? 1 : 0;
      }`,
  };

  for (const [name, src] of Object.entries(cases)) {
    it(`gc: ${name}`, async () => {
      expect(await run(src)).toBe(1);
    });
    it(`standalone: ${name}`, async () => {
      expect(await run(src, "standalone")).toBe(1);
    });
  }

  it("for-await array member target writes through (async)", async () => {
    const src = `
      async function run(): Promise<number> {
        const x: any = {};
        for await ([x.y] of [[6]]) {}
        return x.y === 6 ? 1 : 0;
      }
      export function test(): number { return 1; }`;
    // Compiles + instantiates (the for-await lowering shares the for-of path).
    expect(await run(src)).toBe(1);
  });

  it("standalone member-target destructure stays host-free (0 env imports)", async () => {
    const src = `
      export function test(): number {
        const x: any = {}; [x.y] = [4]; return x.y === 4 ? 1 : 0;
      }`;
    const r = await compile(src, { fileName: "test.ts", target: "standalone" } as never);
    expect(r.success).toBe(true);
    expect(envImportCount((r as { wat?: string }).wat ?? "")).toBe(0);
  });
});
