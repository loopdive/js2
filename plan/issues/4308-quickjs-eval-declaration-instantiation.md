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
| unmeasured, expected 0 | direct eval whose caller is an **arrow with no parameters and no declarations** — indistinguishable from global code at the seam (P4), so its `var`s land on the global object | one line of `src/` codegen fixes it (sentinel seed entry per non-global call site); §2 forbids `src/` edits, and the corpus uses `function` wrappers throughout. Lane case, not engineering. |
| unmeasured | in-eval `instanceof` against a *mirrored* compiled constructor; sources >64 var names per activation | corpus shows zero occurrences; document, don't engineer |
| unmeasured, expected small | sources that are **SyntaxErrors as eval code** and whose strictness therefore falls back to `callerStrict` (§1.1′ INCONCLUSIVE) | the real evaluation throws SyntaxError regardless, so strictness is unobservable |

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
