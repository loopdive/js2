---
id: 3775
title: "Invalid Wasm: an externref module-global used directly as an `if` condition emits no i32 coercion — 'if[0] expected type i32, found global.get of type externref'"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: control-flow
goal: core-semantics
origin: "probing whether acorn's own test suite can be compiled and run ENTIRELY inside wasm (no per-test JS bridge marshaling) — driver.js + a test file + acorn compiled as one unit compiles clean but fails WebAssembly.instantiate()"
related: [3729, 3756, 3757, 1710]
---

# #3775 — externref global as an `if` condition emits invalid Wasm

## Severity

`compile()` reports **success**, emits a ~745 KB binary, and the failure
only appears at `WebAssembly.instantiate()`:

```
WebAssembly.instantiate(): Compiling function #1060:"__closure_340" failed:
if[0] expected type i32, found global.get of type externref @+318923
```

So the compiler produces a **structurally invalid module** without any
diagnostic — the validator is the only thing that catches it. Same class
as the silent-wrong bugs found via the dogfood corpus (#3747/#3749/#3750),
except here it's caught loudly by the engine rather than silently
mis-executing.

## Repro (via the acorn test-suite-in-wasm probe)

Compiling acorn + its own `test/driver.js` + one test file as a SINGLE
module (so the whole suite runs in-wasm with no per-test bridge crossing):

```
=== tests-bigint.js (unit 233 KB) ===
compile: success=true in 27.0s binary=745686
THREW: WebAssembly.instantiate(): Compiling function #1060:"__closure_340"
       failed: if[0] expected type i32, found global.get of type externref @+318923

=== tests-es7.js (unit 237 KB) ===
compile: success=true in 25.8s binary=720807
THREW: ... function #1057:"__closure_340" failed: if[0] expected type i32,
       found global.get of type externref @+319070
```

Both test files fail in the **same** `__closure_340` at essentially the
same offset, so it's one shared construct in acorn/driver, not something
specific to either test file's data.

The driver's own code has several `if` tests on values that are plain JS
truthy checks over module-level state, e.g.:

```js
var tests = [];
exports.runTests = function(config, callback) {
  var parse = config.parse;
  for (var i = 0; i < tests.length; ++i) {
    var test = tests[i];
    if (config.filter && !config.filter(test)) continue;
    var testOpts = test.options || {locations: true};
    if (!testOpts.ecmaVersion) testOpts.ecmaVersion = 5;
    var expected = {};
    if (expected.onComment = testOpts.onComment)   // assignment-in-condition
      testOpts.onComment = []
    ...
```

Note `if (expected.onComment = testOpts.onComment)` — an **assignment
expression used as an `if` condition**, whose value is an externref. That
is a strong candidate for the un-coerced condition (the assignment's
result value flows straight into `if` without the truthiness→i32
lowering), but it has NOT been narrowed to a minimal repro yet.

## Scope

- [ ] Reduce to a minimal repro — start from
      `if (obj.prop = someExternrefValued)` and from a bare
      `if (someModuleGlobal)` where the global is externref-typed, and
      find which shape actually emits the un-coerced `global.get`.
      (`emitWatOnlyFunctions` from #3743 can dump just `__closure_340`
      out of the 745 KB module without building whole-module WAT.)
- [ ] Fix the lowering so ANY value used as an `if`/branch condition is
      coerced to i32 truthiness, regardless of its static type — an
      externref condition should emit the same truthiness test the
      compiler already emits elsewhere, not a raw `global.get`.
- [ ] Audit sibling branch sites (`while`, `for` condition, `?:`,
      `&&`/`||` short-circuit) for the same missing coercion — if the
      `if` path is missing it, those may be too.
- [ ] Regression test pinning the minimal repro (compile + **instantiate**,
      since `compile()` alone reports success today and would not catch it).

## Acceptance criteria

- [ ] Minimal repro compiles AND instantiates (the test must instantiate —
      a compile-only assertion would still pass while broken).
- [ ] The acorn test-suite-in-wasm probe above gets past
      `WebAssembly.instantiate()` (it may then surface further, separate
      issues — that's fine and expected; this issue is only the
      invalid-Wasm blocker).
- [ ] Sibling branch constructs audited, with any additional gaps either
      fixed here or filed separately.

## Why this matters beyond the probe

Running a package's own test suite fully in-wasm is the strongest
dogfood signal available (see #3729's harness, which currently runs
acorn's driver in **JS** and crosses the bridge per test). This bug is
currently the blocker for that stronger mode. Note it is NOT a
performance blocker for #3756 — bridge marshaling was separately measured
and ruled out there — the value here is test fidelity, not speed.
