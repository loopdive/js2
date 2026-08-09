// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4261) A fnctor prototype-method call's RESULT was clobbered to 0/null by a
// declared-field access of the SAME receiver in the same function — each half
// was correct alone, only the composition failed, silently.
//
// Mechanism (so a regression here is diagnosable from the test name alone):
// the #2660 S1 escape gate's clause B was ABSOLUTE — any typed own-field
// consumer classified the `new P()` site `keep-typed`, even when the site ALSO
// had a dynamic use (`p.step()`). A keep-typed fnctor never enters
// `approvedNames`, so its prototype methods were NEVER COMPILED (the #2660 S2
// prototype materialization, #3683 direct-call twins and `__fnctor_proto_start`
// registry are all approval-gated); the call then fell to the generic
// `__extern_method_call`, found nothing, and returned null — which
// `__unbox_number` reads as 0 (ToNumber(null)), a plausible-looking wrong
// answer. The fix classifies typed∧dynamic sites `reconstruct` (standalone
// lane only; host/wasi verified byte-identical), where A1 typed instances
// (#4155) + A3 read dispatch keep the field reads on `struct.get`.
//
// Every assertion is a CONTENT assertion against the native JS answer (#4253):
// the composite `s + q*100` shape distinguishes "s corrupted" (100) from "q
// corrupted" (2) from "both fine" (102), so a regression names its victim.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PRE = `
function P(n) { this.pos = n; this.type = "x"; }
P.prototype.step = function () { return this.pos + 1; };
P.prototype.twice = function () { return this.step() + this.step(); };
`;

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(`${PRE}\n${body}`, { target: "standalone" });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => unknown> & { _start?: () => void };
  if (typeof exports._start === "function") exports._start();
  return exports.t();
}

describe("#4261 — fnctor method result must survive a declared-field access of the same receiver", () => {
  // CONTROL — the single-statement halves, which passed before the fix and
  // must keep passing after it (the composition bug hid behind exactly these).
  it("control: method call alone answers 2", async () => {
    expect(await runStandalone(`export function t() { var p = new P(1); var s = p.step(); return s; }`)).toBe(2);
  });
  it("control: field read alone answers 1", async () => {
    expect(
      await runStandalone(`export function t() { var p = new P(1); var s = p.step(); var q = p.pos; return q; }`),
    ).toBe(1);
  });

  // THE two-line repro from the issue.
  it("call-then-read: the earlier call's result is 2, not 0", async () => {
    expect(
      await runStandalone(`export function t() { var p = new P(1); var s = p.step(); var q = p.pos; return s; }`),
    ).toBe(2);
  });
  it("composite s + q*100 answers 102 (pins WHICH value corrupts on regression)", async () => {
    expect(
      await runStandalone(
        `export function t() { var p = new P(1); var s = p.step(); var q = p.pos; return s + q * 100; }`,
      ),
    ).toBe(102);
  });

  // The acceptance-criteria spellings — every part passes alone today, so only
  // the composition is load-bearing in each.
  it("read-then-call ordering", async () => {
    expect(
      await runStandalone(
        `export function t() { var p = new P(5); var q = p.pos; var s = p.step(); return s + q * 100; }`,
      ),
    ).toBe(506);
  });
  it("hoisted method value plus field read", async () => {
    expect(
      await runStandalone(`export function t() { var p = new P(2); var m = p.step; var q = p.pos; return q; }`),
    ).toBe(2);
  });
  it("separate-if spelling", async () => {
    expect(
      await runStandalone(
        `export function t() { var p = new P(1); var r = 0; if (p.pos === 1) { r += 1; } if (p.step() === 2) { r += 10; } return r; }`,
      ),
    ).toBe(11);
  });

  // Blast-radius shapes that were ALSO wrong pre-fix (measured 2026-08-09:
  // 11 of 13 probe shapes failed on main @ dda0d1dc7).
  it("method result into an if-condition", async () => {
    expect(
      await runStandalone(
        `export function t() { var p = new P(1); var q = p.pos; if (p.step() === 2) { return 10 + q; } return -1; }`,
      ),
    ).toBe(11);
  });
  it("method result as a call argument", async () => {
    expect(
      await runStandalone(
        `function id(x) { return x; } export function t() { var p = new P(3); var q = p.pos; return id(p.step()); }`,
      ),
    ).toBe(4);
  });
  it("chained method (method calling method) with a field read present", async () => {
    expect(await runStandalone(`export function t() { var p = new P(1); var q = p.pos; return p.twice(); }`)).toBe(4);
  });
  it("a typed field WRITE also must not kill the method (pre-fix: null)", async () => {
    expect(await runStandalone(`export function t() { var p = new P(1); p.pos = 7; return p.step(); }`)).toBe(8);
  });
  it("string field read triggers it the same as the numeric one", async () => {
    expect(
      await runStandalone(
        `export function t() { var p = new P(1); var s = p.step(); return p.type === "x" ? s : -1; }`,
      ),
    ).toBe(2);
  });
  it("two instances, both fields and both methods", async () => {
    expect(
      await runStandalone(
        `export function t() { var a = new P(1); var b = new P(10); var q = a.pos + b.pos; return a.step() + b.step() + q * 100; }`,
      ),
    ).toBe(1113);
  });
  it("typed-only receiver stays on the keep-typed lowering (control both ways)", async () => {
    expect(await runStandalone(`export function t() { var p = new P(9); return p.pos; }`)).toBe(9);
  });
});
