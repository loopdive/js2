---
id: 3283
title: "standalone dstr runtime-semantics — Opus-now unblocked slices (lazy-defaults, obj-rest ToPrimitive, abrupt-step errors, gen brand-check)"
status: wont-fix
resolution: "superseded by intervening substrate — slices 1&4 already resolved on main (#3223 obj-rest, lazy-default fix); residuals belong to #3132/#3164/#3032/#3086. No code fix warranted (verified 2026-07-14)."
sprint: 75
created: 2026-07-14
completed: 2026-07-14
priority: high
feasibility: medium
model: opus
horizon: l
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: destructuring, generators
goal: standalone-mode
subtask_of: 2040
related: [2602, 3132, 3164, 3086]
---

# #3283 — the Opus-executable unblocked slices carved out of #2040

Carved 2026-07-14 from #2040's 2026-07-12 re-ground plan so the standalone dstr
cluster can progress under Opus without waiting for fable. #2040 stays the
fable-gated parent for its A1 headline (the ~382 `assert.notSameValue(x,values)`
rest-identity rows), which is **explicitly BLOCKED on the #2580 M2 / #3032 / #3053
tag-5 substrate track — NOT staffable here** (two shelved landings + a −162 eject;
do not re-litigate the classifier). This issue owns ONLY the four independent,
grounded, non-substrate slices below.

Source of truth for the specs: the "RE-GROUND + RESTAFFING PLAN (architect,
2026-07-12)" section of `plan/issues/2040-standalone-generator-dstr-runtime-semantics.md`.
Read that section first. All four slices are independent per that plan; slices
1/2/3 all touch `src/codegen/destructuring-params.ts` so they are worked SERIALLY
here (stacked PRs), one per slice. Acceptance is per-slice + dstr standalone fail
count trending toward ≤1,800.

## Slice 1 (START HERE, ~198 rows): lazy default evaluation
`§8.6.2 IteratorBindingInitialization`, SingleNameBinding step 5: the Initializer
is evaluated ONLY when the bound value is `undefined`/iterator-done. Standalone
evaluates it (or bumps its counter) when a value is PRESENT.
Repro: `language/expressions/function/dstr/dflt-ary-ptrn-elem-id-init-skipped.js`
(`function f([x = (initCount += 1)]) {}` called with a present value → `assert.sameValue(initCount, 0)`).
Ground in `src/codegen/destructuring-params.ts` param-pattern element lowering
(#2574 added default-on-`undefined`; the residual is the CONVERSE — default emitted
eagerly, or the presence/`done` guard mis-read for iterator-driven bindings).
Diagnose ONE file's WAT first. Acceptance: the `dflt-*-init-skipped` / `initCount, 0`
family flips (~198); zero host-lane byte delta.

## Slice 2 (~190 rows): object-rest copy ToPrimitive
`{...rest}` CopyDataProperties (§14.7.5.6) copies property VALUES as-is; the
standalone lane wrongly routes them through a primitive coercion.
Repro: `language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-rest-skip-non-enumerable.js`
(`Cannot convert object to primitive value`). Check `__extern_rest_object` / the
object-rest lowering in `destructuring-params.ts` + `object-runtime.ts`. #2602
(the assignment-rest arm) is DONE — take the binding-pattern arm here.

## Slice 3 (~115 rows): abrupt iterator-step errors must be catchable
A throwing `next()`/`return()` during IteratorBindingInitialization must surface
as a catchable typed error completion, not a Wasm trap.
Repro: `language/expressions/class/dstr/async-gen-meth-ary-ptrn-elision-step-err.js`.
Wrap the step call in the dstr drive loop with try/catch (native `__exn` tag),
rethrow-as-JS-error. Ground where the binding-init loop calls `__iterator_next`
(iterator-native.ts consumers + destructuring-params.ts).

## Slice 4 (~48 rows): Generator.prototype method brand check
`Generator.prototype.next.call(g)` on a native driven-gen frame fails the brand
test. Extend brand-check admission to the native frame structs (the
`ctx.nativeGenerators` per-producer `ref.test` arms — same pattern as
`__iter_hof_open`'s driven-frame admission in `iter-hof-native.ts`). Different
file from slices 1-3, so it may be worked last or in parallel if budget allows.

## Acceptance
Per-slice: the named assertion family flips to ~0; scoped repro test added; NO
host-lane regression; merge_group standalone-floor green. A1 (rest-identity) is
out of scope and stays with #2040.

## Verified census (2026-07-14, vs origin/main)

Resolution: **wont-fix — superseded by intervening substrate work.** Verified
against current `origin/main` with the real runner
(`runTest262File(path, cat, timeout, 'standalone')`) + WAT / zero-import probes,
not the 2-day-old plan narrative. Slice framing above is retained for history;
it is stale as of this date.

**Per-slice status:**

- **Slice 1 (lazy defaults / `*init-skipped*`): ALREADY RESOLVED on main.** 14/14
  sampled variants pass standalone; the exact repro
  `dflt-ary-ptrn-elem-id-init-skipped.js` returns `initCount=0` correctly with
  zero host imports. `emitNestedBindingDefault` (statements/destructuring.ts) and
  the array-element default path (destructuring-params.ts ~L2194) already gate
  the initializer on the presence/`__extern_is_undefined` check. No work.
- **Slice 4 (Generator.prototype brand-check): repro passes standalone**
  (`gen-meth-ary-ptrn-elem-ary-elision-init.js` standalone=pass, host=fail).
- **Slice 3 (abrupt iterator step/close errors): plain-object-iterator variants
  already pass.** The FAILING variants (`*elision-step-err`, `*rest-*step-err`,
  `*rtrn-close-err`) all use a **generator** as the iterator and leak
  `env::__gen_create_buffer,__create_generator,__gen_next,__gen_return,__gen_result_value,__gen_result_done`
  in standalone → zero-import instantiation fails (the runner mislabels this as
  "uncaught Wasm-GC exception"). Blocked on the generator-standalone substrate.
- **Slice 2 (obj-rest ToPrimitive): the named function `__extern_rest_object`
  already has a native standalone impl (#3223, object-runtime.ts:4121)** wired
  in destructuring-params.ts:595; minimal static- AND computed-key obj-rest
  assignment/binding repros both compile zero-import. Remaining obj-rest fails
  are for-await/async (ride #3132) or #3086 vacuous-wrapper.

**Census — 95 sync `/dstr/` files (async/for-await/generator-method excluded),
deterministic every-7th spread:** 75 pass / 20 fail standalone (**~79% pass**).
The 20-fail tail is thin and heterogeneous (~10 buckets); largest buckets with
substrate attribution:

| Bucket (rows in sample) | Example | Root cause / owner |
| --- | --- | --- |
| Function.name on dstr defaults (~3+) | `array-elem-init-fn-name-gen`, `obj-id-init-fn-name-cover`, `meth-dflt-ary-ptrn-elem-id-init-fn-name-class` | needs `Function.prototype.name` + property-descriptor substrate (`verifyProperty` full descriptor). NOT a codegen fix — belongs to a Function.name/PropertyDescriptor track |
| comma-op + computed-member assignment target CE (3) | `array-elem-trlg-iter-list-thrw-close-err` (`0, [ {}[thrower()], ] = it`) | niche `0, [<computed-member-target>] = it` compile error; ALSO needs iterator-`return()`-close semantics → belongs with iterator-close work (#3132-adjacent) |
| generator/async iterator leaks | `*elision-step-err`, `*rest-*step-err`, `*rtrn-close-err`, for-await obj-rest | `env::__gen_*` / async-gen standalone substrate → **#3164 / #3032 / #3132** |
| #3086 vacuous-wrapper | `*obj-ptrn-rest-getter` (for-await) | harness-wrapper callback never executed → **#3086** |

## Residual redirect (which issue owns each remaining bucket)

- Generator-driven dstr step/close errors + any `__gen_*` standalone leak →
  **#3164 / #3032** (generator standalone substrate).
- for-await / async-gen dstr (obj-rest val, step-err, `Cannot destructure null`)
  → **#3132**.
- `assert.notSameValue(x, values)` rest-identity headline (A1, 382 rows) →
  **#2040** (blocked on #2580 M2 / #3032 / #3053 tag-5 substrate).
- Vacuous harness-wrapper rows → **#3086**.
- Function.name-on-default + full property-descriptor rows → no dedicated issue
  yet; needs a `Function.prototype.name` / PropertyDescriptor-fidelity track
  (flag to PO if these rows are prioritized).

No dedicated new issue is opened here — the buckets above already have owners or
are explicitly out of scope. This census exists to stop a future planner from
re-carving the already-resolved slices 1 & 4 or the substrate-blocked 2 & 3.
