---
id: 2900
title: "≤ES3 (edition bucket): module indirect default-export binding update returns wrong value"
status: done
priority: high
sprint: 77
created: 2026-06-30
completed: 2026-07-25
feasibility: hard
task_type: bug
area: testing
es_edition: 3
language_feature: module-code
goal: spec-completeness
related: [2898, 3505, 3592]
assignee: ttraenkler/opus-es3
trap-growth-allow:
  count: 1
  reason: "#3596 reclassification: deferring top-level init in the FIXTURE lane lets pending-async-dep-from-cycle.js run past the point it previously stopped, reaching a pre-existing latent illegal_cast trap. Baseline status is `fail` with `TypeError: compareArray is not a function` (reached_test: false) — the harness class this PR fixes, so the baseline DID testify and this is the #3596 baseline-did-testify branch, not the #3595 never-instantiated class. fail -> fail, flavour only; the test has never passed. Reproduced locally by A/B on the single defer flag: OFF `compareArray is not a function`, ON `illegal cast`. PR net +48 pass, host stable-path fine-gate net +67, all other trap categories flat (null_deref 159->159, oob 60->60, unreachable 3->3)."
  tests:
    - test/language/module-code/top-level-await/pending-async-dep-from-cycle.js
---

> Closed 2026-07-02 with the #2932 PR — umbrella split into #2930 (RC2 alias,
> PR #2437), #2931 (RC3 live bindings, PR #2446), #2932 (RC1 .js module-dep
> compile + wrapTest import hoist). With all three in,
> `eval-gtbndng-indirect-update-dflt.js` returns 1 (PASS) through the runner
> path (verified locally by dev-2900f; confirmed by the #2932 PR's sharded CI).

# #2900 — module indirect global-binding update of a default export reads stale

One of the **8 tests blocking 100% ≤ES3 conformance** (edition-heuristic bucket — this is module/ESM code, surfaced under ≤ES3 because it lacks version frontmatter).

## Failing test

`test/language/module-code/eval-gtbndng-indirect-update-dflt.js`

→ **`returned 2`** (assertion failure — the indirectly-updated binding reads the wrong value).

## What it checks

ES module semantics: a `default` export bound indirectly (via an indirect/re-exported binding) must observe later updates to the live binding (module bindings are live, not snapshots). The test mutates the binding and asserts the indirect reference sees the new value.

## Root-cause direction

Module-code (ESM) live-binding handling for the `default` export through an indirect binding. Likely the default-export slot is read as a value copy rather than through the live module-environment binding. This is part of broader module-code support; scope to this single default-export-indirect-update case unless a shared root cause covers more `module-code/eval-gtbndng-*` tests.

## Acceptance

- The indirect default-binding update is observed; the test passes.
- No regression in other `module-code/` tests.

---

## Investigation (dev-2900, 2026-07-01) — root cause is NOT "stale live-binding read"

Deep tracing on current `origin/main` (`414a8610`) shows the issue's framing is a
**misdiagnosis**. The failure is not a stale-value snapshot of a working binding —
the default import `val` never resolves to the fixture's function **at all**, and
the fixture is not even compiled. Three **independent** root causes each block the
test; all three must be fixed for it to pass. This is a broader module-binding
change, not a single-site patch — hence this plan instead of a partial fix.

### How the runner compiles this test

`tests/test262-shared.ts` (and the sharded worker) detect the `_FIXTURE.js` import
(`resolveFixtures`) and compile via `compileMulti(vfiles, "./test.ts", { skipSemanticDiagnostics: true, target, inferModuleStrictArguments })`
— note **no `allowJs`**. `analyzeMultiSource` (`src/checker/index.ts`) builds one TS
program from `{ "./test.ts": <wrapped test>, "./…_FIXTURE.js": <fixture> }` and
codegen concatenates all files into one Wasm module.

### Ground-truth traces

- Real wrapped test → `test()` returns **2** (reproduces baseline).
- Probe injected after the import: `val()` **=== null** (fixture not linked).
- WAT of the merged module: **no `fn` function exists**; both `val()` and the `val`
  read compile to `ref.null extern`. (`__host_eq`/`__box_number` trace confirms the
  asserts compare `null` vs `1`/`2`.)

### Root cause 1 — `.js` module dependency is not compiled (fixture → null)

Without `allowJs`, TypeScript excludes `.js` **root** files from the program, so the
fixture's top-level `export default function fn` is never codegen'd. Proof (minimal,
`skipSemanticDiagnostics: true`):

- file **key** `./h.js`, `export function add` + `import {add}` → `test()` calls `add(1,2)` returns **0** (unlinked).
- identical content, file **key** `./h.ts` → returns **3** (linked).
- `{ allowJs: true }` with the `.js` key → returns **3** (linked).

The existing vitest `tests/issue-1015.test.ts` ("positive fixture test") **already
fails on main** for exactly this reason (`expected 2 to be 1`) — cross-module `.js`
import of `add` returns 0.

**Fix options (broad-impact — MUST validate via full CI / merge_group, not a scoped sweep):**

- (a) Compiler: in `analyzeMultiSource` (`src/checker/index.ts`), auto-set
  `allowJs: true` (keep `checkJs` off to limit diagnostics) when any root file has a
  `.js`/`.jsx`/`.cjs`/`.mjs` extension. Correct for real bundler use (importing `.js`
  from `.ts` is the ESM norm) but changes every multi-file `.js` compile.
- (b) Harness-scoped: pass `allowJs: true` only in the FIXTURE branch of
  `tests/test262-shared.ts` (+ the sharded fork worker). Blast radius bounded to the
  ~172 `_FIXTURE.js` tests. Still a conformance shift for that bucket (many
  `instn-*`/`eval-gtbndng-*` module tests currently "pass/fail" on the null artifact),
  so it needs a full test262 diff before merge.

### Root cause 2 — import-alias name mismatch (local name ≠ target decl name)

Codegen keys `funcMap`/`moduleGlobals`/`closureMap` by the **declaration's own name**
and never registers the differing **local import binding** name. So any import whose
local name differs from the imported symbol's declaration name resolves to `null`.
Proven on `.ts` fixtures (no `.js`/`allowJs` confound):

- `import fn from "./h.ts"` where fixture is `export default function fn(){…}` (local == decl) → `fn()` = **7** ✓
- `import val from "./h.ts"` (local `val` ≠ decl `fn`) → `val()` = **0** ✗
- `import { add as plus } from …` (renamed **named** import) → `plus(1,2)` = **0** ✗
- `export { g as default }` + `import v from …` → `v()` = **0** ✗
- anonymous `export default function(){…}` + `import val` → `val()` = **0** ✗

The test uses `import val from …` with fixture `function fn`, so this bites even after
RC1 is fixed. The read path (`src/codegen/expressions/identifiers.ts` `compileIdentifierCore`,
`name = id.text`) and the call path (`src/codegen/expressions/calls.ts`) both look up
by the **local** name.

**Fix (additive / low-risk — only currently-`null` sites change):** add a helper
`resolveImportedTargetName(ctx, id)` that, when `id.text` is not a known binding,
resolves the checker symbol, follows `SymbolFlags.Alias` via `getAliasedSymbol`, and
returns the target `valueDeclaration`'s name (or `"default"` for anonymous default).
Retry `funcMap`/`moduleGlobals`/`closureMap`/`funcref-value` resolution under the
resolved name at the identifier-read, call, `new`, and `typeof` sites. Model it on
`ensureFuncValueWrappersRegistered` in `calls.ts`, which already uses
`sym.valueDeclaration → decl.name.text` and thus resolves `val` → `fn` for the wrapper
pre-registration (that is why `val()` returned a non-null value in one earlier probe).

### Root cause 3 — reassigned function-declaration is not a live binding

A function declaration whose name is **assigned to** (`fn = 2`) is bound to an
immutable Wasm func index, not a mutable slot. In `emitIdentifierWriteFromLocal`
(`src/codegen/expressions/assignment.ts`) the LHS `fn` is not in `localMap`,
`capturedGlobals`, or `moduleGlobals` (function decls live in `funcMap`), so the write
falls through to the **"undeclared sloppy implicit global → auto-allocate a fresh
local"** arm — the `fn = 2` value is written to a throwaway local and never observed.
Reads of `fn` as a value emit a cached closure struct
(`emitCachedFuncClosureAccess`), disconnected from that write. Proven (single module,
name-matching, so RC1/RC2 don't apply):

- `function fn(){ fn = 2; return 1; } … fn(); (fn as any) === 2` → returns **200** (the read still sees the function, not `2`).
- cross-module name-matching `.js` + allowJs, same shape → returns **200** likewise.

**Fix (additive / narrow — only reassigned function decls change):**

1. Static scan (declaration/setup pass in `src/codegen/index.ts` /
   `src/codegen/declarations.ts`): collect function-declaration names that appear as
   an assignment **target** (`fn = …`) anywhere in the module (rare pattern).
2. For each, register a **mutable** `externref` module global (in `moduleGlobals`)
   initialized in `__module_init` to the function's closure value (funcref-as-closure,
   mirroring `emitCachedFuncClosureAccess`); ensure a `closureMap` entry exists so the
   existing read arm at `identifiers.ts:~926` (`existingClosure && closureModGlobal →
global.get`) fires.
3. Reads → `global.get` (through the arm above); writes → already route to
   `moduleGlobals` in `emitIdentifierWriteFromLocal`; calls `fn()` → keep the direct
   `funcMap` call (valid: at call time the slot still holds the function).
4. `export default fn` must export the **live global**, not a func-index snapshot
   (see the `ExportAssignment` / default-export handling in
   `src/codegen/declarations.ts` ~3286/3622/4246). Combined with RC2's alias
   resolution, the importer reads module A's live global.

Ordering caveat: registering a late module global shifts global indices — follow the
existing "reserve struct/global indices up-front, register shared types late+once"
discipline (memory `project_type_index_shift_and_deadelim`,
`reference_subview_type_idx_stability`) to avoid an index-desync.

### Split (filed 2026-07-02)

Split into three issues (each independently valuable and testable):

- **#2930** — RC2 import-alias resolution (renamed/default/anonymous imports).
  Clean, additive, unit-testable with `.ts` fixtures. **DONE** (PR #2437, merged
  2026-07-02).
- **#2931** — RC3 live bindings for reassigned function declarations. Narrow,
  additive, unit-testable single-module. **DONE** (PR #2446, merged 2026-07-02).
- **#2932** — RC1 compile `.js` module dependencies. **Broad-impact; gate on a full
  test262 diff.** Blocked pending tech-lead sign-off on option + run slot. This is
  the piece that actually lets `#2900`'s runner path exercise #2930 & #2931.

`#2900` closes only when all three land. #2930 + #2931 alone do not flip this test
(the `.js` fixture still would not compile); #2932 alone does not either (alias +
live-binding still fail). Repro scripts used for this analysis are ephemeral
(`.tmp/`); the key controls are the `.ts`-fixture probes above (no `.js`/allowJs
needed to reproduce RC2 and RC3).

## REOPENED 2026-07-25 — still failing, and the failure mode has CHANGED

Marked `done` on 2026-07-02, but the target test **still fails today** — with an
error that does not match this issue's description. Reopened (`status: ready`,
`sprint: current`); `completed:` left as history.

Measured against a **force-fetched** baseline (`--force`; the bare command is a
silent no-op, see #3629):

```
test/language/module-code/eval-gtbndng-indirect-update-dflt.js
  status : fail
  category: type_error
  error  : TypeError: sameValue is not a function
```

**Contributes to #3628 (close the ≤ES3 edition)** — 1 of only 3 issues between
the host lane and a closed ≤ES3 edition (currently 230/273, 84.2 %).

### The error suggests this is no longer a module-binding bug

`sameValue is not a function` means the **harness's `assert` object lost its
method** — the test never reaches the binding semantics this issue is about. So
the original fix may well have worked, and a _different_, later defect is now
masking it.

That symptom is the signature of the **own-properties-on-function-objects**
class (assert.\* methods read as `undefined` ⇒ never invoked). See the
lane-parity F1 finding and #3468. Related: the same class produced the ~5,000
vacuous standalone passes fixed on 2026-07-25 via #3592.

**So: diagnose before implementing.** If the cause is the harness class, this
issue should be re-pointed (or closed as blocked on that defect) rather than
re-implementing module-binding logic that may already be correct. Verify on the
CI path — `runTest262File`'s category and location are unreliable.

---

## Resolution 2026-07-25 — case (3): a **different, later defect** was masking a correct fix

The reopen note's hypothesis was right, and the module-binding work
(#2930 / #2931 / #2932) needed no change at all. The cause was in the **test
runner**, not the compiler: one execution lane was still running the harness
before the runtime was wired.

### Diagnosis

Reproduced through the exact CI recipe for this test — the in-process FIXTURE
branch of `tests/test262-shared.ts` (`assembleOriginalHarness` →
`discoverFixtureGraph` → `compileMulti` → instantiate → `setExports` →
`__module_init`), not `runTest262File`.

A minimal control isolated the variable immediately: the trivial body
`assert.sameValue(1, 1)` — no fixtures, no modules, no imports — **also** threw
`sameValue is not a function` under that recipe. So the failure had nothing to
do with module bindings, `.js` fixtures, or `allowJs`. Flipping one flag:

| compile                      | `deferTopLevelInit` | result                              |
| ---------------------------- | ------------------- | ----------------------------------- |
| `compile()` single file      | off                 | THREW `sameValue is not a function` |
| `compile()` single file      | **on**              | OK                                  |
| `compileMulti()` `.js` entry | off                 | THREW `sameValue is not a function` |
| `compileMulti()` `.js` entry | **on**              | OK                                  |

### Root cause

Without `deferTopLevelInit`, the whole original-harness assembly runs in the
wasm `(start)` section — i.e. **before** `importObj.setExports(instance.exports)`
wires the runtime. `assert` is a **function object** and `assert.sameValue` is an
own property assigned onto it (`assert.sameValue = function …` in
`harness/assert.js`); those reads need the wired runtime. So every `assert.*`
call in an affected test threw "… is not a function" and the test body was never
reached — which is exactly what the baseline row records
(`reached_test: false`).

The FIXTURE branch was the **only** lane still running undeferred.
`scripts/test262-worker.mjs` defers on both its single-file path and its own
fixture-graph path (`...deferOpt`), and the FYI runner defers too (#3505). Every
one of the corpus's other ~42,900 tests already ran deferred; the ~204
fixture-graph tests did not. That is why this looked like a module-semantics gap
confined to `language/module-code`.

The branch's comment gave the historical reason for the omission: deferring made
compileMulti emit a **second** `__module_init` export (V8 "Duplicate export name
'**module_init'" — the #2835/#2839 merge-queue park). **#3505 fixed that**: the
progressively accumulated dependency-order initializers now retain only the
FINAL `**module_init` export. The omission outlived its cause.

### Fix

`tests/test262-shared.ts`: the FIXTURE compile now passes
`deferTopLevelInit: true`, aligning this lane with every other one. No compiler
source change. The stale comment is replaced with the #3505 rationale.

### Measured effect

Swept all **204** fixture-graph tests through the branch's own verdict logic,
`deferTopLevelInit` off vs on, everything else identical:

|               | off (stock) | on (fixed) |
| ------------- | ----------: | ---------: |
| pass          |           3 |     **34** |
| fail          |          64 |         33 |
| compile_error |          45 |         45 |
| skip          |          92 |         92 |

**31 fail→pass, 0 pass→fail, byte-identical compile_error set** (verified as
sets, not just counts). All 31 are `fail` in the force-fetched baseline, so the
gain is real rather than a re-labelling. No duplicate-export CompileError
appeared anywhere in the 204 — #3505's fix holds for this whole bucket.

Of the 31, 22 were failing on `sameValue is not a function` and 1 on
`throws is not a function` — i.e. the harness class this issue was suspected of.

The residual fixture failures are unrelated and out of scope here: 18 opaque
`WebAssembly.Exception`, 5 `null is not a function` (the renamed/aliased-import
class), 3 dynamic-import module-resolution, 3 async-marker, 2 `Cannot convert
null to object`, 1 `Reflect.get called on non-object`, 1 `illegal cast`.

### Verification

`tests/issue-2900.test.ts`:

- source guard that the FIXTURE compile passes `deferTopLevelInit: true` (and
  still passes `allowJs: !isNegative`, #2932);
- the target test, run through the branch's recipe **both ways** — asserting it
  fails with `sameValue is not a function` when the defer is removed and passes
  with it, so the test cannot pass for the wrong reason;
- an explicit assertion that the deferred fixture binary exports exactly **one**
  `__module_init`, locking the #2835/#2839 park shut.

With the defer, the test's own assertions (`assert.sameValue(val(), 1)` and
`assert.sameValue(val, 2)`) are actually reached — and they pass. That is the
positive evidence that #2930 / #2931 / #2932 were correct all along.

### Merge-queue outcome and the trap-growth declaration

The PR was auto-parked once on the #3189 uncatchable-trap ratchet:
`illegal_cast` 74 → 75 (+1), newly trapping
`test/language/module-code/top-level-await/pending-async-dep-from-cycle.js`.
Everything else was strongly positive — net **+48 pass**, host stable-path
fine-gate net **+67** (71 improvements − 4 regressions), every other trap
category flat.

Routed against the authoritative baseline jsonl rather than a local repro: that
file's baseline status is **`fail`** (`TypeError: compareArray is not a
function`, `reached_test: false`) — the harness class this PR fixes. So the
baseline **did** testify, which puts it on the **#3596** branch, not the #3595
never-instantiated exclusion. Confirmed by A/B on the single defer flag: OFF it
fails with `compareArray is not a function`, ON it fails with `illegal cast`.
`fail → fail`, flavour only, on a test that has never passed — the defer simply
lets it run past where it previously stopped, into a pre-existing latent trap.

Declared as a bounded `trap-growth-allow` (`count: 1`, naming that single test)
in this issue's frontmatter, machine-checked by `evaluateTrapReclassification`:
named + not-previously-passing + no undeclared growth. No source change.

### Scope correction — "≤ES3" is a metadata bucket, not the ES3 language

This issue's title says "≤ES3 (edition bucket)" and that qualifier is
load-bearing. `classifyEdition` assigns edition 0 only as a **fall-through**, so
the bucket collects tests that lack version frontmatter — this ESM test among
them. `eval` / `with` / `Function`-constructor tests sort into **later** buckets
by frontmatter vintage and sit far lower (~37 %). Closing this issue is progress
on the ≤ES3 _metadata bucket_, **not** a statement that the ES3 language is
complete. #3628 and PR #3627 carry the full correction.
