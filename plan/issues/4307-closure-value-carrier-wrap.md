---
id: 4307
title: "Closure VALUES are not carrier-wrapped for the eval seam — `var f = function(){}` crosses as a non-callable membrane wrapper"
status: done
assignee: ttraenkler/opus-senior
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: m
feasibility: hard
model: opus
reasoning_effort: max
task_type: fix
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4197, 4238, 4245, 4305]
blocked_by: [4245]
loc-budget-allow:
  # The carrier front-guard has to sit AT the three closure-typed cast sites in
  # `compileClosureCall`; that function is what turns a cell/global value into a
  # `(ref $selfCarrier)`, and there is no seam between it and the cast to hoist
  # the guard into. All 30 lines of actual logic live in the subsystem module
  # (`runtime-eval-callable.ts`); what lands here is one import plus three
  # one-line `emitRuntimeEvalCarrierUnwrapAny(ctx, fctx)` calls and the comment
  # that explains why (+7).
  - src/codegen/expressions/calls-closures.ts
  # The AOT-side unwrap reads one new optional field on the carrier record,
  # and that record type is declared here — there is no subsystem module to
  # move a type declaration into (+2).
  - src/codegen/context/types.ts
# id 4307 reserved + claimed for this lane before work started. `gh` is NOT
# available in this container, so the open-PR half of the collision scan was
# DEGRADED (pr_scan=degraded): the id was verified against upstream `main`
# (no matching file under plan/issues/ for id 4307) and against the assignment ref —
#   `node scripts/claim-issue.mjs 4307 --check` →
#   "#4307 is CLAIMED by ttraenkler/opus-senior (since 2026-08-09T19:45:42Z)"
#   "(read origin/issue-assignments)" (exit 3, i.e. claimed by THIS lane).
# The required `check:issue-ids:against-main` gate in `quality` is the backstop
# that actually arbitrates an id introduced by a concurrently-open PR.
---

# #4307 — closure VALUES are not carrier-wrapped for the eval seam

## The defect

#4245 slice 1 made a compiled **top-level function DECLARATION** reachable and
callable from evaluated code, and that single mechanism cleared the 230-file
`assert` / `fnGlobalObject` bucket (`language/eval-code/` 442 → 560 / 816). It
works because `__module_init` seeds the declaration's module global with the
#2928 **AOT-callable carrier** (`declarations.ts` →
`emitRuntimeEvalAotCallableAdapter`), and the carrier is a structurally shared
type both modules agree on, whose `code` field routes an invocation back into
caller code through `__apply_closure`.

A closure **VALUE** is not a declaration and never met that adapter:

| shape | before |
| --- | --- |
| `var f = function (x) {…}` in a caller's local scope, reached by DIRECT eval | `typeof f` → `"object"`, `f(…)` → TypeError inside evaluated code |
| `var f = function (x) {…}` at SCRIPT scope, reached by indirect **or** direct eval | same |
| a closure read off a plain compiled object (`bag.m`) | same |

The value crossed as a raw module-local closure struct. The membrane's outbound
converter classifies callability with the ADAPTER's own closure classifier
(`typeof value === "function"` in `qjsWrapOutbound`), and a caller's closure
wrapper hierarchy is module-local by construction — "a separately compiled
provider cannot reliably classify every typed AOT closure", which is the exact
sentence that motivated the carrier in the first place. So the value got the
non-callable wrapper class and a call was a loud QuickJS TypeError.

## Root cause, named

Three caller-side sites hand a value to the provider; only one of them wrapped.

1. `emitRuntimeEvalGlobalBindingPushBody` (`src/codegen/expressions/runtime-eval-provider.ts`)
   applies `emitRuntimeEvalAotCallableAdapter` **only** in the
   `ctx.topLevelFunctionNames` arm. A script-scope `var` holding a function
   expression is an ordinary module global and takes the `else` arm, which
   pushes `global.get` raw.
2. `emitStandaloneDirectEvalRuntime`'s `bindingPushInstrs` pushes the
   direct-eval binding CELLS untouched. `reifyCurrentDirectEvalBindings`
   (`direct-eval-environment.ts`) boxes each binding with `boxTopAsExternref`,
   which is a plain `coerceType` to `externref` — for a closure that is
   `extern.convert_any` of the module-local struct, i.e. the raw closure.
3. A closure read off a plain compiled object — **not caller-side fixable, see
   "Deliberately out of scope" below.**

## The fix

One new caller-owned helper plus its inverse, and three wiring points.

| file | why |
| --- | --- |
| `src/codegen/runtime-eval-callable.ts` | `__runtime_eval_wrap_callable(externref) → externref` (mint/return the canonical carrier iff the value is a raw closure), its one-entry identity memo, and `emitRuntimeEvalCarrierUnwrapAny` — the AOT-side inverse |
| `src/codegen/expressions/runtime-eval-provider.ts` | call the wrap helper at the two crossing sites: the direct-eval cells (in place) and the script-scope-`var` globals push (write-back) |
| `src/codegen/expressions/calls-closures.ts` | carrier front-guard at the three closure-typed cast sites of `compileClosureCall`, so the compiled side keeps calling a binding that now holds a carrier |
| `src/codegen/context/types.ts` | one optional field on the carrier record (`wrapHelperFuncIdx`) |
| `tests/issue-4307-closure-carrier-wrap.test.ts` | new self-gating lane, 9 cases |
| `tests/quickjs-eval-membrane.test.ts` | retires #4245's pinned residual case (`12` → `1042`) |

### Why a HELPER FUNCTION and not an inline ladder

The set of closure base-wrapper types is not final until every closure in the
module has been emitted. An inline `ref.test` ladder built while compiling an
expression tests a PARTIAL hierarchy and silently misses exactly the closures
declared after it. The helper's body is rebuilt by
`refreshRuntimeEvalCallableTrampolines` at finalize time — the same discipline
the carrier trampolines already use — so the ladder is complete.

### Why the cell is mutated IN PLACE

The cell IS the interpreter's write-back target. Wrapping a copy would silently
drop every assignment made inside the evaluated source. In-place also makes the
wrap idempotent for free: a second crossing sees a value that is already a
carrier, the classifier's carrier arm is skipped, and the identical reference is
returned — which is what keeps `f === f` true across two separate evaluations.

### Why there is a one-entry memo

Idempotence is not enough for `var g = f`. Two cells hold the same closure and
each would mint its own carrier, so `f === g` inside evaluated code would read
**false** where it reads true today — a regression, not a leftover gap. Aliases
are wrapped back to back in the same push loop against the same target, so a
one-entry most-recent-target memo covers it; and because a cell that holds a
carrier is never re-wrapped, the memo cannot thrash across evaluations either.
It is a cache, not a registry: a program that interleaves N distinct closures
within one crossing keeps only the last, and a miss simply mints a fresh
carrier, which is today's behaviour. Measured: `identityProbe` 11 both before
and after.

### Why the AOT side needs an unwrap

This is the part that turned the change from "wrap at two sites" into real
codegen. Once a binding holds a carrier, three AOT paths must still work:

- `typeof f` — **already fine**, `collectClosureBaseWrapperTypeIdxs` includes
  the carrier (#2928).
- `f` passed as an argument and called dynamically — **already fine**,
  `__call_fn_method_N`'s #4197 front-guard.
- `f(1)` and `f.call(…)` called directly on the binding — **broken**, and it
  broke as a **trap**, not a wrong answer. `compileClosureCall` reaches the
  callee by guard-casting the cell/global value to the lifted self-carrier
  struct; a carrier fails that cast, the cast yields null, and the call traps
  "dereferencing a null pointer".

`emitRuntimeEvalCarrierUnwrapAny` replaces a carrier with its `target` field —
the very closure the carrier was minted around — so the fast path is restored
with no dispatch, no argument vector and no `__current_this` bookkeeping. It
emits nothing in a module that never minted a carrier.

## Measured

Container: this worktree, artifact key `d8a5a91d6f183b87`
(sha256 `b0662069c241…`), adapter key `75adce1e4526170a`, engine
`JS2WASM_EVAL_ENGINE=quickjs`.

### Probe, per shape (each shape its own module, so one trap cannot mask another)

| case | before | after |
| --- | --- | --- |
| local `var f = function(){}` — `typeof` inside direct eval | `"object"` | **`"function"`** |
| local `var f = function(){}` — `f(20)` inside direct eval | TypeError | **41** (`x*2+1`, compiled body) |
| a function CREATED by eval calls the caller's local closure | TypeError | **21** |
| script-scope `var fn = function(){}` — `(0,eval)("fn(1)")` | TypeError | **42** |
| script-scope `var fn = function(){}` — direct eval from a sloppy fn | TypeError | **42** |
| top-level function DECLARATION (control, #4245) | 42 | 42 |
| script-scope `let` + arrow (control, already worked) | 42 | 42 |
| AOT `f(1)` after the binding crossed | 42 | **42** (traps without the unwrap) |
| AOT `f(1)` with a TYPED closure binding | 42 | **42** |
| `f === g` (two names, one closure) across two evaluations | 11 | **11** |
| non-closure bindings (object / number / string) | 9 | 9 |

### Poisoning check — the path is live, not dead code

`callableWrapHelperBody` was reduced to `return [{ op: "local.get", index: 0 }]`
behind an env flag, leaving **every** call site, the memo global, the AOT
unwrap and all wiring intact. Every fixed case reverted to its exact pre-fix
reading (`typeof` → `"object"`, calls → TypeError, `gVar`/`gVarDirect` → -1),
and the non-regression cases stayed green. A green run with the change doing
nothing is therefore impossible.

### Default path — byte-identical

126 binaries (13 playground examples + `tests/fixtures` + `examples/`, each
compiled in **default**, **standalone** and **wasi** mode) hashed with the
change applied and again with all four `src/` files restored to `HEAD`:
`diff` reports **no difference**. The wrap helper, its memo global and the
unwrap all key off `ctx.runtimeEvalAotCallableCarrier`, which no module mints
unless it consumes the runtime-eval provider.

### Suites

| suite | result |
| --- | --- |
| `tests/issue-4307-closure-carrier-wrap.test.ts` (new) + `quickjs-eval-membrane` + `quickjs-eval-provider`, `JS2WASM_EVAL_ENGINE=quickjs` | 55 passed |
| default-path proof set (`issue-2928-refusal-provider`, `issue-2960`, `issue-2928-e6-provider-cache`, `issue-1102`, `issue-4162`, `issue-2657-raw-wasi-fd-import`), no env | 71 passed, 3 skipped |
| `tsc --noEmit`, lint, `format:check` | clean |
| `check:oracle-ratchet` | OK — `getTypeAtLocation +0`, `ctx.checker +0` across 4 changed codegen files (no raw-checker query was needed; the wrap is a wasm-lowering question answered by the closure classifier) |
| `check:func-budget` | OK (the cell-wrap sequence was extracted to `directEvalCellWrapInstrs` rather than taking a grant) |
| `check:loc-budget` | needs the `calls-closures.ts` grant above (+7) |

## Deliberately OUT of scope, with the evidence

**A closure read off a plain compiled object (`bag.m`) is NOT fixable
caller-side.** The task named it as a second site, so it was measured rather
than assumed. `__membrane_get` does `target[key]` **in the adapter's own
compiled code**, and the adapter answers plain-object reads by walking the
caller's structurally-canonical object vector directly. Two probes pin that:

- an ACCESSOR on a compiled object (`get g() { side += 1; return 5 }`) read from
  evaluated code returns **0** and `side` stays **0** — the caller's getter
  never ran;
- a PROTOTYPE method on a class instance reads as **`undefined`** from evaluated
  code — the caller's prototype chain is never consulted.

So no caller-side codegen sits on that path at all; the caller's `__extern_get`
is not invoked. Making it work requires the membrane to route object property
reads back to the owning module (an object-side counterpart of the callable
carrier), which is #4245 slice-2 territory, not a caller-side wrap. Filed as a
residual below rather than half-done here.

## Residuals

1. **`bag.m` — a closure held by a plain compiled object** still crosses
   non-callable (above). Needs `__membrane_get` to delegate to the owning
   module, i.e. an object carrier.
2. **The identity memo holds ONE entry.** N distinct closures wrapped inside a
   single crossing keep only the last, so a pathological alias pair separated by
   another closure in the same push loop can still mint two carriers. Every
   measured pattern hits the memo; a registry keyed by reference identity would
   close it completely.
3. **A typed closure-struct module global is not wrapped** — the write-back
   would not typecheck. Only `externref`-typed globals participate; their AOT
   reads are dynamic, which is why the carrier is safe there.
4. **`eval("f = function(){…}")` write-back still does not take effect** for the
   compiled side (`f()` keeps returning the old body). Measured at **1** both
   before and after this change — a PRE-EXISTING gap in the provider's
   non-primitive write-back, not something this fix touched or worsened.
5. **#4305** (a succeeding direct eval followed by a throwing one with an
   `instanceof` catch → `RuntimeError: illegal cast`) was **not** hit while
   working on this issue and is **not** fixed by it — nothing here touches the
   exception-tag bridge or the catch-clause lowering.

## Scoped test262 — `language/eval-code/`

Same scoped set, same container, same commands as #4245 slice 1:

```
TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/' \
  JS2WASM_EVAL_ENGINE=quickjs        bash scripts/run-test262-vitest.sh
TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/' \
  TEST262_FULL_RUNTIME_EVAL=1        bash scripts/run-test262-vitest.sh
```

| tier | #4245 slice 1 | **this change** | delta |
| --- | --- | --- | --- |
| quickjs | 560 / 816 | **560 / 816** | **0** |
| interpreter (`TEST262_FULL_RUNTIME_EVAL=1`) | 779 / 816 | **779 / 816** | **0** |

Per sub-corpus, quickjs — identical to slice 1 in **all four** buckets, so the
zero is a genuine no-change and not a `+N/−N` that happens to cancel:

| sub-corpus | slice 1 | this change |
| --- | --- | --- |
| `language/eval-code/direct` | 260 / 286 | 260 / 286 |
| `language/eval-code/indirect` | 48 / 61 | 48 / 61 |
| `annexB/…/eval-code/direct` | 155 / 309 | 155 / 309 |
| `annexB/…/eval-code/indirect` | 97 / 160 | 97 / 160 |

Interpreter tier, per sub-corpus: 271/286, 56/61, 300/309, 152/160 — the exact
slice-1 split. The interpreter tier is **untouched**, which matters because
this change is engine-independent caller-side codegen and therefore reaches
that tier too.

**Read this honestly: the fix moves ZERO tests in this corpus.** The probes
prove the behaviour genuinely changed (TypeError → a working call, `"object"` →
`"function"`); no test in these 816 depends on it. The 230-file harness bucket
that made slice 1 worth +118 was `assert`/`fnGlobalObject`, i.e. top-level
function DECLARATIONS, which slice 1 already fixed; what remains here is
EvalDeclarationInstantiation (#4238's bucket 2) and annexB value/ordering.
The value of this change is a correctness hole closed and a trap removed, not
a conformance delta — and it is stated that way rather than extrapolated to
some other corpus that was not run.

Caveat on precision: `loopdive/main` was merged into the branch after the
quickjs run started. The runner builds its compiler bundle up front, so that
run measured the pre-merge tree (this change + its #4245/#4238 predecessors);
the interpreter run measured the post-merge tree. Both landed on their
respective slice-1 baselines.
