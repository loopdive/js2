---
id: 3945
title: "Standalone: a REST element in a generator's binding-pattern param bails the native lowering — the rest local's type is minted by the emit site, so the plan phase cannot predict it"
status: done
completed: 2026-07-31
sprint: 78
created: 2026-07-31
updated: 2026-08-18
priority: high
horizon: m
complexity: M
feasibility: hard
task_type: bugfix
area: codegen
language_feature: generators, destructuring, rest-parameters
es_edition: multi
goal: standalone-mode
umbrella: 3178
assignee: ttraenkler/senior-dev-rest
related: [3178, 3386, 3893, 3896, 3620, 2938, 2920, 3315]
loc-budget-allow:
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
origin: "2026-07-31: found while sizing #3896. A rest inside the binding pattern makes a class generator method leak with or without a whole-param default, public or private — orthogonal to #3896's name-kind bail and to #3893's fn-expr default bail. The most cross-cutting of the four mechanisms in the #3178 leak class."
---

# #3945 — rest-in-binding-pattern generators leak the host generator machinery

## The bail was a deliberate deferral, and its stated reason was correct

`buildNativeGeneratorPlan`, `src/codegen/generators-native.ts`:

```ts
walk(pat);
if (hasRest) return null;
```

The comment above it named the obstacle exactly: the rest local's type "is
minted inside the destructure helpers, not via `resolveBindingElementType`, so
the spill typing is not yet reconciled." That is right, and it is why this slice
is a typing change rather than a predicate relaxation — the two prior slices in
this family (#3893, #3896) were one-line gate relaxations where the machinery
already existed.

## Root cause — the plan phase cannot predict the rest local's type, and must not try

Every OTHER pattern-bound name is safely predictable. `ensureBindingLocals`
allocates its factory local from `resolveBindingElementType`, and the emit site
does **not** re-type it (`destructuring-params.ts`, `if
(!fctx.localMap.has(name))`). So the checker rule is faithful, which is why the
existing loop uses it.

A **rest** local is the one exception. The destructure helpers MINT its type from
whichever lane they took, and then **reallocate over** `ensureBindingLocals`'
guess when the two disagree (`destructuring-params.ts`, the #971 realloc):

| emit-site param lowering    | rest local type the destructure produces      |
| --------------------------- | --------------------------------------------- |
| externref param (the common standalone / defaulted case) | `ref_null $__vec_externref` (`convertedType` in `destructureParamArray`) |
| typed vec param             | `ref_null $__vec_f64`                         |
| object rest                 | `externref` (a fresh rest `$Object`)          |

Which row applies is a property of the **emit site's resolved param type** — not
of the AST and not of the checker. So `resolveBindingElementType` predicts it
wrongly, and here a wrong prediction is an **illegal cast / invalid module**, not
a graceful fallback (`coerceType` between two different struct types is exactly
where that failure lives).

Two structural facts close off the obvious alternatives:

- **Prediction from emit-site param types is unavailable.**
  `isNativeGeneratorCandidate` calls `buildNativeGeneratorPlan(ctx, decl)` with
  no param types and **must agree** with the `analyzeNativeGenerator` call, or
  the emit bakes an undefined funcidx. This is the #2938 lockstep constraint.
- **Reading the realized factory local back is order-dependent.** A `.next()`
  call site emits the resume function (`generators-native-consumer.ts`, 8 call
  sites) — and with it the 3984-4008 spill reconcile — which can happen *before*
  the generator's own emit site destructures, whenever the consuming method
  precedes the generator in the class body.

## The fix — spill a rest binding at the WASM-BOUNDARY representation

A rest binding spills at **`externref`**, which is reachable from every realized
lane: `compileNativeGeneratorFunction` already coerces the factory local into the
spill type, and `extern.convert_any` reaches externref from any vec/struct ref,
in any lane, in any order. It is AST-only, so the candidate gate and the
registration cannot diverge.

This is the same lesson as the **#3620** note a few hundred lines below on the
`param_*` fields: a binding-pattern parameter's state field must be typed at the
boundary representation, not at the checker's inferred type. That precedent was
already paid for on the adjacent field.

**Measured prerequisite** (this was the discriminating question, checked before
writing the fix): an externref local holding a converted vec reads correctly in
the standalone lane — `.length` → 3 and `[1]` → 20 on a host-free module. Had it
not, externref spill would have been value-wrong and the slice blocked on
something much larger than this file.

### What this costs, and why it is NOT the general rule

The boundary rep is a deliberate trade, not a free win: the resume body now
reads `r` through the dynamic `__extern_get` path instead of `struct.get` on a
typed vec, which is strictly slower for `r.length` / `r[i]`. That is the price
of lane-independence, and it is worth paying only because the alternative was
leaking the host generator machinery outright.

**Do not generalise it to pattern bindings at large.** Every non-rest element
keeps the checker rule precisely because the checker rule is faithful for them.
A future slice could recover the typed-vec path for rest bindings too, but only
if it ALSO solves the candidate-gate agreement problem — `isNativeGeneratorCandidate`
must reach the same verdict as `analyzeNativeGenerator` without seeing emit-site
param types, or the emit bakes an undefined funcidx. That constraint, not the
representation, is what makes this the exception.

### The second half of the fix — `walk` had to descend

The pre-fix `walk` `continue`d on a rest element **without descending**. Lifting
the bail alone would therefore leave the rest name — and *every* name bound under
a nested rest pattern (`[...[a, b]]`, `[...{length}]`) — with **no spill field**:
the resume function never rehydrates it and reads the local's inert default.

**That module has zero host imports and validates.** It passes the import-set
gate and no-import instantiation, which are otherwise the correct instruments for
this question. It is caught only by asserting a VALUE. Names bound under a nested
rest keep the ordinary checker rule (the emit site allocates them through
`ensureBindingLocals`); only the identifier rest itself takes the boundary rule.

## Verification — attributed by kill-switch, valued, and shape-complete

Instrument note: `runTest262File(..., "standalone")` **supplies** the host
imports, so a leaking module still scores `pass` (see `docs/methodology.md`).
Every measurement below is (a) the import set of a bare standalone compile and
(b) instantiation with **no import object**, plus (c) a value assertion.

Probe set derived from the **population's filenames** — the distinct
`*-ptrn-rest-*` suffixes of `test/language/**/dstr/gen-meth-*-ptrn-rest-*.js` —
not from imagined shapes.

**Kill-switch A/B** (restore `let hasRest` + `if (hasRest) return null`):

| arm                       |     result |
| ------------------------- | ---------: |
| bail restored (kill-switch) | **2 / 20** clean + value-correct |
| fix applied                 | **20 / 20** |

The 18 that flip fail under the kill-switch with `Import #0 "env": module is not
an object or function` — except the `function*` declaration case, which fails
earlier as a hard `"sequential numeric yields"` compile error (that hard error is
the `compile_error` status this population carries in the baseline).

Covered, one representative per bucket family, all clean + value-correct:

- **array rest** — `id`, `id-direct`, `id-elision`, `id-exhausted`
- **nested under rest** — `ary-elem`, `ary-elision`, `ary-empty`, `ary-rest`,
  `obj-id`, `obj-prop-id`
- **object rest** — `val-obj`, `getter`, `skip-non-enumerable`
- **error paths** — `id-iter-step-err`, `id-elision-next-err`, `id-iter-val-err`
  (each asserts the abrupt completion surfaces at **CALL** time per §10.2.11 and
  that the generator body never ran)
- **declaration forms** — class instance, class static, `function*` declaration,
  object-literal method, and whole-param-default + rest
- **round-trip** — array and object rest each read **after a suspension**
- **CONTROLS** — no-rest patterns unaffected; the six NEGATIVE shapes
  (`init-*`, `not-final-*`, early SyntaxErrors in the corpus) stay rejected, so
  admitting rest did not widen the accepted grammar

`tests/issue-3945.test.ts` (24 cases) pins all of the above and documents the
kill-switch procedure.

## Sizing — state it with the caveat

**363 rows name a rest binding; 333 (91.7 %) are host-`pass`** — the highest
known-achievable ratio in the current harvest. It spans every declaration form:
class public 152 · class private 120 · objlit 40 · fn-expr/decl 36 · async-gen 7
· other 8.

**All 363 are `compile_error` today, so the prize is host-free INSTANTIATION,
not passes.** Do not quote 363 or 333 as a pass delta.

The **120 class-private** rows need **both** this fix and #3896's name-kind fix:
#3896 gets them past `isNativeGeneratorCandidate`, this gets them past the plan
builder. #3896 landed on `main` while this branch was in flight, so the overlap
is no longer an inference — **measured on the merged tree**, `*#p([...x])`,
`*#p({a, ...rest})`, `*#p([...x] = [1,2,3])` and `static *#p([...[a, b]])` are
all host-free and value-correct, and are pinned in `tests/issue-3945.test.ts`.
That is what lets #3896 state a real yield instead of "≤252, reduced by
overlap." The two fixes are still independent to *merge* — they touch different
regions ~600 lines apart and merged without conflict; only their counting
interacts.

The 7 async-gen rows are **not** claimed: async methods are excluded before the
candidate call (`!isAsyncMethod`) and never reach this code.

## Notes for the next slice

- **HOST-FREE INSTANTIATION IS NECESSARY BUT NOT SUFFICIENT FOR THIS FAMILY —
  ASSERT VALUES.** This is the most transferable result here and it invalidates
  the acceptance criterion the whole #3178 leak class has been using. Lifting
  the bail without also making `walk` descend yields a module with **zero host
  imports** that **validates** and **instantiates with no import object** — and
  silently reads the inert default for the rest binding and every name under a
  nested rest. The import-set gate greens it. Only a value assertion catches it.
  The next slice in this family — the unowned objlit parameter-default cluster
  (~102 rows, recorded on #3896) — will be picked up under exactly the criterion
  that misses this. See also `reference_valid_wasm_is_not_correct_verify_by_value`.
- **The broken allocator caused TWO id collisions on this branch, which is
  stronger evidence for #3880 / #3636 than anything filed today** (do not edit
  #3901 / #3904 — cross-referenced here instead).
  `scripts/claim-issue.mjs` could not write the claim ref at all — its git
  subprocess exits 1 with empty stdout/stderr (`writeMode`, line 676); both
  `--allocate` and a direct claim failed identically. The id was therefore
  hand-allocated against `origin/main` ∪ open-PR-added issue files ∪
  `origin/issue-assignments`, and `check:issue-ids:against-main` passed
  **locally**. Another lane hand-allocated the *same* id concurrently, landed
  first, and the collision surfaced only in CI's `quality` lane
  (`--check FAILED: 1 duplicate IDs`, against
  `3916-array-from-nonvec-source-map-closure-illegal-cast.md`). This issue was
  renumbered 3916 → 3925 as the loser — **and then collided a SECOND time**,
  with open PR #3910's `3925-linear-quadratic-intra-call-string-alloc.md`,
  caught by `check:issue-ids:against-open-prs`. Final id: **3945**.
- **The gaps are deliberate, and the second collision is why.** At the first
  renumber, max across all three sources was 3921 — so every lane
  hand-allocating "max + 1" while #3880 is down converges on 3922, the single
  most collision-prone id on the board. I took 3925 for headroom; the band
  moved past it anyway. Measured burn rate: main 3916 → 3927 and open-PR ids
  3921 → 3929 **within one hour**. With the atomic reservation path
  unavailable, a ~15-id gap (max 3930 → 3945) is the only thing that survives
  that rate. **This reasoning exists solely because `--allocate` is down.**
  Restore it and hand-allocation — with both its gaps and its collisions —
  goes away. Cross-ref #3880, #3636; fixes in flight #3901, #3904.
- The `object/*` parameter-default asymmetry recorded on #3896 (an
  identifier-named object-literal generator method leaks on a **parameter
  default** while the identical class method does not) is still unowned and is
  NOT this fix — verified here that object-literal rest methods route native.
