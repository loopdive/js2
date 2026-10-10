---
id: 6937
title: "Script-goal compile of a single file is half-applied: `inferModuleStrictArguments: false` makes function code sloppy, but `ctx.sourceIsModule` still follows the synthetic `export` (Octane crypto `setupEngine`, navier-stokes `checkResult`)"
status: ready
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: core-semantics
sprint: current
related: [874, 833, 6474, 6491, 2119, 4190, 3956]
assignee: "ttraenkler/claude-session-c-octane-script-goal-20261010"
---

# #6937 — the single-file Script-goal switch stops at function strictness

Found by the Octane triage for #874 (Session C, 2026-10-10). Two of the nine
selected Octane benchmarks fail at run time on both the gc host and the
standalone lane:

| bench | symptom (gc host) | Octane construct |
| --- | --- | --- |
| crypto | `ReferenceError: setupEngine is not defined` | `setupEngine = function(fn, bits) {…}` — a sloppy-mode assignment to an undeclared identifier (crypto.js:147), called at crypto.js:1677 |
| navier-stokes | `this.result` write on `undefined` (NaN result / Wasm exception) | `function checkResult(dens) { this.result = 0; … }` called as a plain `checkResult(...)` (navier-stokes.js:52) — in sloppy code `this` is the global object |

Standalone reports both as an opaque `[object WebAssembly.Exception]`.

## Minimized repro (node vs js2)

Three one-file programs, run through the public `compile()` with
`{ fileName: "input.js", allowJs: true, skipSemanticDiagnostics: true,
validate: false }` (driver: `.tmp/run-js.mjs`, gc host and `target:
"standalone"`), and through node as a **Script** (`vm.runInThisContext`,
`.tmp/run-script-goal.cjs`) and as a **Module** (`node file.js` — the repo's
`package.json` has `"type": "module"`, so a `.js` runs as ESM):

```js
// r1 — implicit global (crypto's setupEngine)
setupEngine = function (x) { return x + 1; };
function f() { return setupEngine(41); }
export function main() { return f(); }

// r2 — sloppy `this` in a plain call (navier-stokes' checkResult)
function checkResult(d) { this.result = 0; this.result += d; return this.result; }
export function main() { return checkResult(77); }

// r3 — top-level `this` and `var` as global-object property
var top = this;
var g = 7;
export function main() { return top === undefined ? -1 : (top.g === 7 ? 1 : 0); }
```

(For node the `export` is dropped and `console.log(main())` appended.)

| | node Script goal | node Module goal | js2 default (gc = standalone) | js2 `inferModuleStrictArguments: false` (gc = standalone) |
| --- | --- | --- | --- | --- |
| r1 | `42` | `ReferenceError: setupEngine is not defined` | `ReferenceError: setupEngine is not defined` / Wasm exception | **`42`** |
| r2 | `77` | `TypeError: Cannot set properties of undefined` | `NaN` / Wasm exception | **`77`** |
| r3 | `1` | `-1` | `-1` | **`-1`** (wrong — should be `1`) |

So:

1. js2's **default** behaviour is spec-correct for the input as written: a
   top-level `export` makes the file Module code, Module code is strict
   (ECMA-262 §11.2.2 / §16.2.1), and node agrees line for line. The Octane
   driver (`PRELUDE + base.js + bench.js + export function octane_run(reps)`)
   therefore compiles a sloppy script as a strict module. That is the direct
   cause of both assigned failures — a goal-selection problem in the harness,
   not a codegen defect.
2. The compiler already has the switch for exactly this shape — a Script-goal
   source carrying a synthetic `export` as its entry point —
   `CompileOptions.inferModuleStrictArguments: false` (#2119; `src/index.ts`
   L664-680). With it, r1 and r2 pass on both lanes, i.e. the implicit-global
   path (`src/codegen/expressions/implicit-global-binding.ts`,
   `unresolvable-assign.ts`) and the sloppy-`this` path
   (`src/codegen/helpers/sloppy-this-global.ts`,
   `src/codegen/expressions/this-keyword.ts`) are already correct.
3. **The switch is half-applied (r3).** It flips function-level strictness and
   the Script-only lexing, but **not** the top-level binding goal, so a
   "script" compiled this way still has module-goal top-level `this`
   (`undefined`) and module-scoped `var`s (no global-object property). This is
   the compiler defect this issue fixes.

## Root cause (confirmed)

The Script-goal signal is read in four places; three honour it, one does not:

| site | reads the signal? | effect |
| --- | --- | --- |
| `src/codegen/helpers/is-strict-function.ts` `isStrictFunction` L60-99 / `isStrictContext` L103-121 | yes (`inferModuleStrict && isModuleSourceFile(node)`) | function/expression strictness → sloppy |
| `src/compiler.ts` `lexScriptSource` L1673-1675, for-head compat L1723-1725 | yes (`options.inferModuleStrictArguments === false` ⇒ "explicit Script-goal compile") | Annex B HTML-like comments, `for` head quirks |
| `src/codegen/index.ts` multi-file `generateMultiModule` L10680-10684 (#6474 `entryScriptGoal`) | yes (its own flag) | `ctx.sourceIsModule` from the entry's real `externalModuleIndicator` |
| **`src/codegen/index.ts` single-file `generateModule` L5336-5337** | **no** | `ctx.sourceIsModule = sourceFileInternal.externalModuleIndicator !== undefined;` — the synthetic `export` alone decides the goal |

`ctx.sourceIsModule` is what the top-level goal hangs off:
`src/codegen/expressions/this-keyword.ts` L104 (top-level `this` → global
object only when `!ctx.sourceIsModule`), `src/codegen/global-var-bindings.ts`
L208 and `global-function-bindings.ts` L69 (top-level `var`/function → global
object property), `src/codegen/global-environment.ts` L779/L834,
`helpers/sloppy-this-global.ts` L248, `module-global-registration.ts`
L158-179 (standalone), `declarations/module-var-undefined-seed.ts` L92 and
`statements/variables.ts` L1744 (standalone script var bindings),
`literals.ts` L1849, `expressions/identifier-module-storage.ts` L185-240,
`expressions/unresolvable-assign.ts` L85.

Why the test262 lanes never see this: the honest original-harness lane
compiles a script test **without** any `export` (`tests/test262-runner.ts`
`buildNegativeCompileSource` L3842 appends `export {}` only for module-goal
rows; the body runs from the exported `__module_init` under
`deferTopLevelInit`), so `externalModuleIndicator` is genuinely unset. The
linked lane uses the multi-file path and `entryScriptGoal` (#6474). Only the
legacy `wrapTest` lane (`tests/test262-runner.ts` L4962-4972), the QuickJS
eval-provider canaries (`scripts/build-quickjs-eval-provider.mjs` L254-262,
L304-318) and `scripts/compiler-fork-worker.mjs` L67-83 combine
`inferModuleStrictArguments: false` with a synthetic `export` — all of them
emulate a script and would be *more* faithful after the fix.

Export emission does not depend on the goal: `src/codegen/declarations.ts`
L3110 `const isExported = isEntryFile && hasExportModifier(stmt);` — so a
Script-goal compile keeps its `export function` entry points as Wasm exports.
(Verify on the fixed build; this is the one assumption the plan rests on.)

## Implementation Plan

Session C implements this at the project lead's direction; the touched files
are in Session A's WasmGC / shared-IR area, so the exact functions are listed
for an overlap check.

### 1. Compiler — honour the Script-goal signal for the top-level goal

`src/codegen/index.ts`, `generateModule` (single-file), L5336-5337. Mirror the
multi-file rule of #6474:

```ts
// (#6937) `inferModuleStrictArguments: false` is the caller's statement that
// the top-level `export` is a synthetic entry point on a SCRIPT (test262
// wrappers, Octane/benchmark drivers, QuickJS canaries). Function strictness
// (is-strict-function.ts) and Script-only lexing (compiler.ts) already honour
// it; the top-level goal must too, or `this`/`var` stay module-scoped.
ctx.sourceIsModule =
  sourceFileInternal.externalModuleIndicator !== undefined && ctx.inferModuleStrictArguments !== false;
```

Keep `isModuleSourceFile()` in `is-strict-function.ts` unchanged (it is
already gated by the same flag). Do **not** derive this from `scriptGoal`
(#6491) — that flag rejects `export` declarations as SyntaxErrors, which is
the opposite of what a synthetic-entry-point driver needs — and do not add a
fourth goal flag; three (`inferModuleStrictArguments`, `scriptGoal`,
`entryScriptGoal`) is already the maximum anyone should have to understand.

Order/semantics constraints (ECMA-262):

- §16.1.7 GlobalDeclarationInstantiation vs §16.2.1.6.4 module environment:
  with the flag, top-level `var`/function declarations become
  global-object properties and top-level `this` is the global object
  (§9.4.4 / §19.1 `globalThis`), exactly as `!ctx.sourceIsModule` already
  lowers them for export-free scripts. `let`/`const`/`class` stay lexical
  (§16.1.7 step 15/16) — no change needed, they are already not global
  properties.
- Exported entry points keep their Wasm export and keep binding by name inside
  the script; an `export function octane_run` that the script also calls
  internally must still resolve (`declarations.ts` L3110 path).
- A `"use strict"` prologue or class body still forces strict (§11.2.2) —
  unchanged, `isStrictFunction` L68-76.
- Standalone: `module-global-registration.ts` L158-179 and the
  `standaloneScriptVarBindings` seeds (`module-var-undefined-seed.ts` L92,
  `shared-script-var-access.ts` L46, `variables.ts` L1744) now take the
  script arm for these compiles — same code path export-free test262 scripts
  already exercise, so no new lowering.

### 2. Document the switch where a harness author will find it

`src/index.ts` L664-680: the `inferModuleStrictArguments` doc comment still
reads as an `arguments`-mapping detail. Add one paragraph: *"`false` is the
Script-goal switch for a single-file source whose top-level `export` is a
synthetic entry point: function code is sloppy, top-level `var`/function
declarations are global-object properties, top-level `this` is the global
object. Use it for benchmark drivers and test wrappers; never for real module
input."* Mention it in `plan/issues/874-benchmark-compare-all-js-to.md` §Driver
contract (see step 4).

### 3. Regression tests — real source through the public `compile()`, vs node

`tests/issue-6937.test.ts` (vitest), both lanes (`gc` host via
`buildImports`/`instantiateWasm`, and `target: "standalone"`):

- r1, r2, r3 above with `inferModuleStrictArguments: false` → `42`, `77`,
  `1` (the node Script-goal values; assert the literals, do not shell out to
  node in CI).
- A fourth case `var g = 7; export function main() { return globalThis.g; }`
  → `7` (var → global property, the half that r3 reads through `this`).
- A fifth: `export function octane_run(n) { return n + 1; } export function
  main() { return octane_run(1); }` → `2` (exported entry point still
  callable from the host AND by name inside the script).
- Negative controls (must NOT change): r1/r2/r3 **without** the flag keep
  module semantics (`ReferenceError`/throw, `NaN`-or-throw, `-1`); r2 with a
  `"use strict"` prologue and the flag still throws; a source with no `export`
  at all is unaffected either way (`sourceIsModule` was already false).
- Linear lane: not applicable — `src/codegen-linear/` and `src/ir/` do not
  read `sourceIsModule` or `externalModuleIndicator` (grep 2026-10-10: 0
  hits); add one `target: "linear"` compile of r3 as a does-not-regress check
  only if the lane compiles it today.

Existing gates to run: `tests/test262-edition-ratchet` is unaffected (no
runner change), but run the legacy in-process runner on a scoped set that
uses top-level `this` (`language/global-code/`, `language/statements/variable/
*global*`) before/after, because that lane is the one existing caller whose
`sourceIsModule` flips; and `node scripts/build-quickjs-eval-provider.mjs`'s
`verifyQuickjsProvider` canaries (they pass the flag with exports).

### 4. Octane driver (#874, `benchmarks/octane/worker-js2.mjs`)

- Pass `inferModuleStrictArguments: false` on every js2 lane. Drop the planned
  `var setupEngine;` prelude shim — the benchmark must run unmodified, and the
  shim would mask exactly this class of defect.
- The node reference worker must run the driver as a **Script**, not as a
  CommonJS or ESM file: `.tmp/octane/<bench>.js` inside this repo is ESM
  (`"type": "module"`) and would fail r1/r2 like js2 did, and a `.cjs` makes
  top-level `this` the `module.exports` object (r3 → `0`). Use
  `vm.runInThisContext` (or `node --input-type=commonjs` is still wrong for
  `this`), as `.tmp/run-script-goal.cjs` does.

### Acceptance criteria

- [ ] r1/r2/r3 and the var-as-global case pass on gc and standalone with
      `inferModuleStrictArguments: false`; negative controls unchanged.
- [ ] Octane `crypto` and `navier-stokes` compiled with the flag no longer fail
      at `setupEngine` / `checkResult` (measured with
      `.tmp/octane-probe-sloppy.mjs`, `SLOPPY=1`). This is a *progress* check,
      not a pass check — see the two unrelated blockers below.
- [ ] `scripts/build-quickjs-eval-provider.mjs` verification still passes;
      scoped legacy-runner comparison shows no pass→fail.
- [ ] `src/index.ts` doc paragraph added; #874 driver contract updated.
- [ ] `check-loc-budget` / `check-func-budget` / `check-coercion-sites` /
      `check:oracle-ratchet` / `check:dead-exports` green (the change is one
      expression plus tests, so no allowance should be needed).

## Not in scope (found on the way, not root-caused — file separately)

- **navier-stokes still traps after the goal fix**: `Cannot access property
  on null or undefined` at combined-source 538:39 = navier-stokes.js:146
  `x[0] = 0.5 * (x[1] + x[rowSize])` in `set_bnd` — the field array `x` reads
  as null. Suspected (not verified): the `var temp = u0; u0 = u; u = temp;`
  parameter swaps in `vel_step` over `FluidField`'s closure-captured
  `u`/`v`/`dens` arrays. Same failure with and without the flag, both lanes;
  it fires on the first `run()` (frame 1), so the
  frame-15 `checkResult` was never reached in this session's runs (the
  `checkResult` attribution in #874's table came from a different driver
  shape).
- **crypto under the flag compiles (gc, 6.2 s) but `octane_run(1)` had not
  returned after 17 min** when this triage ended (node: 13 ms). Likely the hot `this.am(...)` /
  `BigInteger.prototype.am = fn` dynamic-method path, not the implicit global
  itself. Needs its own minimization.

## Overlap check (2026-10-10)

- `node scripts/pre-dispatch-gate.mjs 833` → CAUTION (5 historical commits,
  no claim, no open PR). #833 is the broad "consider sloppy mode / `--sloppy`
  flag" backlog item (octal escapes); this issue is the specific, already
  half-built switch, so #833 is `related`, not superseded.
- Issues #2119, #4190, #3956, #4202, #4205, #3985 (sloppy `this`, implicit
  globals, top-level global writes) are all `done` and are the machinery that
  makes r1/r2 pass once the goal is right.
- Open PRs (32, listed via REST on 2026-10-10): none touch
  `inferModuleStrictArguments`, `sourceIsModule`, or Octane. Highest issue id
  added by any open PR is 6936 (PR 6608); 6937 is free.
- Claim ledger `upstream/issue-assignments`: #874 is claimed by
  `ttraenkler/claude-session-c-octane-20261010` (same session, octane-harness
  slice); #6937 reserved for this lane (`pr_scan=degraded`, hand-checked
  above).
