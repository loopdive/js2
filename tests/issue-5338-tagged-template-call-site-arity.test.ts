// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5338 — a tagged template is a CALL, so its substitutions are call arguments
// and its strings object carries `raw`. Neither held before this fix.
//
// (1) `compileTaggedTemplateExpression` marshalled at most `declaredParams - 1`
//     substitutions into positional slots and dropped the rest — without even
//     evaluating them. A tag that reads `arguments` (the vitest/jest
//     `test.each\`table\`` helper is the production witness) therefore saw
//     `arguments.length === 1`.
// (2) `strings.raw` was only read from the template vec's third field for
//     receivers the compiler could type statically — a vec-typed slot or the
//     first parameter of an INLINE tag. An ordinary named tag's parameter is a
//     plain `externref`, so the read fell through to `__extern_get`, and in
//     JS-host mode that import cannot index a WasmGC struct: it answered
//     `undefined`.
//
// Together those made the harness gate `Array.isArray(cases) && cases.raw &&
// values.length > 0` false, so `test.each` treated the TEMPLATE CHUNKS as its
// case list and invoked each body with a string where the row object belonged.
// Downstream, hono's `src/utils/ipaddr.test.ts` called `.split` on the `null`
// that destructuring a string for `{ input }` produces — the ten-test
// `Cannot read properties of null (reading 'split')` cluster this issue is
// named for. Measured on that suite: 4/16 → 13/16.
//
// Fixtures are untyped `.js` in a two-file project: an annotated single file
// resolves the tag's parameter to a concrete type and reads `raw` through the
// pre-existing static arm, so it would pass with and without the fix.
//
// Not covered here, deliberately: a tag reached through a PROPERTY
// (`tags.each\`…\``, hono's own spelling) compiles to the `__tagged_template`
// host bridge in a small fixture like this one, and that bridge hands the raw
// closure carrier to JS, which cannot call it — `TypeError: tag is not a
// function`, identically before and after this change. That is a separate live
// defect; the hono suite reaches the closure `call_ref` arm instead (its module
// registers many same-shape closures) and is the measurement that covers it.

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
  const root = mkdtempSync(join(tmpdir(), "js2-5338-"));
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

// `report` is deliberately a SEPARATE function: it keeps the observation out of
// the tag itself, so the tag's own parameter list stays at one — the arity that
// makes every substitution surplus.
//
// The template's first chunk carries a `\n` escape so `raw` is distinguishable
// from `cooked` by LENGTH (raw "a\\nb" is 4 characters, cooked "a\nb" is 3).
// A `raw` that merely EXISTS would pass a presence check while still being the
// cooked array.
const MOD = `
export function report(cases, values) {
  return 'chunks=' + String(cases.length) +
    ' cooked0=' + String(cases[0].length) +
    ' raw0=' + String(cases.raw ? cases.raw[0].length : -1) +
    ' vals=' + String(values.length) +
    ' v=' + values.join('/');
}

export function eachImpl(cases) {
  var values = Array.prototype.slice.call(arguments, 1);
  return report(cases, values);
}
`;

const ENTRY = `
import { eachImpl, report } from './mod.js';

function eachLocal(cases) {
  var values = Array.prototype.slice.call(arguments, 1);
  return report(cases, values);
}
// A closure VARIABLE tag (\`var f = function …\`) — a third tag spelling
// alongside the local and imported function declarations.
var eachClosure = function (cases) {
  var values = Array.prototype.slice.call(arguments, 1);
  return report(cases, values);
};
export function viaClosureVar() { return eachClosure\`a\\nb\${'X'}c\${'Y'}d\`; }

// The imported binding used directly as the tag.
export function viaImportedIdentifier() { return eachImpl\`a\\nb\${'X'}c\${'Y'}d\`; }

// A tag declared in this module — the statically-resolved arm.
function localTag(cases) {
  var values = Array.prototype.slice.call(arguments, 1);
  return report(cases, values);
}
export function viaLocal() { return localTag\`a\\nb\${'X'}c\${'Y'}d\`; }

// Anti-vacuity control: this tag DECLARES a slot for every substitution, so it
// never depended on the surplus-argument path and reads identically before and
// after the fix. (Numeric substitutions: an untyped parameter lowers to f64 in
// this lane, so a string substitution would read NaN here for reasons that have
// nothing to do with this issue.)
function declaredTag(strings, a, b) { return strings[0] + a + strings[1] + b + strings[2]; }
export function viaDeclaredParams() { return declaredTag\`a\${1}c\${2}d\`; }
`;

const EXPECTED = "chunks=3 cooked0=3 raw0=4 vals=2 v=X/Y";

describe("#5338 tagged template call-site arity and the strings object's raw parts", () => {
  it("a tag reading `arguments` sees the substitutions, and `strings.raw` is the raw parts", async () => {
    const result = await compileFixture({ "mod.js": MOD, "main.js": ENTRY }, "main.js");
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const exports = await instantiate(result);

    // Pre-fix every one of these read
    //   "chunks=3 cooked0=3 raw0=-1 vals=0 v="
    // — no raw array and no substitutions.
    expect((exports.viaLocal as () => string)()).toBe(EXPECTED);
    expect((exports.viaImportedIdentifier as () => string)()).toBe(EXPECTED);
    expect((exports.viaClosureVar as () => string)()).toBe(EXPECTED);
  });

  it("anti-vacuity control: a tag with a declared slot per substitution is unchanged", async () => {
    const result = await compileFixture({ "mod.js": MOD, "main.js": ENTRY }, "main.js");
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const exports = await instantiate(result);
    // Passes on the parent commit too — it pins the arm this change must not
    // disturb (substitutions still land in their declared positional slots).
    expect((exports.viaDeclaredParams as () => string)()).toBe("a1c2d");
  });
});
