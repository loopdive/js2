// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3621 slice 1 — `delete obj.prop` asserted the receiver's representation from
// the checker's view of its DECLARATION, and trapped when the value disagreed.
//
// `compileDeleteExpression` resolves the backing struct from
// `resolveStructName(checker.getTypeAtLocation(receiver))` — the object
// literal's declared shape — then emits a `struct.set` to poison the field. For
// `delete this.x` inside an accessor that is invoked REFLECTIVELY (through
// `__call_accessor_get` ← `__extern_get`, e.g. via a `with` scope), `this` is
// bound to whatever the accessor was called on, so the coercion to that struct
// became `ref.cast null (ref null $Shape)` over a value that is not that shape
// — an UNCATCHABLE `illegal cast` that aborts the whole module.
//
// Same invariant as #3610 / #3620: a `ref.cast` is a claim that the value's
// runtime representation is known, and a static type is not that evidence.
// Unlike #3610 this one is not compile-time decidable, so the remedy is the
// runtime arm: `ref.test`, skip the field poke on a miss.
//
// NOTE ON METHOD. The trap needs the real test262 harness shape; a hand-written
// TypeScript `with` repro does NOT reproduce it (verified: it returns the same
// value before and after the fix, so it is not a repro — the same
// check-the-control discipline that caught an over-reaching assertion in
// #3620). So the trap assertion below runs the ACTUAL failing test262 input
// through compile + instantiate and asserts on the observable OUTCOME CLASS:
// a `WebAssembly.RuntimeError` (uncatchable trap, aborts the module) must not
// occur. The value-level `delete` semantics are asserted separately on
// self-contained sources.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { assembleOriginalHarness } from "./test262-original-harness.ts";
import { parseMeta } from "./test262-runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST262 = resolve(HERE, "..", "test262");

async function instantiate(src: string) {
  const r = await compile(src, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return instance.exports as Record<string, unknown>;
}

async function runStandalone(src: string): Promise<unknown> {
  const ex = await instantiate(src);
  (ex.__module_init as (() => void) | undefined)?.();
  return (ex.test as () => unknown)();
}

/** Run a real test262 file's assembled harness; return the thrown error, if any. */
async function runTest262Raw(rel: string): Promise<unknown> {
  const source = readFileSync(resolve(TEST262, rel), "utf-8");
  const asm = assembleOriginalHarness(source, parseMeta(source));
  const src = (asm.primary as { source?: string }).source ?? (asm.primary as never as string);
  const ex = await instantiate(src as string);
  try {
    (ex.__module_init as () => void)();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe("#3621 a reflectively-bound receiver no longer traps in `delete`", () => {
  // These four all trapped with `WebAssembly.RuntimeError: illegal cast` before
  // the guard. They still FAIL (the underlying `with`-scope PutValue write-back
  // is a separate feature gap) — but they now fail CATCHABLY, so the failure is
  // reportable instead of aborting the module and poisoning every later
  // assertion in the file.
  const cases = [
    "test/language/expressions/compound-assignment/S11.13.2_A5.10_T3.js",
    "test/language/expressions/compound-assignment/S11.13.2_A5.11_T3.js",
    "test/language/expressions/postfix-increment/S11.3.1_A5_T3.js",
    "test/language/expressions/prefix-increment/S11.4.4_A5_T3.js",
  ];
  for (const rel of cases) {
    it(`${rel.split("/").slice(-2).join("/")} does not raise an uncatchable trap`, async () => {
      const err = await runTest262Raw(rel);
      // A thrown Test262Error / WasmGC exception is fine — a RuntimeError is not.
      expect(err).not.toBeInstanceOf(WebAssembly.RuntimeError);
    });
  }
});

describe("#3621 ordinary `delete` semantics are unchanged", () => {
  it("property access: the deleted field reads undefined, siblings survive", async () => {
    expect(
      await runStandalone(
        `export function test() { const o: any = { a: 5, b: 6 }; delete o.a; return (o.a === undefined ? 1 : 0) + (o.b === 6 ? 10 : 0); }`,
      ),
    ).toBe(11);
  });
  it("element access: the deleted field reads undefined, siblings survive", async () => {
    expect(
      await runStandalone(
        `export function test() { const o: any = { a: 5, b: 6 }; delete o["a"]; return (o.a === undefined ? 1 : 0) + (o.b === 6 ? 10 : 0); }`,
      ),
    ).toBe(11);
  });
  it("delete reports true for a configurable own property", async () => {
    expect(
      await runStandalone(`export function test() { const o: any = { a: 5 }; return (delete o.a) === true ? 1 : 0; }`),
    ).toBe(1);
  });
  it("deleting a missing property still reports true", async () => {
    expect(
      await runStandalone(
        `export function test() { const o: any = { a: 5 }; return (delete o.zzz) === true ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
  it("a non-object receiver is untouched by the guard", async () => {
    expect(
      await runStandalone(`export function test() { const n: any = 5; return (delete n.x) === true ? 1 : 0; }`),
    ).toBe(1);
  });
});
