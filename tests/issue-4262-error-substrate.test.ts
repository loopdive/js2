// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4262) The standalone ERROR SUBSTRATE — two independent halves, pinned here.
 *
 * ## Half 1 — a compiler-minted TypeError must BE a TypeError
 *
 * `typeErrorThrowInstrs` (src/codegen/property-access.ts) used to throw a
 * native STRING whose text merely begins with `"TypeError: "`. Every
 * `catch (e) { e instanceof TypeError }` therefore answered `false`, and the
 * upstream harness's `assert.throws(TypeError, fn)` rejected the throw before
 * it even compared constructors (`typeof thrown !== 'object'` short-circuits
 * first). In no-JS-host mode the throw is now a real `$Error_struct`.
 *
 * ## Half 2 — `err.constructor` must be the value the NAME reads
 *
 * `fillExternGetErrorProps` answered `<Test262Error>.constructor` from
 * `ctx.funcClosureGlobals`, the LOWER-precedence of the two carriers a function
 * value can live in. The literal upstream harness always takes the other one
 * (`ctx.moduleGlobals`, because `assert.js` closes over `Test262Error`), so the
 * two disagreed: `e.constructor` was a function, but `!==` the name and with an
 * empty property bag. `userErrorCtorCarrierGlobal`
 * (src/codegen/error-ctor-carrier.ts) resolves it with the identifier read's
 * own precedence.
 *
 * ## Why the negative cases are load-bearing
 *
 * A naive "always answer true" implementation of either half passes the
 * positive assertions trivially. Each half therefore carries CROSS checks that
 * such an implementation fails:
 *
 *   - Half 1: the thrown TypeError must NOT be `instanceof RangeError`, must
 *     not report `name === "RangeError"`, and `e.constructor` must not be
 *     `RangeError`. Two nulls / two undefineds compare equal, so the RangeError
 *     identifier is separately asserted to be a real value first.
 *   - Half 2: a SECOND user error constructor in the same module must resolve
 *     to its OWN carrier — `e.constructor === A` and `e.constructor !== B` —
 *     and the rendered text must still name the right class.
 *
 * The gc / JS-host lane is asserted UNCHANGED (Half 1 is gated on `noJsHost`
 * because `__new_TypeError` is an `env` import there, and registering an import
 * from inside a half-built instruction array is the #1839 index-shift trap).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(__dirname, "..");
const HARNESS_DIR = join(REPO_ROOT, "test262", "test", "harness");
const HARNESS_AVAILABLE = existsSync(join(HARNESS_DIR, "sta.js"));

/**
 * Compile `source` and read every zero-arg numeric export. Each probe returns
 * `1`/`0` so the answer crosses the wasm boundary as an i32 — a string-typed
 * export would come back as an opaque WasmGC struct under `--target
 * standalone` and silently read as "not equal" for every comparison.
 */
async function runProbes(source: string, target?: "standalone"): Promise<Record<string, number>> {
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "issue-4262.ts",
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
  });
  expect(compiled.success, compiled.errors.map((e) => `L${e.line}: ${e.message}`).join("; ")).toBe(true);
  const importObject = (compiled as unknown as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(compiled.binary, importObject);
  const exports = instance.exports as Record<string, unknown>;
  (exports._start as (() => void) | undefined)?.();
  (exports.__module_init as (() => void) | undefined)?.();
  const out: Record<string, number> = {};
  for (const [name, fn] of Object.entries(exports)) {
    if (name === "_start" || name === "__module_init" || name.includes("\0")) continue;
    if (typeof fn !== "function") continue;
    out[name] = (fn as () => number)();
  }
  return out;
}

/**
 * The compiler-minted "cannot access property on null/undefined" throw. Every
 * question is answered INSIDE the catch clause: assigning the catch binding out
 * to a module-scope `var` is a separate, pre-existing representation gap and
 * would make this file measure that instead.
 */
const MINTED_THROW_PROBES = `
function probe(which: number): number {
  var o: any = null;
  try {
    var v: any = o.foo;
    return -1;
  } catch (e) {
    if (which === 0) return (e instanceof TypeError) ? 1 : 0;
    if (which === 1) return (typeof e === "object") ? 1 : 0;
    if (which === 2) return ((e as any).name === "TypeError") ? 1 : 0;
    if (which === 3) return ((e as any).constructor === TypeError) ? 1 : 0;
    // Prefix, not equality: the message carries the source position
    // ("… at <line>:<col>") when the throw site has one.
    if (which === 4) return (String(e).indexOf("TypeError: Cannot access property on null or undefined") === 0) ? 1 : 0;
    // ── negative / cross checks ──
    if (which === 5) return (e instanceof RangeError) ? 1 : 0;
    if (which === 6) return ((e as any).name === "RangeError") ? 1 : 0;
    if (which === 7) return ((e as any).constructor === RangeError) ? 1 : 0;
    if (which === 8) return (typeof e === "string") ? 1 : 0;
    return -1;
  }
}
export function isTypeError(): number { return probe(0); }
export function typeofIsObject(): number { return probe(1); }
export function nameIsTypeError(): number { return probe(2); }
export function ctorIsTypeError(): number { return probe(3); }
export function rendersWithPrefix(): number { return probe(4); }
export function notRangeError(): number { return probe(5); }
export function nameIsNotRangeError(): number { return probe(6); }
export function ctorIsNotRangeError(): number { return probe(7); }
export function typeofIsNotString(): number { return probe(8); }
// The cross checks above are only meaningful if RangeError is a real distinct
// value: undefined !== undefined would be false for the wrong reason.
export function rangeErrorIsRealAndDistinct(): number {
  return ((RangeError as any) !== null && (RangeError as any) !== undefined && (RangeError as any) !== (TypeError as any)) ? 1 : 0;
}
`;

describe("#4262 Half 1 — a compiler-minted TypeError is a real TypeError (standalone)", () => {
  it("answers instanceof / name / constructor / String() correctly, and is not a RangeError", async () => {
    const r = await runProbes(MINTED_THROW_PROBES, "standalone");
    // Guard the cross checks first — otherwise a build where every identifier
    // reads null would pass the negatives vacuously.
    expect(r.rangeErrorIsRealAndDistinct, "RangeError must be a real value distinct from TypeError").toBe(1);

    expect(r.isTypeError, "catch (e) { e instanceof TypeError }").toBe(1);
    expect(r.typeofIsObject, 'typeof e === "object"').toBe(1);
    expect(r.nameIsTypeError, 'e.name === "TypeError"').toBe(1);
    expect(r.ctorIsTypeError, "e.constructor === TypeError").toBe(1);
    // The rendered text is deliberately UNCHANGED from the old string throw:
    // `__error_to_string` (#2962) renders `$name + ": " + $message`, so the
    // runner's failure-signature classification is stable across this change.
    expect(r.rendersWithPrefix, 'String(e) starts with "TypeError: Cannot access property on null or undefined"').toBe(
      1,
    );

    expect(r.notRangeError, "must NOT be instanceof RangeError").toBe(0);
    expect(r.nameIsNotRangeError, 'e.name must not be "RangeError"').toBe(0);
    expect(r.ctorIsNotRangeError, "e.constructor must not be RangeError").toBe(0);
    expect(r.typeofIsNotString, "the thrown value must no longer be a string").toBe(0);
  });

  it("leaves the JS-host lane on the historical string throw (no env import added mid-body)", async () => {
    // Half 1 is gated on `noJsHost` on purpose: in host mode `__new_TypeError`
    // is an `env` IMPORT, and registering one from inside a half-built `then:`
    // array is the #1839/#117/#1886 index-shift trap. Pinning host-mode
    // behaviour here is what makes the gate observable rather than incidental.
    const r = await runProbes(MINTED_THROW_PROBES);
    expect(r.typeofIsNotString, "host lane still throws the message string").toBe(1);
    expect(r.isTypeError, "host lane string is not a TypeError instance").toBe(0);
  });
});

/**
 * Two user-declared error constructors in one module.
 *
 * **This synthetic does NOT discriminate base-from-fix and is not claimed to.**
 * The carrier SPLIT (`$__mod_<name>` alongside `$__fn_closure_<name>`) only
 * appears in the assembled multi-include harness; every synthetic shape tried
 * here — self-referencing constructor, nested declarations, closure-captured
 * thrower — produces the `$__fn_closure_` carrier alone, where both consumers
 * already agreed. What this pins is the SHAPE of a correct answer, including
 * the cross checks a naive always-true implementation fails
 * (`e.constructor` must not be the sibling constructor).
 *
 * The discriminating pin for Half 2 is the harness self-test at the bottom of
 * this file: it fails on the base with `Expected a Test262Error, but a
 * "undefined" was thrown.` and passes after.
 */
const TWO_CTORS = `
function Test262Error(message: any) {
  this.message = message || "";
}
function OtherError(message: any) {
  this.message = message || "";
}
// Force both into the closure/moduleGlobals carrier by capturing them.
function throwT262(m: any): any { throw new Test262Error(m); }
function throwOther(m: any): any { throw new OtherError(m); }

// Evaluating the two names as VALUES first is deliberate and mirrors the real
// harness: the cached closure singleton (#1340) behind \`__fn_closure_<name>\` is
// materialised lazily by the identifier read, and \`fillExternGetErrorProps\`
// only READS that global (it must not mint a ref.func trampoline at finalize).
// So a \`.constructor\` read that happens BEFORE the name has ever been evaluated
// anywhere still answers \`undefined\`. sta.js/assert.js evaluate the name during
// module init, which is why the harness self-tests are unaffected — see the
// dedicated ordering test below, which pins the residual explicitly.
var t262Ref: any = Test262Error as any;
var otherRef: any = OtherError as any;

function probe(which: number): number {
  try {
    throwT262("m");
    return -1;
  } catch (e) {
    if (which === 0) return ((e as any).constructor === (Test262Error as any)) ? 1 : 0;
    if (which === 1) return ((e as any).constructor === (OtherError as any)) ? 1 : 0;
    if (which === 2) return (typeof (e as any).constructor === "function") ? 1 : 0;
    if (which === 3) return ((e as any).name === "Test262Error") ? 1 : 0;
    if (which === 4) return (String(e) === "Test262Error: m") ? 1 : 0;
    return -1;
  }
}
export function ctorIsT262(): number { return probe(0); }
export function ctorIsNotOther(): number { return probe(1); }
export function ctorIsFunction(): number { return probe(2); }
export function nameIsT262(): number { return probe(3); }
export function rendersT262(): number { return probe(4); }
export function bothCtorsAreRealAndDistinct(): number {
  return (t262Ref !== null && t262Ref !== undefined
    && otherRef !== null && otherRef !== undefined
    && t262Ref !== otherRef) ? 1 : 0;
}
export function nameSelfIdentity(): number { return ((Test262Error as any) === (Test262Error as any)) ? 1 : 0; }
`;

describe("#4262 Half 2 — err.constructor is the value the NAME reads (standalone)", () => {
  it("resolves the same carrier the bare identifier reads, and not a sibling constructor", async () => {
    const r = await runProbes(TWO_CTORS, "standalone");
    // Without this, `undefined === undefined` would satisfy `ctorIsT262`.
    expect(r.bothCtorsAreRealAndDistinct, "both constructors must be real, distinct values").toBe(1);
    expect(r.nameSelfIdentity, "the bare identifier must be a stable singleton").toBe(1);

    expect(r.ctorIsFunction, "typeof e.constructor === 'function'").toBe(1);
    expect(r.ctorIsT262, "e.constructor === Test262Error").toBe(1);
    expect(r.ctorIsNotOther, "e.constructor must NOT be the sibling OtherError").toBe(0);
    expect(r.nameIsT262, 'e.name === "Test262Error"').toBe(1);
    expect(r.rendersT262, 'String(e) === "Test262Error: m"').toBe(1);
  });
});

/**
 * The ORDERING residual, pinned so it cannot change silently in either
 * direction.
 *
 * `fillExternGetErrorProps` deliberately only READS `__fn_closure_<name>`; it
 * must not mint a `ref.func` trampoline at finalize (the late-funcidx-shift
 * hazard `ensureErrorCtorCarrierGlobal` documents). That global is materialised
 * LAZILY by the first identifier read, so a `.constructor` read that is the
 * FIRST evaluation of the name in the whole program still answers `undefined`.
 *
 * This does not affect the harness — sta.js/assert.js evaluate `Test262Error`
 * as a value during module init — but it is a real residual and #4262 does not
 * fix it.
 */
const COLD_FIRST_READ = `
function Test262Error(message: any) { this.message = message || ""; }
function throwT262(m: any): any { throw new Test262Error(m); }
export function coldCtorRead(): number {
  try {
    throwT262("m");
    return -1;
  } catch (e) {
    // The FIRST evaluation of the name anywhere is the right-hand side here,
    // and it is evaluated AFTER \`e.constructor\`.
    return ((e as any).constructor === (Test262Error as any)) ? 1 : 0;
  }
}
`;

describe("#4262 — the lazy-materialisation ordering residual (known, not fixed here)", () => {
  it("a .constructor read that PRECEDES the first identifier read still misses", async () => {
    const r = await runProbes(COLD_FIRST_READ, "standalone");
    expect(
      r.coldCtorRead,
      "FIXED? If this now reads 1, the cached closure singleton is materialised " +
        "eagerly (or the arm mints it). That is the good direction — update this " +
        "expectation and the 'Not done' section of plan/issues/4262-*.md in the same PR.",
    ).toBe(0);
  });
});

/**
 * The end-to-end proof, through the LITERAL upstream harness rather than a
 * synthetic reproduction: `propertyhelper-verifynotwritable-writable.js` fails
 * with `Expected a Test262Error, but a "undefined" was thrown.` for exactly the
 * Half-2 carrier mismatch, and nothing else in the file is at issue.
 *
 * `tests/es5-standalone-harness-selftests.test.ts` is the RATCHET; this single
 * entry is the causal pin, so a future change that re-breaks the carrier fails
 * here with the root cause named rather than only as a ratchet delta.
 */
describe.skipIf(!HARNESS_AVAILABLE)("#4262 — the harness self-test that isolates Half 2", () => {
  it("propertyhelper-verifynotwritable-writable.js passes on the standalone lane", { timeout: 180_000 }, async () => {
    const result = (await runTest262File(
      join(HARNESS_DIR, "propertyhelper-verifynotwritable-writable.js"),
      "harness-selftest",
      60_000,
      "standalone",
    )) as { status: string; error?: string };
    expect(result.status, `runner said: ${result.error ?? "(no detail)"}`).toBe("pass");
  });
});
