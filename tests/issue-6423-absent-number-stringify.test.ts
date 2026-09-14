// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #6423 — an ABSENT number-typed property stringified as `"NaN"`.
 *
 * `__extern_get` narrows a dynamic property read whose slot is number-shaped to
 * `{ kind: "f64", undefSentinel: true }` and materialises an absent slot as
 * `UNDEF_F64_BITS` (property-access-dispatch.ts, #5251). That brand is why
 * `typeof o.maxAge`, `o.maxAge === undefined` and `"maxAge" in o` all answer
 * correctly — the property READ was never broken. The ToString arms then
 * ignored the brand and called `number_toString` on the raw f64, and the host
 * import renders that bit pattern as `"NaN"`. So `String(o.maxAge)` on an
 * object with no `maxAge` printed `"NaN"` where §7.1.17 says `"undefined"`.
 *
 * The fix is one brand-gated helper (`emitNumberToStringSentinelAware`,
 * coercion-engine.ts) that the js-host f64 ToString arms route through.
 *
 * Why the fixture is shaped this way:
 *  - **The calls must be unspecializable.** Reading `o.maxAge` dynamically is
 *    what produces the brand, and the compiler resolves the read statically
 *    when `readProp` is called with a literal at a monomorphic, inlinable call
 *    site: the same nine cases written as straight-line calls inside one
 *    exported function answer 9/9 **on the parent**. Registering each case as a
 *    closure — which is what the dogfood harness does with its `test(name, fn)`
 *    callbacks, and where this was originally measured — keeps the read
 *    dynamic. A future refactor that makes this file pass without the fix is
 *    far more likely to have re-specialized the call than to have fixed
 *    anything, so the parent bitmask is asserted verbatim below.
 *  - **Untyped `.js` half.** `o` is an `any` parameter; a typed parameter
 *    resolves the slot statically and never carries the sentinel.
 *  - **Controls in the same module, not a separate one.** The whole risk of
 *    this change is criterion 2: `UNDEF_F64_BITS` is a *signaling*-NaN payload
 *    and a genuine `NaN` is the quiet `0x7FF8000000000000`, so only the exact
 *    i64 bit-pattern compare separates them. A fix that mapped all NaN to
 *    `"undefined"` would be worse than the bug — and fails bit 8 here.
 *
 * Exact counts both ways (measured, same HEAD, `.tmp/6423/`):
 *   parent → `448` = `0b111000000`, only the three present-value controls;
 *   fixed  → `511`, all nine.
 *
 * The second `it` pins the standalone lane, which was ALREADY correct on the
 * parent (probe `127` before and after — measured, not assumed): its ToString
 * goes through `$__any_to_string` rather than the narrowed f64, so it never saw
 * the sentinel. The helper is js-host-only by design for exactly that reason —
 * standalone / native-strings codegen is byte-identical to the parent here,
 * verified by hashing the emitted binaries both ways — and this `it` is what
 * keeps a later widening of the helper from silently regressing the lane that
 * did not need it. See `emitNumberToStringSentinelAware`'s doc comment.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** The untyped half — every read below is the dynamic `__extern_get`. */
const LIB_MODULE = `
export function readProp(o) {
  return String(o.maxAge);
}
export function readPropWithField(o) {
  return String(o.path) + "/" + String(o.maxAge);
}
export function tmpl(o) {
  return \`\${o.maxAge}\`;
}
export function plusEmpty(o) {
  return o.maxAge + "";
}
`;

/**
 * Six absent-read cases (bits 1-6, the defect) then three present-value
 * controls (bits 7-9, criterion 2). One exported bitmask so the count is exact
 * in both directions rather than "some subset failed".
 */
const ENTRY_MODULE = `
import { readProp, readPropWithField, tmpl, plusEmpty } from "./lib.js";

const cases = [];
function reg(fn) { cases.push(fn); }

reg(() => readProp({}) === "undefined");
reg(() => readPropWithField({ path: "/" }) === "//undefined");
reg(() => readPropWithField({}) === "undefined/undefined");
reg(() => tmpl({}) === "undefined");
reg(() => plusEmpty({}) === "undefined");
reg(() => readProp(Object.assign({})) === "undefined");
reg(() => readProp({ maxAge: 0 }) === "0");
reg(() => readProp({ maxAge: NaN }) === "NaN");
reg(() => readProp({ maxAge: 5 }) === "5");

export function probe() {
  let bits = 0;
  for (let i = 0; i < cases.length; i++) {
    if (cases[i]()) bits |= (1 << i);
  }
  return bits;
}

export function caseCount() {
  return cases.length;
}
`;

/**
 * The standalone lane. Host-free, so one instantiation with no imports; 127 =
 * all seven checks (four absent-read, three present-value).
 */
const STANDALONE_PROBE = `
function readProp(o: any): string {
  return String(o.maxAge);
}
function tmpl(o: any): string {
  return \`\${o.maxAge}\`;
}
function plusEmpty(o: any): string {
  return o.maxAge + "";
}
export function probe(): number {
  let bits = 0;
  if (readProp({}) === "undefined") bits |= 1;
  if (readProp({ path: "/" }) === "undefined") bits |= 2;
  if (tmpl({}) === "undefined") bits |= 4;
  if (plusEmpty({}) === "undefined") bits |= 8;
  if (readProp({ maxAge: 0 }) === "0") bits |= 16;
  if (readProp({ maxAge: NaN }) === "NaN") bits |= 32;
  if (readProp({ maxAge: 5 }) === "5") bits |= 64;
  return bits;
}
`;

describe('#6423 an absent number-typed property stringifies as "undefined", not "NaN"', () => {
  it("answers all nine js-host cases, absent reads and present-value controls alike", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6423-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "lib.js"), LIB_MODULE);
    writeFileSync(join(root, "entry.mjs"), ENTRY_MODULE);

    // The dogfood compile worker's options (`upstream-suite-compile-worker.mjs`),
    // which is the lane the defect was measured in.
    const result = await compileProject(join(root, "entry.mjs"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      experimentalIR: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();

    // Anti-vacuity: all nine closures registered and ran. A fixture that
    // silently stopped executing reports 0 here rather than passing blank.
    expect((instance.exports.caseCount as () => number)()).toBe(9);
    // Parent commit: 448 (0b111000000) — only the present-value controls.
    expect((instance.exports.probe as () => number)()).toBe(511);
  }, 300_000);

  it("leaves the standalone lane, which already answered correctly, unchanged", async () => {
    const result = await compile(STANDALONE_PROBE, {
      fileName: "issue-6423-standalone-probe.ts",
      target: "standalone",
      hostBridge: "off",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    // 127 on the parent too — measured, not assumed.
    expect((instance.exports.probe as () => number)()).toBe(127);
  }, 300_000);
});
