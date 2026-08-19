---
id: 4308
title: "EvalDeclarationInstantiation + Annex B B.3.3 for the QuickJS eval engine — the bucket that dominates the remaining 256 eval-code failures"
# Slices A–D all merged: A #4340, B #4343 (2026-08-10), C+D via #4366
# (2026-08-11, superseding fork-head #4348 whose commits it carried verbatim).
# This flip is the deferred HANDOFF-case observation of those merges.
status: done
assignee: ttraenkler/senior-dev
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-11
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
5. **#4305** — root-caused and fixed in PR #4339; **the shape first written here
   was wrong**, corrected 2026-08-09 during slice A. It is NOT "a succeeding
   direct eval followed by a throwing one with an `instanceof` catch". The
   trigger is STATIC: `catch` → direct eval → `catch` whose body **reads its
   parameter**. `instanceof` is incidental (`typeof e === "object"` traps
   identically), and succeeded-then-threw is incidental (the runtime outcome only
   decides whether the second handler is entered). Root cause:
   `fctx.boxedCaptures` is keyed by NAME but describes one specific slot, so a
   catch clause rebinding that name leaves stale direct-eval cell metadata and
   the identifier read emits a `ref.cast` to the cell type against a raw
   exception payload — V8 reports `illegal cast`, which made a scoping bug look
   like a type bug. It also hit the REFUSAL path, so it was never gated on direct
   eval succeeding. Caller-side and engine-independent either way: match against
   this shape, not the old one, before booking an eval-run delta as a regression.

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

> **AMENDED 2026-08-09 by probe Q5 — DO NOT IMPLEMENT THE SCANNER BELOW.**
> The hand-rolled scanner is measurably wrong on 5 of 18 prologue shapes and is
> replaced by a QuickJS parse-only probe that is exact. See
> **§1.1′** immediately after this subsection, and `## Probe results` → Q5.
> The original text is kept only so the amendment's reasoning is checkable.

`PerformEval`: eval code is strict iff the source's directive prologue says so
OR the caller is strict. The adapter currently only knows `callerStrict`; a
strict SOURCE under a sloppy caller is wrapped in `with (S)` where the
directive stops being a directive — that is `var-env-var-strict-source.js`
failing today. ~~Add `qjsSourceIsStrict(source): boolean`: skip whitespace and
`//`/`/* */` comments, then accept a directive prologue (string literals
separated by `;`/ASI) and answer whether any is exactly `use strict`. ~40
lines next to `qjsIsSafeConstName` :1312. Enumerate the known-imperfect edges
in a comment (a directive followed by a newline and `[`/`(`/`` ` ``/binary-op
is expression continuation, not a directive) — mis-scan risk is confined to
pathological sources and is a declared residual.~~

#### 1.1′ Primitive A (AMENDED) — strictness by parse-only probe

The framing error in the original §1.1 was "the adapter has no parser". It has
one: the same QuickJS §1.2 uses. Strictness is decidable **at parse time**, and
a parse error executes nothing, so the answer is free of side effects.

```
control = "(function(){" + source + "\n})"
marker  = "(function(){" + source + "\n;with({}){}\n})"
```

A `FunctionBody` has the **same** DirectivePrologue rules as eval code, and
`with` is an **early** (parse-time) SyntaxError in strict code. Evaluate both
with `qjs_eval` in a scratch context:

| control | marker | verdict |
| --- | --- | --- |
| parses | parses | source prologue is **sloppy** |
| parses | SyntaxError | source prologue is **strict** |
| SyntaxError | — | **INCONCLUSIVE** — see below |

Four properties, all measured (Q5, Q5b, Q5c):

1. **Zero side effects.** The wrapper only *declares* a function expression and
   never calls it; a parse failure runs nothing at all.
2. **The parenthesised FunctionExpression form is LOAD-BEARING.** The statement
   form `function __p(){ SRC \n}` is escapable: a source of
   `} ; globalThis.__BOOM__ = 1; function evil(){` **parses and RUNS** under it
   (measured `__BOOM__ = 1`). `(function(){ … })` rejects the same source as a
   SyntaxError. `void function(){ … };` also leaks — use the parenthesised form.
3. **INCONCLUSIVE ⊆ "the source is a SyntaxError as eval code."** Across 22
   probe sources there is no case where the wrapper control fails but real eval
   code parses; the reverse (control succeeds, eval code fails) happens only for
   `return`/`new.target`, which are SyntaxErrors as eval code anyway. So the
   fallback is only ever taken for sources whose real evaluation throws
   SyntaxError, where strictness is moot. Fall back to `callerStrict` alone.
4. **It agrees with the engine that will actually run the code, which is the
   only agreement that matters here.** On `"use strict"\n`x`` (tagged template)
   QuickJS's parser treats the string as a directive and V8 does not; the probe
   reports QuickJS's answer, which is the one the real `qjs_eval` will act on.

Cost: two extra `qjs_eval` calls per direct eval of a *sloppy caller* (skip
entirely when `callerStrict` — the OR already decides). Both are parse-only in
the strict case. Reuse §1.2's scratch context.

**This collapses the "directive-scanner ASI edges" half of §5's ~4–6 residual to
zero.** The other half (preamble ↔ source lexical collisions) collapses by the
same trick — see §1.6′.

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

> **AMENDED 2026-08-09 by probe P2 — the design SURVIVES, with three
> corrections.** Full evidence in `## Probe results` → P2.
>
> 1. **Verified as specified.** `throw 0;\n if (false) ; else function f(){}`
>    leaves `f` hoisted as `undefined`; `{ let f; { function f(){} } }`
>    correctly hoists nothing; `var x = (globalThis.__boom__ = 1)` does **not**
>    set `__boom__`. GDI-vs-EDI: the declared-NAME sets are identical on all six
>    cross-checked sources, so reading the plan off a Script-goal scratch eval is
>    sound. (Descriptors differ — GDI `configurable:false`, EDI
>    `configurable:true` — which does not matter here because §1.4 creates the
>    binding on the compiled carrier, and `configurable:true` is what B.3.3.3
>    and the annexB tests want.)
> 2. **CORRECTION — the probe is strictness-BLIND and must be gated on §1.1′.**
>    The `"throw 0;\n"` prefix destroys the directive prologue, so a strict
>    source is probed as sloppy: measured, `"use strict"; { function sf(){} }`
>    hoists `sf` under the probe, while real strict eval creates nothing. §1.2's
>    "only for sloppy eval code" line is therefore not an optimisation, it is a
>    **correctness precondition**, and it is only as good as the strictness
>    answer. That is why §1.1′ had to become exact.
> 3. **CORRECTION — var-names and annexB-names CANNOT be told apart, and §1.3
>    needs the distinction.** EDI throws SyntaxError for a *var* name colliding
>    with an outer lexical, but B.3.2.3 says an annexB block-function name in the
>    same position is **silently skipped**. After the abort, `typeof` separates
>    top-level function declarations (already a function) from
>    `var` ∪ annexB (both `undefined`) but not the latter two.
>    *Tried and rejected:* re-probing with a `"use strict";` prefix. It does not
>    isolate annexB — it makes the whole source strict, so sloppy-only
>    constructs (`with`, single-statement function declarations) become
>    SyntaxErrors and the diff reports every name as annexB. Measured on 4
>    sources; do not re-invent it.
>    **Use §1.3′ instead** — it removes the need for the distinction entirely.

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

#### 1.3′ Redeclaration checks (AMENDED) — let QuickJS decide, don't hand-roll

Hand-rolling the check needs the var-vs-annexB distinction P2 proved is not
recoverable (§1.2 correction 3). Delete the need instead: **seed the scratch
context with the caller's lexical names as real `let` declarations** before the
sentinel eval.

```
scratchPrologue = "let " + lexicalNamesJoinedByComma + ";\n"
probeSource     = scratchPrologue + "throw 0;\n" + source
```

QuickJS then applies its own EDI rules and the probe's *outcome* is the answer:

- probe throws `SyntaxError: redeclaration of 'x'` ⇒ return
  `runtimeEvalResult(false, new SyntaxError(...))` before creating anything;
- probe aborts on the `0` sentinel ⇒ the surviving name set already has the
  annexB collisions removed, silently, exactly as B.3.2.3 requires.

Measured (P2b): with a global `let f` in scope, both `var f;` and
`{ function f(){} }` are rejected by QuickJS with `redeclaration of 'f'`, and
**V8 in a fresh realm rejects both identically** (`Identifier 'f' has already
been declared`) — so this is engine-consistent behaviour, not a QuickJS quirk
being laundered into the adapter. Only names that pass `qjsIsSafeConstName`
may be seeded (an unsafe identifier would corrupt the prologue); fall back to
"create nothing for that name" otherwise.

#### 1.4 Global-caller / indirect: the compiled global IS the varEnv

Applies to indirect eval (always) and direct eval from global code
(recognizable: no activation layers — `activationSeedNames` empty and
`outerNames` empty; verify in a probe, do not guess).

> **AMENDED 2026-08-09 by probe P4 — the predicate is CONFIRMED for global code
> and has ONE measured hole.** Evidence in `## Probe results` → P4.
> Global code arrives as `outer[] seed[] lex[]` in every shape tried (first
> statement, after top-level `var`s, after a top-level `let`, inside a block
> with `let`, inside a `for` body, with and without a surrounding `try`).
> Every ordinary **function** caller carries at least `arguments` in
> `activationSeedNames`, even with no params, no locals and an empty body.
> **The hole:** an **arrow** caller with no parameters and no declarations also
> arrives `outer[] seed[] lex[]` — arrows have no `arguments` — so it is
> indistinguishable from global code and would have its eval-created `var`
> placed on the global object instead of the arrow's own varEnv. Add
> `lexicalNames` to the conjunction (it is empty for global code in all
> measured shapes) and book the declaration-free-arrow case as a named residual
> with a lane case; the exact fix, if it ever bites, is one line of `src/`
> codegen — always push a sentinel seed entry for a non-global call site — which
> §2's "no `src/` change" rule would have to be relaxed for.

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
  is the `existing-non-enumerable-global-init` 16-cluster. ~~Probe P3 decides
  the fix: either the carrier exposes `Object.getOwnPropertyNames`, or the
  push must additionally walk a name list the caller can enumerate. If neither
  works adapter-side, this 16-cluster is a declared residual pending #4245
  slice 2 (descriptor/own_keys fidelity) — do NOT block the rest on it.~~

  > **RESOLVED 2026-08-09 by probe P3 — the 16-cluster is IN SCOPE for #4308.
  > It does NOT need #4245 slice 2.** Measured from inside the compiled
  > adapter, on a global defined by the user module as
  > `Object.defineProperty(globalThis,"p3hidden",{value:42,writable:true,
  > enumerable:false,configurable:true})`:
  > `Object.keys(globalObject)` → absent; **`Object.getOwnPropertyNames(
  > globalObject)` → present**; `"p3hidden" in globalObject` → true;
  > `globalObject["p3hidden"]` → 42; `Object.getOwnPropertyDescriptor` →
  > `{writable:true, enumerable:false, configurable:true}`. The adapter can
  > read the name, the value **and** the descriptor. Strike the ≤16 residual in
  > §5 and fold the cluster into slice B's target.
  >
  > **HAZARD — do NOT simply swap `Object.keys` for
  > `Object.getOwnPropertyNames` in `qjsPushGlobals`.** The extra names on a
  > realistic module are, measured exactly:
  > `p3hidden`, `__js2wasm_runtime_eval_global_lexical_cells__`, and the eight
  > intrinsic error constructors `Error, TypeError, RangeError, SyntaxError,
  > ReferenceError, EvalError, URIError, AggregateError`. Mirroring those would
  > (a) push the compiler's private lexical-cells carrier into the QuickJS realm
  > and (b) push **compiled** error constructors into the realm as membrane
  > wrappers — which §1.7 explicitly forbids and which would fight slice A.
  > Keep the **mirror** on `Object.keys` + `qjsIsMembraneWrappable` as today;
  > use `Object.getOwnPropertyNames` **only** for the EDI existence test
  > ("does this probe name already exist?") and the post-eval propagation walk,
  > with the adapter-prefix / intrinsic-marker exclusions applied.
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
> **AMENDED 2026-08-09 by probe P4.** Two facts slice C should not re-derive:
> (a) the routing predicate this section is the other half of has a measured
> hole for declaration-free **arrow** callers — see the amendment box in §1.4;
> (b) `activationState.length` is **128** in every measured call, i.e. 64 slots
> × 2 cells (name + value). The "64 slots" figure below is confirmed, and the
> pool length is a compile-time constant, so it is **not** usable as a
> caller-kind discriminator.

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
  ~~accept the remaining collision class as a residual of the no-parser
  design.~~

#### 1.6′ Preamble ↔ source lexical collisions (AMENDED) — also decidable

"No parser" was never true (§1.1′). The preamble collides exactly when the
source's own top-level lexical declarations reuse a preamble name — which is a
**parse-time** early error, so it is answerable with the same zero-side-effect
wrapper:

```
(function(){ let <candidateNames>;  <source>  })
```

SyntaxError ⇒ at least one candidate collides. Bisect (or probe per name;
`qjsSourceMentions` already keeps the candidate list short) and drop the
colliding names from the preamble. Measured shape: `let x; let x;` inside the
wrapper is rejected with `invalid redefinition of lexical identifier`, and the
wrapper's control probe is exactly as parse-tight as real eval code (Q5c).
This closes the second half of §5's ~4–6 residual.

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

> **AMENDED 2026-08-09 by probes P3 / P4 / Q5 — two rows are struck, one is
> added. Net: ~16 files move INTO scope and the "irreducible" row was wrong.**

| count | what | why not |
| --- | --- | --- |
| 37 | both-engines-fail files (incl. `$262.createRealm` null-deref, 30 shared `SameValue` fails) | not a quickjs delta; belongs to the interpreter/compiler lanes |
| ~~≤16~~ **0** | ~~`existing-non-enumerable-global-init` IF P3 says the carrier cannot expose non-enumerable names~~ | **STRUCK (P3).** The adapter reads non-enumerable globals — name, value and descriptor — via `Object.getOwnPropertyNames` / `getOwnPropertyDescriptor` on the carrier. In scope for slice B; #4245 slice 2 is not a prerequisite. |
| ~~~4-6~~ **0** | ~~strict-preamble ↔ source lexical collisions + directive-scanner ASI edges~~ | **STRUCK (Q5).** Both classes are parse-time questions and QuickJS is available as the parser: §1.1′ for the prologue, §1.6′ for the collisions. "The adapter has no parser" was the false premise. |
| ~~unmeasured, expected 0~~ **0 — FIX IT** | ~~direct eval whose caller is an **arrow with no parameters and no declarations** — indistinguishable from global code at the seam (P4), so its `var`s land on the global object~~ | **STRUCK (tech lead, 2026-08-09). `src/` IS authorized for this one line in slice C.** §2's adapter-only rule is a good default because it avoids budgets and the oracle ratchet — it is not a correctness principle, and this is a correctness hole: an arrow-caller's `var`s land on the **global object** instead of the activation, silently and with green tests, because the seam cannot distinguish the two callers. "Expected 0 in the corpus" is an argument about *this* test set, not about the compiler. A wrong-scope write that no test happens to observe is exactly the class that surfaces later as an unattributable bug. Slice C emits the sentinel seed entry per non-global call site and carries a lane case with a declaration-free arrow caller; it then owes the equivalence gate and the budgets like any `src/` change. |
| unmeasured | in-eval `instanceof` against a *mirrored* compiled constructor; sources >64 var names per activation | corpus shows zero occurrences; document, don't engineer |
| unmeasured, expected small | sources that are **SyntaxErrors as eval code** and whose strictness therefore falls back to `callerStrict` (§1.1′ INCONCLUSIVE) | the real evaluation throws SyntaxError regardless, so strictness is unobservable |

Everything else in the 219 is claimed by a slice above.

### 6. Projected ceiling (projection, not measurement — labeled as such)

> **AMENDED 2026-08-09 (tech lead) — the number below is STALE. It was computed
> against a §5 that has since had two rows struck.** P3 moved the ≤16
> non-enumerable-global files into scope and Q5 moved the ~4–6 strictness/
> preamble files into scope, so ~21 files that this projection excluded are now
> claimed by slices B and D. That raises the floor; it does **not** license a
> claim of 779.
>
> What is honest to say now: **779 is no longer excluded by a known residual.**
> The only *named* remainders left are the 37 both-engines-fail files — which
> are not part of the 219 and are not this issue's cost — plus three
> `unmeasured, expected 0` rows. Everything else in the 219 is claimed.
>
> What is still unknown, and is the whole risk: **the 10–15 % second-order
> discount is unmeasured.** Unblocking a test lets it reach the next thing it
> tests; the membrane projected 672 and landed 560. That discount is the only
> reason not to state a number here, and it resolves slice by slice, not by
> analysis. **Do not recompute this projection — replace it with slice B's
> measured result**, which is the first one large enough to calibrate the
> discount for the rest.
>
> Target for the workstream is **parity at 779**, not the range below.

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

## Probe results — P2, P3, P4, Q5

Senior developer, 2026-08-09. Base tree `e8e43ee86` (branch
`issue-4245-membrane-slice1`), probe branch `issue-4308-probes`. Artifact key
`d8a5a91d6f183b87`, sha256
`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b` —
**unchanged**; no shim rebuild was needed, no `src/` file was touched, no
adapter behaviour change is proposed here. All instrumentation is throwaway and
lives under `.tmp/` (gitignored).

**Method.** P2 and Q5 drive `libquickjs.wasm`'s `qjs_*` shim exports directly
from node — no adapter, no compiled module — through the same entry point
(`qjs_eval`, `JS_EVAL_TYPE_GLOBAL`) the adapter uses. P3 and P4 patch the
adapter **source string** returned by `buildQuickjsAdapterSource` (so
`scripts/quickjs-eval-provider.mjs` is never edited — the slice-A agent owns
that file), compile it, and drive it from a real compiled probe module through
the frozen 4-import seam. Every probe eval source is composed through a runtime
`join()` loop so `tryStaticEvalInline` cannot fold it, and every module is
asserted to actually import `js2wasm:runtime-eval` before any result is read.

---

### P2 — the scratch-context hoist probe: **DESIGN SURVIVES, three corrections**

Sources are `"throw 0;\n" + source` evaluated with `qjs_eval` in a fresh
`qjs_new_context`, then `Object.getOwnPropertyNames(globalThis)` diffed against
a virgin-context baseline.

| source | abort | names added | value |
| --- | --- | --- | --- |
| `if (false) ; else function f(){}` | threw `0` | `["f"]` | `undefined` |
| `{ function f(){} }` | threw `0` | `["f"]` | `undefined` |
| `{ let f; { function f(){} } }` | threw `0` | `[]` | — |
| `{ let f; function f(){} }` | `SyntaxError: invalid redefinition of lexical identifier` | `[]` | — |
| `function g(){ return 1; }` | threw `0` | `["g"]` | **function** |
| `var v1 = 1;` | threw `0` | `["v1"]` | `undefined` |
| `var a; function b(){}; { function c(){} } if(0); else function d(){}` | threw `0` | `["a","b","c","d"]` | `b` function, rest `undefined` |
| **`var x = (globalThis.__boom__ = 1);`** | threw `0` | **`["x"]` only** | **`__boom__` NOT set** |
| `globalThis.__boom2__ = 1; var y = 2;` | threw `0` | `["y"]` only | `__boom2__` NOT set |
| `let L = 1; const C = 2;` | threw `0` | `[]` | — |
| `var =` | `SyntaxError: variable name expected` | `[]` | — |
| `switch(0){ case 0: function sc(){} }` | threw `0` | `["sc"]` | `undefined` |
| `lbl: { function lf(){} }` | threw `0` | `["lf"]` | `undefined` |
| `try { function tf(){} } catch(e) {}` | threw `0` | `["tf"]` | `undefined` |
| `for(;false;) function ff(){}` | `SyntaxError: function declarations can't appear in single-statement context` | `[]` | — |
| **`"use strict"; { function sf(){} } var sv=1;`** | threw `0` | **`["sf","sv"]`** | **WRONG for strict eval — correction 1** |

**The four questions asked:**

1. `throw 0; if (false) ; else function f(){}` leaves `f` hoisted as
   `undefined` — **yes, verbatim.**
2. The early-error collision `{ let f; { function f(){} } }` correctly does
   **not** hoist — `[]`, no error.
3. **Zero-side-effects invariant: PROVEN.** `var x = (globalThis.__boom__ = 1)`
   adds only `x`; `__boom__` is absent. Same for a leading expression
   statement. The design is sound on this axis.
4. **GDI vs EDI: declared-NAME sets are IDENTICAL.** Six sources run both ways
   in the same engine (`qjs_eval` Script goal vs `(0,eval)(src)` inside the
   realm) match test-for-test, so reading the plan off a Script-goal scratch
   eval is sound. The **descriptors** differ — GDI `configurable:false`, EDI
   `configurable:true` — which is spec-correct (script bindings non-deletable,
   eval bindings deletable) and harmless here, because §1.4 creates the binding
   on the *compiled* carrier and `configurable:true` is what B.3.3.3 and the
   annexB `verifyProperty` assertions want.

**Correction 1 — strictness gating is a correctness precondition, not an
optimisation.** Last table row: the `"throw 0;\n"` prefix destroys the directive
prologue, so a strict source is probed as sloppy and its annexB block function
is "hoisted" when real strict eval creates nothing. §1.2's "only for sloppy eval
code" is load-bearing, and only as good as the strictness answer — which is
why Q5 mattered.

**Correction 2 — var-names and annexB-names are NOT separable, and §1.3 needed
them separated.** `typeof` after the abort separates top-level function
declarations from {var ∪ annexB}, not the last two. Per B.3.2.3 an annexB name
colliding with an outer lexical must be **silently skipped** while a var name
must throw SyntaxError, so §1.3 as written would throw where the spec skips.
*Tried and rejected:* a `"use strict";`-prefixed re-probe to suppress annexB. It
makes the whole source strict, so sloppy-only constructs become SyntaxErrors and
the diff attributes **every** name to annexB (e.g. `with({}){ } var w;` →
sloppy `["w"]`, strict `SyntaxError: invalid keyword: with`, "annexB-only"
`["w"]` — nonsense). Do not re-invent it. **§1.3′ removes the need.**

**Correction 3 / cross-engine check for §1.3′.** With a real global lexical `f`:

| engine | `(0,eval)("{ function f(){} } ; 42")` | `(0,eval)("var f;")` |
| --- | --- | --- |
| quickjs-ng 0.16.1 | `SyntaxError: redeclaration of 'f'` | same |
| V8, fresh realm (`vm.runInNewContext`) | `SyntaxError: Identifier 'f' has already been declared` | same |

Both engines agree, so §1.3′ inherits engine-consistent behaviour rather than
laundering a QuickJS quirk. (In CommonJS module scope V8 answers differently —
that `let` is module-scoped, not a global lexical; the fresh-realm run is the
apples-to-apples one.)

---

### P3 — compiled-global carrier semantics: **ALL YES; the 16-file cluster is IN SCOPE**

Instrumented adapter, driven by a compiled module that first executes
`Object.defineProperty(globalThis,"p3hidden",{value:42,writable:true,
enumerable:false,configurable:true})`. Descriptor bits are
`4=writable 2=enumerable 1=configurable`.

| adapter-side measurement | value |
| --- | --- |
| `Object.keys(globalObject).length` | 50 |
| `Object.getOwnPropertyNames(globalObject).length` | **59** |
| `"p3hidden"` in `Object.keys` | **0** |
| `"p3hidden"` in `Object.getOwnPropertyNames` | **1** |
| `"p3hidden" in globalObject` | 1 |
| `globalObject["p3hidden"]` unwrapped | **42** |
| `getOwnPropertyDescriptor(globalObject,"p3hidden")` | **5** = `{w:t,e:f,c:t}` |
| `getOwnPropertyDescriptor(globalObject,"p3existing")` (ordinary script global) | 6 = `{w:t,e:t,c:f}` |
| `globalObject["p3fresh"] = __runtime_eval_wrap_result(undefined)` | ok |
| created name in `keys` / `getOwnPropertyNames` | **1 / 1** |
| created name's descriptor | **7 = `{w:t,e:t,c:t}`** |
| created name's unwrapped value | `undefined` |
| after `globalObject["p3fresh"] = wrap(7)`, read back | **7** |
| compiled-side `getOwnPropertyNames` / `keys` sees it | 1 / 1 |
| compiled-side descriptor | **7 = `{w:t,e:t,c:t}`** |
| `(0,eval)("var p3evar = 5;")` then compiled `globalThis.p3evar === 5` | **0** — today's gap |

**(a) enumerates compiled-side under `Object.keys` — YES.
(b) verifies as `{writable:true, enumerable:true, configurable:true}` under a
compiled `verifyProperty` — YES, exactly the B.3.3.3 attribute set.
(c) round-trips a later value assignment — YES.**

**The decisive question, answered definitively: the adapter CAN see a
`defineProperty`'d non-enumerable compiled global.** `Object.keys` cannot (by
design); `Object.getOwnPropertyNames` on the same carrier returns it, `in` finds
it, the value reads back, and `getOwnPropertyDescriptor` returns the true
attribute set. **The ~16 `existing-non-enumerable-global-init` files are
recoverable inside #4308 and must NOT be routed to #4245 slice 2.**

**The trap that comes with it.** On a module that also declares a top-level
`let`, `getOwnPropertyNames` minus `keys` is exactly:

```
p3hidden, __js2wasm_runtime_eval_global_lexical_cells__,
Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError,
URIError, AggregateError
```

A blanket swap of `Object.keys` → `Object.getOwnPropertyNames` in
`qjsPushGlobals` would therefore mirror the compiler's private lexical-cells
carrier and **eight compiled error constructors** into the QuickJS realm — the
latter is exactly what §1.7 forbids and would fight slice A. Use
`getOwnPropertyNames` **only** for the EDI existence test and the post-eval
propagation walk, with the adapter-prefix and intrinsic exclusions applied;
leave the mirror on `Object.keys` + `qjsIsMembraneWrappable`.

---

### P4 — routing predicate: **CONFIRMED for global code, ONE measured hole**

Layer contents as they arrive at `__runtime_direct_eval` (names, not counts):

| call site | `outerNames` | `activationSeedNames` | `lexicalNames` |
| --- | --- | --- | --- |
| global, first statement | `[]` | `[]` | `[]` |
| global, after top-level `var`s | `[]` | `[]` | `[]` |
| global, after a top-level `let` | `[]` | `[]` | `[]` |
| global, inside a block with `let` | `[]` | `[]` | `[]` |
| global, inside a `for` body | `[]` | `[]` | `[]` |
| function, empty body | `[]` | `[arguments]` | `[]` |
| function, 2 params + 2 locals | `[]` | `[arguments,a,b,loc1,loc2]` | `[]` |
| function, block `let`/`const` | `[]` | `[arguments]` | `[lexA,lexB]` |
| nested function | `[arguments,outerLocal]` | `[arguments,innerLocal]` | `[]` |
| strict function | `[]` | `[arguments,sv]` | `[]` |
| object-literal method | `[e]` | `[arguments]` | `[]` |
| **arrow, no params, no declarations** | `[]` | **`[]`** | `[]` |
| **arrow, block body, no declarations** | `[]` | **`[]`** | `[]` |
| **arrow nested in arrow, no declarations** | `[]` | **`[]`** | `[]` |

**Confirmed:** a direct eval from global code arrives with empty activation and
outer layers in every shape tried — including the shapes most likely to perturb
it (`let` at top level, block scope, loop body). A function-caller direct eval
never does: every ordinary function carries at least `arguments`, even with no
params, no locals and an empty body. §1.4/§1.5's routing predicate is sound for
the corpus this issue targets.

**Refuted as sufficient:** the predicate cannot distinguish global code from a
**declaration-free arrow** caller — arrows have no `arguments`, so all three
layers are empty there too. Misrouting puts the eval's `var` on the global
object instead of the arrow's varEnv. `thisArg === globalObject` does not
rescue it (a top-level arrow reports `thisIsGlobal=1` exactly like global code,
while an object-literal method reports `0`), and `activationState.length` is the
compile-time constant **128** (= 64 slots × 2 cells, independently confirming
§1.5's "64 slots") in every call, so it carries no signal either. Booked as a
named §5 residual with the one-line `src/` fix noted.

*Two honesty notes on this probe.* (i) A first pass packed the four layer sizes
into one number and mis-read `pool=128` as `seed=1` for the global case, which
briefly looked like the plan's predicate was broken. That was my decoder, not
the plan — which is why the final answer is stated from names, not counts.
(ii) An earlier draft labelled one row "global, bare, no surrounding `try`";
that module did in fact have a `try`/`catch`. The row is dropped rather than
kept with a wrong label. The catch-free evidence is the bisect below.

---

### Incidental finding (NOT one of the four questions, hand-off to the tech lead)

While re-verifying P4 catch-free after the coordinator's #4305 correction, a
separate reproducible failure surfaced on this base tree. Same instrumented
adapter, one module per row, **zero `try`/`catch` anywhere**:

| module body | result |
| --- | --- |
| `slot = eval(j([...])) as string;` (top-level statement) | **traps — uncaught `WebAssembly.Exception`** |
| `slot = (0, eval)(j([...])) as string;` (top-level statement) | **traps** |
| `eval(j([...])); slot = "ok";` (result dropped) | **traps** |
| `var anyv: any = eval(j([...])); slot = String(anyv);` | **traps** |
| `{ slot = eval(j([...])) as string; }` (same stmt inside a block) | works |
| `if (1 === 1) { slot = eval(j([...])) as string; }` | works |
| arrow / function callers (all shapes) | work |

So: **an `eval` call as a direct top-level statement of the module body traps,
while the identical statement nested in any block does not** — independent of
eval kind (direct or indirect) and of what happens to the result. This is **not
#4305**: no `catch` clause exists in any failing variant. It may be a sibling of
the refusal-path defect #4339 fixes; this base predates #4339 and, per the
coordinator, #4339 must not be merged here, so it was not retested against the
fix. Recorded for triage, not attributed.

**Does it corrupt anything above? No, and here is why for each probe:** P2 and
Q5 use raw QuickJS with no compiled module at all. P3's module wraps every eval
in `try`/`catch` and every row returned a real value (never the `-777` catch
sentinel), so no exception was raised; the values are also mutually consistent
(descriptor 7 ↔ value 7 ↔ hidden 42). P4's load-bearing negative — the
declaration-free arrow — was **re-measured catch-free** in the bisect above,
where the ordinary-function control in the *same* run shows
`seed[arguments,...]` against the arrows' `seed[]`. That is a within-run
contrast under identical codegen conditions, so it cannot be a catch-clause
artifact.

---

### Q5 — strictness: **the residual COLLAPSES; §1.1's scanner should be replaced**

The premise "the adapter has no parser" is false — §1.2 already uses QuickJS as
one. Strictness is a **parse-time** property and a parse error executes nothing,
so it is answerable exactly and with zero side effects.

Three oracles were built and cross-compared on 21 sources:

- **A (proposed mechanism)** — `(function(){SRC\n})` vs
  `(function(){SRC\n;with({}){}\n})`; strict ⟺ the marker fails to parse.
- **B (measurement only)** — real `(0,eval)(SRC + ";with({}){}")`; runs the
  source when sloppy, so it can never be the mechanism.
- **C** — eval-code parse-only, `(0,eval)(SRC + ";with({}){}\n;)")` against the
  same without the `with`, distinguished by error message.

| source | truth (QuickJS) | A | C | §1.1 scanner |
| --- | --- | --- | --- | --- |
| `"use strict"; var a = 1;` | STRICT | STRICT | STRICT | STRICT |
| `var a = 1;` | SLOPPY | SLOPPY | SLOPPY | SLOPPY |
| `"other"; "use strict"; var a=1;` | STRICT | STRICT | STRICT | STRICT |
| `"use strict"\nvar a = 1` (ASI) | STRICT | STRICT | STRICT | STRICT |
| `"use strict" + ""; var a = 1;` | SLOPPY | SLOPPY | SLOPPY | **STRICT ✗** |
| `"use strict"\n["length"]; …` | SLOPPY | SLOPPY | SLOPPY | **STRICT ✗** |
| `"use strict"\n(function(){}); …` | SLOPPY | SLOPPY | SLOPPY | **STRICT ✗** |
| `"use strict"` + newline + tagged template | STRICT\* | STRICT | STRICT | STRICT |
| `"use strict", 1; var a = 1;` | SLOPPY | SLOPPY | SLOPPY | **STRICT ✗** |
| `"use strict"; …` (escaped) | SLOPPY | SLOPPY | SLOPPY | SLOPPY |
| `"use strict"; …` (escaped) | SLOPPY | SLOPPY | SLOPPY | SLOPPY |
| `/* c */ // l` + newline + `"use strict"; …` | STRICT | STRICT | STRICT | STRICT |
| `function q(){"use strict";} var a=1;` | SLOPPY | SLOPPY | SLOPPY | SLOPPY |
| `var a = 1; "use strict";` | SLOPPY | SLOPPY | SLOPPY | SLOPPY |
| `"use strict";` (only a directive) | STRICT | STRICT | STRICT | STRICT |
| directive with a line continuation | SLOPPY | SLOPPY | SLOPPY | SLOPPY |
| `"use strict"; var a=1; /* open` | SyntaxError | **INCONCLUSIVE** | SLOPPY ✗ | — |
| `"use strict"; return 1;` | SyntaxError as eval code | STRICT | SLOPPY ✗ | — |

`*` — on the tagged-template row **QuickJS treats the string as a directive and
V8 does not** (V8 compile-only, `new vm.Script(src + ";with({}){}")`, answers
SLOPPY). Oracle A reports QuickJS's answer, which is the correct one for
routing: the same parser decides the real `qjs_eval`. It is the only row where
the mechanism deviates from spec, and it deviates *with* the engine that will
execute the code.

**Score: the §1.1 scanner is wrong on 5 of 18 decidable rows; oracle A is wrong
on 0 and inconclusive on 1.** Oracle A also beats oracle C on the two rows where
C silently mis-answers (an unterminated block comment swallows C's marker; an
earlier parse error masks it).

**Three robustness facts that make or break the mechanism:**

1. **The wrapper MUST be the parenthesised FunctionExpression.** With the
   statement form `function __p(){SRC\n}`, a source of
   `} ; globalThis.__BOOM__ = 1; function evil(){` **parses and executes** —
   measured `__BOOM__ = 1` in the scratch realm. `(function(){SRC\n})` rejects
   it as a SyntaxError. `void function(){SRC\n};` leaks too. This is the one
   detail an implementer could get wrong and turn a "zero side effects" probe
   into arbitrary execution.
2. **INCONCLUSIVE ⊆ {source is a SyntaxError as eval code}.** Across 22 probe
   sources there is no case where the wrapper control fails while real eval code
   parses; the reverse happens only for `return` / `new.target`, which are
   SyntaxErrors as eval code anyway. So the fallback is reached only for sources
   whose real evaluation throws SyntaxError, where strictness is unobservable.
3. **Cost is two parse-only `qjs_eval` calls, and only for sloppy callers**
   (when `callerStrict` is already true the OR short-circuits), reusing §1.2's
   scratch context.

**Verdict: the strictness residual collapses.** §1.1's scanner should be
replaced by §1.1′. The same wrapper also answers §1.6's preamble-collision class
(§1.6′), so **both halves** of §5's "~4–6 irreducible" row are struck. The
premise was wrong, not the count.

---

## Slice A — implementation record

Implementer: senior-dev, 2026-08-09. Branch `issue-4308-slice-a-error-identity`,
stacked on `issue-4245-membrane-slice1` at `e8e43ee86` (PR #4335) per §7.
**Adapter-only**: `scripts/quickjs-eval-provider.mjs` + lane cases in
`tests/quickjs-eval-membrane.test.ts`. No `src/` change, no `qjs_shim.c` change.

### P1 — the answer (and where §1.7's preference order was wrong)

Measured with a compiled probe that reproduces test262's `assert.throws`
comparison exactly, run on BOTH tiers (`.tmp/p1-probe.mjs`, scratch):

| question | quickjs (before) | interpreter |
| --- | --- | --- |
| `thrown.constructor === expectedErrorConstructor` | **0** | 1 |
| `expectedErrorConstructor === <user module>.ReferenceError` | **0** | **1** |
| `thrown.constructor === <user module>.ReferenceError` | **1** | 1 |
| in-eval `e instanceof ReferenceError` | 1 | (unsupported by the interpreter's Phase-1 emitter) |

1. **The known-good target is the CALLER'S OWN constructor object.** The
   interpreter hands `assert.throws` exactly that (`src/interp/loop.ts`
   `intrinsicErrorConstructor` :565, reached from `envLookup` — and its comment
   already states the requirement: the identity check "must observe the same
   constructor carrier as an error thrown by the interpreter").
2. **The throw side was already correct on both engines.** `qjsErrorFromHandle`'s
   `new ReferenceError(msg)` yields an instance whose `.constructor` IS the user
   module's `ReferenceError`: `.constructor` is resolved by the READING module.
   Nothing on the throw path needed to change.
3. **Preference (c) of §1.7 — "the adapter's own intrinsics" — is measurably
   WRONG, and the plan's stated reason for it does not hold.** A standalone
   module's intrinsic constructor *object* is per-module. Proved by branding:
   seeding with the adapter's own `ReferenceError` after setting
   `ctor.__js2wasm_adapter_seeded__ = 7` gave `expected.__js2wasm_adapter_seeded__
   === 7` (the adapter's object DID arrive) while
   `(<user module>.ReferenceError).__js2wasm_adapter_seeded__` was `undefined`
   (a different object). Only `.constructor`, being reader-resolved, is canonical.
4. **Preference (a) — `globalObject.ReferenceError` — works, and works even for
   the real test shape** where the module never mentions `ReferenceError` outside
   the eval string (checked separately before trusting it: the realm carrier
   still exposes all seven).

**The trap that cost the most time, recorded because it is the workstream's
recurring silent-no-op class:** the natural guard `typeof ctor === "function"`
seeds NOTHING. The caller holds its intrinsic constructor as the cross-module
AOT callable carrier, and the **adapter's** `typeof` answers `"object"` for it
while the **caller's** `typeof` answers `"function"` for the very same value
(measured on `raw`, on `__runtime_eval_unwrap_result(raw)`, and on
`__runtime_eval_unwrap_interpreted_callback(...)` — all three `"object"`). The
guard compiles, links, runs, and produces a silently unchanged pass count. The
shipped guard is `qjsIsMembraneWrappable(ctor)`. Liveness was established by
POISONING the seed (`{poison:i}` in place of the constructors) and observing
`typeof expected` flip to `"object"` compiled-side.

### What shipped

`qjsSeedIntrinsicErrorIdentities(c, realm)` — one function plus its call site.
It seeds the existing handle registry with seven (realm constructor handle,
caller's compiled constructor) pairs, which IS the `qjs_is_equal`-strict lookup
§1.7 asks for, expressed through machinery that already exists, and it therefore
fixes both crossings at once:

- **outward**: `qjsPublish`'s `qjsFindBoxIndex` hit returns the caller's
  constructor instead of minting an opaque published box;
- **inward**: `qjsToQuickjs`'s `qjsHandleOf` hit returns the realm's own
  constructor, so a compiled `ReferenceError` crossing in cannot SHADOW the realm
  intrinsic — which is why in-body `e instanceof ReferenceError` keeps working.

Seeding is **lazy**, hooked at the head of `qjsPushGlobals` (the first point at
which the caller's realm is in hand, and it precedes every crossing on both the
direct and the indirect path). It could not live in `qjsEnsureContext`: at
context-creation time there is no realm to read the constructors from. We do NOT
mirror the compiled constructors into the realm — QuickJS builds engine-generated
errors from its internal intrinsics whatever the global binding says.

### Measured result (tier-pinned, this tree, 2026-08-09)

`TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/'
JS2WASM_EVAL_ENGINE=quickjs`, 816 files:

| run | pass / 816 |
| --- | --- |
| quickjs, pre-slice-A (base = `e8e43ee86`) | **560** |
| quickjs, post-slice-A | **624** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | **779** (unchanged) |

- **+64, and the done-signal was ≥ 615.** The §0 560 was reproduced by two
  independent baseline runs with **zero** per-file status disagreement, so the
  design-grade number of §0 is now gate-grade on this tree.
- **Regressions: 0**, diffed test-for-test over all 816 files (not totals).
- All 64 gains are the targeted cluster: `skip-early-err-*`, **56 direct + 8
  indirect** — precisely §0's `aB-d 56 · aB-i 8` split. No other template moved
  in either direction.
- No `illegal cast` rows appeared; the #4305 defect (root-caused and fixed
  separately in PR #4339 — static shape `catch` → direct eval → `catch` whose
  body reads its parameter; neither `instanceof` nor a succeed-then-throw
  sequence is required) is absent from this delta.

### Artifact

**Unmoved, as required**: key `d8a5a91d6f183b87`, `libquickjs.wasm` sha256
`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b`.
`scripts/quickjs-artifact/` is untouched; the whole slice is adapter TS.

### Lane cases (`tests/quickjs-eval-membrane.test.ts`)

Shaped like the real corpus: sloppy function caller, DIRECT eval,
`assert.throws(ReferenceError, fn)` only INSIDE the eval string, and `assert` as
a top-level function declaration carrying `throws` as a property — test262's own
harness shape. That last detail is load-bearing: with an object-literal `assert`
the probe fails with `not a function` (its `throws` is an uncarried closure
value, the residual #4245 slice 1 pinned) and measures nothing about identity.

Cases: identity match · realm-side `instanceof` still true · SECOND and THIRD
evaluations after the new crossing path (delayed realm corruption) · the
constructor as an indirect-eval COMPLETION value · in-band
`__js2wasm_eval_engine` engine identity. Every source is composed through a
runtime loop (`tryStaticEvalInline` folds literals).

**Anti-vacuity, measured both ways:** on the pre-slice-A adapter these same cases
FAIL (identity `0`, `sameNameMisses 3` — the corpus's exact
"different error constructor with the same name" signature); with the slice they
pass 23/23.

### Residuals this slice deliberately leaves

- A caller that SHADOWS an intrinsic error name on its realm carrier with some
  other object would have the QuickJS intrinsic mapped to that shadow. Not
  observed in this corpus; the alternative (a `.name` cross-check) risks
  disabling the mechanism the way the `typeof` guard did.
- Outward identity for compiled objects generally is untouched:
  `qjs_wrapper_gc_handle` is declared in the adapter's externs but **never
  called**, so a compiled object that crossed inward and comes back out is still
  an opaque box rather than the original. That is #4245 slice 2's job, not this
  one; it does not affect the intrinsic-error path.
- One realm per provider instance is assumed (the seed runs once), exactly as
  `qjsIntrinsicRealm` already assumes.

---

## Slice B — implementation record

Implementer: senior-dev, 2026-08-09/10. Branch `issue-4308-slice-b-edi`, stacked
on `issue-4308-slice-a-error-identity` at `2c8b8f3fd` (PR #4340), which descends
from `issue-4245-membrane-slice1` at `e8e43ee86` (PR #4335). **Adapter-only**:
`scripts/quickjs-eval-provider.mjs` + lane cases in
`tests/quickjs-eval-membrane.test.ts`. No `src/` change, no `qjs_shim.c` change,
no artifact rebuild.

### Measured result (tier-pinned, this tree)

`TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/'`, 816 files:

| run | pass / 816 |
| --- | --- |
| quickjs, pre-slice-B (base = `2c8b8f3fd`) | **624** |
| quickjs, post-slice-B | **710** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | **779** (unchanged) |

- **+86; the done-signal was ≥ 700.** The 624 baseline was re-measured on this
  tree before any edit and reproduced slice A's number exactly.
- **Regressions: 0**, diffed test-for-test over all 816 files (not totals).
- The gap to the interpreter is now **71 quickjs-only files**, plus the 37
  both-engines-fail files that are not this issue's cost.

### Gains, by cluster

| n | cluster | what unblocked it |
| --- | --- | --- |
| 16 | `global:existing-global-update` (d+i) | realm identity + function write-back |
| 16 | `global:existing-block-fn-update` (d+i) | realm identity + function write-back |
| 14 | `global:block-scoping` (d+i) | call-time globals sync (below) |
| 24 | `func:existing-var-update` / `existing-fn-no-init` / `existing-block-fn-update` | function write-back — **slice C's clusters, recovered early** |
| 16 | `lang:var-env-*` global, `switch-{case,dflt}-decl-nostrict`, `non-definable-global-{function,generator}` | EDI creation + propagation |

The 24 `func:*` files were not in slice B's target list. They fall out of the
widened write-back rather than of the routing work, which is why they land here
and not in C.

### What shipped, and why each piece exists

**1. The realm object is ONE object at the boundary** (`qjsSeedRealmIdentity`).
This is the premise everything else rests on, and it was the largest single
finding of the slice. test262's `fnGlobalObject.js` is
`Function("return this;")()`; under this engine that lands in `qjs_call` with
`this === undefined`, so a sloppy function returns the QUICKJS realm global,
which crossed out as an opaque published box. `Object.defineProperty(
fnGlobalObject(), 'f', …)` therefore defined `f` on a one-property box — on
neither realm — which is verbatim why the corpus reported *"binding is not
reinitialized"* and *"f should be an own property"*.

The fix is slice A's mechanism with one more pair: seed the handle registry with
(QuickJS `globalThis` handle, the caller's compiled realm carrier). Outward, the
realm global publishes AS the carrier; inward, the carrier crosses back as
QuickJS's own `globalThis` instead of a membrane wrapper. `AggregateError` was
added to slice A's seven for the same reason the other seven are there — and
because the widened pull below would otherwise have replaced the caller's
compiled `AggregateError` with a box.

**2. EDI by parse-only probe, in a throwaway context** (§1.1′ + §1.2 + §1.3′).
`qjsPlanEdiNames` mints a scratch context (`qjs_new_context` on the same
runtime), answers strictness with the parenthesised-FunctionExpression `with`
probe, takes the realm-name baseline, runs the `throw 0;` sentinel probe, diffs,
and frees the context on every path. `qjs_free_context` was already a shim
export, so listing it in `QUICKJS_ADAPTER_EXTERNS` moved no artifact bytes and
the per-eval scratch context is not a leak.

- The **parenthesised** wrapper is used, per Q5's measurement that the statement
  form executes injected code.
- Running the strictness probe in the SCRATCH context (not the caller's) is a
  deliberate second line of defence: Q5 measured the escape for the statement
  form, and a paren-matched escape of the shape `}); …; (function(){` is not
  excluded by that measurement. In a throwaway realm it cannot matter.
- The baseline is taken AFTER the parse probes, so anything such an escape
  created is part of the baseline and cannot be mistaken for a declared name.
- A cheap `var`/`function` token gate keeps both contexts off the hot path of
  the overwhelmingly common `eval("x + 1")` shape.
- §1.3′ is implemented in two phases so it needs no error-message matching: the
  UNSEEDED probe establishes that the source parses, and only a name colliding
  with a caller global lexical triggers a SECOND, seeded probe. A new failure
  there can only come from the seed, so it is EDI's redeclaration SyntaxError; a
  sentinel abort means QuickJS silently skipped the annexB collision, and its
  diff is the plan. The var-vs-annexB distinction is never made, exactly as P2
  correction 2 requires.

**3. Global-caller routing** (§1.4 + P4). A direct eval whose three layers are
all empty is evaluated RAW at global scope rather than through `with (S) { … }`.
That is not an optimisation for an empty `S`: wrapping the source in a Block
demotes its TOP-LEVEL function declarations to annex-B BLOCK-level ones, and
those declarations are exactly what the `eval-global` corpus measures. The arm
also skips `qjsMirrorNewBindings`, which would otherwise consume activation-pool
slots for bindings that belong on the global object.

**4. The push widened to non-enumerable primitives** (P3). `Object.keys` cannot
see a `defineProperty`'d non-enumerable global — the whole
`existing-non-enumerable-global-init` cluster. This is **not** the blanket
`keys → getOwnPropertyNames` swap P3 warned against: the extra names are
restricted to PRIMITIVES and filtered by the `__js2wasm` prefix, which excludes
the compiler's lexical-cells carrier and, structurally, all eight compiled error
constructors. A non-enumerable OBJECT-valued global stays unmirrored (residual).

**5. The pull widened to FUNCTION values, over a derived name set.**
"Primitive-only" was always about RAW handles: a published function box is the
sanctioned crossing, and it is what completion values already use. Three guards
make that safe, and each one is load-bearing:

- the pull walks the PUSH set ∪ the EDI names, never a fresh enumeration of the
  carrier. A compiled global the push deliberately skipped still has a
  same-named QuickJS intrinsic in the realm, and pulling that would replace the
  caller's own value with a box;
- a realm value that is one of OUR membrane wrappers is skipped
  (`qjs_wrapper_gc_handle` used as a GUARD only — outward identity remains #4245
  slice 2's job), so a compiled function that was merely READ is never
  downgraded to a box;
- a primitive may only replace a primitive, so realm `undefined` cannot clobber
  a compiled object; and the memoized `eval`/`Function` markers are excluded by
  identity.

**6. Call-time globals sync** — and the silent no-op it hid. A function an eval
CREATED shares the caller's global environment and can be invoked long after the
evaluation returned; the `block-scoping` corpus does exactly that
(`eval('{ function f(){ initialBV = f; … } }')` followed by a compiled `f()`).
So the mirror runs around the CALL in `__runtime_apply_interpreted` too, guarded
by a re-entrancy depth counter — re-entering the snapshot protocol from inside a
running evaluation would push the caller's PRE-eval values over bindings that
evaluation had just created.

> **The workstream's recurring trap, hit again and recorded.** The first cut of
> this gated on `qjsIntrinsicRealm`, which is set only by
> `qjsIntrinsicEvalValue` — i.e. only when a module reads `eval`/`Function`
> **first-class**. A module whose only entry is a plain `eval(source)` call never
> sets it, so the sync compiled, linked, ran, and gained **exactly zero** files:
> a full scoped run diffed 0 gained / 0 lost against the run without it, at an
> identical total of 696. It was only visible because the run was diffed
> test-for-test instead of by total — a totals-only comparison would have read as
> "this change does nothing" AND as "this change is harmless", both wrong. The
> realm is now recorded at the head of `qjsPushGlobals`, the same hook slice A
> used, and the same 14 files then landed.

### Residuals — what the remaining 71 quickjs-only files are

| n | cluster | owner |
| --- | --- | --- |
| **48** | `global:init`, `global:existing-global-init`, `global:existing-non-enumerable-global-init` (d+i) | **#4245 slice 2** — see below |
| 16 | `func:no-skip-param`, `func:existing-fn-update` | slice C |
| 4 | `lang:global-env-rec-eval`, `lang:lex-env-distinct-cls` (d+i) | pre-existing, unchanged by this slice |
| 3 | `lang:var-env-var-strict-caller`, `-caller-3`, `-strict-source` | slice D |

**The 48 are EDI-complete and blocked on ONE different defect.** They all fail
with `Test262Error: Invalid descriptor field: __qjs_handle__`. That is
test262's `propertyHelper.js` rejecting the DESCRIPTOR OBJECT: the eval body
calls `verifyProperty(global, "f", {enumerable:true, writable:true,
configurable:true})`, and that object literal — created inside the QuickJS realm
and handed to a compiled function through the membrane — crosses OUT as an
opaque published box whose only own property is `__qjs_handle__`. The binding,
its value and its descriptor are all correct by then; the assertion cannot reach
them. `global:init` moved from *"f should be an own property"* to this message,
which is the second-order discount made concrete and legible.

This is the **outward** half of the membrane (a plain QuickJS object crossing
out has no live view), i.e. #4245 slice 2, not EDI. It is deliberately NOT
attempted here: a snapshot-copy `qjsPublish` would lose identity, liveness and
cycles, and would have to be removed when the live view lands. **Consequence for
the projection: 48 of the remaining 71 are one dependency, not a long tail.**

**`lex-env-distinct-cls` (2) is not slice B's, and is not a regression.** Its
`SyntaxError: redeclaration of 'outside'` is byte-identical before and after,
and the EDI redeclaration check cannot be its source — the `var`/`function`
token gate never fires on `class outside {}`. `global-env-rec-eval` (2) likewise
fails identically before and after, on the strict rerun.

**#4309, for whoever trips over it next.** #4309 (PR #4341, based on #4339 —
neither in this base) fixes `directEvalRunsAtScriptGlobal`, whose stopping set
omitted the per-iteration declarative record of a `let`/`const` loop, so
unbraced `for (let i = 0; …) eval(s)` and the `for-in`/`for-of` forms mis-lower
to the INDIRECT entry. That mis-routing is invisible today and this slice is
what starts to make it visible. **A lexical-binding case that works BRACED and
fails UNBRACED is #4309, not a slice-B residual.** Related, and worth knowing
when reasoning about which seam entry a corpus test takes: the compile option
`inferModuleStrictArguments` — not the source shape — decides whether a bare
top-level `eval` lowers direct or indirect, and `false` (the Script goal every
`language/eval-code/` test compiles under) routes INDIRECT. Slice B routes both
global-caller paths through the same EDI, which is why the direct and indirect
halves of every cluster moved together.

### Consequences for the projection (§6)

§6 asked slice B to replace the stale ceiling with a measurement. It does:

- **The second-order discount is real but small and NAMED.** Slice B's own
  target list was ~110 files and it landed 86 — but 24 of those 86 came from
  slice C's clusters, so the target-list yield is ~62/110. The shortfall is not
  diffuse: **48 of it is one dependency** (#4245 slice 2's outward object view),
  measurable file-by-file, not a discount to be applied as a percentage.
- **779 remains reachable, and the path is now enumerated**: 48 (#4245 slice 2)
  + 16 (slice C) + 3 (slice D) + 4 pre-existing = 71. There is no unattributed
  remainder.
- **#4245 slice 2 is now on #4242's critical path**, ahead of slices C and D by
  file count. It was previously framed as optional for this issue.

### Artifact

**Unmoved, as required**: key `d8a5a91d6f183b87`, `libquickjs.wasm` sha256
`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b`.
`scripts/quickjs-artifact/` is untouched; the whole slice is adapter TS.

### Lane cases (`tests/quickjs-eval-membrane.test.ts`)

Nineteen readings shaped like the corpus, compiled Script-goal
(`inferModuleStrictArguments: false`), every eval source composed through a
runtime loop. They cover: the `fnGlobalObject` premise; EDI creation with the
B.3.3.3 `{w:t,e:t,c:t}` descriptor; an annexB block function `undefined` inside
the body and a function after; a FUNCTION crossing into a caller binding and
being CALLED; a non-enumerable compiled global visible inside the eval; "not
reinitialized" plus descriptor preservation; the SECOND and THIRD evaluations
after the new write-back path; the probe's zero-side-effects invariant (a
witness that reads 1, not 2); and the `eval`/`Function` markers still intact.

**Anti-vacuity, measured both ways:** on the pre-slice-B adapter this same module
fails **11 of 19** readings — `realm` reads 0, `fnWrite`/`fnCall` read 0,
`hidden` throws. It cannot pass with the slice reverted.

One detail worth keeping, because it cost time: the lane writes
`Function("return this;")` with **no `new` and no cast**. `(Function as any)(…)`
is a different lowering — the cast stops it being the recognised intrinsic call
site — and throws. The corpus takes the bare form, so the lane must too.

---

## Slice C — implementation record

Implementer: senior-dev, 2026-08-10. Branch `issue-4308-slice-cd`, stacked on
`issue-4245-membrane-slice2` at `1c721c8fa` (PR #4346) → slice B `2aa44ab21`
(PR #4343) → slice A `2c8b8f3fd` (PR #4340) → membrane slice 1 `e8e43ee86`
(PR #4335) → #4321 → #4319, per §7. Slices **C and D shipped together**: they
touch the same three functions of the adapter and splitting them would have
serialised one measurement behind the other for no benefit. This record covers
C; the next covers D; the measurement is shared and reported once, here.

### Measured result (tier-pinned, this tree)

`TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/'`, 816 files:

| run | pass / 816 |
| --- | --- |
| quickjs, pre-slice (base = `1c721c8fa`) | **758** |
| quickjs, post-slices-C+D | **783** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | **779** (unchanged) |

- **+25 with ZERO regressions and zero error-text changes**, diffed
  test-for-test over all 816 files, never by totals.
- The 758 baseline was re-measured on this tree before any edit and reproduced
  slice 2's number with **zero per-file disagreement**.
- The interpreter tier was re-run **after** the `src/` change (below) and is
  779 with **zero per-file movement** — the sentinel does not degrade it.

**The parity gap is 0.** Of the 34 remaining quickjs failures, **all 34 are
files the interpreter fails too**; there is no quickjs-only residual left in
this set. Going the other way, quickjs now passes **4 files the interpreter
does not**: `non-definable-global-{function,generator}` and
`var-env-{var,func}-init-local-new-delete` (all `direct`).

### Gains, by cluster (25)

| n | cluster | slice |
| --- | --- | --- |
| 8 | `annexB func:existing-fn-update` (direct) | C |
| 8 | `annexB func:no-skip-param` (direct) | C |
| 3 | `lang var-env-var-strict-{caller,caller-3,source}` | D |
| 2 | `lang lex-env-distinct-cls` (d+i) | D |
| 2 | `lang global-env-rec-eval` (d+i) | D |
| 2 | `lang var-env-{var,func}-init-local-new-delete` | C (unplanned) |

The last two were not on either target list; they fall out of the pre-seed.

### What shipped, and why each piece exists

**1. The user's source is HANDED to the realm's own `eval`, not spliced into
the wrapper.** `with (S) { eval(SRC) }` instead of `with (S) { SRC }`, with SRC
published to an adapter-private realm slot. This is the whole of slice C's
`existing-fn-update` cluster and most of slice D, and it is not a refactor:

- Splicing puts the source inside a **Block**, which demotes its TOP-LEVEL
  function declarations to annex-B BLOCK declarations bound lexically in that
  block. A later `f` in the source then resolves to the block binding instead of
  the varEnv one the corpus measures — measured "outer declaration" where
  "inner declaration" is right.
- The inner eval is a DIRECT eval whose LexicalEnvironment is the with-object,
  so EDI skips it when hunting for a conflicting binding (ObjectEnvironment
  Records are skipped by construction) and the annex-B extension applies.
- A `"use strict"` directive in the SOURCE becomes a directive again — which is
  slice D's `var-env-var-strict-source` for free.

Re-entrancy is safe by construction: every wrapper reads the slot as the first
thing it does, so a nested evaluation cannot overwrite a value an outer wrapper
has not consumed.

**2. Pre-seeding: an EDI-declared name the caller already binds is presented as
a realm global, not on S.** EDI step 15.d.iii does `SetMutableBinding(fn, fo)`
on the caller's VariableEnvironment; in this bridge that environment is the
QuickJS realm global, not S. A name on S therefore has the with-object SHADOW
the binding EDI just updated. Measured on `var-env-func-init-local-update`:
`eval('initial = f; function f(){ return 33; }')` under a caller `var f = 88`
read **88**. GDI leaves an EXISTING property alone (measured: a seeded 123
survives `var f;`), so the seed is what the body observes, EDI's update lands on
it, and `qjsPullSeededBindings` copies it into the caller's live cell.

**The pre-seed is NOT applied when the caller's realm already owns the same
name**, and that exclusion is load-bearing rather than an optimisation. The
realm slot is then spoken for by the true GLOBAL, and seeding an ACTIVATION
binding over it makes that binding visible at global scope for the duration of
the evaluation — which is exactly what `indirect/global-env-rec-eval` measures
(an eval that declares `var x` and then runs an INDIRECT eval reading `x` must
see the global's value). Without the exclusion this file was the single
remaining parity-gap file; with it the gap is zero.

`qjsRestoreSeededGlobals` hands the realm slot back to the caller's realm value
(or drops it) afterwards, so `qjsPullGlobals` can never copy a function-scoped
value onto a same-named compiled global.

**3. The two write-back paths widened from primitives to the published
crossings** (`qjsWriteBackCallerCells`, `qjsMirrorNewBindings`), exactly as
slice B widened the globals pull, with slice B's wrapper guard intact.
"Primitive-only" was always about RAW handles. This is what lets
`eval('function f(){}')` leave a callable `f` in a function caller's variable
environment instead of `f is not defined`.

**4. Pool exhaustion is accepted but no longer silent.** 64 slots per
activation (`activationState.length` is the compile-time constant 128, P4). A
name that had a value and no vacancy is dropped — never mis-slotted, never a
trap — and the drop is counted into `__js2wasm_eval_pool_overflow_count__` on
the realm, where a probe can read it back. That realm global is the only
diagnostic channel the frozen seam leaves open. Lane case: 70 declared names,
reads **6** dropped, and the next evaluation still works.

### The one `src/` line (authorized by the AMENDED §5 row)

`src/codegen/expressions/runtime-eval-provider.ts` emits one extra
activation-seed entry, `RUNTIME_EVAL_NON_GLOBAL_SENTINEL`, at every
FUNCTION-scoped direct-eval call site (`directEvalCallerIsFunctionScoped`, a
purely syntactic walk — no checker query, so no oracle involvement). The
adapter reads it as a routing signal and `qjsAppendBinding` drops it before the
snapshot.

It closes P4's measured hole: a declaration-free ARROW caller has no
`arguments` and no locals, so it arrives with all three layers empty —
byte-identical to global code inside a block, which reaches the same entry
because `directEvalRunsAtScriptGlobal` stops at Block. "Empty ⇒ global" put the
arrow's eval-created `var`s on the global object. **The corpus contains no such
caller, so this buys zero test262 files and is a correctness fix only** — which
is why it needed its own lane case (`arrowGlobalProbe`, which reads 0 without
the sentinel and 1 with it).

Owed gates, all run: `equivalence-gate` shards 1-4/4 (no new regressions;
12 baseline failures now PASS, not ratcheted here), `check:oracle-ratchet` OK
(+0 raw checker calls), `check:loc-budget` OK (+51 LOC), `check:func-budget` OK,
`tsc --noEmit` clean, prettier clean. **`check:godfiles` fails on this tree with
5 regressions — all in `calls.ts` / `index.ts` / `object-runtime.ts`, none of
which this branch touches. It is pre-existing drift on the stacked base, not
this PR's.**

### Artifact

**Unmoved, as required**: key `d8a5a91d6f183b87`, `libquickjs.wasm` sha256
`b0662069c241d0430d91c53a3b0e2d1281fd9eb78dd1c93490b0a9dfa70eec5b`.
`scripts/quickjs-artifact/` is untouched; both slices are adapter TS plus the
single `src/` line.

### The silent-no-op this slice paid for (the workstream's fifth)

The in-realm route captured `%eval%` at DIRECT-HELPER-INSTALL time. That is
lazy, and on the indirect path it now runs **after** the first
`qjsPushGlobals`. Once a module reads `eval` FIRST-CLASS,
`qjsIntrinsicEvalValue` installs the memoized marker ON the caller's realm
carrier and the next push mirrors that carrier — so the capture could take a
MEMBRANE WRAPPER of the compiled marker, and calling it re-entered
`__runtime_apply_interpreted` → `__runtime_indirect_eval` → itself until the
stack was gone. It surfaced as `RuntimeError: memory access out of bounds` on
four `global-env-rec*` files in the first full run. The capture now happens in
`qjsEnsureContext`, the one instant at which the realm is provably untouched.

This one was caught by the totals (four files went red), but the OTHER
regression in that same run was not: `var-env-func-init-local-update` flipped
pass→fail while the total still rose by 20. **Only the test-for-test diff
separated "+25/−5" from "+20".**

### Lane cases (`tests/quickjs-eval-membrane.test.ts`, `EDI_FUNC_SOURCE`)

Thirteen readings, corpus-shaped (Script goal, sloppy FUNCTION callers, every
source composed through a runtime loop). **Anti-vacuity, measured both ways:
against the pre-slice adapter 9 of the 13 readings are wrong** —
`fnUpdate 0` (the corpus's "outer declaration"), `noSkip 1`, `poolScoped 0`,
`strictSource 1`, `strictCaller/-Write/-Throw -1` (the `const` preamble's
`invalid redefinition of lexical identifier`), `lexCls -1`, `arrowGlobal 0`,
`poolOverflow 0`.

Two of those pairings are worth keeping, because each is a case that would
otherwise have passed while verifying nothing:

- `poolFnProbe` reads **85 on BOTH adapters**. Before the slice the eval-created
  function was simply LEFT on the QuickJS realm, where a later direct eval could
  still reach it. `poolScopedProbe` is the discriminating half: an INDIRECT eval
  is a global-scope evaluation and must NOT see a function-scoped binding.
- `arrowInnerProbe` also reads 7 on both. `arrowGlobalProbe` is the one that
  moves, and it is the only reading that exercises the `src/` line.

`tests/quickjs-eval-provider.test.ts` case 11 (strict caller) was **updated, not
deleted**: it pinned the slice-3 `const`-preamble residual ("assignment THROWS")
which slice D retires. It now asserts the assignment UPDATES the caller's
binding, and still distinguishes that from both the old TypeError (−2) and a
write that is accepted and silently lost (−3).

### Incidental finding — a caller-side codegen defect, not ours

**`for (var i = …)` in the same function as a direct eval emits an INVALID
module**: `CompileError: local.tee[0] expected type (ref null N), found
local.get of type i32`. `let` in the loop head is unaffected, and the order does
not matter (eval before or after the loop both fail — the second variant fails
on `extern.convert_any` instead). Engine-independent caller-side codegen, and
**reproduced with this branch's `src/` change reverted**, so it is neither slice
C's nor D's. It cost a lane rewrite (the pool-exhaustion case builds its 70
declarations at module level for this reason). Handed to the lead for triage; it
is a sibling of the #4305 / #4339 refusal-path family in shape but not the same
defect.

### Residuals slice C leaves

1. **A compiled-side read of an eval-created binding does not work at all** —
   `eval("var q = 5"); q` throws in the compiled caller. Measured identical on
   the pre-slice adapter, so it is pre-existing and NOT this slice's; it is why
   the pool lane case reads the binding through a second DIRECT eval instead.
   The pool round-trip itself is correct: the value is in the caller's
   activation pool and the next direct eval from that activation sees it.
2. **A name that is both a caller binding and a compiled global does not get
   EDI's update propagated to the realm** (only to S) — the deliberate price of
   the pre-seed exclusion above. Zero occurrences in this corpus.
3. **The 64-slot ceiling stands** (§1.5), now counted rather than silent.
4. A sloppy caller that BINDS the name `eval` falls back to the spliced wrapper,
   because `with (S)` would resolve the callee to the caller's shadow and the
   call would stop being an eval at all (measured: it returns the shadow's
   result). The strict arm cannot hit this — `eval` is reserved there.

---

## Slice D — implementation record

Same branch, same commit, same measurement as slice C above (the two shipped
together and share one before/after pair): **758 → 783 / 816**, interpreter
**779** unchanged, **0 regressions**. Slice D's own clusters are the 7 files
below.

### Gains, by cluster (7 of the 25)

| n | cluster | what unblocked it |
| --- | --- | --- |
| 3 | `lang var-env-var-strict-{caller,caller-3,source}` | the strict arm's in-realm eval |
| 2 | `lang lex-env-distinct-cls` (d+i) | the global/indirect arm's in-realm eval |
| 2 | `lang global-env-rec-eval` (d+i) | both of the above |

Slice D's done-signal was ≥750; the pair landed 783.

### What shipped

**1. The strict arm is a `let` preamble plus `try…finally` copy-out around an
IN-REALM direct eval** (§1.6′, but simpler than §1.6′ proposed):

```
"use strict"; undefined; { let x = S.x; try { eval(SRC) } finally { S.x = x; } }
```

- The `let` + copy-out retires the slice-3 residual: an assignment to an
  existing caller binding now UPDATES it instead of throwing
  `assignment to constant`, and the `finally` lands it **even when the body
  throws**, matching the sloppy arm's write-back. Measured: `x = x + 41` → 42;
  `y = 9; throw` → 9.
- **§1.6′'s collision probe turned out to be unnecessary and was not built.**
  Making the body a real strict eval gives it its OWN VariableEnvironment, so
  the source's `var x` no longer collides with the preamble's `let x` at all —
  there is nothing to detect. Measured: preamble `let x` + source `let x = 3`
  parses and answers 3, with the caller's `x` untouched. That is what fixes
  `var-env-var-strict-caller` (was `SyntaxError: invalid redefinition of
  lexical identifier`), and it is also why `var-env-var-strict-caller-3` came
  along for free: the strict eval's `var` never reaches the realm global, so
  nothing propagates to the compiled global either.
- The `undefined;` seeding guard is KEPT. Completion values re-measured through
  the new shape: `1+1`→2, `var y = 1`→undefined, `function g(){}`→undefined,
  `if(0);`→undefined, and a directive-only `'use strict'` source→`"use strict"`
  (which is correct — a Script's completion value is its last non-empty
  statement value).
- The write-back step is no longer skipped for a strict caller. What stays
  strict-only is the ABSENCE of `qjsMirrorNewBindings`: strict eval code creates
  no bindings in the caller's variable environment.

**2. §1.1′ is not needed on the direct path and was NOT implemented there.**
Source strictness was going to be answered by the parenthesised-`with` parse
probe and used to route. Handing the source to a real `eval` makes the engine
answer it natively — a `"use strict"` directive is a directive because it is in
directive position. §1.1′ survives where slice B put it, inside
`qjsProbeDeclaredNames`, where the probe's own `throw 0;` prefix destroys the
prologue and the question has to be asked separately.

**3. The global/indirect arm evaluates through the realm's own %eval% too.** A
Script's top-level `let`/`const`/`class` create GLOBAL LEXICAL bindings that
outlive the evaluation, so a second eval of the same source answered
`SyntaxError: redeclaration of 'outside'` — precisely what
`lex-env-distinct-cls` asserts must not happen (eval code gets a
NewDeclarativeEnvironment for its lexical declarations). Indirect eval keeps the
global VariableEnvironment, so `var` hoisting, slice B's top-level function
declaration ORDER gain and completion values are all unchanged — each
re-measured before this landed. `new Function`'s synthesized body (`edi ===
false`) stays on the direct route: it is a parenthesised function expression
with nothing to leak.

### Residuals slice D leaves

1. `undefined;` seeding is retained even though the in-realm form makes the
   block's completion always non-empty. It is one statement and it is the
   documented reason the strict arm answers correctly; removing it would be a
   change with no measurement behind it.
2. A strict eval's `var` is still evaluated at the realm's script level, so a
   strict source that does `var x = 1; globalThis.x` observes its own binding
   where a real engine would show the global's. Not in this corpus.
