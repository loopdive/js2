import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2029 — object literal mixing a DATA property with an accessor crashed the
// standalone binary emitter.
//
// An object literal that carries any get/set accessor is routed through the
// host-object (externref) path. In that path each plain DATA property key was
// materialized with a raw `{ op: "global.get", index: stringGlobalMap.get(key) }`.
// Under `--target standalone` / nativeStrings, `addStringConstantGlobal` records
// the -1 sentinel ("no host string-constant global — materialize inline", #1174),
// so the emitted `global.get -1` blew up the encoder:
//   `Binary emit error: Codegen error: global index out of range — -1`
// — a hard compile_error losing the whole file. This drove the bulk of the
// standalone `built-ins/Iterator/prototype` failures (their throwing-iterator
// fixtures return `{ done: true, get value() { … } }` — a data key + accessor).
//
// The accessor key in the same path already used the dual-mode
// `stringConstantExternrefInstrs` helper; the fix applies it to the data key too.
// gc/host mode is unaffected (real globals, never the sentinel).

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

describe("#2029 object literal data-property + accessor standalone emit", () => {
  it("data property before a getter compiles standalone (was: global index out of range -1)", async () => {
    const r = await compileStandalone(
      `function f(): any { return { a: 1, get v() { return 5; } }; } export function test(): number { return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("data property after a getter compiles standalone", async () => {
    const r = await compileStandalone(
      `function f(): any { return { get v() { return 5; }, a: 1 }; } export function test(): number { return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("data property mixed with a setter compiles standalone", async () => {
    const r = await compileStandalone(
      `function f(): any { return { a: 1, set v(x: number) {} }; } export function test(): number { return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("multiple data properties + accessor compile standalone", async () => {
    const r = await compileStandalone(
      `function f(): any { return { a: 1, b: 2, get v() { return 3; } }; } export function test(): number { return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("the Iterator throwing-iterator next() shape compiles standalone", async () => {
    const r = await compileStandalone(
      `class X extends Iterator { next(): any { return { done: true, get value() { throw new Error(); } }; } } export function test(): number { return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("does not emit a -1 string-global for the data key (no encoder crash)", async () => {
    const r = await compileStandalone(
      `function f(): any { return { a: 1, get v() { return 5; } }; } export function test(): number { return 1; }`,
    );
    expect(r.success).toBe(true);
    expect(r.errors.some((e) => /global index out of range/.test(e.message))).toBe(false);
  });

  it("host (gc) mode unaffected — data + accessor literal still compiles", async () => {
    const r = await compile(
      `function f(): any { return { a: 1, get v() { return 5; } }; } export function test(): number { return 1; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
  });
});
