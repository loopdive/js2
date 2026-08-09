---
id: 4308
title: "EvalDeclarationInstantiation + Annex B B.3.3 for the QuickJS eval engine — the bucket that dominates the remaining 256 eval-code failures"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4238, 4242, 4245, 4305, 4307]
blocked_by: [4245]
# id 4308 reserved via claim-issue.mjs --allocate on 2026-08-09 AFTER
# fast-forwarding the fork's main to upstream — the allocator resolves "main"
# against `origin` (the FORK here), so a stale fork mints ids already used
# upstream (it handed out 4262/4264/4265, all of which exist on main). See
# #4305's frontmatter for the full account. Open-PR scan DEGRADED (no gh in
# this container); id verified against upstream main + the assignment ref, with
# the required check:issue-ids gate as the backstop.
---

# #4308 — EvalDeclarationInstantiation + Annex B B.3.3 under the QuickJS engine

## Why this issue exists (measured, not assumed)

The QuickJS eval engine (#4238) plus the inward membrane (#4245 slice 1) took
the scoped `language/eval-code/` set from **442 → 560 / 816**. The interpreter
scores **779 / 816** on the same set, same container, same day.

The gap is now **one dominant bucket**: `EvalDeclarationInstantiation` and the
Annex B B.3.3 block-function families. Every other enumerated residual is
small or measured at zero:

| bucket | status after #4245 slice 1 |
| --- | --- |
| compiled callables can't cross inward | **CLEARED** (was 230, now 0) |
| var-env fidelity / B.3.3 | **dominates the remaining 256** |
| `new.target` / `super` in eval | 0 relative to the interpreter (both fail the same 10) |
| mapped-`arguments` | measured **0** — the predicted failures do not occur |
| completion values | 21/21 on both engines |
| strict write-back + TDZ | ~5 quickjs-only |

So this issue is the last large lever between the QuickJS engine and parity,
and #4242's default flip stays blocked until it moves.

**Do not trust the pre-membrane numbers.** The 126-fail / 102-quickjs-only
count for var-env fidelity was measured *before* the membrane landed and the
composition of the 256 has shifted. **Re-bucket first** (see below).

## The problem

Under the quickjs engine a direct eval currently snapshots caller bindings onto
a plain object `S` and evaluates `with (S) { … }` (sloppy) or a block-scoped
`const` preamble (strict), writing changed primitives back into the live cells
afterwards (#4238 slice 3). That approximates scope *reads and writes*; it does
**not** implement EvalDeclarationInstantiation:

- `var`s created by eval'd code are not hoisted into the **caller's** varEnv
  with correct visibility and lifetime.
- Annex B **B.3.3** block-level function semantics (the
  `annexB/language/eval-code/**` families) are not modelled.
- Redeclaration checks (`var-env-*`) do not run against the caller's
  environment.

## Scope

1. **Re-bucket the current 256 failures first**, using the tooling that already
   landed: `scripts/eval-engine-parity.mjs` (#4242 P1-S1) plus the runner's
   own jsonl. Produce the real breakdown *post*-membrane before designing
   anything, and record it here. The design must follow the data, not the
   pre-membrane estimate.
2. Design and implement EvalDeclarationInstantiation for this engine:
   var hoisting into the caller varEnv via the existing cell/activation-pool
   plumbing, B.3.3 block-function semantics, redeclaration checks.
3. Measure again and record the delta against 560/816.

## Hard constraints (carried from the whole workstream)

- Flag-gated only: default path (no flag / `interpreter`) **byte-identical**;
  quickjs code loaded only inside the flag branch.
- The 4-import `js2wasm:runtime-eval` seam ABI stays **FROZEN**.
- Zero JS behind the seam beyond the WASI stub; wasm-to-wasm binding only.
- **`src/interp/`, acorn, and the IR substrate the interpreter needs must NOT
  be deleted or degraded** — standing project-lead directive; the interpreter
  stays selectable behind `JS2WASM_EVAL_ENGINE=interpreter` indefinitely.
- Borrow discipline on every handle; primitive-only filter on every write-back
  path (the delayed-realm-corruption class, #4238 slice 2).

## Traps this workstream has already paid for — do not re-learn them

1. A **literal** eval argument is constant-folded by `tryStaticEvalInline` and
   never reaches the provider. Compose every eval source through a runtime loop.
2. `40+2 === 42` proves nothing about which engine ran — assert via the in-band
   `__js2wasm_eval_engine` marker where that matters.
3. Non-primitive write-back clobbers the memoized `eval`/`Function` markers and
   the damage appears on a **LATER** eval. Test a second and third evaluation.
4. Name-based lowerings can stop firing and fall back to a stub that answers
   `undefined` **with green tests**. Prove liveness by poisoning the stub
   (#4245 slice 1 did exactly this).
5. **#4305** (open): a succeeding direct eval followed by a throwing one with an
   `instanceof` catch traps with `RuntimeError: illegal cast` — caller-side
   codegen, engine-independent. It will appear in eval-heavy runs; it is not
   this issue's bug, and it pollutes the `unattributed` bucket of #4242's gate.

## Acceptance criteria

- [ ] Post-membrane re-bucketing of the 256 recorded here, with counts.
- [ ] EvalDeclarationInstantiation implemented to the level the data justifies;
      whatever is deliberately not implemented is enumerated as a residual with
      its measured file count.
- [ ] Measured `language/eval-code/` delta recorded against 560/816, plus
      confirmation the interpreter tier is unchanged (779/816).
- [ ] Default-path suites green with no flag set; equivalence suite green if
      any `src/` file is touched.
- [ ] No `src/interp/` deletion or degradation; diff audited.

## Implementation Plan

Architect, 2026-08-09. Written against the **measured** post-membrane state
(§0), not the pre-membrane estimates. Where the data contradicts this issue's
own framing, the data wins and the contradiction is stated.

### 0. The measured breakdown (2026-08-09, post-membrane — supersedes everything above)

**Provenance.** Both engine runs are on disk in this container, same scoped set
(`TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/'`,
816 files), same day:

| run | file | result |
| --- | --- | --- |
| quickjs, post-#4245-slice-1 | `.claude/worktrees/agent-aec1e0fcc3bb7e052/benchmarks/results/test262-standalone-results-20260809-185253.jsonl` (tree `e8e43ee86`, branch `issue-4245-membrane-slice1`) | **560 pass / 256 fail** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | `.claude/worktrees/agent-ada6058828d9b2da7/benchmarks/results/test262-standalone-results-20260809-144813.jsonl` (tree `168c01f97`) | **779 pass / 37 fail** |

Caveats, stated so nobody launders them later: the interpreter run is ~4h
older and one merge-of-main behind the quickjs tree (the membrane branch's
non-regression check showed `language/*` identical test-for-test, so the skew
is almost certainly nil); neither jsonl carries an in-file tier announcement,
so for the #4242 gate the implementer must produce fresh **tier-pinned** pairs
(`--quickjs-log`/`--interpreter-log`) — these numbers are design-grade, not
gate-grade.

**Headline: 256 fails = 219 quickjs-only + 37 both-engines-fail. 0 wins.**
The 37 both-fail files are shared with the interpreter and are NOT this
issue's cost — parity with 779 requires exactly the 219 and nothing else.

Per sub-family (quickjs fail = quickjs-only + both-fail):

| family | qjs fails | qjs-only | both |
| --- | --- | --- | --- |
| `annexB/…/eval-code/direct` | 154 | **145** | 9 |
| `annexB/…/eval-code/indirect` | 63 | **55** | 8 |
| `language/eval-code/direct` | 26 | **11** | 15 |
| `language/eval-code/indirect` | 13 | **8** | 5 |

The 219 quickjs-only, by error signature (values elided to `«·»`):

| n | signature | families |
| --- | --- | --- |
| 73 | `Expected SameValue(«·», «·») to be true` | aB-d 50 · aB-i 16 · lang 7 |
| 64 | `An initialized binding is not created prior to evaluation Expected a ReferenceError but got a different error constructor with the same name` | aB-d 56 · aB-i 8 |
| 32 | `binding is not reinitialized Expected SameValue(«·», «·»)` | aB-d 16 · aB-i 16 |
| 18 | `f should be an own property` | aB 16 · lang 2 |
| 14 | `ReferenceError: f is not defined` | aB-d 7 · aB-i 7 |
| 8 | `value is updated following evaluation Expected SameValue(«·», «·»)` | aB-d 8 |
| 10 | long tail: redeclaration `SyntaxError` ×2, `initial value` ×2, `x should be an own property` ×2, strict-rerun `invalid redefinition of lexical identifier` ×2, `x is not defined`, `invalid redefinition` | lang |

The 200 annexB quickjs-only, by generated-template cluster (filename suffix):

| n | template | caller |
| --- | --- | --- |
| 64 | `skip-early-err-*` | func 48 · global 16 |
| 16×4 | `global:init` · `existing-global-init` · `existing-non-enumerable-global-init` · `existing-global-update` | global |
| 16 | `global:existing-block-fn-update` | global |
| 14 | `global:block-scoping` | global |
| 8×4 | `func:existing-fn-update` · `existing-fn-no-init` · `existing-var-update` · `existing-block-fn-update` | func |
| 8 | `func:no-skip-param` | func |
| 2 | `switch-{case,dflt}-decl-nostrict` | — |

**Where the data contradicts this issue's framing — say it plainly:**

1. **The single largest cluster (64 files, 29 % of the gap) is NOT
   EvalDeclarationInstantiation at all.** Every `skip-early-err-*` test fails
   with *"Expected a ReferenceError but got a different error constructor with
   the same name"* — QuickJS **correctly skips** the B.3.3 hoisting (the test's
   whole point), the eval body's `f;` correctly throws ReferenceError, and the
   test still fails because the thrown error's `.constructor` and the
   `ReferenceError` value handed to the compiled `assert.throws` are
   **different objects with the same name** after crossing the membrane. This
   is an intrinsic-identity problem at the boundary, worth its own slice, and
   it is the cheapest 64 tests in the whole set.
2. **~37 files of the 256 are not recoverable by ANY quickjs work** — the
   interpreter fails them too. Do not chase them here.
3. The genuinely-EDI remainder (~140) splits cleanly by **caller kind**:
   global-caller/indirect (~110, all global-object mechanics) vs
   function-caller (~40, all activation-pool mechanics) — two different
   channels, two different slices.

### 1. What EDI actually requires, mapped onto the existing plumbing

The seam is frozen (12 direct-eval args; `src/codegen/expressions/runtime-eval-provider.ts`).
The interpreter proves the channel is sufficient: it scores 779 through the
SAME carrier/cell ABI (`src/interp/eval-environment.ts` — read
`collectEvalDeclarations` :261, `validateNonStrictEvalVarNames` :500,
`prepareGlobalDeclarations` :584, `canDeclareGlobalFunction` :540,
`setEvalVariableEnvironmentBinding` :419 as the reference semantics; that file
is **read-only** for this issue). The only thing the interpreter has that the
adapter lacks is a **parser** to compute the declared-names plan. The design
below gets that plan from QuickJS itself.

All file/line anchors below are `scripts/quickjs-eval-provider.mjs` **at
`e8e43ee86`** (branch `issue-4245-membrane-slice1` — the mandatory base, see
§7): `qjsErrorFromHandle` :840, `qjsPushGlobals` :901,
`qjsIsMirrorablePrimitive` :932, `qjsPullGlobals` :1031, `qjsEvaluate` :1062,
`qjsEnsureDirectHelpers` :1167, `qjsWrapDirectEvalSource` :1380,
`__runtime_direct_eval` :1387, `qjsWriteBackCallerCells` :1519,
`qjsMirrorNewBindings` :1550, `qjsClaimPoolSlot` :1629,
`__runtime_apply_interpreted` :1650, `qjsPublish` :797, `qjsToGc` :822,
`qjsToQuickjs` :730.

#### 1.1 Primitive A — a strictness scanner (adapter TS, no parser)

`PerformEval`: eval code is strict iff the source's directive prologue says so
OR the caller is strict. The adapter currently only knows `callerStrict`; a
strict SOURCE under a sloppy caller is wrapped in `with (S)` where the
directive stops being a directive — that is `var-env-var-strict-source.js`
failing today. Add `qjsSourceIsStrict(source): boolean`: skip whitespace and
`//`/`/* */` comments, then accept a directive prologue (string literals
separated by `;`/ASI) and answer whether any is exactly `use strict`. ~40
lines next to `qjsIsSafeConstName` :1312. Enumerate the known-imperfect edges
in a comment (a directive followed by a newline and `[`/`(`/`` ` ``/binary-op
is expression continuation, not a directive) — mis-scan risk is confined to
pathological sources and is a declared residual.

#### 1.2 Primitive B — the hoist probe (QuickJS is the parser)

To create bindings on the caller's varEnv **before** the body runs (the
`*-init` templates assert inside the body via `fnGlobalObject()`), the adapter
needs the EDI declared-names set: `varDeclaredNames` ∪ the annex-B
block-function names that survive the "would `var F` be an early error"
test — with their kind (function vs var) where observable. Mechanism:

- Only for **sloppy** eval code (strict eval leaks nothing — skip entirely).
- Create a scratch context `qjs_new_context(rt)` (already in the shim ABI —
  no artifact change), evaluate `"throw 0;\n" + source` in it. A Script's
  GlobalDeclarationInstantiation hoists every var-scoped name (including the
  annex-B survivors, applying the engine's own early-error applicability test)
  **before** the first statement executes, so the `throw 0` aborts after
  hoisting, deterministically and without running one user statement.
- Diff `Object.getOwnPropertyNames(globalThis)` in the scratch realm against a
  fresh-context baseline (install the same `__js2wasm_eval_prenames__` /
  `__js2wasm_eval_newnames__` helpers, `qjsEnsureDirectHelpers` :1167
  pattern). Names whose scratch value is a **function** after the abort are
  top-level function declarations (initialized at GDI); names that are
  `undefined` are `var`s or annex-B block functions — for binding-creation
  purposes both get `undefined`, which is exactly what B.3.3.3
  `CreateGlobalFunctionBinding(F, undefined, true)` prescribes, so the
  distinction is NOT needed for creation (it IS needed for nothing else in
  this corpus).
- If the scratch eval throws something other than the `0` sentinel before
  hoisting, it is a SyntaxError in the source: skip creation and let the real
  evaluation surface the same error (identical outcome, no double-report).
- Free the scratch context if the shim exposes a free; otherwise document the
  per-eval scratch context as context-lifetime retention (same policy as the
  main context; bounded by test isolation — a fresh runtime per instantiation).

The probe evaluates the source **twice as text but zero times as effects** —
the sentinel throw precedes the first statement by construction. State that
invariant in a comment and assert it in the lane with a
side-effect-detecting source (`var x = (globalThis.__boom__ = 1)` must not
set `__boom__` via the probe).

#### 1.3 Redeclaration checks (spec: EDI steps 5–6)

Before creating anything: for each probe name, if it collides with a caller
**lexical** binding (`lexicalNames`/`outerNames` layers — the flattened
`names[]` built at :1411 already carries them; ALSO check the global lexical
cells carrier, `qjsPushGlobalLexicalCells` :962), throw `SyntaxError` — as a
**thrown envelope** (`runtimeEvalResult(false, new SyntaxError(...))`), before
any binding is created (no partial leak; the interpreter's
`validateNonStrictEvalVarNames` :500 is the reference). This is only ~4 files
in this corpus (`lex-env-*`, redeclaration) but it is cheap once the probe
exists. Caveat: the flattened `names[]` does not distinguish lexical from var
caller bindings — only `lexicalNames`/`lexicalSlots` and the global lexical
carrier entries are conflict candidates; a collision with a var binding is
legal.

#### 1.4 Global-caller / indirect: the compiled global IS the varEnv

Applies to indirect eval (always) and direct eval from global code
(recognizable: no activation layers — `activationSeedNames` empty and
`outerNames` empty; verify in a probe, do not guess).

- **Pre-create** (EDI step "CreateGlobalVarBinding/CreateGlobalFunctionBinding
  with undefined"): for each probe name not already an own property of
  `globalObject` (the compiled realm carrier — the adapter holds it as `any`):
  `globalObject[name] = __runtime_eval_wrap_result(undefined)` BEFORE
  `qjs_eval`. Inside the body, `verifyProperty(fnGlobalObject(), "f", …)` then
  sees the property through the membrane wrapper — and the wrapper's
  synthesized descriptor (`{writable:true, enumerable:true,
  configurable:true}`, #4245 slice-1 residual 3) is **exactly** the attribute
  set B.3.3.3 prescribes for eval-created bindings, so the synthesis works FOR
  us here. If it already exists: create nothing, overwrite nothing
  (`binding is not reinitialized`, 32 files).
- **Mirror completeness**: `qjsPushGlobals` :901 iterates `Object.keys`, so a
  **non-enumerable** compiled global property never reaches the realm — that
  is the `existing-non-enumerable-global-init` 16-cluster. Probe P3 decides
  the fix: either the carrier exposes `Object.getOwnPropertyNames`, or the
  push must additionally walk a name list the caller can enumerate. If neither
  works adapter-side, this 16-cluster is a declared residual pending #4245
  slice 2 (descriptor/own_keys fidelity) — do NOT block the rest on it.
- **Post-eval propagation** (`f is not defined` 14, `existing-*-update` 24+,
  `value is updated` 8): after `qjs_eval`, for every probe name and every
  pre-existing mirrored name, read the realm value; primitives copy back
  (existing `qjsPullGlobals` :1031 discipline); **QuickJS function values
  cross as the slice-2 published function box** (`qjsPublish` :797 — the same
  representation an eval **completion value** already uses, invoked through
  `__runtime_apply_interpreted` :1650). Assign onto `globalObject[name]`.
  `qjsPullGlobals`' "created names are not pulled" rule is thereby REPLACED
  for probe names: they were created by us pre-eval, so the
  existing-names-only pull covers them naturally once creation happens first.
- **The write-back filter is about RAW handles, not about non-primitives.**
  The load-bearing invariant behind "primitive-only" (#4238 slice 2/3) is
  that nothing crossing into a carrier the caller retains may be a value
  whose meaning dies with the QuickJS context or clobbers the memoized
  `eval`/`Function` markers. A **published function box** is the sanctioned
  representation for exactly that crossing — it is what completion values
  already do. Two hard sub-rules survive unchanged: (a) never write ANY value
  raw off a tag test alone — route everything through
  `qjsToGc`/`qjsPublish`; (b) never write to a key whose current compiled
  value is a memoized intrinsic marker (`eval`, `Function` — the :1022
  comment documents the measured corruption). Extend the lane's
  second-and-third-eval probes to cover a function-valued write-back
  (`eval('function f(){}') ; f() ; (0,eval)('1+1') ; f()`).

#### 1.5 Function-caller: the activation pool is the varEnv

`func-*` clusters (~40 quickjs-only). The machinery exists
(`qjsMirrorNewBindings` :1550, `qjsClaimPoolSlot` :1629); it is missing three
things:

- **Pre-seed**: claim pool slots for probe names (value `undefined`) BEFORE
  `qjs_eval`, so a mid-eval callback into compiled code — and the caller's own
  reads if the eval throws mid-body — see the hoisted binding. (The
  inside-body reads resolve realm-side via QuickJS's own hoisting and need
  nothing.)
- **Function values into the pool**: `qjsMirrorNewBindings` currently skips
  non-`qjsIsMirrorableTag` values (":1595) — the entire reason
  `eval('… function f(){}')` leaves `f is not defined` behind. Route function
  tags through `qjsPublish` into the value cell, same §1.4 discipline.
  `no-skip-param` (8) and `func:existing-*` (32) fall out of this plus the
  existing write-back path.
- **Pool exhaustion**: 64 slots per activation (`qjsClaimPoolSlot` returns
  false when full — silently). With pre-seeding, seeding can now CONSUME slots
  for names the body never assigns. Keep the "never mis-slot" rule, but
  release a pre-seeded slot whose post-eval realm value is still `undefined`
  AND whose name the caller never reads… — that is unknowable; instead accept
  the ceiling and record it: sources declaring >64 distinct var names in one
  activation lose the tail. Not observed in this corpus.

#### 1.6 Strict callers and strict sources

- Route on `callerStrict || qjsSourceIsStrict(source)` (§1.1). Strict eval
  code creates NO caller bindings — skip probe/creation/mirroring; but the
  wrapped script's `var`s still land on the QuickJS realm global (a script's
  varEnv is global even under `"use strict"`), so run the realm-diff purely
  for **cleanup** (`__js2wasm_eval_del__` :1188) or later sloppy evals in the
  same context inherit ghosts.
- **Strict-caller WRITES to existing caller bindings** (5 files,
  `var-env-var-strict-caller*`): replace the `const` preamble
  (`qjsWrapDirectEvalSource` :1380) with a `let` preamble plus copy-out:
  `"use strict";\nundefined;\n{ let x = S.x; … try { <body-block> } finally {
  S.x = x; … } }` — assignments now update the `let`, the `finally` lands them
  on `S` even on throw (matching the sloppy arm's throw-path write-back
  :1495), and `qjsWriteBackCallerCells` :1519 works unchanged. The completion
  value of `try…finally` is the try block's — the `undefined;` seeding
  guard is still required (keep the :1372 comment's reasoning). Preamble/
  source lexical collisions (the 2 `strict rerun: invalid redefinition`
  files): keep `qjsSourceMentions` :1332 to limit emitted names, and
  accept the remaining collision class as a residual of the no-parser design.

#### 1.7 Intrinsic-error identity across the membrane (the 64-file slice)

Measured shape: inside the eval body, `assert.throws(ReferenceError, f)` gets
`ReferenceError` from the QuickJS realm; the callback's throw is mapped
outward by `qjsErrorFromHandle` :840 into an **adapter-realm**
`new ReferenceError(msg)`; compiled `assert.throws` compares
`thrown.constructor !== expectedErrorConstructor` — same `name`, different
object. Fix at the **outward crossing**: cache, once per context, handles to
the realm's six intrinsic error constructors (plus `Error`); in
`qjsPublish`/`qjsToGc`, when the crossing value `qjs_is_equal(strict)` one of
them, substitute the matching constructor **from the caller's realm**. Probe
P1 (below) determines where the caller's constructors are reachable — in
order of preference: (a) off `globalObject` (`globalObject.ReferenceError`),
(b) via an existing seam wrap helper, (c) the adapter's own intrinsics IF
canonicalization makes them identical to the user module's (the interpreter
tier answers this — it passes these tests through the same seam, so SOME
reachable constructor satisfies the compiled comparison; find which one it
uses before writing a line). Do NOT mirror compiled error constructors INTO
the realm instead: engine-generated errors are built from QuickJS's internal
intrinsics regardless of the global binding, and in-body
`e instanceof ReferenceError` must keep working realm-side.

### 2. Where it lands

**Adapter-only.** Every change in §1 is inside `buildQuickjsAdapterSource`
(compiled TS) or the in-realm helper strings — `scripts/quickjs-eval-provider.mjs`
exclusively, plus `tests/quickjs-eval-provider.test.ts` /
`tests/quickjs-eval-membrane.test.ts` lane cases. Specifically:

- **No `src/` change.** Every prior slice managed it and nothing here needs
  one; a `src/` edit would drag in LOC/function budgets and the oracle
  ratchet, and slice 3's project-lead directive (report before touching
  `src/`) stands.
- **No `qjs_shim.c` change targeted** — `qjs_new_context`, `qjs_is_equal`,
  `qjs_call`, `qjs_get_prop_str` cover §1; helpers install by evaluation
  (the :1167 pattern). Keeping the artifact at key `d8a5a91d6f183b87` /
  sha256 `b0662069…` is itself a deliverable: an unchanged hash proves the
  engine artifact didn't move. If a probe forces a shim addition (e.g. no way
  to free a scratch context and leak accounting demands it), rebuild is
  reproducible (~3 min, build.sh pins) — record old/new keys in the record
  like #4245 slice 1 did.
- The adapter cache key derives from the adapter source, so every edit
  auto-invalidates the compiled adapter; no manual cache hygiene.

### 3. Probes first (½ day, before ANY slice code)

Run in the stacked worktree (`agent-aec1e0fcc3bb7e052` or a fresh checkout of
the same branch), artifact already cached there (`.tmp/qjs-out`). Record every
answer in this file.

- **P1 (blocks slice A)** — instrument `qjsErrorFromHandle` + a one-off test:
  inside eval, `assert.throws(ReferenceError, function(){ f; })`; log the
  identities compiled-side (`thrown.constructor`, the received
  `expectedErrorConstructor`, the user module's own `ReferenceError`). Then
  run the SAME test on the interpreter tier and find which constructor object
  the interpreter's thrown errors carry — that is the known-good target.
- **P2 (blocks B/C)** — scratch-context hoist probe by hand: does
  `throw 0; if (false) ; else function f(){}` leave `f === undefined` hoisted
  in a quickjs-ng v0.16.1 scratch realm? Does
  `throw 0; { let f; { function f(){} } }`-style early-err collision
  correctly NOT hoist? (quickjs-ng's annex-B applicability is assumed from
  the 155/309 passes, but the GDI-vs-EDI variant difference has not been
  directly observed.)
- **P3 (blocks B)** — compiled-global carrier semantics: does
  `globalObject[name] = wrapped(undefined)` from the adapter create a
  property that (a) `Object.keys`-enumerates compiled-side, (b) verifies as
  `{writable:true,enumerable:true,configurable:true}` under compiled
  `verifyProperty`, (c) round-trips a later value assignment? And: can the
  adapter see a `defineProperty`'d non-enumerable global at all (the
  16-file cluster's fate)?
- **P4 (blocks C)** — direct-eval-from-global recognition: confirm that a
  global-code direct eval arrives with empty activation/outer layers, and
  that a function-caller one does not (the §1.4/§1.5 routing predicate).

### 4. Slices (each one Opus implementer, each with a measured done-signal)

Baseline for every delta: **560 / 816** on the §0 command. Re-run BOTH
engines tier-pinned at slice A start to re-anchor (the §0 caveat).

- **Slice A — intrinsic-error identity (S).** §1.7 + P1. Touches
  `qjsErrorFromHandle` :840, `qjsPublish` :797, context init :884. Target:
  the 64 `skip-early-err-*` files. *Done-signal:* scoped run ≥ **615** with
  zero regressions in the other clusters; lane case: in-eval
  `assert.throws(ReferenceError, …)` passes AND in-eval
  `try{f}catch(e){e instanceof ReferenceError}` still answers true.
- **Slice B — global/indirect EDI (L).** §1.1 + §1.2 + §1.3 + §1.4, P2/P3.
  Touches `__runtime_indirect_eval` :1126 path (`qjsEvaluate` :1062),
  `__runtime_direct_eval` :1387 global arm, `qjsPushGlobals`/`qjsPullGlobals`,
  new probe/scanner helpers. Target clusters: `global:init` 16,
  `existing-global-init` 16, `existing-global-update` 16,
  `existing-block-fn-update` 16, `block-scoping` ~14, `f should be an own
  property`/`f is not defined` global halves, lang `var-env-*` global (~8);
  `existing-non-enumerable` 16 only if P3 allows. *Done-signal:* ≥ **700**
  (≥ 684 if the non-enumerable cluster is deferred); second/third-eval
  function-valued write-back lane case green; interpreter tier re-run
  unchanged at 779.
- **Slice C — function-caller EDI (M).** §1.5 + P4. Touches
  `qjsMirrorNewBindings` :1550, `qjsClaimPoolSlot` :1629, pre-seed insertion
  in `__runtime_direct_eval` before :1467. Target: `func:existing-*` 32,
  `no-skip-param` 8, remaining `f`-visibility files. *Done-signal:* ≥ **740**;
  pool-exhaustion lane case (65 names) fails safe (no mis-slot, no trap).
- **Slice D — strict + lexical long tail (S/M).** §1.6 strict `let`-preamble
  + strict-source routing + §1.3 redeclaration SyntaxError. Target:
  `var-env-var-strict-*` 5, `lex-env`/redeclaration/`global-env-rec` ~8.
  *Done-signal:* ≥ **750**; then produce the full tier-pinned
  `eval-engine-parity.mjs --gate` artifact pair and paste the bucket table
  into this file (the gate will still be BLOCKED on net — that is expected
  until #4242 accepts residuals; what must be zero is `unattributed`).

Slice order is dependency order: A is independent and cheapest per test; B
builds the probe/scanner primitives C and D reuse. A+B are worth shipping even
if C/D slip a window.

### 5. Explicitly NOT worth doing (accepted residuals for #4242, with counts)

| count | what | why not |
| --- | --- | --- |
| 37 | both-engines-fail files (incl. `$262.createRealm` null-deref, 30 shared `SameValue` fails) | not a quickjs delta; belongs to the interpreter/compiler lanes |
| ≤16 | `existing-non-enumerable-global-init` IF P3 says the carrier cannot expose non-enumerable names | needs #4245 slice-2 descriptor/own_keys work — route there, don't half-build it here |
| ~4-6 | strict-preamble ↔ source lexical collisions + directive-scanner ASI edges | irreducible without a real parser in the adapter; the no-parser design is deliberate |
| unmeasured | in-eval `instanceof` against a *mirrored* compiled constructor; sources >64 var names per activation | corpus shows zero occurrences; document, don't engineer |

Everything else in the 219 is claimed by a slice above.

### 6. Projected ceiling (projection, not measurement — labeled as such)

Slice targets sum to ~190 of the 219 quickjs-only. Applying the slice-3
lesson (unblocking a test lets it reach the NEXT thing it tests — the
membrane's projected 672 landed at 560), discount each cluster ~10-15 % for
second-order failures: **realistic landing zone 740–765 / 816** with all four
slices, vs interpreter 779. **This does NOT fully close the gap.** The
honest gap-at-end estimate is 15–40 files: the §5 residuals plus whatever the
discount uncovers. Consequence for #4242: the default flip will need an
accepted-residuals block covering a named, counted remainder — plan for that
conversation now, not after slice D. A projection that claims 779 would be
flattering and wrong.

### 7. Risks, conflicts, and constraints restated

- **Branch base**: stack on `issue-4245-membrane-slice1` (`e8e43ee86`, PR
  chain #4321→membrane) — explicit predecessor-stacking per the CLAUDE.md
  exception; every anchor in this plan is against that tree. Enqueue only
  after the predecessors land; re-merge if they change.
- **CONFLICT — #4307 (closure carrier wrap) is IN FLIGHT** (worktree
  `agent-ab51959099a2b4ce4`, branch `issue-4307-closure-carrier-wrap`,
  stacked on the same membrane branch, locked = active). It edits caller-side
  codegen and possibly the adapter. Coordinate before slice B/C: both touch
  `scripts/quickjs-eval-provider.mjs`. Merge its branch in if it lands first.
- **#4305 (open)**: success-then-throw direct eval + `instanceof` catch traps
  `illegal cast` — caller-side, engine-independent. It WILL appear in slice
  runs; per-test lane cases must keep each strict case in its own function
  (the existing sidestep), and parity artifacts must not book those files as
  slice regressions — check the delta list against #4305's shape before
  panicking.
- **Hard constraints carried forward**: flag-gated only, default path
  byte-identical (the six default-path suites green with no env, every
  slice); seam ABI frozen (nothing here changes it); zero JS behind the seam
  (all new logic is compiled adapter TS or in-realm evaluated JS);
  borrow-in/own-out on every handle incl. every early-return in the new probe
  paths; `src/interp/`, acorn, IR substrate untouched and un-degraded — the
  interpreter tier re-measurement in every slice's done-signal is the proof.
- **Traps checklist for implementers** (each has already burned someone):
  compose every test eval source from runtime bindings
  (`tryStaticEvalInline` folds literals — the canary :434 comment); assert
  engine identity via `__js2wasm_eval_engine`, never via a value any engine
  produces; test the SECOND and THIRD eval after every new write-back path
  (delayed realm corruption); poison any fallback stub to prove the live path
  fires (the `membraneProbe` discipline); `interface EvalBindingCell` +
  explicit cast for every cell access (an `any` read silently answers
  `undefined` — slice-3 defect 1); no `boolean[]` parameters
  (slice-3 defect 2 / #4306); tier-pin every measurement pair or
  `eval-engine-parity.mjs` will refuse it — rightly.
