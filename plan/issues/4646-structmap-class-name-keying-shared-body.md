---
id: 4646
title: "structMap keyed by class NAME — same-named classes in different functions share one compiled body (silent wrong behaviour)"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-28
completed: 2026-08-28
assignee: ttraenkler/opus-dev-4646
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, classes
language_feature: classes, closures
goal: correctness
related: [4627, 4616, 4618]
# (#4646) The fix threads a per-declaration class identity through four
# name-keyed sites; the comments explaining WHY each site was a latent
# collapse are the bulk of the growth.
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/nested-declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/statements.ts::compileStatementInner
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #4646 — `structMap` keyed by class NAME, so same-named classes share one body

## Problem

Two class declarations with the **same name** in **different functions** are
distinct classes with distinct bodies. The compiler keys `ctx.structMap` by
class name, so the second declaration reuses the first one's compiled body.
Every call to the second class runs the first class's code.

This produces **no invalid Wasm and no compile error**. It is a silent
wrong-behaviour bug, which is why nothing has caught it.

## Concrete instance

`test262`'s `harness/temporalHelpers.js` declares `class MySubclass` in **five**
separate helper functions:

- `checkSubclassConstructorUndefined`
- `checkSubclassConstructorNotCalled`
- `checkSubclassSpeciesNull`
- `checkSubclassSpeciesUndefined`
- `checkThisValueNotCalled`

All five share the first one's compiled class body. So
`checkThisValueNotCalled`'s subclass constructor — which the source writes as
`called = true` — actually executes the **first** helper's constructor, which
does `++called`. The helper's own assertion (`assert.sameValue(called, false)`)
is therefore checking a value produced by code it never wrote.

## Relationship to #4627 — same key, different map

`569d78f7` (#4616/#4618) fixed exactly this keying mistake in
**`classMemberCaptureGlobals`**, re-keying it from class name to the `ts.Node`
declaration. That healed the *capture-global* cross-wiring, which was
producing invalid Wasm (`global.set expected f64, found i32` — #4627).

**`structMap` was not re-keyed and still uses the class name.** So the same
collapse persists one layer down, minus the crash that made the first one
visible. Found while instrumenting #4627; deliberately left out of scope there
because it is an independent defect with a different failure mode.

## Suggested approach

Mirror `569d78f7`'s fix: key `ctx.structMap` (and audit any sibling map keyed
the same way) by the declaration node rather than the name. Check for other
name-keyed class state at the same time — this is now the second instance of
the pattern, so a sweep is likely cheaper than a third round-trip.

Watch for the synthetic-name path: class **expressions** are collected under a
synthetic name (see `src/codegen/statements/nested-declarations.ts`, the
`structMap.has(syntheticName)` branch), so the keying change has to keep that
working.

## Acceptance criteria

1. Two same-named classes declared in different functions compile to distinct
   bodies, and each behaves per its own source.
2. A regression test under `tests/` in the shape that actually occurs: two
   functions, each declaring `class MySubclass`, with **different** constructor
   bodies, asserting each runs its own.
3. A sweep for other class-name-keyed compiler state, with findings recorded
   even if nothing else turns up.
4. No net regression on the test262 baseline. Note that this may *change*
   results in `test/built-ins/Temporal/**` — those five helpers currently run
   the wrong constructor, so tests depending on them may flip in either
   direction. Investigate any flip rather than assuming it is noise.

## Measured test262 impact — 45 files, all currently dead

Measured 2026-08-23 against a `tc39/test262` sparse checkout at tip-of-main
(53,872 test files) joined to `test262-current.jsonl`.

**No test calls any of the five helpers directly.** They are reached only
through two public entry points:

| Entry point | Fans out to | Test files |
| --- | --- | --- |
| `TemporalHelpers.checkSubclassingIgnored` | `checkSubclassConstructorUndefined`, `checkSubclassConstructorNotCalled`, `checkSubclassSpeciesNull`, `checkSubclassSpeciesUndefined` | 35 |
| `TemporalHelpers.checkSubclassingIgnoredStatic` | `checkThisValueNotCalled` | 10 |
| **union** | | **45** |

All 45 are `*/subclassing-ignored.js` under `test/built-ins/Temporal/**`. All 45
are present in the baseline, and **all 45 currently report `compile_error`**
with the invalid-Wasm signature from #4627 — none of them reaches its test body
today.

So the blast radius is bounded at 45 tests, and **the flip risk is one-way**:
nothing here can regress from `pass`, because nothing here passes. Once #4627's
fix (`569d78f7`) propagates into the baseline these 45 become the population
where this defect is first observable — five helpers sharing one compiled class
body is exactly what `subclassing-ignored.js` tests are written to detect, so
expect some of them to fail on substance rather than pass outright.

Two caveats on the measurement:

- Taken against **tip-of-main** test262 while the project pins a revision. The
  helper call graph is stable, but re-confirm the file count against the pinned
  submodule before quoting 45 as a target.
- Taken against a **pre-#4627** baseline, which is why all 45 read as
  `compile_error`. Re-measure after that fix lands to get the real starting
  point.

## Notes

Do not quote a pass-count target for this issue. 45 is the number of tests that
can *observe* the defect, not the number that will pass once it is fixed.

---

## Resolution (2026-08-28)

### Keying approach chosen: **disambiguate the NAME at collection time**, not re-key `structMap`

`ctx.structMap` was **not** re-keyed by `ts.Node`. Re-keying it is not a smaller
or safer diff — it is not even a well-formed one:

- `structMap` is a `name → wasm type index` table shared with structs that have
  **no declaration node at all**: `__regexp_match_vec` (`vec-overlay-carriers.ts`),
  `DisposableStack` (`disposable-runtime.ts`), the native-proto struct
  (`native-proto.ts`), generator brands, closure-struct subtypes, linear-type
  reservations. A `ts.Node` key has nothing to hold for those.
- It is read from ~50 sites across `src/codegen/` **and** `src/ir/`, most of
  which only ever have a resolved *name* in hand (a display name off the
  checker, a `classExprNameMap` mapping, a `${className}_new` func key).

The compiler's actual identity handle for a class is its **name string**, and the
project already had the right mechanism for making that handle unique per
declaration: the per-site synthetic identity `__anonClass_<Name>_<n>` recorded in
`ctx.anonClassExprNames` (keyed by declaration node), introduced for class
expressions and extended to nested duplicate declarations by #4618. The fix
finishes that job rather than starting a different one. Node keying is used only
where the question genuinely is *"has THIS declaration node been processed?"* —
which a name cannot answer (see `compiledClassBodies` below, and
`classMemberCaptureGlobals` from #4618).

### What was actually still broken

The shape named in this issue — the five `class MySubclass` helpers in
`harness/temporalHelpers.js` — **already worked on `main`**. Measured by
compiling the real fetched harness (`assert.js` + `sta.js` + `compareArray.js` +
`temporalHelpers.js`) with the runner's options, with each of the five
constructors instrumented to write a distinct marker: the four helpers that
construct their subclass reported markers `1,2,3,4` (the fifth,
`checkThisValueNotCalled`, never invokes its constructor — it makes a *static*
call — so it correctly reports nothing). #4618's collection-pass disambiguation
covers that shape.

Three scopes the collection pass does **not** walk survived, and all three were
reproduced failing on `origin/main`:

| Shape | On `main` | Cause |
| --- | --- | --- |
| `class Foo` in a class/object-literal METHOD body vs. one in a function | `null` — the member did not exist | `collectClassesFromStatements` never visits method bodies, so the declaration was never collected; the name-keyed early return in `compileNestedClassDeclaration` made it the *other* class |
| Two `class Foo` in sibling BLOCKS at module scope | second body for both | ditto (the `nestedDuplicate` gate requires a function-like owner, so neither block-scoped class was disambiguated) |
| Two `class Foo` in sibling BLOCKS inside function bodies | second body for both | the eager top-level body lane (`compileClassesFromStatements`) deliberately clears `insideFunction` through control-flow recursion (#2818), so both classes were compiled eagerly **under the same name** and the second overwrote the first's method-table entries |

### The change

1. **`ctx.compiledClassBodies: Set<ts.ClassDeclaration | ts.ClassExpression>`**
   (`context/types.ts`, `context/create-context.ts`), written by
   `compileClassBodies` — the single chokepoint all six body-compile call sites
   funnel through. `compileNestedClassDeclaration`'s "already fully compiled"
   early return now asks this node-keyed ledger instead of
   `structMap.has(className)`. Class **expressions** deliberately keep the
   name-only rule: `compileClassExpression` owns their body emission and this
   path must not duplicate it.
2. **`mintScopedClassIdentity(ctx, decl)`** (`class-bodies.ts`) — factors out
   #4618's mint-and-collect sequence, with the trigger changed from the
   "is it nested?" heuristic to **declaration-node identity**
   (`classDeclarationMap.get(name) !== decl`). A class that legitimately owns
   its name is untouched.
3. **`statements.ts`** calls that helper on demand at the class-declaration
   statement, so a collision the collection pass never saw is disambiguated
   before `compileNestedClassDeclaration` runs — and before the scoped-local
   binding that gives the source name its lexical scoping.
4. **`declarations.ts` / `prepared-class-body-cutover.ts`** — the eager body lane
   now compiles under the scoped identity when one exists. A scoped class always
   takes the legacy walker, because the standalone exact-cutover correlation keys
   off `declaration.name.text`, which is precisely the name that collides.

### Sweep for other class-name-keyed state (acceptance criterion 3)

Essentially the **entire** class-state family in `CodegenContext` is name-keyed,
and after this fix that is correct rather than a defect list:

`structMap` · `structFields` · `classSet` · `classDeclarationMap` ·
`classNewTargetIds` · `classThrowsOnEval` · `classMethodSet` · `classAccessorSet` ·
`deferredClassBodies` · `classParentMap` · `classBuiltinParentMap` ·
`classExternrefBackedSet` · `classTagMap` · `classExprNameMap` ·
`classMethodNames` · `classMethodsCsvGlobal` · `classObjectGlobals` ·
`classStaticMethodNames` · `classStaticMethodsCsvGlobal`

They all key off the same identity handle, so **one** disambiguation at
collection time fixes all of them at once — which is the argument for fixing the
handle rather than re-keying nineteen maps. Only two pieces of state are
node-keyed, both because they answer a per-declaration question a name cannot:
`classMemberCaptureGlobals` (#4618) and `compiledClassBodies` (this issue).

Every remaining `structMap.has(...)` call site was audited. All but the one fixed
here are ordinary *"does a struct exist under this resolved name?"* lookups, which
are correct once names are unique per declaration; the rest are name-minting
uniqueness loops (`generators-native.ts`, `standalone-dom-callback-authority.ts`,
`ir/closure-struct-registry.ts`) or object-type registration
(`index.ts:11371`), none of which involve class declarations.

**One residual, recorded not fixed:** `src/codegen/index.ts:1504` derives the IR
planning descriptor's class name as
`ts.isClassExpression(stmt) ? anonClassExprNames.get(stmt) : stmt.name?.text` —
it does not consult the synthetic identity for a class **declaration**. It was
left alone deliberately: it runs during IR planning, and whether
`anonClassExprNames` is populated at that point was not established. It is not
reachable by any shape in this issue (all six regression cases pass, including
the standalone-relevant lanes), and changing it blind would trade a measured fix
for an unmeasured one.

### Validation

- `tests/issue-4646-samename-class-shared-body.test.ts` — 6 tests, all asserting
  observable runtime behaviour. **4 of 6 fail on `origin/main`** (verified by
  reverting the seven touched sources to their `origin/main` content and
  re-running); 6/6 pass with the fix.
- Real `temporalHelpers.js` compiles and validates, and each helper's
  `MySubclass` runs its own constructor (marker probe above).
- Green locally: `issue-4618-scoped-same-name-classes`,
  `issue-4787-temporal-merge-group-regressions`,
  `issue-4618-class-capture-owner-isolation`,
  `issue-4618-var-bound-class-expression-identity`,
  `issue-4618-closure-sibling-class-capture`,
  `issue-4616-process-and-class-expr-name` (21 tests); the 9 root-level `class-*`
  suites (59 tests); 13 class/prototype/super `tests/equivalence/*` suites
  (62 tests); `issue-2029-*-standalone` and `issue-1364a/b`.
- `tests/es5-standalone-static-eval-class.test.ts` fails **identically on
  `origin/main`** (missing test262 fixtures locally) — pre-existing, not caused
  by this change.
- The full `tests/equivalence/` directory OOMs in this container; CI covers it.
- **No test262 delta is claimed.** The 45 `subclassing-ignored.js` files this
  issue bounds were not run locally; the merge-queue re-validation measures them.
