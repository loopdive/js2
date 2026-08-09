// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3592 RC2 — an UNDER-APPLIED call through the in-Wasm `__apply_closure` bridge
 * must actually happen.
 *
 * `fillApplyClosure` dispatched on the raw argument count, but
 * `__call_fn_method_N` only carries closures whose declared formal count is
 * `<= N`. So an arity-3 closure called with 2 args matched no arm and fell
 * through to the bridge's undefined sentinel — the call SILENTLY DID NOT HAPPEN.
 * That is the shape of the entire test262 assert harness
 * (`assert.sameValue(found, expected, message)` invoked with two args), which is
 * why every under-applied `assert.*` scored a VACUOUS PASS in standalone.
 *
 * The probe uses a NUMERIC channel rather than exception rendering: the module
 * records the outcome in a global and exposes it as an export, so a false
 * "it threw" can't come from the harness. Every case here runs HOST-FREE — the
 * import manifest is asserted empty and the module is instantiated with `{}` —
 * so a pass cannot be a host shim standing in for the in-Wasm bridge.
 *
 * NOT A REGRESSION OF THIS CHANGE (measured 2026-07-25, do not re-derive):
 * `built-ins/TypedArrayConstructors/ctors-bigint/buffer-arg/byteoffset-is-negative-throws-sab.js`
 * traps `illegal cast in __closure_57 ← __closure_50 ← __call_fn_method_3 ←
 * __apply_closure` once the widening makes `assert.throws` actually invoke its
 * callback. Two controls show the widening does not cause it: making the call
 * exact-arity (`assert.throws(C, fn, "m")`) traps identically WITH the widening,
 * and traps identically with the widening force-disabled. It is a pre-existing
 * defect in `new TA(sharedArrayBuffer, -1)` that the widening only UNMASKS.
 * Discriminator for the general case: a widening-INTRODUCED trap has
 * `__call_fn_method_N` as the INNERMOST frame, not a caller two frames out.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiateStandalone(source: string): Promise<Record<string, unknown>> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "arity.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  // Host-free: a non-empty manifest would mean a JS shim could be answering.
  expect(result.imports ?? [], "standalone probe must not emit host imports").toHaveLength(0);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return exports;
}

/** 1 = callee returned normally (VACUOUS), 2 = callee threw (CORRECT). */
async function outcome(setup: string, call: string): Promise<number> {
  const exports = await instantiateStandalone(`${setup}
var q = 0;
try { ${call}; q = 1; } catch (e) { q = 2; }
export function probeQ() { return q; }
`);
  return Number((exports.probeQ as () => number)());
}

const THROWER = `function Host() {}
Host.m3 = function (a, b, c) { throw new Error("fired"); };
Host.m1 = function (a) { throw new Error("fired"); };`;

describe("#3592 RC2 — __apply_closure dispatches at max(argc, declaredArity)", () => {
  it("invokes a 3-formal function-object static called with 2 args", async () => {
    expect(await outcome(THROWER, `Host.m3(1, 2)`)).toBe(2);
  });

  it("invokes a 1-formal function-object static called with 0 args", async () => {
    expect(await outcome(THROWER, `Host.m1()`)).toBe(2);
  });

  it("keeps the exact-arity call working", async () => {
    expect(await outcome(THROWER, `Host.m3(1, 2, 3)`)).toBe(2);
  });

  it("keeps over-application working (extra args dropped, not refused)", async () => {
    expect(await outcome(THROWER, `Host.m1(1, 2, 3)`)).toBe(2);
  });

  it("reads a missing formal as undefined rather than a stale argument", async () => {
    const setup = `function Host2() {}
Host2.m = function (a, b, c) { if (c === undefined) { throw new Error("c is undefined"); } };`;
    expect(await outcome(setup, `Host2.m(1, 2)`)).toBe(2);
  });

  // The formal the real harness under-applies (`assert.throws`'s `message`) is
  // STRING-typed by its own body (`message = ''` / `message += ' '`), so it does
  // NOT stay a bare `externref` — this is the concrete-ref lowering the missing
  // formal has to survive. Verified BY VALUE, not by "it no longer traps":
  // `seen` says which branch the callee took, `msgLen` says what it then held.
  it("a missing STRING-typed formal reads as undefined in the callee (harness shape)", async () => {
    const exports = await instantiateStandalone(`function Test262Error(message) { this.message = message || ""; }
var seen = 0;
var msgLen = -1;
var assert = function (mustBeTrue, message) {
  if (mustBeTrue === true) { return; }
  throw new Test262Error(message);
};
assert.throws = function (expectedErrorConstructor, func, message) {
  if (message === undefined) { seen = 1; message = ""; } else { seen = 2; message += " "; }
  msgLen = message.length;
  try { func(); } catch (thrown) { return; }
  throw new Test262Error(message + "no exception");
};
var q = 0;
try { assert.throws(RangeError, function () { throw new RangeError("x"); }); q = 1; } catch (e) { q = 2; }
export function probeQ() { return q; }
export function probeSeen() { return seen; }
export function probeMsgLen() { return msgLen; }
`);
    // seen === 0 would mean the call never happened at all (the vacuity this
    // change removes); seen === 2 would mean the missing formal arrived as
    // something OTHER than undefined.
    expect(Number((exports.probeSeen as () => number)())).toBe(1);
    expect(Number((exports.probeMsgLen as () => number)())).toBe(0);
    expect(Number((exports.probeQ as () => number)())).toBe(1);
  });

  it("keeps arguments.length at the actual call-site count (no synthetic extras)", async () => {
    const setup = `function Host3() {}
Host3.m = function (a, b, c) { if (arguments.length !== 2) { throw new Error("argc=" + arguments.length); } };`;
    // The dispatcher widens to the formal count only to select a compatible
    // call bridge. `arguments.length` remains the actual source-level count.
    expect(await outcome(setup, `Host3.m(1, 2)`)).toBe(1);
  });
});
