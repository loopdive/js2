// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2992 S6 — standalone delete / accessor-define on NON-EMPTY pure-data
// literal receivers. Slices 4/5 fixed the empty-`{}`-widening shape; a
// non-empty literal stayed a closed struct where `delete` writes a
// type-shaped sentinel (NaN/null) that every read/`in`/typeof/hasOwnProperty
// consumer then mis-reports, and an accessor define stores a plain value.
// S6 routes such vars to the externref `$Object` builder + refuses struct
// resolution for their checker type, and un-folds the checker-type-based
// consumers (read result, `in`, typeof) for growable-rooted receivers.
// Standalone-gated: the gc/host lane is byte-identical (SHA-asserted twin of
// the #2179 host fix stays a documented residual there).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<any> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" } as any);
  if (!r.success) throw new Error(`Compile failed: ${r.errors?.[0]?.message}`);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as any).test();
}

const mk = (body: string) => `export function test(): number {\n${body}\n}`;

describe("#2992 S6 — standalone delete on non-empty literal receivers", () => {
  it("deleted numeric field reads undefined (no NaN sentinel lie)", async () => {
    expect(
      await runStandalone(
        mk(`const o = { a: 1, b: 2 };\n  delete o.a;\n  if (o.a !== undefined) return 1;\n  return 42;`),
      ),
    ).toBe(42);
  });

  it("deleted string field reads undefined", async () => {
    expect(
      await runStandalone(
        mk(`const o = { name: "hello", n: 1 };\n  delete o.name;\n  if (o.name !== undefined) return 1;\n  return 42;`),
      ),
    ).toBe(42);
  });

  it("typeof of a deleted field is 'undefined' (fold suppressed)", async () => {
    expect(
      await runStandalone(
        mk(`const o = { a: 1 };\n  delete o.a;\n  if (typeof o.a !== "undefined") return 1;\n  return 42;`),
      ),
    ).toBe(42);
  });

  it("'in' observes the deletion and keeps remaining keys (fold suppressed)", async () => {
    expect(
      await runStandalone(
        mk(
          `const o = { a: 1, b: 2 };\n  delete o.a;\n  if ("a" in o) return 1;\n  if (!("b" in o)) return 2;\n  return 42;`,
        ),
      ),
    ).toBe(42);
  });

  it("hasOwnProperty observes the deletion", async () => {
    expect(
      await runStandalone(
        mk(`const o = { a: 1 };\n  delete o.a;\n  if (o.hasOwnProperty("a")) return 1;\n  return 42;`),
      ),
    ).toBe(42);
  });

  it("element-access delete works too", async () => {
    expect(
      await runStandalone(
        mk(`const o = { a: 1, b: 2 };\n  delete o["a"];\n  if (o.a !== undefined) return 1;\n  return 42;`),
      ),
    ).toBe(42);
  });

  it("delete then redefine restores the value", async () => {
    expect(
      await runStandalone(
        mk(`const o = { a: 1 };\n  delete o.a;\n  o.a = 5;\n  if (o.a !== 5) return 1;\n  return 42;`),
      ),
    ).toBe(42);
  });

  it("for-in after delete enumerates only remaining keys", async () => {
    expect(
      await runStandalone(
        mk(
          `const o = { a: 1, b: 2 };\n  delete o.a;\n  let ks = "";\n  for (const k in o) ks += k;\n  if (ks !== "b") return 1;\n  return 42;`,
        ),
      ),
    ).toBe(42);
  });
});

describe("#2992 S6 — standalone accessor define on non-empty literal receivers", () => {
  it("getter defined on a typed const literal is invoked through an any-alias read", async () => {
    expect(
      await runStandalone(
        mk(
          `const o = { a: 1 };\n  Object.defineProperty(o, "b", { get: function() { return 7; } });\n  const x: any = o;\n  if (x.b !== 7) return 1;\n  return 42;`,
        ),
      ),
    ).toBe(42);
  });

  it("getter defined on an any-typed literal is invoked on direct read", async () => {
    expect(
      await runStandalone(
        mk(
          `var o: any = { a: 1 };\n  Object.defineProperty(o, "b", { get: function() { return 7; } });\n  if (o.b !== 7) return 1;\n  return 42;`,
        ),
      ),
    ).toBe(42);
  });
});

describe("#2992 S6 — consumer-safety guard", () => {
  it("a var flowing into a concrete-struct-typed call keeps the struct path (no cast trap)", async () => {
    expect(
      await runStandalone(
        `function f(p: { a: number; b: number }): number { return p.a; }
export function test(): number {
  const o = { a: 3, b: 1 };
  delete o.b;
  return f(o) === 3 ? 42 : 1;
}`,
      ),
    ).toBe(42);
  });
});
