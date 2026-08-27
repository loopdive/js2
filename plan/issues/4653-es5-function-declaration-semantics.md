---
id: 4653
title: "ES5 standalone: language/statements/function residual — 12 rows across arguments.callee identity, named-function-expression scope, property-vs-declaration shadowing, and a null-pointer in __module_init"
status: done
completed: 2026-08-23
sprint: current
created: 2026-08-23
updated: 2026-08-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: functions
goal: standalone-gap
related: [4491, 4504, 4515, 4641, 4643]
origin: "wave-5 lead sweep (2026-08-23) on campaign HEAD c9990a7d2+, fresh compiler bundle + eval adapter. All 12 rows re-verified failing; no existing issue covers this directory."
assignee: dev-4653
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/object-runtime-enumeration.ts
func-budget-allow:
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/closures.ts::computeClosureWrapperSig
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/declarations.ts::lowerParamType
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
---

# #4653 — `language/statements/function` residual (12 rows)

> **Outcome: 5 of the 12 rows fixed, 7 documented as residuals with measured
> roots and owners.** `status: done` records that the issue's acceptance bar —
> triage, before/after sweep, per-file flips, zero regressions, pins, residual
> attribution — is met; it does NOT mean all twelve rows pass. The seven open
> rows and their roots are in `## Residuals`, and the twelve rows turned out to
> be **eleven distinct roots**, so they do not belong under one issue. Anyone
> picking one up should start from that section, not from the row table.

## Affected rows (sweep-verified on campaign HEAD, 2026-08-23)

| row | observed |
| --- | --- |
| `S13.2.2_A18_T1.js` | `callee === 0` → got `1` |
| `S13.2.2_A18_T2.js` | `callee === 0` → got `1` |
| `S13.2.2_A17_T3.js` | `RuntimeError: dereferencing a null pointer in __module_init()` at source L38 |
| `S13.2.2_A8_T3.js` | `ReferenceError: arg is not defined` |
| `S13.2.2_A4_T2.js` | `__device.printShape` is `undefined` |
| `S13.2.2_A19_T8.js` | `__func()==="b"` → got `a` |
| `S13.2.2_A2.js` | exception type should be `TypeError`, got `[object Object]` |
| `S13_A6_T1.js` | `__1 === __A` → got `NaN` |
| `S13_A2_T2.js` | `x === "11"` → got `2` |
| `S13_A15_T3.js` | `typeof __func() === "undefined"` → got `object` |
| `13.2-17-1.js` | expected `"data"`, got `"constructor"` |
| `13.2-18-1.js` | `TypeError: Cannot destructure 'null' or 'undefined'` at `fun.prototype` |

Read each test's source: they are NOT one root. At least four visible
sub-shapes — `arguments.callee` identity across the constructed-instance
boundary (the two `A18` rows share one wording), the `new`-instance
property table (`13.2-17-1` / `13.2-18-1` probe `fun.prototype`'s own
descriptors, so they may belong with #4491's MOP lane — measure before
claiming), named-function-expression scope (`A19_T8`, `S13_A2_T2`), and one
hard invalid-access crash (`A17_T3`).

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING. Read it
   fully before the first edit: methodology 1–7 (revert copies at first
   edit, cross-lane third-arm rule, pin-exercises-the-shape, unfoldable
   pins, "N passed" never exit 0), the stale-`compiler-bundle.mjs` trap,
   the worktree symlink-farm + **gitlink** hazard, the concrete-ref
   `try_table` trap, verification floor, commit rules.
2. **Triage first, fix second.** Re-verify all 12 live, read each test's
   source, cluster by measured ROOT (not by filename prefix). Report the
   cluster table before implementing. Fix the largest cluster(s); a lane
   that lands 5 of 12 with the other 7 correctly attributed is a success,
   a lane that "fixes" 12 by guessing is not.
3. `S13.2.2_A17_T3`'s null-pointer is an invalid-access crash — treat it
   trap-first (absent-not-wrong: decline gracefully before answering
   wrongly), and if the correct answer is out of scope, say so with the
   measurement.
4. Hand off, don't double-fix: rows whose root is the descriptor MOP
   belong to #4491 (dev-4491 active in that territory), value-rep rows to
   #4641, prototype-chain rows to #4643. Cross-lane claims need the third
   arm (methodology 7).

## Acceptance

Scoped standalone sweep over `language/statements/function` +
`language/statements/{return,try}` before AND after from your own runs;
per-file flip list; **zero regressions**. `tests/issue-4653.test.ts`
pinning every fixed shape (executing it, not asserting about it), verified
failing on base by revert; `it.fails` pins for measured residuals with
owners. `## Root cause` (per cluster) / `## Fix` / `## Test Results` /
`## Residuals` in this file.

---

## Triage — the 12 rows are ELEVEN roots, not four

Re-verified live on the branch base (campaign HEAD `c42bdbe3e`) with a freshly
rebuilt `scripts/compiler-bundle.mjs` + quickjs adapter (the brief's stale-bundle
trap: on the first pass, two rows reported "quickjs provider is not built" and
one reported a compile timeout — both artifacts of the missing local adapter, not
of the compiler). All 12 confirmed failing after the rebuild.

Every root below was isolated with a reduced probe, not inferred from the row's
error text. Three of the issue file's four premises did not survive measurement:
`S13_A2_T2` is not a named-function-expression scope bug, `13.2-17-1`'s
descriptors are all correct, and `S13.2.2_A19_T8`'s closure capture works in
isolation.

| cluster | rows | measured root | status |
| --- | --- | --- | --- |
| **E** for-in shadow set | `13.2-17-1` | `__object_keys_forin`'s private `seen` table is written with `__extern_set`, which probes the implicit `Object.prototype` companion and fires a user setter | **FIXED** |
| **F** late-assigned fnctor | `S13.2.2_A4_T2` | `var F; F = function(){}` is invisible to both fnctor recognisers, so `F.prototype` and `new F()` disagree | **FIXED** |
| **D** redeclared function slot | `S13_A6_T1` | the module global is typed from the FIRST `function f(){}`'s signature while the emitted body is the LAST one's | **FIXED** |
| **W1** `with (arguments)` | `S13.2.2_A18_T1`, `_T2` | `arguments.callee` is a compile-time property-access arm, not an own property of the backing vec, so the dynamic `with` HasBinding gate misses it | residual — vec representation |
| **W2** re-declared `with` target | `S13.2.2_A19_T8` | two `with` blocks over one re-declared `var` share a target proof keyed off the FIRST initializer's key set | residual |
| **W3** `with` + var-hoisted fn | `S13.2.2_A17_T3` | null-pointer trap in `__module_init` | residual |
| **V** omitted reference-typed arg | `S13_A15_T3` | an omitted argument for a `(ref null T)` parameter is `ref.null T`, i.e. JS `null`, not `undefined` | **FIXED** |
| **P** binary `+` | `S13_A2_T2` | `number + <dynamic>` folded to an f64 add | **FIXED** |
| **C** non-callable call | `S13.2.2_A2` | calling a non-callable object does not throw at all | residual |
| **R** `Function(p, body)` | `S13.2.2_A8_T3` | `++`/`--` inside eval'd/minted code throws for any name bound in a FUNCTION variable environment (the parameter IS bound; reads and `x = x + 1` work) | residual — **#4662** |
| **M** `fun.prototype` own-ness | `13.2-18-1` | a function EXPRESSION has no own `prototype` under the live descriptor MOP | residual — **#4491** |

## Root cause

### E — the for-in shadow set was written through the full `[[Set]]`

`__object_keys_forin` (`src/codegen/object-runtime-enumeration.ts`) walks the
prototype chain and, at each level, marks EVERY own key — enumerable or not —
into a private `seen` table, so a closer own property shadows an inherited
same-named key. `seen` is `__new_plain_object()`: a `$Object` with a **null
`$proto`**, which is exactly how an ordinary object literal is represented in
this runtime. `__extern_set` therefore treats it as one — it exhausts the
explicit `$proto` chain (immediately, there is none) and then probes the
**implicit** `Object.prototype` companion via `__extern_set_decide`'s
`protoIndexSetDecisionInstrs` tail.

Once a test installs an accessor on `Object.prototype` — which the entire
`propertyHelper.js` / `verifyProperty` family does — the mark
`seen[key] = key` **invokes that user setter**, passing the enumerated key as
its argument, and records nothing. Two observable defects from one write:

1. a bare `for (x in o)` fires a setter it must not touch;
2. the shadow set stays empty, so a name owned at two chain levels is yielded
   twice.

Measured on base: `13.2-17-1` fails `assert.sameValue(data, "data")` with actual
`"constructor"`. A step-by-step replay of `verifyProperty`'s phases showed `data`
flipping at the `for (var x in obj)` enumerability probe (`d0=data` →
`d1=constructor`), not at any assignment the test performs.

### F — `var F; … F = function(){}` was invisible to both fnctor recognisers

`fnctorDeclFromSymbol` and `resolveFnctorSymbol` both keyed on a
`VariableDeclaration`'s own initializer. The Sputnik ES5 corpus overwhelmingly
writes the separated form (`var __CUBE, __FACTORY, __device;` then
`__FACTORY = function(){}`), and TypeScript records no function declaration for
that symbol: `getDeclarations()` answers `[VariableDeclaration, Identifier]`,
the Identifier being the `F` of a later expando write, never the assignment's
right-hand function.

The result was not a missed optimisation but the **split brain**
`resolveUserFnctorName`'s own gate comment names. The escape gate held no ctor
declaration for the name, so `resolveUserFnctorName` reached its
`neverConstructed` arm and minted `__fnctor_proto_F`; `F.prototype = {…}` and
`F.prototype.p` read and wrote that global consistently; and `new F()` could not
route to the fnctor lowering at all. Measured on base:

```
var A; A = function(){}; A.prototype = {shape:"cube", printShape:…};
var a = new A();
A.prototype.shape         // "cube"   <- the write landed
Object.getPrototypeOf(a)  // null     <- the instance never saw it
a instanceof A            // false
```

with `var A = function(){}` correct in the same program on the same run.

### D — a var initialized from a REDECLARED function got a numeric slot

ES §14.1.23 hoists every `function f(){…}` declaration and lets the LAST win, so
a duplicated name is one binding holding the second body; every call, including
one written above the second declaration, answers the second body's value.
TypeScript resolves `f()` through the FIRST declaration's signature.

The compiler already emits the last body correctly — on base the emitted
function is `(func $__func (result (ref null 6)))` returning the `'A'` constant.
Only the receiving slot was wrong: `moduleGlobalWasmType` typed
`var __1 = __func()` from the checker's `number`, giving `(mut f64)`, and the
string result coerced to `NaN` on BOTH reads.

### V — omitted actuals must carry JavaScript `undefined`

`S13_A15_T3` uses a formal named `arguments`, which shadows the implicit
`arguments` object and is still an ordinary JavaScript parameter. The native
ABI previously allowed the checker to select a nullable reference type and
filled a missing actual with `ref.null`, exposing `null` to JavaScript. The
formal boundary now stays `externref` for this unannotated spelling, so the
call adapter supplies the canonical `undefined` singleton while supplied
values remain unchanged.

### P — binary `+` must observe the raw surplus argument

The `S13_A2_T2` IIFE observes `arguments[1]`, whose runtime value is the string
`"1"`, while TypeScript infers the named parameter `arg` as numeric. The
numeric fast path therefore applied ToNumber before the operator could apply
ToPrimitive. Function expressions that need their implicit arguments object now
use the ordinary closure activation (preserving argc and extras), widen
unannotated scalar parameters at that boundary, and route `+` through the
dynamic ToPrimitive path when it reads one of those bindings.

## Fix

| file | change |
| --- | --- |
| `src/codegen/object-runtime-enumeration.ts` | the `seen` mark uses `__extern_set_own` (same data-write tail, no descriptor or prototype consult), falling back to `__extern_set` where the own-only helper is not registered — which is exactly the configuration in which `__extern_set` cannot walk a chain anyway |
| `src/codegen/fnctor-ctor-decl.ts` (new) | `lateAssignedFunctionExpression` + the relocated `fnctorDeclFromSymbol`, so the escape gate and the resolver share ONE admission rule |
| `src/codegen/fnctor-escape-gate.ts` | both recognisers consult it; net −16 LOC (the relocation is larger than the addition) |
| `src/codegen/duplicate-function-declaration.ts` (new) | `callTargetIsRedeclaredFunction`, via `ctx.oracle.declarationsOf` |
| `src/codegen/declarations.ts` | `moduleGlobalWasmType` widens a call-initialized global to `externref` when the callee has ≥2 body-bearing declarations — the sibling of the existing purely-void-call arm |
| `src/codegen/closures.ts` | preserves raw call-site values for unannotated scalar parameters of functions that observe their implicit `arguments` object, and records those bindings for dynamic operators |
| `src/codegen/context/types.ts` | carries the raw-arguments binding set through the function context |
| `src/codegen/declarations.ts` | keeps an unannotated formal named `arguments` on an `externref` boundary so omitted actuals remain `undefined` |
| `src/codegen/expressions/call-tail-dispatch.ts` | routes arguments-observing function-expression IIFEs through a real closure activation instead of the inline path |
| `src/codegen/binary-ops.ts` | uses the dynamic `+` lowering when an operand is a raw arguments-observing binding |

**Why F's admission is narrow.** A wrong claim there is a miscompile; a decline
only forfeits today's behaviour. Admitted: a non-exported `var` with no
initializer, declared at the top level of its source file (a module-local `var`
cannot be written from another file, so one file is the whole write set),
written exactly once, by a top-level `F = <FunctionExpression>` statement. A
second write, a compound assignment, an update expression or a for-in/of binding
all decline. Identity is proved with `checker.getSymbolAtLocation`, never
spelling, so an inner scope that shadows the name cannot forge a write.

**Why D's admission is narrow.** Only two or more **body-bearing** declarations
qualify, so an ordinary TS overload set — where only the implementation has a
body — is untouched, as is every singly-declared function.

## Test Results

All numbers below come from runs executed on this branch, by the same driver
(`runTest262File(…, "standalone")`), with the compiler bundle and quickjs
adapter rebuilt locally before the first measurement.

**Scoped sweep**, `language/statements/function` + `language/statements/return` +
`language/statements/try`, 668 files, both arms, 2 shards, 20 s per-row timeout:

| arm | pass | fail | compile_error |
| --- | --- | --- | --- |
| base (`c42bdbe3e`) | 611 | 56 | 1 |
| this branch, as swept | 604 | 53 | 11 |
| this branch, **corrected** | **614** | **53** | **1** |

**Per-file flips (fail → pass), 3 — each re-verified SERIALLY on both arms:**

| row | base | this branch |
| --- | --- | --- |
| `language/statements/function/13.2-17-1.js` | fail | **pass** |
| `language/statements/function/S13.2.2_A4_T2.js` | fail | **pass** |
| `language/statements/function/S13_A6_T1.js` | fail | **pass** |

**Zero regressions.** The raw after-sweep showed ten `pass → compile_error`
rows — `13.0-{7,8,12,13,14,15,16,17}-s`, `13.0_4-17gs`, `13.1-2-s` — every one
of them `compilation timeout` at 24–54 s with the box at load 17–21 (five lanes
sweeping). **A timeout is a measurement failure, not a status**, and
`runTest262File`'s `timeoutMs` is post-hoc: it cannot interrupt a slow compile,
only report after the fact. All ten were re-run SERIALLY at a 120 s timeout on
BOTH arms and **pass on both**, which is what the corrected row above records.
The three real flips were re-run in the same serial pass and hold in both
directions. The one remaining `compile_error`
(`param-dflt-yield-non-strict.js`) is present on base too and is unchanged.

Two earlier measurements were discarded rather than reported: a first pass at
the 12 rows where the missing local quickjs adapter made two rows read as
"provider not built" and one as a compile timeout (the brief's stale-bundle
trap), and a first after-sweep that I aborted because I had file-copy-reverted
the source mid-run for a pin sensitivity check — a sweep whose base moved under
it is not a measurement.

**Pins** — `tests/issue-4653.test.ts`, 23 tests, `npm test -- tests/issue-4653.test.ts`:

- on this branch: **23 passed**;
- on base, by file-copy revert of exactly the three modified files: **3 failed,
  14 passed** (of the 17 pins that existed at the time of that A/B — three
  runtime-eval pins were added afterwards, see residual **R**, and they are
  `it.fails`/positive controls that this change-set does not touch) — and the
  three failures are precisely the three positive pins that guard E, F and D.
  Every negative control and every `it.fails` residual pin answers identically
  on both arms, which is what makes the three failures attributable to this
  change-set rather than to the revert.

The second E pin (a two-level own name yielded once) and the non-enumerable
shadow pin pass on BOTH arms: they guard the half of the shadow write that the
own-only switch must not break, not a behaviour this change flips.

**Counts audit (2026-08-23, prompted by dev-4515's `N == declared` calibration,
since superseded by their two-tier version).** Every pin run I reported above was
filtered inline through `grep -E "Tests |Test Files|✓ tests|×"`, which does NOT
match `Errors N error` — the exact "a pipe can hide the line that would have told
you" defect, committed repeatedly in this lane. Re-run unfiltered:

```
Tests  23 passed (23)
Errors  1 error        <- [vitest-worker]: Timeout calling "onTaskUpdate"
vitest exit status: 1
```

- **Tier 1** (vitest's own summary): `executed = 23 + 0 = 23`, `total = 23`,
  `total > 0 && executed == total` → PASS.
- **Tier 2** (external count, required here because the RPC error IS present and
  it shrinks `passed` and `total` together): `grep -cE '^\s+it(\.fails)?\('` = 23,
  with zero `it.each` / `test(` / `.skip` / `.only` forms → 23 == 23. **Nothing
  was lost.** The error is the RPC drop with no test involved.
- Retrospectively for the base arm: `3 failed | 14 passed` ⇒ executed 17 = the
  17 declared at that time, so tier 1 clears that run from the numbers already
  recorded.

Two things worth carrying out of this. **The exit status was `1` on a run where
all 23 tests passed** — the inverse of the usual trap, and a second reason the
verdict must come from counts rather than `$?`. And the tier-2 grep is genuinely
the weakest link: in dev-4515's file the naive `it\(|test\(` pattern INFLATES
(comments), while in mine it UNDER-counts by 10 (it misses `it.fails(`). Same
pattern, opposite errors, two files — which is why the denominator belongs on
vitest's own summary line wherever tier 1 can answer.

**Exit status carries no verdict in EITHER direction — both measured on this one
suite.** Forcing an all-skipped run of the same file (`-t` matching nothing, the
brief's regex case):

```
npx vitest run tests/issue-4653.test.ts -t "zzz-no-such-test-name-zzz"
  Tests  23 skipped (23)      exit status: 0     <- nothing executed, exits GREEN
npx vitest run tests/issue-4653.test.ts
  Tests  23 passed (23)       exit status: 1     <- everything passed, exits RED
```

Tier 1 classifies both correctly (`executed = 0 != 23` fails; `executed = 23 ==
23` passes) while `$?` is exactly inverted from the truth in both. One file, both
directions, so this needs no cross-file argument.

**Confirmed on this suite: skipped NAMES are `--reporter=verbose` only**
(dev-4515's measurement, independently reproduced here). Same all-skipped run:
`--reporter=basic` prints one file-level line,
`↓ tests/issue-4653.test.ts (23 tests | 23 skipped)`, with **no test names**;
`--reporter=verbose` prints 23 `↓` lines with the full names. So a lane that
skips by accident cannot see WHICH tests vanished under the default or basic
reporter. This suite is unaffected in practice — it declares zero `.skip` /
`.only` / `skipIf`, so `executed != total` can only arise from a filter or an
infrastructure failure, not from an intended skip — but the reporter choice is a
precondition for the tier-1 rule's diagnostic half, not just for its verdict.

**2026-08-25 scope/error-cluster follow-up.** The authoritative 131-row
standalone census used the pinned QuickJS artifact and `COMPILER_POOL_SIZE=1`.
Compared path-for-path with
`benchmarks/results/test262-standalone-results-20260825-144627.jsonl` (81/131
passing), the candidate report
`benchmarks/results/test262-standalone-results-20260825-164800.jsonl` is
**83/131 passing**, with 47 semantic failures and 1 compile error. The only
changes are these two fail→pass flips, with zero pass→fail losses:

| row | base | candidate |
| --- | --- | --- |
| `language/statements/function/S13_A2_T2.js` | fail | **pass** |
| `language/statements/function/S13_A15_T3.js` | fail | **pass** |

The QuickJS adapter compiled and validated successfully. The focused pins in
`tests/issue-4653.test.ts` now execute the exact named-`arguments` formal and
arguments-observing IIFE shapes as positive tests; the seven original rows
listed as residuals below remain `it.fails` with their measured owners.

## Residuals

Seven rows remain, each with a measured root and an owner. None is a guess.

- **W1 `with (arguments)`** (`S13.2.2_A18_T1`, `_T2`) — `arguments.callee` is
  synthesized by a compile-time property-access arm; it is not an own property of
  the runtime vec that backs the arguments object, so the dynamic `with`
  HasBinding gate (`__extern_has`) misses it and `callee = 1` writes the OUTER
  binding. Measured discriminator: inside the same `with (arguments)`,
  `return length` answers 3 for a 3-argument call (the vec DOES own `length`)
  while `return callee` answers the outer variable. A real fix needs `callee` to
  become a writable own property of the arguments object — the row also asserts
  `result.callee === 1` afterwards, so a read-only special case would flip
  CHECK#1 and still fail CHECK#3. That is vec-representation work
  (`src/codegen/vec-overlay*.ts`), owned by another lane; **not** attempted here.
- **W2 re-declared `with` target** (`S13.2.2_A19_T8`) — narrowed to: two `with`
  blocks over the SAME re-declared `var obj`, where the second literal owns a key
  the first does not. The same program with two DISTINCT target variables is
  correct, and a single `with` block with a `var`-declared closure inside is
  correct; only the re-declared target fails. The static target proof is keyed
  off the first initializer's key set.
- **W3 `with` + var-hoisted function expression** (`S13.2.2_A17_T3`) — a
  `var f = function(){}` declared inside a `with` body whose target owns the same
  name traps with `dereferencing a null pointer in __module_init`. Reproduced in a
  reduced probe. Trap-first: this is an invalid access, not a wrong answer, and I
  did not attempt a fix I could not verify end-to-end within this lane.
- **V omitted reference-typed argument** (`S13_A15_T3`) — **FIXED by this
  follow-up**. The row's `arguments`-named formal now uses an `externref`
  boundary, so an omitted actual is the canonical JavaScript `undefined` while
  a supplied string remains a string. The focused pin exercises both calls.
- **P binary `+`** (`S13_A2_T2`) — **FIXED by this follow-up**. The named
  function-expression scope check remains correct, `arguments[1]` remains the
  string `"1"`, and the arguments-observing IIFE now takes the closure path and
  reaches dynamic `+` rather than applying an eager numeric add.
- **C non-callable call** (`S13.2.2_A2`) — `rose()` does not throw at all; it
  evaluates to `undefined`. That is why the row reports `[object Object]`: the
  test's own `throw new Test262Error(…)` then runs inside the `try` and is caught
  as "the exception". The spec answer is a TypeError from §7.3.14 Call step 1.
- **R `Function(p, body)`** (`S13.2.2_A8_T3`) — **CORRECTED TWICE. Read the final
  rule, not the two superseded ones; both earlier versions are recorded below
  because the way they failed is the useful part.**

  **Final measured rule** (`.tmp/probes/ev{1,…,6}.js`, standalone, this branch):

  > Inside eval'd / `Function`-minted code, an **update expression (`++`/`--`)**
  > throws `ReferenceError: <name> is not defined` for any name whose binding
  > lives in a **FUNCTION variable environment** — the enclosing function's
  > locals or parameters, a `Function`-mint's own parameters, or an eval-local
  > `var` when the eval runs inside a function. It works for names bound in the
  > **module/global** environment. **Plain reads and compound assignment
  > (`x = x + 1`) work in every case.**

  The axis is **where the name is bound**, not what syntax surrounds it and not
  whether an enclosing function exists.

  | shape | binding lives in | result |
  | --- | --- | --- |
  | `eval("n + 1")` — read | module | ✓ 1 |
  | `eval("if (a<3){a=7;}")` — outer in IF test | module | ✓ 7 |
  | `eval("while (d<3){ d++; }")` — `++` | module | ✓ 3 |
  | `eval("var i=0; i++; i")` at module top level | module | ✓ 1 |
  | `eval("var j=0; j=j+1; j")` — compound assign | fn | ✓ 1 |
  | `eval("var k=0; while(k<1){k=k+1;} k")` | fn | ✓ 1 |
  | `eval("d + 1")` — read of a fn-local | fn | ✓ 42 |
  | `eval("var i=0; i++; i")` inside a function | fn | **THROW** `i` |
  | `eval("var m=0; while(m<1){m++;} m")` inside a fn | fn | **THROW** `m` |
  | `eval("var q=0; for(q=0;q<3;q++){} q")` inside a fn | fn | **THROW** `q` |
  | `function h(){ var d=0; eval("d++;"); }` | fn | **THROW** `d` |
  | `function h(){ var d=0; eval("while(d<3){d++;}"); }` | fn | **THROW** `d` |
  | `(function(p){ eval("p++;"); })(1)` — fn param | fn | **THROW** `p` |
  | `(function(p){ return eval("p + 1"); })(1)` — read | fn | ✓ 2 |
  | `new Function("p","return p;")(7)` | fn | ✓ 7 |
  | `new Function("p","return p+1;")(1)` | fn | ✓ 2 |
  | `new Function("p","p=p+1; return p;")(1)` | fn | ✓ 2 |
  | `new Function("p","p++; return p;")(1)` **at module top level** | fn | **THROW** `p` |
  | `new Function("","var z=0; z++; return z;")()` | fn | **THROW** `z` |

  `S13.2.2_A8_T3` is the `Function`-parameter row: `Function.call(this, "arg",
  "return ++arg;")`. Owner: the runtime-eval lane; filed as **#4662**.

  **Superseded v1** — "the minted function does not bind its declared
  parameters". False: `new Function("p","return p;")(7)` answers 7. I had not run
  the read-only case.

  **Superseded v2** — "`++` on a name LOCAL to the eval'd/minted code, and only
  when the eval/mint sits inside an enclosing FUNCTION". Both halves wrong.
  *Local-vs-outer* is the wrong axis: an enclosing function's own local `d`
  is neither eval-local nor module-level, and it **throws**. *Enclosing function*
  is the wrong gate: `new Function("p","p++;…")` throws at **module top level**,
  where no enclosing function exists — a `Function` parameter is always bound in
  a function environment, which is what actually decides it.

  **How both were wrong the same way.** Each version generalised from the cells
  my probe harness happened to make convenient. v1 varied only the operator on
  one shape. v2 varied operator × surrounding-syntax × top-level-vs-in-a-function
  — a 3-axis table that never varied *where the name is bound*, because every
  probe wrapped its subject in the same `note()` helper and every "outer"
  variable I chose was module-level. The refuting probe was two lines each time.
  A table is only evidence for the axes it varies; the axis you did not vary is
  where the wrong rule hides.

  **dev-4515's repro is vindicated and the tree question is closed.** Their
  `var n = 0; eval("while(n<3){ n++; }")` sits inside an `export function
  test(){…}` pin — the error text they quoted names `n4515`, not `n`, which is
  what showed me the source was not the snippet — so `n` is an
  **enclosing-function local**, row 12 above, and it throws here too. My earlier
  "does not reproduce on my base" was measuring row 3 (a module-level `var`), a
  different cell. There is no tree difference between `c42bdbe3e` + mine and
  `8794ab2c9` + theirs on this shape.

  **The reflex that kept this alive for three rounds was mine first.** When our
  results disagreed I wrote, in this file, "per the brief's third-arm rule I can
  only say it does not reproduce here; whether their tip differs is theirs to
  measure" — invoking a rule about *claims* to justify not *reconciling*. The
  third-arm rule is right that I cannot assert anything about their tree; it
  says nothing about whether we measured the same cell, which is the question a
  disagreement actually poses and which costs one probe to answer. dev-4515
  reached the same stopping point independently, which is what makes it a
  process gap rather than a lapse: added to the brief as methodology 6 (a table
  is only evidence for the axes it varies) and a new bullet under 7 (the
  third-arm rule governs claims, not disagreements). Both **ratified** by the
  lead and carried in PR #4814.

  **Deliberately NOT promoted to the brief — do not re-add it.** dev-4515 and I
  converged on a synthesis of the three instances in this thread: *the check you
  didn't run, the axis you didn't vary, the line you didn't print* — one shape,
  where the failure is invisible because the instrument that would have shown it
  was never pointed at it, and in all three cases pointing it cost one command.
  The lead **declined** to add it, and the reason is budget rather than quality:
  the brief took eleven edits in one session, and a document every lane must read
  before its first edit stops paying for additional insight per page. It lives
  here and in `plan/issues/4515-…md` instead, which is where a lane doing this
  kind of work lands. **Promotion trigger: a fourth independent instance of the
  same shape.** If you are about to add it because it seems obviously missing,
  that judgement has already been made — supply the fourth instance instead.
- **M `fun.prototype` own-ness** (`13.2-18-1`) — **owner #4491**, with evidence: a
  function EXPRESSION has no own `prototype` property under the live descriptor
  MOP. With an accessor installed on `Function.prototype.prototype`,
  `fun.prototype` therefore reads as `undefined` and
  `hasOwnProperty(fun, "prototype")` is false, so `verifyProperty`'s
  `assert(__hasOwnProperty(obj, name))` cannot hold and `fun.prototype.toString()`
  throws first (base error: "Cannot destructure 'null' or 'undefined'").
  **This is DISTINCT from its sibling `13.2-17-1`**, whose
  `fun.prototype.constructor` descriptors are already fully correct on base
  (`writable: true, enumerable: false, configurable: true`, own, data) — that row
  rooted in the for-in shadow write and is fixed here. The pair looked like one
  family and is two. Routed to the issue file rather than to a live lane: the
  dev-4491 lane completed and stood down (its slice is in PR #4808), so the next
  lane on #4491 picks this row up from here.

One residual is NOT one of the twelve, found while measuring F and worth
recording: `a instanceof A` still answers false for a late-assigned fnctor even
now that `Object.getPrototypeOf(a)` is right. `native-user-instanceof.ts` reaches
the same `emitFnctorProtoGet` but a different arm decides first. Pinned
`it.fails`.

Also observed while measuring E, outside this issue's rows: an inherited
accessor's SETTER is not invoked by an ordinary `o.zzz = 42` when `zzz` is an
accessor on `Object.prototype` and `o` has no own `zzz` (measured: the setter
never ran). That is #4504's territory, stated here only because the same
`__extern_set_decide` path carries both.

## Cross-lane note

`language/statements/try` is in this sweep's scope and **dev-4515 has landed
§13 completion-value changes that move three rows in it**
(`try/cptn-finally-{wo-catch,skip-catch,from-catch}.js`) on branch
`issue-4515-wave5`. Those are eval-only and touch no file this change-set
touches (`statements/eval-completion-value.ts`, `statements.ts`,
`statements/exceptions.ts`, `expressions/eval-*.ts`, `helpers/*`,
`binary-ops-in.ts` vs this lane's `object-runtime-enumeration.ts`,
`fnctor-escape-gate.ts`, `declarations.ts` + two new modules), so there is no
file conflict. Per the brief's third-arm rule, the numbers above are for THIS
branch only and say nothing about dev-4515's effect: those three rows are `fail`
on both of my arms, exactly as they should be, because neither arm contains
their change. The combined tree needs its own run.
