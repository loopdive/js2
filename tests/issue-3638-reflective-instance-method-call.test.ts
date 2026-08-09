// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3638 — a reflective `.call`/`.apply` whose receiver is an INSTANCE member
// read of a builtin prototype method (`a.fill.call(t, 9)`, `[].fill.call({}, 1)`)
// emitted an UNCONDITIONAL `ref.cast` of a value that is null at runtime, i.e.
// an uncatchable `illegal cast` trap. A trap aborts the module, so the enclosing
// `try`/`catch` — and test262's `assert.throws` — can never observe it.
//
// Every behavioural assertion reads an OBSERVABLE VALUE out of the compiled
// module (a caught-error discriminant, a side-effect counter). "It compiles" is
// never asserted, and a trap surfaces as a rejected `runStandalone`, so
// "no uncatchable trap" is enforced by these tests completing at all.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

async function compileStandalone(src: string, emitWat = false) {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true, emitWat } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  return r;
}

async function runStandalone(src: string): Promise<unknown> {
  const r = await compileStandalone(src);
  const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: Record<string, unknown>) => void };
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  io.__setExports?.(instance.exports as Record<string, unknown>);
  return (instance.exports as { test(): unknown }).test();
}

const wrap = (body: string) => `export function test() { ${body} }`;

/** 1 = completed normally, 2 = caught a TypeError, 3 = caught something else. */
const guard = (body: string) => `try { ${body} return 1; } catch (e) { return e instanceof TypeError ? 2 : 3; }`;

/** Did the module take the reflective-call lowering this issue fixes? */
async function usesReflectiveLowering(body: string): Promise<boolean> {
  const r = await compileStandalone(wrap(body), true);
  return ((r as { wat?: string }).wat ?? "").includes("__builtinfn_singleton_");
}

// The programs the behavioural block below relies on. Each is paired with the
// premise check so a case can never silently stop covering the defect.
const COVERED: Array<[name: string, body: string, expected: number]> = [
  ["a.fill.call(t, 9) — named array base", `var a = [0]; var t = [1, 2]; ${guard("a.fill.call(t, 9);")}`, 2],
  ["[].fill.call({}, 1) — plain-object thisArg", `var o = {}; ${guard("[].fill.call(o, 1);")}`, 2],
  ["[].sort.call(undefined)", guard("[].sort.call(undefined);"), 2],
  ["[].toString.call({})", `var o = {}; ${guard("[].toString.call(o);")}`, 2],
  ["[].fill.apply(t, [9]) — the .apply spelling", `var t = [1, 2]; ${guard("[].fill.apply(t, [9]);")}`, 2],
  ["a.indexOf.call(t, 6)", `var a = [0]; var t = [5, 6, 7]; ${guard("a.indexOf.call(t, 6);")}`, 2],
  ["a.slice.call(t, 1) — completes normally", `var a = [0]; var t = [1, 2, 3]; ${guard("a.slice.call(t, 1);")}`, 1],
];

// ── Premise assertions ──────────────────────────────────────────────────────
// A regression test proves a fix DETECTS the bug; a premise assertion proves it
// EXERCISES the path it claims to. That distinction is load-bearing here: an
// earlier array-aware arm claims `Array.prototype.fill.call(<vec>, …)` and
// `[].fill.call(<vec>, …)` outright, so those spellings never reach the
// reflective lowering at all. An obvious-looking suite built on them would pass
// on unmodified main and cover nothing — the first draft of this file did
// exactly that, and only the premise check caught it.
describe("#3638 premise: every covered case reaches the reflective-call lowering", () => {
  for (const [name, body] of COVERED) {
    it(`${name} takes the singleton lowering`, async () => {
      expect(await usesReflectiveLowering(body)).toBe(true);
    });
  }

  // Negative controls — without these the premise check could be vacuously true.
  it("negative control: a DIRECT method call does not take it", async () => {
    expect(await usesReflectiveLowering(`var t = [1, 2]; t.fill(9); return t[0];`)).toBe(false);
  });

  it("negative control: Array.prototype.fill.call(<vec>, …) does not take it", async () => {
    expect(await usesReflectiveLowering(`var t = [1, 2]; Array.prototype.fill.call(t, 9); return t[0];`)).toBe(false);
  });
});

// ── The outcome is observable from inside Wasm, never an uncatchable trap ────
describe("#3638 an instance-read reflective call is catchable, not a trap", () => {
  for (const [name, body, expected] of COVERED) {
    it(name, async () => {
      expect(await runStandalone(wrap(body))).toBe(expected);
    });
  }
});

// ── The receiver base keeps its side effects, exactly once ───────────────────
describe("#3638 the receiver base is still evaluated for its side effects", () => {
  it("f().fill.call(t, 9) calls f exactly once", async () => {
    const src = wrap(
      `var n = 0;
       function f() { n = n + 1; return [0]; }
       var t = [1, 2];
       try { f().fill.call(t, 9); } catch (e) {}
       return n;`,
    );
    expect(await runStandalone(src)).toBe(1);
  });
});

// ── KNOWN RESIDUAL (pinned so it cannot regress silently) ───────────────────
// `var f = [].fill; f.call(o, 1)` still traps: the receiver is an IDENTIFIER, so
// the syntactic classifier cannot see that its value came from an instance
// member read — and that read is the separate upstream gap (`a.fill` reads as
// null on BOTH lanes; see the issue's Residual section). Pinned as a KNOWN GAP
// rather than omitted, so closing that gap flips this test loudly.
describe("#3638 KNOWN GAP: an identifier bound to an instance member read", () => {
  it("var f = [].fill; f.call(o, 1) still traps", async () => {
    await expect(runStandalone(wrap(`var o = {}; var f = [].fill; ${guard("f.call(o, 1);")}`))).rejects.toThrow(
      /illegal cast/,
    );
  });
});
