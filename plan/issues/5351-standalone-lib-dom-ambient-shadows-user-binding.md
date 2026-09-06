---
id: 5351
title: "standalone/wasi: a lib.dom ambient `declare function` shadows the script's own top-level binding and leaks an env:: import (env::toString, env::blur, …)"
status: in-progress
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: medium
horizon: s
feasibility: easy
model: sonnet
reasoning_effort: high
task_type: bug
area: codegen
language_feature: globals
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [2961, 3561, 2175, 4444]
loc-budget-allow:
  # 2026-09-06 (Sonnet-high implementation): the #5351 fix adds a user-bound
  # top-level name collector (~+23 LOC) to collectReferencedGlobalNames in
  # extern-declarations.ts so a lib.dom ambient `declare function` (toString,
  # blur, focus, …) never shadows the script's own binding. This is the exact
  # subsystem module the pre-pass already lives in (#3272) — there is no
  # separate module to split it into without breaking the single walk over
  # `userFiles` the function already performs.
  - src/codegen/extern-declarations.ts
---

## Problem

24 ES2015 standalone rows fail with `standalone target emitted host imports:
env::toString (#2961)`. They are not an `Object.prototype.toString` gap. The
compiler loads the full default lib (no `lib:` in the three
`ts.CompilerOptions` literals at `src/checker/index.ts:921/1143/1348`), and
`node_modules/typescript/lib/lib.dom.d.ts:38831` declares
`declare function toString(): string;`. A script that binds
`var toString = Object.prototype.toString;` at top level and then USES
`toString.call(x)` has that use resolved by TypeScript to the ambient lib
declaration, not to the script's own binding. `collectReferencedGlobalNames`
(`src/codegen/extern-declarations.ts:622-661`, decision at L651
`if (decls && decls.some(isAmbientGlobalDecl))`) therefore records `toString`
as lib-referenced and `collectExternDeclarations` (L715-817 →
`registerAmbientParseImport`) registers `env::toString`. Renaming the binding
(`var ts2 = …`) gives `imports: []`; `blur`, `focus` (other lib.dom `declare
function`s) reproduce identically (`env::blur`, `env::focus`). Measured
2026-09-05 (scratch `.tmp/w5/tostring/`, batch harness `batch.mts`): the 24
rows are 24/24 `LEAK :: env::toString` on base; with a one-line shadow guard
they are 24/24 `CLEAN`, and the real runner flips 6 to pass and unmasks 18
(their next blocker is `Function.prototype.call` in standalone, #2175, 9 rows;
a null receiver defect in 8 Temporal `branding.js` rows; Array-method
genericity, 1).

Only reachable under `ctx.wasi || ctx.standalone` (`src/codegen/index.ts:5343`
passes `libRefs: undefined` otherwise), so the host lane cannot move.

## Implementation Plan (2026-09-05, Fable lane; Sonnet-high implements)

1. In `collectReferencedGlobalNames` (`extern-declarations.ts:622`), before
   the walk, collect the names the user source files bind at top level:
   `ts.isVariableStatement` declarations with an identifier name, plus
   non-`declare` `FunctionDeclaration` / `ClassDeclaration` names (the function
   already receives `userFiles`; `hasDeclareModifier` is already imported). Add
   `&& !userBound.has(node.text)` to the L651 condition. That is the whole
   change. `.some → .every` does NOT work (measured): TypeScript does not merge
   the script `var` with the ambient declaration, so the use-site symbol carries
   only the lib declaration; the check must be by NAME against the user's own
   top-level bindings. Do not fix it in `collectExternDeclarations`'s loop
   (L715-830) — by then the name is already in `libReferencedNames`.
2. Pin: `tests/issue-5351-lib-dom-shadow.test.ts` — for `toString`, `blur`,
   `focus` and one name that is NOT shadowed (`parseInt`), compile on standalone
   and wasi and assert `result.imports` equals the base's for the unshadowed
   case and `[]` for the shadowed ones; run the six flipped rows through
   `run-test262-paths.mts --isolate --standalone` and assert pass.
3. Corpus A/B (required, the risk is here): `libReferencedNames` also gates
   `collectDeclaredGlobals` (`index.ts:5358`), and ~60 lib.dom `declare
   function` names are in scope (`blur`, `focus`, `stop`, `close`, `open`,
   `print`, `scroll`, …). Compile every `playground/examples/**/*.ts` and every
   test262 ES2015 row body that top-level-binds one of those names (grep the
   corpus for `^\s*(var|let|const|function|class)\s+(<name>)\b`) on standalone
   and wasi before/after and diff the import TABLES; the only allowed change is
   the removal of an `env::<name>` import for a name the source itself binds.
   Also confirm `check-issue-spec-coverage` and the #2961/#3561 leak-scan
   guard tests (`tests/*2961*`, `tests/*3561*`) stay green.

Known sharp edge (record in the test's comment, do not fix here): the checker
still types the shadowed binding with the LIB type (`() => string`); codegen
tolerates it for these 24 bodies (all compile clean), but a binding whose lib
type differs in arity from the user's value could mis-lower a call. The deeper
fix — `lib: ["lib.es2022.d.ts"]` in `src/checker/index.ts`, which also corrects
the resolution (measured 24/24 CLEAN) — removes the DOM global surface for
every compile and is a separate, wider issue.

## Acceptance criteria

- The 6 rows pass: `BigInt/prototype/toString/thisbigintvalue-not-valid-throws.js`,
  `Error/prototype/toString/called-as-function.js`,
  `RegExp/prototype/toString/called-as-function.js`,
  `String/prototype/toString/{non-generic,string-object,string-primitive}.js`;
  the other 18 move from `compile_error` to a real assertion (list each with
  its new error in the implementation section).
- Import tables byte-identical across the corpus A/B except the shadowed
  names; host lane untouched by construction (state the gate).
- Gates green bare and with `LOC_GATE_BASE=origin/main`.

## Lane protocol

Fresh worktree of the session branch; one commit for the fix + pin, one for
the corpus A/B record; `Model: Claude Sonnet 5 High`; never push/PR/enqueue;
append `## 2026-09-05 implementation (Sonnet)` with the measurements.

## 2026-09-05 implementation (Sonnet)

**Fix**: `collectReferencedGlobalNames` (`src/codegen/extern-declarations.ts:622`)
now collects every name the user's own top-level statements bind — `var`
declaration names, and non-`declare` `FunctionDeclaration`/`ClassDeclaration`
names — into a `userBound` set before the identifier walk, and skips the
ambient-decl check entirely for any identifier whose text is in that set
(`!userBound.has(node.text)` added to the walk's `if`, per the plan's L651
condition — implemented at the guard on the outer `if`, equivalent and
short-circuits earlier). +23 LOC, granted in this file's own
`loc-budget-allow:` frontmatter (dated 2026-09-06).

**Mechanism note (not in the original plan, measured while building the pin
test)**: the shadow only manifests in a **script** (no top-level
`import`/`export` — exactly what every test262 body is). Wrapping the same
code in a module (adding any `export`) puts the `var` in module scope, which
never collides with the lib.dom global — confirmed both ways on base. This is
why the pin test and the `blur`/`focus` repros below are written as bare
scripts, and why a `compile()` call that happens to add an `export` will look
falsely "clean" on unpatched code.

### Row-level measurements (base = origin/main at this worktree's fork point,
### via `.tmp/base/src/index.ts`; after = this branch's `src/index.ts`; both
### through `npx tsx`, in-process, no bundle rebuild needed for the compile()
### API — the compiler bundle/eval-provider were rebuilt only for the real
### test262 runner passes below)

**24/24 known leak rows** (`leak-rows.txt`, reused from
`.tmp/w5/tostring/`, batch harness `compile(body, { allowJs: true, fileName:
'probe.js', skipSemanticDiagnostics: true, target: 'standalone',
deferTopLevelInit: true })`): base 24/24 `LEAK :: env::toString`; after 24/24
`CLEAN` (`imports: []`).

**Minimal `blur`/`focus` repros** (no natural test262 namesake — `blur`/`focus`
have no built-in prototype method — so `Object.prototype.blur`/`.focus` stand
in for the same PropertyAccessExpression-initializer shape that reproduces the
mechanism):

```js
var blur = Object.prototype.blur;
blur.call({});
```

base standalone: `["env::blur"]` → after: `[]`. Same for `focus` →
`["env::focus"]` → `[]`. `toString`'s shadow-fix confirmed identical under
`--target wasi` (the only other target that passes `libRefs`,
index.ts:5343/10542 — the js-host lane never reaches this code path, so it is
untouched by construction).

**Unshadowed control**: `parseInt("42", 10);` (genuinely not shadowed
anywhere) — `imports: []` on **both** base and after; the fix does not touch
legitimate unshadowed globals. (parseInt is natively lowered in standalone —
this control is import-neutral by construction, not a case where a real
`env::` import is preserved; recorded as the measured, not assumed, baseline.)

**Real runner — the 6 acceptance-criteria rows**
(`npx tsx scripts/run-test262-paths.mts --isolate --standalone`, compiler
bundle + eval provider rebuilt after the fix): `{ pass: 6 }`, 0 non-pass.

**Real runner — all 24 leak rows** (same command): `{ fail: 18, pass: 6 }`.
The 6 passes are exactly the acceptance-criteria list. The 18 that move from
`compile_error` (base) to a real assertion (after) fall into three buckets,
per-row error below:

| Bucket | Count | New error |
| --- | --- | --- |
| `Object.prototype.toString` `Symbol.toStringTag` cases (Map/Set/WeakMap/WeakSet/Promise/String-Iterator/Array-Iterator/generator/non-string-tag) | 9 | `TypeError: Function.prototype.call is not yet implemented in --target standalone` (#2175, cited in `related:`) |
| `Temporal.*.prototype.toString` branding checks (Instant/PlainDateTime/PlainYearMonth/PlainTime/PlainDate/ZonedDateTime/Duration/PlainMonthDay) | 8 | `TypeError: Cannot access property on null or undefined at 327:18` — a null-receiver defect in the shared Temporal `branding.js` polyfill helper, unrelated to this issue |
| `Array/prototype/methods-called-as-functions.js` | 1 | `Test262Error: copyWithin Expected a TypeError but got a Test262Error` — Array-method genericity, unrelated to this issue |

This exactly matches the Problem section's prediction ("their next blocker is
`Function.prototype.call` in standalone, #2175, 9 rows; a null receiver defect
in 8 Temporal `branding.js` rows; Array-method genericity, 1"). None of the 18
throws a leak-related error — all 18 compile clean and fail on genuine,
pre-existing, unrelated gaps.

### Corpus A/B (required — the risk named in the plan)

**`website/playground/examples/**/*.ts`** (13 files — the actual
`check:ir-fallbacks` corpus path; `playground/examples/` named in the plan no
longer exists at that path in this tree): compiled every file on standalone
and wasi, before/after, diffing the full import table. **0 mismatches across
13 files × 2 targets** — every table byte-identical.

**test262 rows that top-level-bind a lib.dom `declare function` name**: grepped
all 40 `declare function <name>(...)` names in `lib.dom.d.ts` against
`^\s*(var|let|const|function|class)\s+(<name>)\b` across the full test262
corpus (broader than "ES2015 rows" — a full-corpus sweep is the superset and
was cheap enough to run in full) → 92 files. Compiled every one on standalone
and wasi, before/after, diffing the import table (same batch harness as
above, `deferTopLevelInit: true`). **0 unexplained mismatches; 27 allowed
diffs** — every diff was exactly "an `env::toString` import removed, nothing
added" (24 of the original leak rows + 2 more caught by the wider grep:
`test/staging/sm/Function/function-bind.js`,
`test/staging/sm/object/object-toString-01.js` — both also flip LEAK→CLEAN,
consistent with the fix; not part of the 24-row acceptance set but a free
extra confirmation).

**Guard tests**: `pnpm run -s check:issue-spec-coverage` → OK (1 changed
issue file, all gated done-flips carry a probe/test reference).
`tests/issue-2961.test.ts` (11 tests, carries the #3561 refresh) +
`tests/issue-2961-standalone-no-raw-pass.test.ts` (3 tests) → 14/14 pass,
unaffected.

### Gates

All run bare, exit code read directly (never piped):

- `check-loc-budget`: FAILS bare (`merge-base(origin)`) without the frontmatter
  grant → OK with it (`+23` in `extern-declarations.ts`, granted). With
  `LOC_GATE_BASE=$(git rev-parse origin/main)` (the **live** tip, which had
  advanced by 3 unrelated merges since this worktree's fork point): shows one
  **unrelated** pre-existing `+6` in
  `src/codegen/expressions/call-tail-dispatch.ts` — verified this branch never
  touches that file (`git diff --stat` shows only the 3 files this issue
  changed); the `+6` is upstream drift that landed on `main` after this
  worktree forked, exactly the "ceiling reset by main's post-merge baseline
  refresh" case CLAUDE.md names. Re-run with `LOC_GATE_BASE` pinned to this
  worktree's actual fork point (`22a6e4d51e…`, origin/main as of session
  start): clean, only this change's allowed `+23`. Not something to fix here —
  the integrator's merge will re-run this gate against whatever `main` is at
  merge time.
- `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`
  (`getTypeAtLocation +0, ctx.checker +0`), `check:dead-exports` (0 new),
  `check:speculative-rollback`, `check:stack-balance` (all buckets delta 0),
  `check:codegen-fallbacks` (0 corpus hits), `check:any-box-sites`,
  `check:issue-spec-coverage`: all OK.
- TS7 typecheck (`node node_modules/typescript7/lib/tsc.js --noEmit -p
  tsconfig.ts7.json`): clean.
- `pnpm lint` (biome): exit 0.
- Pin test (`tests/issue-5351-lib-dom-shadow.test.ts`, 5 tests): green on
  node 22 and node 25 (`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
  --poolOptions.forks.singleFork=true`).

### Residuals (deliberately not fixed here)

- The sharp edge already named in the Implementation Plan: the checker still
  types the shadowed binding with the lib signature, not the user's actual
  value type. Tolerated for all 24 rows here (all compile clean); the deeper
  fix (`lib: ["lib.es2022.d.ts"]` restriction) is a separate, wider issue.
- The 18 rows' new failures are pre-existing, unrelated gaps (#2175
  `Function.prototype.call` in standalone — 9 rows; a Temporal
  `branding.js` null-receiver defect — 8 rows; Array-method genericity — 1
  row). Not in scope for this issue; #2175 is already tracked and cited in
  `related:`.
