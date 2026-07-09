# Fable sprint — dispatch sheet (window opens 2026-07-09)

**Owner:** Product Owner (po-fable-sprint) · **Prepared:** 2026-07-08 (on Opus;
Fable exhausted until the window opens tomorrow).

**What this is.** The lead's ready-to-dispatch sheet for the Fable budget
window. Every item below is a `model: fable`, `feasibility: hard` (bar one),
`sprint: current` issue — so the auto-sync (`scripts/sync-current-tasklist.mjs`)
lands them in the TaskList and the lead can spawn Fable seniors straight from
it, in the ROI order given here.

**Source of truth for root-causes / measured counts:**
[`plan/log/fable-window-worklist.md`](fable-window-worklist.md) (consolidated,
measured 2026-07-07). This sheet is the dispatch layer on top of it — it does
not re-derive; it verifies state against current `main` and orders by ROI.

---

## Verify-first results (against `origin/main` @ 39af81b4)

Several worklist items were marked `status: done`. Each verified before tagging
— **do not re-tag a genuinely-done issue into the window.**

| issue | claim | verified state | action |
| --- | --- | --- | --- |
| **#2939** any-closure arity dispatch | done (sprint 69) | Fix present in `src/codegen/closures.ts` + `expressions/calls.ts`. Genuinely landed. | **Not tagged** — done. The keystone gap it *left* is #3074 (see below). |
| **#2940** harness-wrapper vacuous | done (sprint 69) | Measurement/decision doc; closed as blocked-on-#2939. | **Not tagged** — done. Live keystone work = #3074/#2790. |
| **#2044** BigInt i64-brand ValType decision | done (2026-07-03) | Architect decision doc; "Evidence the design is landed and satisfies every stated constraint." | **Not tagged** — done. (Its `sprint: current` tag is stale-but-harmless; left as-is.) |
| **#3054** resizable-AB epic | done (2026-07-05) | **Genuinely closed** — B1/B2/B3/C/D+E all landed, **+17 floor passes**, harness shim + `new ArrayBuffer(n,{maxByteLength})` + `.resize()` all work. | **Not tagged** — done. **Remaining resizable scope is NOT lost** — it is the two banked follow-ups #3057/#3058 (see below). |
| **#3057** dynamic `$__ta_dyn_view` element codec | done | Landed (the banked D+E element-access follow-up). | **Not tagged** — done. |
| **#3058** resizable-TA proto-methods over dynamic view | was in-progress (no branch) | **This is the live resizable-AB remainder** — runtime-kind method dispatch on a dynamic view. | **TAGGED** — `model: fable`, `sprint: current`, P1, L. |

**Net:** the "~150-file resizable cluster still needs work" flagged in the
worklist resolves to **#3058** (proto-methods over a dynamic view) — already
filed, no new issue needed. #3054 itself is done and stays done.

---

## Keystone status — #3074 / PR #2790 is landing now

- **#2790** (`fix(#3074): dispatch any-typed HOF callbacks on the gc/host lane`)
  is **OPEN and CLEAN** but **not yet enqueued** (mergeQueueEntry null as of
  2026-07-08). It closes the #1 keystone: the ~1487-file TypedArray
  harness-wrapper vacuous cluster on the gc/host lane. **Enqueue it first** — it
  gates the two largest clusters on the board.
- **The keystone follow-ups #3087 / #3088 / #3089 are NOT lost.** Verify-first
  correction to the session premise: they were **not** dropped by the network
  outage — dev-keystone bundled the three issue files **into PR #2790's branch**
  (`issue-3074-gc-lane-harness-dispatch`). They will land on `main` *with*
  #2790. **They were therefore NOT recreated here** — recreating (fresh or
  reused ids) would collide in the `merge_group` dup-id gate against #2790.
  - **ACTION FOR THE LEAD (one step):** #3087/#3088/#3089 arrive with
    `sprint: Backlog` / no `model:` (dev-keystone's original frontmatter). To
    make them dispatchable, bump their frontmatter to the values in the table
    below — **either** ask dev-keystone to set it in #2790 *before* it enqueues,
    **or** apply it in a tiny follow-up edit once #2790 lands. Values are
    mechanical (see the ⚠ rows).

---

## ROI-ordered dispatch list (all `model: fable`)

Priority tag maps to frontmatter: **P1**=high, **P2**=medium, **P3**=low.
Horizon: **XL/L/M/S** from the issue's `horizon:` field.

### Wave 0 — enqueue first (server-side)
- **PR #2790** → enqueue (CLEAN). Lands the keystone (#3074) + the three
  follow-up issue files. Nothing to dispatch; this is a queue action.

### Wave 1 — the biggest rocks (P1, pull at window start when per-agent share is largest)

| # | one-line root cause | model | pri | horizon | notes |
| --- | --- | --- | --- | --- | --- |
| ⚠ **#3087** | dynamic `new TA(...)` on an `any`-typed ctor value fails on the gc/host lane ("No dependency provided for extern class"). Entry points: `src/runtime.ts:7702` extern-class resolver + `src/codegen/expressions/new-super.ts` `compileNewExpression`. **Dominant honest-fail after the keystone.** | fable | **P1** | L | **Lands via #2790.** Needs bump: `sprint: current`, `model: fable` (already P1/L/hard). |
| **#2773** | any/dynamic values have no uniform native representation → reconstructed dynamic reads return `NaN`/`null` when TS can't infer the concrete type. Closes the other half of the Array-HOF cluster + object-destructuring-param `NaN` residual. | fable | **P1** | XL | `[EPIC][ARCH]`. One of the two biggest rocks. |
| **#3058** | resizable-TA proto-methods over a dynamic `$__ta_dyn_view` receiver — runtime-kind method dispatch (materialize-into-f64-vec + OOB ValidateTypedArray + write-back). The live resizable-AB remainder after #3054. | fable | **P1** | L | Builds on the landed #3054/#3057 substrate. |
| **#2963** | methods/builtins have no stable first-class value identity (`__get_builtin` re-materialises a wrapper per access) → ~400-CE cluster; enables #3080 + class-method-identity (`c.m === C.prototype.m`, ~87 files). | fable | **P1** | L | Co-enabler with #3037 for identity. |
| **#3037** | standalone dynamic reads don't canonicalise object identity → `ref.eq`/`===` between two reads of one object is false. Foundation under the ~1,552-test #3027 keystone. | fable | **P1** | L | `depends_on: #2175` (in-progress; co-enabler). |
| **#2865** | standalone async generators / `for await` have no Wasm-native carrier — `asyncGen()` returns `null` / leaks `__…`. Closes the async-generator `forbidden-ext` cluster (~46 files); unblocks #2895/#2978. | fable | **P1** | XL | `depends_on: #2864, #2867` (async sub-slices, in-progress). Root of the async chain. |

### Wave 2 — Tier-1 language/semantics + async-chain dependents

| # | one-line root cause | model | pri | horizon | notes |
| --- | --- | --- | --- | --- | --- |
| **#3084** | RegExp `@@match`/`@@replace`/`@@split` eagerly coerces `lastIndex` (`Number(_hostToPrimitive)`, `src/runtime.ts` ~L7838-7847) during a protocol call, firing `valueOf` on a non-empty match — violates §22.2.6.8. | fable | **P1** | M | **Blocks #2777** (its sole "regression" is this bug's vacuity-unmask). Preserve `tests/issue-2671-regexp.test.ts:108`. |
| **#3049** | `Iterator.prototype` helpers (`map`/`filter`/`take`/…) → "X is not a function": the internal iterator-record must dispatch the user callback (a compiled closure) across the `externref` boundary — not wired. | fable | **P2** | L | Same closure-through-externref dispatch the keystone needs. |
| **#3050** | `Generator.prototype.throw()` resumed into `try/finally`/`try/catch` hits `unreachable` — the resume machine doesn't model try-region state. | fable | **P2** | M | Needs a try-region state-machine in the generator/async drive layer. |
| **#3076** | standalone destructuring doesn't invoke user getters / user `@@iterator` while binding a pattern (host mode does) → silent bind instead of throw; also exposes standalone `assert.throws` leniency (vacuity). | fable | **P2** | M | **Blocks #3040.** Vacuity de-vac strand = #3056. |
| **#3056** | standalone lane does not enforce NUMERIC equality asserts — no `assert_sameValue_num` routing → numeric-heavy standalone "passes" are vacuous. Recalibrates the standalone floor %. | fable | **P2** | M | `feasibility: medium` (harness-prelude routing — genuinely not "hard"; kept honest). Measurement-integrity. |
| **#2895** | a genuinely-pending `await` can't suspend the current frame (only single-tail-await fast path works) — true frame suspension (AG1 / PATH B). | fable | **P2** | XL | **`depends_on: #2865`** — dispatch *after* #2865's carrier lands. |
| **#2978** | standalone `for await` over a sync iterator yielding a **rejected** promise loops forever (3GB OOM) — no bounded sync fix; needs frame suspension + `$Promise` widen. | fable | **P2** | L | **Gated on #2895 + #2865** — dispatch last in the async chain. |
| **#3080** | private-method value identity: `this.#m === (()=>this)().#m` false for class *declarations* (fresh non-canonical wrapper per access). | fable | **P3** | M | **Folds into #2963 / #3037** — not a bespoke wrapper-dedup. Don't re-chase `.name` (resolved on main). |
| ⚠ **#3088** | non-BigInt `testWithTypedArrayConstructors` shim passes 1 arg but the real harness passes 2 (ctor + boundArgFactory) → 2-param callbacks stay vacuous via the #1837 over-arity-void skip. | fable | **P2** | S | **Lands via #2790.** Needs bump: `sprint: current`, `model: fable`, `feasibility: hard` (currently medium). Tail filler. |
| ⚠ **#3089** | BigInt TypedArray tests fail to compile — "Binary emit error: RangeError: offset is out of bounds" (i64 codegen, ~22/30 sampled, pre-existing). | fable | **P2** | M | **Lands via #2790.** Needs bump: `sprint: current`, `model: fable` (already hard). |

---

## Dependency / sequencing notes for the lead

- **Async chain** must go in order: **#2865 (root) → #2895 → #2978.** #2865
  itself has open sub-slices #2864/#2867 (in-progress) — the assigned senior
  finishes those first within the same lane. #2895 and #2978 carry accurate
  `depends_on` and are priced P2 so natural priority-pull sequences them; do
  **not** dispatch #2895/#2978 before #2865's carrier lands.
- **Identity cluster:** #2963 + #3037 are co-enablers; #3080 folds into them
  (dispatch #3080 last / bundle it). #3037 `depends_on #2175` (in-progress).
- **Keystone chain:** enqueue #2790 → it lands #3074 + #3087/#3088/#3089. #3087
  is the dominant honest-fail *after* the keystone (dispatch it first in Wave 1
  once its frontmatter is bumped). #3049 reuses the same closure-through-externref
  dispatch — expect shared code with the keystone.
- **RegExp:** #3084 unblocks #2777 (open PR, `fix(#3051)`). Land #3084 first, then
  re-validate #2777.
- **Resizable:** #3058 is the only remaining resizable rock; #3054/#3057 are done.

## Status-field policy applied here

- Flipped stale `in-progress` → `ready` on #2773/#2963/#3037/#2865/#2895/#3058
  (no live branch existed for any of them — the `in-progress` was orphaned).
  Stale `assignee:` fields removed on those (fresh re-dispatch).
- `depends_on` fields kept accurate (they encode the sequence above); the ROI
  ordering + priority tags carry the dispatch order, and the lead dispatches
  these hard rocks from this sheet, so premature auto-pull is not the governing
  risk.
- All items are `model: fable`. One deliberate deviation from the blanket
  `feasibility: hard`: **#3056 kept `medium`** — it is harness-prelude routing,
  genuinely medium; forcing `hard` would misrepresent it. It stays fable-routed
  because it needs the window's attention (standalone-floor recalibration).
