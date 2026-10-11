// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 lane SC1 — the `scope-*param-*elem-var-*` family on `--target standalone`.
//
// THE COUNT FIRST, because the family's name is misleading. The 14 rows whose
// filename matches `scope-*param-*elem-var-close` are NOT a destructuring or
// parameter-scope-lowering family: every one of them is a **sloppy direct `eval`
// in a formal parameter's initializer that introduces a `var`**, asserted to be
// visible to closures created in the parameter list AND to the function body
// (§10.2.11 step 20 gives a non-simple parameter list its own parameter
// environment, so the eval's `var` lands in step 28's `varEnv` — the BODY's
// VariableEnvironment). Measured on both axes on the same commit, 2026-09-26:
// exactly **3** of the 14 are standalone-only (fail/CE on standalone, pass on
// host); the other 11 either already pass or fail on host too.
//
// THE CAUSE this file pins (2 of those 3, plus a third row that fails on host):
// the compiler creates that `var` through the static-eval-inline splice (#1163,
// `hoistVarDeclarations`), as an ordinary local of the function being compiled.
// Right for a plain function. Wrong for a NATIVE-LOWERED GENERATOR, where the
// formals run in the FACTORY and the body runs in a separate RESUME function: the
// body's read of the name finds no local and falls through to the outer binding,
// answering `'outside'` where `'inside'` is required.
//
//   - `functionMayReachDirectEval` cannot see this eval — it scans `decl.body`
//     only, by construction — which is why no existing reification covered it.
//   - The failure is NOT about closures. `got = x` read DIRECTLY in the
//     generator body fails identically (the `body reads the name directly` case
//     below), and a closure created in the PARAMETER list already answered
//     correctly on the base tree (the negative control below).
//   - Disproof probe run per the method rule: an unconditional throw at the top
//     of `compileInlinedEvalStatements` turned every one of these shapes into
//     `SC1_PROBE_static_eval_inline_reached`, so the static-inline splice is the
//     path that creates the binding — it was not assumed.
//
// The fix registers the names a parameter-list direct eval introduces as native
// generator SPILLS, exactly as a destructuring-param binding is registered
// (#3386): the factory packs the value into the spill field at `struct.new` and
// the resume function's ordinary spill-load loop rehydrates it. Two details are
// load-bearing and pinned below:
//   - the factory must DEREFERENCE a boxed local. A parameter-list closure that
//     captures the name boxes it into a one-field ref cell (`boxedCaptures`, the
//     #2925 reification), and packing the cell would store the carrier where the
//     resume function expects a value.
//   - the spill is `externref` and undef-widened. The checker resolves this name
//     to the OUTER declaration, whose type says nothing about the eval-created
//     value, so a resume-state read must skip the checker-type unbox narrowing.
//
// NOT FIXED, recorded as a pinned residual below: a REST PARAMETER on a
// generator (`function* g(...a){}`) bails native lowering outright
// (`isNativeGeneratorCandidate`, the #2920/#3386 "separate follow-up" bail), so
// `scope-gen-meth-param-rest-elem-var-close` stays a compile error. Measured: it
// has nothing to do with eval or with destructuring — `function* g(...a){}` on
// its own compile-errors.
//
// Measured, authoritative lane (`tests/test262-shared.ts::runTest262Chunk`,
// `TEST262_PATH_FILTER_FILE`, `TEST262_IT_TIMEOUT_MS=120000`, pool 2,
// shard-completion manifest checked on every sweep quoted in the receipt).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile a test262-shaped module (loose, untyped, top-level statements) the way
 * the runner does and answer the accumulated `__r` bitmask.
 *
 * `target` is a parameter because the change is NOT standalone-gated: the plan
 * builder registers the spill in both lanes, so host behaviour is measured
 * rather than assumed.
 */
async function runTest262Shaped(body: string, target: "standalone" | "gc" = "standalone"): Promise<number> {
  const source = `var __r = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone", deferTopLevelInit: true } : {}),
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  if (target === "standalone") {
    const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
    expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    ex.__module_init?.();
    return ex.run!();
  }
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.run!();
}

/** Does `body` compile for `--target standalone` without leaking host imports? */
async function standaloneCompiles(body: string): Promise<{ ok: boolean; error: string }> {
  const source = `var __r = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  if (!r.success) return { ok: false, error: r.errors.map((e) => e.message).join("\n") };
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  if (leaked.length > 0) return { ok: false, error: `leaked env imports: ${leaked.join(", ")}` };
  return { ok: true, error: "" };
}

describe("#6651 SC1 — a generator body sees a var a parameter-list direct eval introduced", () => {
  // THE MINIMAL REPRO, and the one that shows this is not a closure problem: the
  // body reads the name DIRECTLY. RED on reverted sources (measured: `'outside'`,
  // so bit 1 unset → 0), GREEN with the fix (1).
  it("the body reads the name directly — generator EXPRESSION", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var got;
var it = (function*(_ = eval('var x = "inside";')) {
  got = x;
  yield 1;
}());
it.next();
if (got === 'inside') __r |= 1;
`),
    ).toBe(1);
  });

  // Same, generator DECLARATION lane (a different registration site).
  it("the body reads the name directly — generator DECLARATION", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var got;
function* g(_ = eval('var x = "inside";')) { got = x; yield 1; }
g().next();
if (got === 'inside') __r |= 1;
`),
    ).toBe(1);
  });

  // ROW 1 of the two fixed rows, verbatim shape of
  // language/expressions/generators/scope-param-elem-var-close.js.
  // The param-list closures (`probe1`, `probe2`) were ALREADY correct on base;
  // `probeBody` is the bit that was 0.
  it("expressions/generators/scope-param-elem-var-close shape", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var probe1, probe2, probeBody;
(function*(
    _ = (eval('var x = "inside";'), probe1 = function() { return x; }),
    __ = probe2 = function() { return x; }
  ) {
  probeBody = function() { return x; };
}()).next();
if (probe1() === 'inside') __r |= 1;
if (probe2() === 'inside') __r |= 2;
if (probeBody() === 'inside') __r |= 4;
`),
    ).toBe(7);
  });

  // ROW 2, verbatim shape of
  // language/expressions/object/scope-gen-meth-param-elem-var-close.js — the
  // object-literal generator-METHOD lane, a third emit site.
  it("expressions/object/scope-gen-meth-param-elem-var-close shape", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var probe1, probe2, probeBody;
({
  *m(
    _ = (eval('var x = "inside";'), probe1 = function() { return x; }),
    __ = probe2 = function() { return x; }
  ) {
    probeBody = function() { return x; }
  }
}.m().next());
if (probe1() === 'inside') __r |= 1;
if (probe2() === 'inside') __r |= 2;
if (probeBody() === 'inside') __r |= 4;
`),
    ).toBe(7);
  });

  // The BOXED-LOCAL path, isolated: the name is captured by a closure built in
  // the parameter list, so the factory local is a ref CELL. Without the pack-site
  // deref the resume function reads the carrier instead of the value. (The row
  // shapes above cover this too; this case names the mechanism on its own.)
  it("a parameter-list closure over the same name still round-trips the VALUE", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var probeParam, got;
(function*(_ = (eval('var x = "inside";'), probeParam = function() { return x; })) {
  got = x;
  yield 1;
}()).next();
if (probeParam() === 'inside') __r |= 1;
if (got === 'inside') __r |= 2;
if (typeof got === 'string') __r |= 4;
`),
    ).toBe(7);
  });

  // The value must survive a SUSPENSION, not merely the first entry — the spill
  // field is the frame slot, so a read after `yield` must still see it.
  it("the binding survives a suspension", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var before, after;
var it = (function*(_ = eval('var x = "inside";')) {
  before = x;
  yield 1;
  after = x;
}());
it.next();
it.next();
if (before === 'inside') __r |= 1;
if (after === 'inside') __r |= 2;
`),
    ).toBe(3);
  });

  // The same shapes on the HOST lane. The change is un-gated, so this is the
  // measurement that host did not move — and the declaration case GAINS here
  // (it fails on host on the base tree, for the same reason).
  it("the host lane agrees — expression and declaration", async () => {
    expect(
      await runTest262Shaped(
        `
var x = 'outside';
var got;
var it = (function*(_ = eval('var x = "inside";')) { got = x; yield 1; }());
it.next();
if (got === 'inside') __r |= 1;
`,
        "gc",
      ),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — a PLAIN function was already correct (the splice's local
  // IS the body's local there). Green on base too; fails if the new spill
  // registration perturbs the non-generator path.
  it("a plain function is unchanged [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var got, probeBody;
(function(_ = eval('var x = "inside";')) {
  got = x;
  probeBody = function() { return x; };
}());
if (got === 'inside') __r |= 1;
if (probeBody() === 'inside') __r |= 2;
`),
    ).toBe(3);
  });

  // NEGATIVE CONTROL — eval in the generator BODY (not the parameter list) was
  // already correct: there the splice runs inside the resume function itself.
  // Green on base too.
  it("eval in the generator BODY is unchanged [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var probeBody;
(function*() {
  eval('var x = "inside";');
  probeBody = function() { return x; };
}()).next();
if (probeBody() === 'inside') __r |= 1;
`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — the eval-created `var` must NOT leak to the OUTER
  // binding: it belongs to the function's VariableEnvironment, not the script's
  // (§10.2.11 step 20). Green on base too; this is the assertion that the new
  // frame slot shadows only inside the generator.
  it("the outer binding is untouched [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
(function*(_ = eval('var x = "inside";')) { yield 1; }()).next();
if (x === 'outside') __r |= 1;
`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — a generator with no parameter-list eval must be
  // untouched: `collectParamScopeEvalVarNames` returns empty, so no spill is
  // registered and the frame layout is unchanged. Green on base too.
  it("a generator with no parameter-list eval is unchanged [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var b = 0;
function* g(a = 5, [p, q] = [1, 2]) {
  if (a === 5) b |= 1;
  if (p === 1 && q === 2) b |= 2;
  yield 1;
}
g().next();
__r = b;
`),
    ).toBe(3);
  });

  // NEGATIVE CONTROL / recorded boundary — a NON-constant eval argument is
  // deliberately NOT covered. `constantEvalText` resolves only literal shapes,
  // because naming a binding the splice does not actually create would shadow the
  // outer binding with an inert frame slot. Asserted by the SHAPE of the module
  // rather than by running it: a non-constant argument falls to the runtime-eval
  // provider (`js2wasm:runtime-eval` import), which is exactly the case the
  // static splice — and therefore this fix — does not reach. A later lane that
  // widens the resolver gets a failing assertion here instead of silently moving
  // a boundary nobody recorded.
  it("residual: a non-constant eval argument still falls to the runtime-eval provider", async () => {
    const r = await compile(
      `var x = 'outside';
var src = 'var x = "inside";';
var got;
(function*(_ = eval(src)) { got = x; yield 1; }()).next();
export function run() { return got === 'inside' ? 1 : 0; }
`,
      {
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        deferTopLevelInit: true,
      },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // `r.imports` enumerates only the `env` host imports, so the provider
    // dependency is read off the instantiation instead: a module that needs
    // `js2wasm:runtime-eval` did NOT take the static-inline splice.
    await expect(WebAssembly.instantiate(r.binary, {})).rejects.toThrow(/js2wasm:runtime-eval/);
  });
});

describe("#6651 SC1 — pinned residual: a REST PARAMETER on a generator bails native lowering", () => {
  // The third standalone-only row of the family,
  // `expressions/object/scope-gen-meth-param-rest-elem-var-close.js`, is a
  // COMPILE ERROR, and the cause is neither eval nor destructuring: a rest
  // PARAMETER on any generator fails `isNativeGeneratorCandidate`'s
  // `param.dotDotDotToken` bail (documented there as the #2920/#3386 "separate
  // follow-up"), which routes to the host-generator eager-buffer path and so
  // leaks `env::__create_generator` & co. in standalone.
  //
  // Pinned in its CURRENT state, with the two probes that localise it: the bare
  // rest parameter alone fails, and the same shape WITHOUT `*` compiles. A later
  // lane lifting the bail gets a failing assertion here.
  it("a bare generator rest parameter does not compile for standalone", async () => {
    const r = await standaloneCompiles(`
var got;
function* g(...a) { got = a.length; yield 1; }
g(1, 2).next();
`);
    expect(r.ok, `expected the #2920/#3386 rest bail, got a clean compile`).toBe(false);
    expect(r.error).toMatch(/native generator lowering|__create_generator/);
  });

  it("the row's own shape does not compile for standalone", async () => {
    const r = await standaloneCompiles(`
var x = 'outside';
var probeParam, probeBody;
({
  *m(...[_ = (eval('var x = "inside";'), probeParam = function() { return x; })]) {
    probeBody = function() { return x; }
  }
}.m().next());
`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/native generator lowering|__create_generator/);
  });

  // The localising control: drop the `*` and the identical parameter list
  // compiles AND answers correctly. So the bail is about the rest parameter
  // meeting a generator, not about the rest pattern or the eval.
  it("the same parameter list on a NON-generator method is fine [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var x = 'outside';
var probeParam, probeBody;
({
  m(...[_ = (eval('var x = "inside";'), probeParam = function() { return x; })]) {
    probeBody = function() { return x; }
  }
}.m());
if (probeParam() === 'inside') __r |= 1;
if (probeBody() === 'inside') __r |= 2;
`),
    ).toBe(3);
  });

  // ...and a generator with an ARRAY-PATTERN (non-rest) parameter IS natively
  // lowered, which is the other half of the localisation: the bail is specific to
  // `dotDotDotToken` on the parameter, not to destructuring.
  it("a generator with a non-rest pattern parameter is fine [green on base too]", async () => {
    expect(
      await runTest262Shaped(`
var got;
function* g([a]) { got = a; yield 1; }
g([7]).next();
if (got === 7) __r |= 1;
`),
    ).toBe(1);
  });
});
