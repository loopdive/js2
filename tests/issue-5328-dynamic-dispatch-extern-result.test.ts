// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5328 — a dynamic-dispatch arm whose funcref returns `externref` while the
// call site expects `f64` must UNBOX the result, not discard it.
//
// `call-identifier.ts`'s funcref ladder gives every candidate signature its own
// `ref.test`-guarded arm, and each arm has to leave a value of the block's
// declared result type. When an arm's return type disagrees with that type it
// asks `scalarBridgePlan` for a conversion; if none is available it falls back
// to a "dead-arm placeholder" — `drop` + `defaultValueInstrs(expected)` — on the
// theory that the arm can never actually run.
//
// The externref→f64 row of that planner is gated on `allowProvenNumberUnbox`,
// which the RETURN site passed as `false`. Nothing else supplies that direction,
// so the arm fell through to the placeholder, and for an `f64` block
// `defaultValueInstrs` is the `0x7FF00000DEADC0DE` undefined sentinel. The arm
// is not dead: the ladder always seeds an externref-returning ALTERNATE
// candidate (`tryAltFuncType([{ kind: "externref" }])`), and a function whose
// inferred return is `number | undefined` is lowered with exactly that
// signature — so the LIVE arm called the function, threw its answer away, and
// answered `undefined`.
//
// Production witness: jest's `packages/jest-config/src/stringToBytes.ts`
// (`export default stringToBytes;`, returning `number | null | undefined`,
// consumed through a default import). 21 of its 28 upstream unit tests read the
// undefined sentinel instead of the computed byte count; the jest dogfood suite
// went 299/356 → 320/356 on this change alone.
//
// The `allowProvenNumberUnbox` guard is right for an ARGUMENT — a declared-`any`
// argument may really be a Boolean/Symbol/BigInt and must not be silently run
// through the numeric ABI. It is wrong for a RESULT: `expectedReturn` IS the
// call expression's own statically computed result ValType, so the compiler has
// already committed to reading whatever comes back as `f64`. Refusing the unbox
// does not protect the value, it destroys it.
//
// Fixtures are untyped `.js` in a two-file project on purpose. An explicit
// return annotation, or a single-source graph, routes the call through a direct
// arm and the test then passes identically with and without the fix.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-5328-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

// `export default <identifier>` — the STATEMENT form, not the inline
// `export default function` — is what puts the call site on the dynamic ladder:
// the binding reaches the importer as a closure wrapper rather than a direct
// call target. `export { g as default }` and a named export both keep the direct
// lowering and never reproduced.
const DEP_NUMBER = `
function g(input) {
  if (input === 0) return undefined;
  return 42;
}
export default g;
`;

// Twin whose inferred return is \`string | undefined\`. The ladder's expected
// result is then externref, the seeded alternate matches exactly, and no bridge
// is consulted — a preserved-behaviour anchor for the arm this change touches.
const DEP_STRING = `
function label(input) {
  if (input === undefined) return undefined;
  return 'n' + input;
}
export default label;
`;

const ENTRY = `
import g from './dep.js';
import label from './dep-str.js';

export function literalArg() { return g(5); }
export function throughLocal() { const r = g(5); return r; }
export function forwardedParam(v) { return g(v); }
export function inArithmetic() { return g(5) + 1; }
export function undefinedResult() { return g(0); }
export function stringTwin() { return label(7); }
`;

// (#5332) `export default <identifier>;` in a two-file project does not COMPILE
// on `main` right now — `buildIrModuleInitPlan` counts an `ExportAssignment` as
// module-init work while `identity.ts` mints no module-init terminal for one, so
// the census invariant hard-errors with
// `multi-prepared-module-init-census:terminal-join`. That is a separate, live
// regression (it also costs jest's `stringToBytes.test.ts` all 28 of its tests
// on `main` today), and it MASKS the defect this file is about: the shape that
// reproduces #5328 is exactly the shape #5332 refuses to compile. Every
// alternative spelling measured — `export { g as default }`, an inline
// `export default function`, a named export, a factory return, a callback
// parameter — takes a different arm and never reproduced, so there is no
// unblocked fixture to substitute.
//
// So: skip loudly while #5332 is live, and assert for real the moment it lifts.
// A skip that names its blocker is honest; a green test that silently stopped
// exercising anything is not.
const CENSUS_BLOCKER = "multi-prepared-module-init-census";

function blockedByCensusRegression(result: CompileResult): boolean {
  return (
    result.success === false && (result.errors ?? []).some((error) => String(error.message).includes(CENSUS_BLOCKER))
  );
}

describe("#5328 dynamic-dispatch arm returning externref into an f64 call site", () => {
  it("answers the callee's value instead of the undefined sentinel", async (ctx) => {
    const result = await compileFixture(
      { "dep.js": DEP_NUMBER, "dep-str.js": DEP_STRING, "main.js": ENTRY },
      "main.js",
    );
    if (blockedByCensusRegression(result)) ctx.skip(`blocked by #5332 (${CENSUS_BLOCKER})`);
    expect(result.success).toBe(true);
    const exports = await instantiate(result);

    // Every one of these answered the undefined sentinel before the fix.
    expect((exports.literalArg as () => number)()).toBe(42);
    expect((exports.throughLocal as () => number)()).toBe(42);
    expect((exports.forwardedParam as (v: number) => number)(5)).toBe(42);
    expect((exports.inArithmetic as () => number)()).toBe(43);
  });

  it("leaves the genuinely-undefined result and the externref twin unchanged", async (ctx) => {
    const result = await compileFixture(
      { "dep.js": DEP_NUMBER, "dep-str.js": DEP_STRING, "main.js": ENTRY },
      "main.js",
    );
    if (blockedByCensusRegression(result)) ctx.skip(`blocked by #5332 (${CENSUS_BLOCKER})`);
    expect(result.success).toBe(true);
    const exports = await instantiate(result);

    // DOCUMENTED RESIDUAL, asserted so it cannot move silently. The callee
    // really returns `undefined` here, and the `f64` carrier at this call site
    // cannot represent that. Measured NaN before the fix (the
    // `0x7FF00000DEADC0DE` sentinel) and NaN after it
    // (`__unbox_number(undefined)`'s quiet NaN) — both read as "not a number",
    // neither reads as `undefined`. Giving `expectedReturn` the `undefSentinel`
    // brand for a `T | undefined` return is the real fix and is much wider than
    // this change.
    expect((exports.undefinedResult as () => number)()).toBeNaN();
    // Preserved: the `string | undefined` twin already took a matching arm.
    expect((exports.stringTwin as () => string)()).toBe("n7");
  });
});
