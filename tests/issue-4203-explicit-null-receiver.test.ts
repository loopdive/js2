// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4203 — ES5 §10.4.3: an EXPLICITLY-null receiver is not an ABSENT one.
//
// `__current_this` spelled both states `ref.null.extern`, so a strict callee
// answered `undefined` for `f.call(null)` where the spec says `null`. Two
// independent defects sat on top of that substrate and are covered here too:
//
//   * `f.bind(t, …)(…)` reshaped to a direct `call $f` and evaluated `t` only
//     for its side effects — the evaluate-and-DROP wrong answer #4025 removed
//     for `.call` and #3983 for `.apply`, left standing for `.bind`;
//   * the trampoline's admission gate refused every statically-nullish
//     receiver, so `f.call(null)` never reached it at all.
//
// ── The trap this file is mostly here to pin ──────────────────────────────
// §10.4.3 does NOT say "stop coercing null". A **sloppy** callee handed `null`
// still binds the global object, exactly as an absent receiver does; only
// strict code observes the difference. Half the cases below are that guard,
// green on both arms, and they are the point — a fix that turned sloppy
// `f.call(null)` into `null` would look like progress on the strict rows while
// silently breaking a much larger population.
//
// ── Harness: no `export`, throw-to-fail (inherited from #4190/#4202) ───────
// A top-level `export` makes TypeScript call the source a MODULE, and module
// code is strict throughout — which would erase the sloppy half of every case.
// So the body carries no export, signals failure by throwing, and completing
// `__module_init` IS the pass; `inferModuleStrictArguments: false` pins the
// Script goal exactly as `runTest262File` does.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Compile + run `body` as a sloppy SCRIPT. Returns the thrown text, or null. */
async function runScript(body: string, standalone: boolean): Promise<string | null> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "issue-4203.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    ...(standalone ? { target: "standalone" as const, deferTopLevelInit: true, hostBridge: "always" } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  if (standalone) {
    // A standalone module must not need a JS host to answer a `this` question.
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.module)).not.toContain("env");
  }
  const imports = standalone
    ? {}
    : (buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as never);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  try {
    (instance.exports as Record<string, () => void>).__module_init?.();
    return null;
  } catch (error) {
    return String((error as { message?: unknown })?.message ?? error);
  }
}

/** `check(cond, tag)` source helper — throws the tag when `cond` is false. */
const CHECK = `function check(ok, tag) { if (!ok) { throw "FAILED: " + tag; } }\n`;

/** Assert the probe completes on `--target standalone`. */
async function expectStandalone(body: string): Promise<void> {
  expect(await runScript(CHECK + body, true), "standalone lane").toBeNull();
}

/** Assert the probe completes on the JS-host lane AND on `--target standalone`. */
async function expectBoth(body: string): Promise<void> {
  expect(await runScript(CHECK + body, false), "JS-host lane").toBeNull();
  expect(await runScript(CHECK + body, true), "standalone lane").toBeNull();
}

describe("#4203 explicit-null receiver vs absent receiver (§10.4.3)", () => {
  // ── RED on origin/main, standalone only ────────────────────────────────
  // The marker is gated to the standalone / native-strings lane, where
  // `undefined` has a guaranteed non-null externref form (#2106). The JS-host
  // lane deliberately keeps today's answer, so these three assert one lane.
  it("a strict callee sees `null` through .call(null) (10.4.3-1-72-s)", async () => {
    await expectStandalone(`
      function f() { "use strict"; return this === null; }
      check(f.call(null), "strict f.call(null) must bind null");
    `);
  });

  it("a strict callee sees `null` through .apply(null) (10.4.3-1-67-s)", async () => {
    await expectStandalone(`
      function f() { "use strict"; return this === null; }
      check(f.apply(null), "strict f.apply(null) must bind null");
    `);
  });

  it("a strict callee sees `null` through .bind(null)() (10.4.3-1-77-s)", async () => {
    await expectStandalone(`
      function f() { "use strict"; return this === null; }
      check(f.bind(null)(), "strict f.bind(null)() must bind null");
    `);
  });

  it("a dynamically-null receiver is explicit too, not absent", async () => {
    await expectStandalone(`
      var n = null;
      function f() { "use strict"; return this === null; }
      check(f.call(n), "f.call(<runtime null>) must bind null, not undefined");
    `);
  });

  // ── RED on origin/main, BOTH lanes: .bind dropped the receiver ─────────
  it(".bind(o)() installs the receiver (10.4.3-1-79-s)", async () => {
    await expectBoth(`
      var o = {};
      function f() { "use strict"; return this === o; }
      check(f.bind(o)(), "f.bind(o)() must bind o");
    `);
  });

  it(".bind(this)() at top level installs the global object (10.4.3-1-80-s)", async () => {
    await expectBoth(`
      function f() { "use strict"; return this; }
      check(f.bind(this)() === this, "f.bind(this)() must be the global object");
    `);
  });

  it("a sloppy declaration bound by a strict caller still gets the receiver (10.4.3-1-98)", async () => {
    await expectBoth(`
      var o = {};
      function f() { return this === o; }
      check((function () { "use strict"; return f.bind(o)(); })(), "strict caller, sloppy callee");
    `);
  });

  it(".bind threads partial args alongside the receiver", async () => {
    await expectBoth(`
      var o = { v: 7 };
      function f(a) { return this.v + a; }
      check(f.bind(o)(3) === 10, "f.bind(o)(3) must be 10");
      check(f.bind(o, 3)() === 10, "f.bind(o, 3)() must be 10");
    `);
  });

  // ── GREEN ON BOTH ARMS — the guards. See the header. ───────────────────
  it("GUARD: a SLOPPY callee still binds the global object for null", async () => {
    await expectBoth(`
      var g = this;
      function f() { return this === g; }
      check(f.call(null), "sloppy f.call(null) must be the global object");
      check(f.apply(null), "sloppy f.apply(null) must be the global object");
      check(f.bind(null)(), "sloppy f.bind(null)() must be the global object");
    `);
  });

  it("GUARD: explicit `undefined` is NOT null — strict sees undefined, sloppy the global", async () => {
    await expectBoth(`
      var g = this;
      function s() { "use strict"; return this === undefined; }
      function l() { return this === g; }
      check(s.call(undefined), "strict f.call(undefined) must be undefined");
      check(l.call(undefined), "sloppy f.call(undefined) must be the global object");
    `);
  });

  it("GUARD: an ABSENT receiver keeps its own answer", async () => {
    await expectBoth(`
      var g = this;
      function s() { "use strict"; return this === undefined; }
      function l() { return this === g; }
      check(s(), "strict f() must be undefined");
      check(l(), "sloppy f() must be the global object");
    `);
  });

  it("PRECONDITION: an ordinary object receiver already worked and must not move", async () => {
    await expectBoth(`
      var o = {};
      function f() { "use strict"; return this === o; }
      check(f.call(o), "f.call(o) must bind o");
      check(f.apply(o), "f.apply(o) must bind o");
    `);
  });
});
