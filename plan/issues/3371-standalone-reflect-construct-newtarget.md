---
id: 3371
title: "standalone: Reflect.construct arbitrary distinct NewTarget still refuses 33 ES2015 rows"
status: in-progress
created: 2026-07-17
updated: 2026-09-04
reopened: 2026-09-01
sprint: current
priority: high
horizon: l
feasibility: hard
model: fable
task_type: bugfix
area: codegen, runtime
language_feature: reflect, constructors, prototype chain
es_edition: ES2015
goal: standalone-mode
umbrella: 1781
related: [1472, 1781, 1905, 2026, 2046, 2618, 3240, 4196, 4661, 5138, 5140, 5143, 5150, 5153, 5154, 5156, 5316, 4444]
loc-budget-allow:
  # 2026-09-04 r1 plan: a runtime NewTarget operand through every construct
  # thunk; new module new-target.ts carries the helpers, the listed files grow
  # by the operand plumbing.
  - src/codegen/new-target.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/native-construct.ts
  - src/codegen/class-constructor-wrapper.ts
  - src/codegen/standalone-subclass-ctors.ts
  - src/codegen/dataview-native.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  # 2026-09-04 r4 implementation (Opus): the runtime GetPrototypeFromConstructor
  # arm and its ordinary-[[Construct]] route live in a new module; the bound
  # function [[Construct]] arm grows the Reflect classifier.
  - src/codegen/expressions/reflect-construct-newtarget.ts
  - src/codegen/reflect-construct-native.ts
  # 2026-09-05 review round 1 (Opus): the site gate that keeps base's refusal
  # for every NewTarget/target shape measured to answer wrongly, plus the
  # §10.1.14 step-3 Type(proto)-is-Object guard on the carrier write. Both live
  # in reflect-construct-newtarget.ts; call-namespace-static.ts grows by the
  # dispatch and the restored refusal.
  # 2026-09-05 review round 2 (Opus, +207 LOC): the six admitted-shape
  # narrowings from the round-1 verdict, and the measurement each one rests on
  # written down beside it. Most of the growth is that evidence — the
  # nine-constructor wrapper table, the base-attribution for the name-keyed
  # `prototype` reader, the descriptor-write measurement the round-1 comment
  # asserted without one, and the four narrowings of the in-file function
  # target, each recorded with the wrong answer that forced it. A refusal whose
  # measurement is not next to it is the defect this round was called to fix.
  # 2026-09-06 review round 1 of r2 (Opus, +126 LOC net): the dynamic in-file
  # function target is now gated on the VALUE SET of its binding rather than on
  # the kind of its initializer (`dynamicTargetIsAllOrdinaryFunctions`), and the
  # nested-`new.target` stop is gated on whether that nested function can itself
  # be constructed (`neverConstructed`). Seven measured wrong answers become
  # refusals. As in round 2, the growth is mostly the measurement written next
  # to the clause it justifies; `resolvesToAsyncFunction` was deleted, since the
  # value-set gate subsumes it.
  # 2026-09-06 review round 2 of r2 (Opus): four more measured wrong answers
  # become refusals — the value-set gate now re-runs the `new.target` check on
  # every MEMBER body (it only ever scanned the initializer's identifier), a
  # function EXPRESSION in initializer position is refused (its callee lowering
  # drops the fetched prototype), the annotation refusal covers JSDoc `@type`
  # in `.js` sources as well as TS syntax, and `neverConstructed`'s
  # name-escape scan is limited to function DECLARATIONS (a named function
  # EXPRESSION is reached through what it is assigned to, not its own name).
  # The write scan also resolves each `T = …` through the oracle, so an
  # unrelated same-spelled parameter or block shadow no longer over-refuses.
  # As before, most of the growth is the measurement written beside the clause.
  # 2026-09-06 review round 3 of r2 (Opus, +86/-5 LOC): two more measured wrong
  # answers become refusals — a NAMED function EXPRESSION that reaches ITSELF by
  # name inside its own body is no longer proved unconstructible by the IIFE
  # test alone, and a destructuring SHORTHAND write (which the oracle resolves
  # to the object-literal property, not to the binding) is matched textually
  # again so it cannot be dropped from the value set. Two over-refusals are also
  # narrowed, both about WHERE a JSDoc tag applies rather than what it says: a
  # `@type` in a `.ts` file is inert, and a statement-level tag over several
  # declarators types the first one. As before, most of the growth is the
  # measurement written beside the clause it justifies.
  - src/codegen/expressions/reflect-construct-newtarget.ts
  # 2026-09-06 STRANDED GRANT, restated — not this round's growth. Simulating
  # CI's base (`LOC_GATE_BASE=$(git rev-parse origin/main)` = 78f1b2d03c) fails
  # on `calls-closures.ts` 2726 > 2699 (+27). That +27 is #5334's
  # rest-param-wrapper work, already carried by this integration branch and
  # granted in `plan/issues/5334-rest-param-wrapper-metadata-illegal-cast.md`,
  # which THIS change-set does not modify — so against main the grant is
  # stranded and the gate cannot see it. `git diff origin/main..HEAD` on that
  # file shows only #5334's hunks and none of this round's; against the round-1
  # head the same gate reports it as "granted by …5334…" and exits 0. Restated
  # here per CLAUDE.md's stranded-grant rule; it lapses once the branch merges
  # origin/main, which supersedes that hunk (main's own copy is 2699 with the
  # helper moved into callable-property-host-value.ts).
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  # 2026-09-04 r4 implementation (Opus): four helpers for the runtime
  # NewTarget.prototype read, its carrier application, the single-assignment
  # proof for an ordinary function target, and the ordinary-construct route.
  - src/codegen/expressions/reflect-construct-newtarget.ts
  # +63 lines in the Reflect.construct arm: the once-evaluated NewTarget local,
  # the static/runtime prototype branch, and the ordinary-[[Construct]] route.
  # The heavy lifting moved OUT into reflect-construct-newtarget.ts; what stays
  # is the dispatch that has to sit inside this arm's control flow.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
origin: "2026-09-01 immutable f841 standalone census; reopened because the prior done closure still refuses arbitrary distinct NewTarget."
---

# #3371 — standalone Reflect.construct with arbitrary distinct NewTarget

## Reopen decision

The prior implementation and closure are stale. On the fresh immutable census
below, 33 ES2015 paths end in the same compile error; this issue is therefore
**reopened** and must not be treated as done. This planning-only audit makes no
production or Test262-source change, creates no GitHub issue, and does not run a
compiler lane.

The blocking state is an ownership gate, not a claim that #2046 is the semantic
prerequisite: active local #2046 currently owns
src/codegen/expressions/call-namespace-static.ts. Rebase and audit after it
lands before taking any source edit in that file.

## Immutable evidence

| Item | Value |
| --- | --- |
| Source baseline | f841cddc0f0ea665b63700d9944a4372a34a8b57 |
| Baselines commit | 8a39bd1d4ddf200f8db3751c878ece02aa8688fe |
| Census artifact | /private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/test262-standalone-current.jsonl |
| Artifact SHA-256 | 4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf |
| Edition mapping | /private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/es2015-per-file-editions.json |
| Exact result | 33 ES2015 paths, all compile_error |

The raw signature occurs in 64 all-edition census rows. This issue deliberately
uses only the 33 rows whose path is explicitly in the ES2015 mapping; the other
31 are not silently folded into this scope.

Every listed row reports:

~~~
Codegen error: standalone Reflect.construct cannot preserve an arbitrary distinct NewTarget without a statically-resolved NewTarget.prototype assignment (#3371).
~~~

The refusal is in src/codegen/expressions/call-namespace-static.ts:1620-1627.
The positive control remains healthy in the same census:
test/built-ins/Reflect/construct/return-without-newtarget-argument.js
(pass, reached and executed). Preserve that control while repairing the
distinct-NewTarget cases.

## Current mechanism and defect boundary

The Reflect.construct namespace-static lowering currently recognizes an
array-literal argument list, builds a NewExpression, and asks
assignedNewTargetPrototype() to find a syntactic prior
Identifier.prototype = … assignment. If the scan cannot statically resolve one,
it emits the refusal above. It is not a runtime Get(newTarget, "prototype"), so
it cannot faithfully cover ordinary functions/classes, implicit prototypes,
built-ins, bound functions, proxies, accessors, abrupt completion, realm
behavior, or target-specific ordering.

There are already narrow native-view hooks (constructProto for DataView and
dynamic typed arrays) and the constructor classifier from completed #4661.
They are inputs to the eventual fix, not evidence that generic arbitrary
NewTarget is implemented. Do not replace the runtime contract with a broader
source-text scan.

## Exact ES2015 refusal cluster (33)

The paths below are the complete immutable ES2015 intersection. They are grouped
by the target / NewTarget carrier that determines the prerequisite; the list is
also the future isolated acceptance set.

### View target and accessor ordering — 9

DataView target with a bound-function accessor NewTarget.prototype:

1. test/built-ins/DataView/byteOffset-validated-against-initial-buffer-length.js
2. test/built-ins/DataView/custom-proto-access-detaches-buffer.js
3. test/built-ins/DataView/custom-proto-access-throws.js

Dynamic typed-array target with a bound-function accessor NewTarget:

4. test/built-ins/TypedArrayConstructors/ctors/length-arg/custom-proto-access-throws.js
5. test/built-ins/TypedArrayConstructors/ctors/object-arg/custom-proto-access-throws.js
6. test/built-ins/TypedArrayConstructors/ctors/typedarray-arg/custom-proto-access-throws.js
7. test/built-ins/TypedArrayConstructors/ctors/no-args/custom-proto-access-throws.js
8. test/built-ins/TypedArrayConstructors/ctors/typedarray-arg/throw-type-error-before-custom-proto-access.js
9. test/built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js

These require real getter/abrupt and detachment ordering; row 8 additionally
requires the argument TypeError before custom-prototype access. Coordinate with
#5138 (in review) and #5150 / draft PR #5224 before touching the view carriers.

### Ordinary / class target — 4

10. test/built-ins/Reflect/construct/return-with-newtarget-argument.js
11. test/language/expressions/new.target/value-via-reflect-construct.js
12. test/language/expressions/super/call-construct-invocation.js
13. test/built-ins/Object/subclass-object-arg.js

This group covers a function with Array as NewTarget, ordinary custom NewTarget,
a class/super invocation, and Object with a class NewTarget. Its immediate
dependencies are the ownership/status audits for #2026 (dynamic class-as-value),
#5153 (super), and #5154 (new.target).

### Native constructor carrier and ordering — 6

14. test/built-ins/Date/subclassing.js
15. test/built-ins/Error/prototype/stack/getter-foreign-new-target.js
16. test/built-ins/ArrayBuffer/data-allocation-after-object-creation.js
17. test/built-ins/ArrayBuffer/prototype-from-newtarget.js
18. test/built-ins/Promise/get-prototype-abrupt.js
19. test/built-ins/Promise/get-prototype-abrupt-executor-not-callable.js

These cover Date, native Error, ArrayBuffer, and Promise. They must preserve
each constructor's own allocation / validation order, including the
non-callable-executor-before-prototype-getter requirement in row 19. Coordinate
with #3240 (faithful native constructors), #5143 (Promise), #5150 (buffers),
and #5156 (function/error); do not assume the ordinary slice can implement
them.

### Proxy target or Proxy NewTarget — 10

20. test/built-ins/Proxy/construct/call-parameters-new-target.js
21. test/built-ins/Proxy/get-fn-realm.js
22. test/built-ins/Proxy/construct/trap-is-undefined.js
23. test/built-ins/Proxy/construct/trap-is-null.js
24. test/built-ins/Proxy/get-fn-realm-recursive.js
25. test/built-ins/Proxy/construct/trap-is-null-target-is-proxy.js
26. test/built-ins/Proxy/construct/trap-is-undefined-proto-from-cross-realm-newtarget.js
27. test/built-ins/Proxy/construct/trap-is-undefined-target-is-proxy.js
28. test/built-ins/Proxy/construct/trap-is-missing-target-is-proxy.js
29. test/built-ins/Proxy/construct/trap-is-undefined-no-property.js

Keep this as a separate carrier slice. It needs proxy [[Construct]], trap result
and forwarding semantics, recursive / cross-realm fallback behavior. #5140 (in
review) identifies its residual Proxy cluster as out of scope, while #2618 is
the host Proxy construct-path issue and is blocked on #56. Do not claim these as
a generic Reflect.construct follow-up without coordinating those owners.

### Bound-function carrier — 4

30. test/built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget-bound.js
31. test/built-ins/Function/prototype/bind/get-fn-realm-recursive.js
32. test/built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget.js
33. test/built-ins/Function/prototype/bind/get-fn-realm.js

Completed #4196 supplies the bound [[Construct]] carrier (construct-bound.ts).
This slice must compose its actual NewTarget forwarding and realm fallback; it
must not reimplement or bypass that carrier.

## Ownership and overlap audit

| Scope | State at audit | Required treatment |
| --- | --- | --- |
| Local #3371 worktrees | This planning worktree only | No implementation has been started here. |
| Local #2046 worktree | Active and dirty on codex/2046-reflect-set-receiver-f841-20260901 | It edits call-namespace-static.ts; wait for its landing and re-audit before source edits. |
| #2046 source overlap | Its current diff is an import plus the Reflect.set arm around lines 896-935; #3371 refusal is around lines 1620-1627 | Semantically separate today, but a shared-file lease remains a merge/conflict risk. |
| Open remote PR mentioning #3371 | None found | This does not reopen the issue automatically; the local plan is the authoritative handoff. |
| Open remote PR touching call-namespace-static.ts | None found | Re-check immediately before implementation. |
| Draft PR #5224 | WIP ES2015 buffers wave 1; changes DataView/buffer support but not call-namespace-static.ts | It does not block the ordinary carrier directly, but it owns adjacent view/buffer substrate for rows 1-9 and 16-17. |

Relevant issue states at this audit: #4661 done; #2026 in progress; #4196 and
#3240 ready; #5138, #5140, #5143, #5153, #5154, and #5156 in review; #5150 is
ready with its adjacent WIP #5224. Re-check both issue and worktree ownership,
not only labels, at the start of each implementation slice.

## Implementation slices and sequencing

Do not make a single patch for all 33 paths.

1. **Release the shared-file gate.** Wait for #2046 to land. Rebase from the
   then-current upstream, inspect the current ownership of
   call-namespace-static.ts, and verify whether #2026/#5153/#5154 changed the
   ordinary construction interfaces. This plan authorizes no source edit until
   that check succeeds.

2. **Ordinary/class runtime-NewTarget contract (rows 10-13).** This is the
   first candidate post-#2046 slice. For the narrow ordinary function, class,
   and Object paths, evaluate target, arguments, and NewTarget once in source
   order; reuse #4661's IsConstructor machinery; perform the real prototype
   operation rather than source scanning; and preserve returned objects, fallback
   behavior, new.target, and super semantics. Exclude native views/buffers,
   native Promise/Error/Date, bound functions, and proxies from this patch.

3. **View getter / abrupt-order slice (rows 1-9).** Extend the existing
   DataView and dynamic-typed-array construction-prototype hooks only after
   coordination with #5138 and #5150/#5224. Preserve each constructor's
   target-specific validation, detachment, and getter order; a static prototype
   assignment is not an acceptable substitute.

4. **Native constructor slice (rows 14-19).** Implement per-target
   GetPrototypeFromConstructor-equivalent ordering only with the owners of
   #3240, #5143, #5150, and #5156. Keep executor/argument validation and
   allocation ordering observable before/after the prototype operation exactly
   as required by each constructor.

5. **Bound carrier slice (rows 30-33).** Integrate with #4196's bound construct
   path, preserving forwarding and realm behavior instead of adding a second
   bound-function model.

6. **Proxy carrier slice (rows 20-29).** Wait for a coordinated #5140 and
   #2618/#56 direction. Preserve trap behavior, recursive/cross-realm fallback,
   target/newTarget forwarding, and invariant checking in the Proxy construct
   implementation rather than papering over it in the namespace-static caller.

### Safe first slice after #2046?

**Yes, conditionally.** After #2046 lands and the prescribed fresh ownership
audit succeeds, the four-row ordinary/class slice is non-overlapping with the
active #2046 Reflect.set change and does not require the #5224 view/buffer
files. It is not blanket authorization for all #3371 work: it must still honor
any newly landed #2026/#5153/#5154 interfaces, and all view, native, bound, and
Proxy groups remain separately owned.

## Future acceptance and regression gate

Run these only in the later implementation worktree, after acquiring ownership;
they were intentionally **not** run for this planning audit.

1. Re-fetch the current standalone baseline with the normal project workflow
   (do not reuse a stale cache) and confirm all 33 paths above are pass, not
   merely free of this one error signature. Confirm the positive control
   test/built-ins/Reflect/construct/return-without-newtarget-argument.js
   remains pass.

2. Put the exact 33 paths above, with the leading test/ removed, in
   .tmp/3371-es2015-paths.txt, then run the isolated corpus bucket:

   ~~~sh
   pnpm exec tsx scripts/run-test262-paths.mts \
     --isolate .tmp/3371-es2015-paths.txt --standalone
   ~~~

   The isolate is required so a failure cannot be hidden by realm contamination.

3. Run focused unit/host guards (using the repository's root-installed
   dependencies, not a fresh worktree install):

   ~~~sh
   PATH="/Users/thomas/Code/js2/node_modules/.bin:$PATH" \
     pnpm exec vitest run \
       tests/issue-3371.test.ts \
       tests/issue-4394-reflect-construct-newtarget.test.ts
   ~~~

4. Preserve the unit suite's zero-import / valid-Wasm and host ABI assertions.
   Add focused regressions for any newly implemented carrier, including
   evaluation order and abrupt completion; do not rebaseline until the true
   result is understood.

## Handoff

The next owner should begin with slice 1's post-#2046 audit, then implement only
the four ordinary/class paths if the interfaces are still unowned. Record a fresh
precise result for all 33 paths after each slice, retain the no-distinct-
NewTarget positive control, and leave each carrier group as a separate
coordination decision. This document is the corrected reopen record; it does
not certify the historical closure or authorize a broad source rewrite.


## Implementation Plan — r1 (2026-09-04, Fable lane; Opus-medium implements)

**Gate re-audit (supersedes "slice 1" above).** #2046 has NOT landed: its
Codex checkpoint PR #5397 is `dirty` and self-described as non-mergeable, and
the receiver design it stalled on is now owned by the proxy r4 lane (#5316,
same wave, `object-runtime-ordinary-set.ts`). The shared-file hazard in
`expressions/call-namespace-static.ts` is therefore between THIS lane and
#5316, not #2046: #5316 edits the `Reflect.set` 4-arg arm (~L1106) and adds a
`$Proxy` runtime arm before the "cannot preserve" refusal (~L1940); this lane
edits the ordinary/class/native/bound arms of the SAME construct site. Keep
the edits in separate, clearly delimited arms; the integrator merges both
lanes into one tree and re-runs both row lists. The Codex checkpoint PR #5400
(2026-09-01, `dirty`, "intentionally inert architectural substrate … the
namespace-static dispatcher remains unwired") is a DESIGN REFERENCE only —
its diff is saved at `/home/user/js2/.tmp/wave4/pr5400-3371-new-target.diff`
(new `new-target.ts`, 517 lines; `new-super.ts`, `class-constructor-wrapper.ts`,
`context/types.ts` changes). Read it for the carrier shape; do not apply it
blindly — main has moved (#5561, #5576 touched `new-super.ts` and
`native-construct.ts`).

**Rows this lane owns (23 of the 33 in "Exact ES2015 refusal cluster"):** the
view rows 1-9, the ordinary/class rows 10-13, the native rows 14-19 and the
bound rows 30-33. The proxy rows 20-29 belong to #5316 (they are a
[[Construct]] dispatch inside the proxy runtime). Non-Proxy paths from the
2026-09-04 census (all `compile_error` with this refusal):

- `test/language/expressions/new.target/value-via-reflect-construct.js`
- `test/language/expressions/super/call-construct-invocation.js`
- `test/built-ins/DataView/byteOffset-validated-against-initial-buffer-length.js`
- `test/built-ins/DataView/custom-proto-access-detaches-buffer.js`
- `test/built-ins/DataView/custom-proto-access-throws.js`
- `test/built-ins/TypedArrayConstructors/ctors/length-arg/custom-proto-access-throws.js`
- `test/built-ins/TypedArrayConstructors/ctors/object-arg/custom-proto-access-throws.js`
- `test/built-ins/TypedArrayConstructors/ctors/typedarray-arg/custom-proto-access-throws.js`
- `test/built-ins/TypedArrayConstructors/ctors/no-args/custom-proto-access-throws.js`
- `test/built-ins/TypedArrayConstructors/ctors/typedarray-arg/throw-type-error-before-custom-proto-access.js`
- `test/built-ins/ArrayBuffer/data-allocation-after-object-creation.js`
- `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js`
- `test/built-ins/ArrayBuffer/prototype-from-newtarget.js`
- `test/built-ins/Date/subclassing.js`
- `test/built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget-bound.js`
- `test/built-ins/Function/prototype/bind/get-fn-realm-recursive.js`
- `test/built-ins/Error/prototype/stack/getter-foreign-new-target.js`
- `test/built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget.js`
- `test/built-ins/Function/prototype/bind/get-fn-realm.js`
- `test/built-ins/Reflect/construct/return-with-newtarget-argument.js`
- `test/built-ins/Object/subclass-object-arg.js`
- `test/built-ins/Promise/get-prototype-abrupt.js`
- `test/built-ins/Promise/get-prototype-abrupt-executor-not-callable.js`

**Step 0 — inventory.** Isolate-run the 23 rows on a `git archive origin/main`
base tree and on the lane tree; run the positive control
`test/built-ins/Reflect/construct/return-without-newtarget-argument.js`; run
the control corpora `test/built-ins/Reflect/construct/**`,
`test/language/expressions/new.target/**`, `test/language/expressions/super/**`
and `test/built-ins/Function/prototype/bind/**` (ES2015 rows) and keep the
passing list. Then read `call-namespace-static.ts` L1880-1990 (the
`Reflect.construct` arm: `distinctNewTarget`, `assignedNewTargetPrototype`,
`isDefinitelyPrimitivePrototype`), `expressions/new-super.ts`,
`native-construct.ts`, `standalone-subclass-ctors.ts`,
`ir-plain-implicit-constructors.ts` and `class-constructor-wrapper.ts` — the
current `new.target` plumbing is a compile-time selection of the prototype
(the "statically-resolved NewTarget.prototype assignment" the refusal names);
the missing piece is a RUNTIME NewTarget value threaded into construction.

**Step 1 — ordinary/class runtime NewTarget (rows 10-13).** Give every
compiled constructor entry (class constructor wrappers and ordinary
function-constructor thunks — the `__fnctor_*_new` family) a NewTarget
operand: `new F(...)` passes F itself, `super(...)` forwards the derived
constructor's own NewTarget, `Reflect.construct(F, args, NT)` passes NT.
Inside the body `new.target` reads that operand (today it reads a constant
per site). `OrdinaryCreateFromConstructor`: the instance prototype is
`Get(NT, "prototype")` when NT is distinct — a real property read on the
runtime value, falling back to the intrinsic default when it is not an
Object — evaluated AFTER the arguments and BEFORE the body, exactly once.
Preserve the returned-object override, `super` semantics and the
`derived-class-return-override` behaviour byte-for-byte where NT === F (the
common case must not slow down or change: gate the dynamic prototype read on
"NT is not the static constructor" so existing modules are byte-identical).

**Step 2 — bound carrier (rows 30-33).** `new BF(...)` / `Reflect.construct(BF,
args, NT)` where BF is a bound function (`$__bound_fn`): construct the
BOUND TARGET with `newTarget === BF ? target : NT` (§10.4.1.2 step 5),
prepending bound args; `get-fn-realm` rows resolve the default prototype
through the innermost target. Reuse the existing bound-function construct
path (grep `bound` in `native-construct.ts` / `new-non-constructable-value.ts`)
— add the NewTarget operand, do not add a second bound-function model.

**Step 3 — native constructors (rows 14-19).** `ArrayBuffer`, `Date`,
`Error` (stack getter foreign new-target), `Promise` (two
`get-prototype-abrupt*` rows), `Object` (subclass-object-arg): each native's
construct path takes the NewTarget operand and does
`GetPrototypeFromConstructor(NT, "%X.prototype%")` — a real `Get(NT,
"prototype")` whose abrupt completion propagates (`get-prototype-abrupt.js`
throws from the getter) — at the spec step (AFTER argument validation where
the spec says so; `data-allocation-after-object-creation.js` pins that the
buffer allocation happens after the object is created from NT). The
`Promise` rows must not touch the promise/microtask carrier itself (#2867,
other team) — only the constructor's prototype-selection step.

**Step 4 — view getters and abrupt order (rows 1-9).** `DataView` and dynamic
typed-array constructors: same `GetPrototypeFromConstructor` with the
per-constructor ordering the row names pin: `custom-proto-access-throws`
(the getter throws → propagate, before/after the buffer/length validation as
each test states), `custom-proto-access-detaches-buffer` (the getter detaches
the buffer → the constructor must re-check and throw TypeError),
`byteOffset-validated-against-initial-buffer-length`,
`throw-type-error-before-custom-proto-access`. Anchor:
`dataview-native.ts` (the `descTypeIdx` carrier that feeds
`emitTaDynCtorConstructFromLocals`; note the 2026-09-03 brand lesson in
#5194: there are TWO `$__ta_ctor` mint sites) and `ta-dyn-mop.ts`.

**Order-preservation constraints.** Every module whose constructors are only
ever constructed with `new F()` / `super()` (NT === F statically) must be
byte-identical to base on standalone, host and wasi; run the #5194/#5195
pins (`tests/issue-5194*.test.ts`, `tests/issue-5195*.test.ts`,
`tests/issue-5309*.test.ts`, `tests/issue-5312*.test.ts`) unchanged.

## Acceptance criteria — r1

- 23 owned rows `pass` (isolated, standalone) or given up with the mechanism;
  the positive control keeps passing; zero rows lost in the four control
  corpora above.
- `tests/issue-3371-r1-*.test.ts`: kept rows pinned; a node-parity matrix for
  `new.target` under `new`, `super`, `Reflect.construct` with/without NT, a
  bound function, and a getter-throwing `NT.prototype`.
- Gates, typecheck, lint green; `new-super.ts` / `native-construct.ts` growth
  granted in this file's frontmatter with a dated rationale.

## Lane protocol (applies to every step above)

- **Worktree only.** Work in the worktree the workflow gave you; branch from the
  merge-base you were spawned on and `git pull --no-rebase --no-edit origin main`
  before the first source edit. `git merge` is hook-blocked in the repo root;
  `git pull --no-rebase` is not. Link `node_modules` and `test262` DIRECTLY to
  `/home/user/js2/node_modules` and `$(readlink -f /home/user/js2/test262)` (no
  symlink chains through sibling worktrees). Copy
  `/home/user/js2/.test262-cache/quickjs*` into the worktree's `.test262-cache/`
  and run `node scripts/build-quickjs-eval-provider.mjs` there, or every
  eval-dependent row fails fast with "quickjs provider is not built" and hides
  both wins and regressions.
- **Measure, do not predict.** Every row you claim flips is run with
  `npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone` on BOTH
  a `git archive origin/main` base tree and the lane tree; the enclosing control
  corpus named in the plan is re-run the same way and every base-pass row must
  still pass. A `compile_timeout` under load is re-run alone before it counts.
  Name the artifact and the time for every number you write down.
- **The failure family to hunt for is "a working program now throws."** Every
  confirmed regression across the last four waves was a "provable" predicate
  resolving by NAME or by declaration shape without a single-assignment /
  shadowing proof. Decline to base unless the proof holds under reassignment,
  destructuring, loop heads, parameters, `eval`/`with` and shadowing — and
  never let a new arm change the answer of a program that worked on base.
- **Node is the oracle, but the engine differs.** CI runs node 25; this
  container runs node 22 (a node 25 lives at
  `/home/user/js2/.tmp/wrap/node25/cache/_npx/8758e404b5eed2f3/node_modules/node/bin`).
  A pin that asserts node's answer must probe the running engine, not assert a
  fixed value, when the two disagree (sloppy-function own `caller`/`arguments`
  is the known case).
- **Do not touch the other team's territory:** the generator carrier (#2864,
  every `__gen_*`/`__create_generator` row), the promise/microtask carrier
  (#2867), and built-in method reflection (#2175 — `length.js`/`name.js`/
  `prop-desc.js`/`not-a-constructor.js` rows and the
  "`Object.prototype.toString` / `Function.prototype.call` is not yet
  implemented in --target standalone" rows). Leave those rows out of your
  claims and your acceptance list; record them as gated.
- **Gates before every commit, chained:** `node scripts/check-loc-budget.mjs &&
  node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)`; plus
  `pnpm run -s check:speculative-rollback` (a raw `fctx.body.length = n`
  rollback outside `context/speculative.ts` fails CI — use
  `withSpeculativeCompile`/`probeCompiledType`), `check:stack-balance`,
  `check:codegen-fallbacks`, `check:any-box-sites`, TS7 typecheck
  (`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`)
  and `pnpm run -s lint`. Growth grants go in THIS issue's frontmatter
  (`loc-budget-allow` / `func-budget-allow`) with a dated rationale; never edit
  `scripts/*-baseline.json`. New codegen type queries go through `ctx.oracle`.
- **Tests:** `tests/issue-<id>-r4-*.test.ts` pin every kept row through
  `runTest262File(file, "issue-<id>", 60_000, "standalone")` plus node-parity
  probes compiled with `compile(source, { target: "standalone", allowJs: true,
  skipSemanticDiagnostics: true })`, asserting `result.imports` is `[]`. Run
  them at the CI fork heap, single fork:
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/issue-<id>*.test.ts
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
  --dangerouslyIgnoreUnhandledErrors`.
- **Commits:** author stays the repo's configured identity; subject ends with
  ` ✓`; `SKIP_SLOW_PRECOMMIT=1`; never `--no-verify`; trailers
  `Model: Claude Opus 5 Medium`, `Co-Authored-By: Claude Opus 5
  <noreply@anthropic.com>`. Commit each step separately with the measurement
  in the body. Do NOT push, open a PR, or enqueue — the integrator merges the
  lane branch, validates the combined tree and opens the PR.
- **Report** (your final message): the per-step row table (base → lane, kept /
  given up), the control-corpus result, gate status, the worktree path and head
  sha, and every residual with its mechanism.


## 2026-09-04 r4 implementation (Opus)

**What landed:** the refusal is gone. `Reflect.construct(target, args, NT)` with
an arbitrary distinct NewTarget now performs the real
`? Get(NewTarget, "prototype")` instead of scanning the source for a prior
`NT.prototype = …` assignment, and a bound function is finally recognised as a
constructor. 11 of the 23 rows this lane owns flip from `compile_error` to
`pass`; the other 12 stay failing, each for a named mechanism (below).

Worktree `/home/user/js2/.claude/worktrees/wf_a9776683-b00-4`, branch
`worktree-wf_a9776683-b00-4`, base `origin/main` 46c12b01d6.

### Mechanism

Three changes, each confined to a branch that used to `reportError`, so no
program that compiled before reaches any of them:

1. **`src/codegen/expressions/reflect-construct-newtarget.ts` (new).** NewTarget
   is evaluated ONCE, before the argument list, into an externref local;
   `Get(NT, "prototype")` runs AFTER the ordinary construction, via
   `__extern_get`. The fetched prototype is written to the DataView window or
   dynamic typed-array view struct, and to anything else through
   `__object_setPrototypeOf` — the "not implemented for this target carrier"
   compile error is retired.
2. **`src/codegen/reflect-construct-native.ts`.** §10.4.1 — a `$__bound_fn` has
   [[Construct]] iff its bound target does. The classifier arm recurses on the
   target, which is what a bound-of-bound chain needs.
3. **The ordinary-[[Construct]] route.** An ordinary user function's `new`
   lowering builds a CLOSED struct with no `$proto` field, so patching the
   prototype afterwards is a silent no-op — measured: `Object.getPrototypeOf`
   read back `null`. Such a target instead goes through
   `__native_construct_<N>(callee, proto, …)`, which creates the instance FROM
   the prototype, so the constructor body's own `Object.getPrototypeOf(this)`
   is right too. Gated on a single-assignment proof
   (`isUnreassignedOrdinaryFunction`): one function declaration, no assignment,
   `++`/`--`, second binding, parameter/catch shadow, `with`, or direct `eval`
   anywhere in the file.

**Why the read is AFTER construction, not before.** Two rows pin each side:
`DataView/byteOffset-validated-against-initial-buffer-length.js` wants the
RangeError to win over the getter, and
`TypedArrayConstructors/…/throw-type-error-before-custom-proto-access.js` wants
`ToIndex(Symbol())` to throw first — so the read must NOT move earlier. The
`custom-proto-access-throws` rows pass on either side. The one row that
genuinely needs the read BEFORE allocation stays failing (below).

### Rows — base vs lane

Base `.tmp/base-rows.txt` and lane `.tmp/lane-rows-s3.txt`, both
`npx tsx scripts/run-test262-paths.mts --isolate … --standalone`,
`COMPILER_POOL_SIZE=2`, 2026-09-05.

| | base 46c12b01d6 | lane |
| --- | --- | --- |
| 23 owned rows | 0 pass / 23 compile_error | **11 pass** / 12 fail |
| positive control `return-without-newtarget-argument.js` | pass | pass |

Kept (11):

1. `built-ins/DataView/byteOffset-validated-against-initial-buffer-length.js`
2. `built-ins/DataView/custom-proto-access-throws.js`
3. `built-ins/TypedArrayConstructors/ctors/length-arg/custom-proto-access-throws.js`
4. `built-ins/TypedArrayConstructors/ctors/object-arg/custom-proto-access-throws.js`
5. `built-ins/TypedArrayConstructors/ctors/typedarray-arg/custom-proto-access-throws.js`
6. `built-ins/TypedArrayConstructors/ctors/no-args/custom-proto-access-throws.js`
7. `built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js`
8. `built-ins/TypedArrayConstructors/ctors/typedarray-arg/throw-type-error-before-custom-proto-access.js`
9. `built-ins/Promise/get-prototype-abrupt.js`
10. `built-ins/Promise/get-prototype-abrupt-executor-not-callable.js`
11. `built-ins/Reflect/construct/return-with-newtarget-argument.js`

### Control corpus — 0 rows lost, 10 gained

`built-ins/Reflect/construct/**` + `language/expressions/new.target/**` +
`language/expressions/super/**` + `built-ins/Function/prototype/bind/**`, 218
rows, same isolated standalone runner, base tree archived from `origin/main` at
46c12b01d6 (`.tmp/base-controls.txt`) vs lane (`.tmp/lane-controls.txt`),
2026-09-05:

| | base | lane |
| --- | --- | --- |
| pass | 156 | **166** |
| fail | 54 | 51 |
| compile_error | 8 | 1 |

**Lost: 0.** Gained 10, of which **9 are collateral wins outside the 23-row
list**, all from the bound-function [[Construct]] arm:
`Function/prototype/bind/{15.3.4.5-2-1, 15.3.4.5-6-4, 15.3.4.5-6-6,
15.3.4.5-6-8, 15.3.4.5-6-10, 15.3.4.5-6-11, 15.3.4.5-9-2, S15.3.4.5_A3}.js` and
`Reflect/construct/not-a-constructor.js` — each of them asks whether a bound
function is a constructor and got the wrong answer before.

### Residuals — 12 rows, each with its mechanism

| Row | Mechanism it still needs |
| --- | --- |
| `language/expressions/new.target/value-via-reflect-construct.js` | `new.target` is an i32 CLASS-ID module global keyed by class NAME (`src/codegen/new-target.ts`, #2023). Reading it as an arbitrary function VALUE needs an externref carrier, and every `new`/`super`/`Reflect.construct` site rewritten to write it. Out of scope for this lane. |
| `language/expressions/super/call-construct-invocation.js` | Same carrier, plus `super()` forwarding the derived constructor's own runtime NewTarget. |
| `built-ins/DataView/custom-proto-access-detaches-buffer.js` | The getter detaches the buffer and returns normally; the DataView constructor must RE-CHECK detachment after the prototype read and throw TypeError. Needs a post-read detach guard on the `dvWindow` carrier. |
| `built-ins/ArrayBuffer/data-allocation-after-object-creation.js` | Requires the read strictly BEFORE the data-block allocation (7 PiB → the getter's DummyError must beat the RangeError). Moving the read earlier globally breaks rows 1 and 8 above, so it needs a per-constructor read point inside `ArrayBuffer`'s own construct path. |
| `built-ins/ArrayBuffer/prototype-from-newtarget.js` | The native ArrayBuffer carrier has no settable prototype link: `__object_setPrototypeOf` declines and `Object.getPrototypeOf` reads back null. Needs an ArrayBuffer carrier proto field (coordinate #5150 / draft PR #5224). |
| `built-ins/Date/subclassing.js` | Same — the Date carrier (#3240). |
| `built-ins/Error/prototype/stack/getter-foreign-new-target.js` | Same — the native Error carrier (#5156). |
| `built-ins/Object/subclass-object-arg.js` | Not a NewTarget defect: `class O extends Object {}` passes the argument through to the instance (`o1.a` reads 2 where the spec says undefined). Belongs with the class-heritage work (#5195/#2026). |
| `built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget.js` | §10.4.1.2 step 5 — bound [[Construct]] must forward `newTarget === BF ? target : NT`, and the row reads `new.target` inside the target, so it also needs the value carrier. Compose with #4196's `construct-bound.ts`. |
| `built-ins/Function/prototype/bind/instance-construct-newtarget-boundtarget-bound.js` | Same, one bound level deeper. |
| `built-ins/Function/prototype/bind/get-fn-realm.js` | Cross-realm: `realm1.Date` reads as null/undefined before NewTarget is reached (`TypeError: Cannot access property on null or undefined`). A realm-shim gap, not this arm. |
| `built-ins/Function/prototype/bind/get-fn-realm-recursive.js` | Same realm-shim gap. |

Rows 20-29 (Proxy target / Proxy NewTarget) were never in this lane's scope —
they belong to #5316. The generator carrier (#2864), the promise/microtask
carrier (#2867) and built-in method reflection (#2175) were not touched.

### Gates

All bare and with `LOC_GATE_BASE=$(git rev-parse origin/main)`:
`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit`, `lint` — all green. Growth grants are in this file's frontmatter.
The single-assignment predicate queries `ctx.oracle.declarationsOf`, not the raw
checker (the first cut used `ctx.checker.getSymbolAtLocation` and the
oracle-ratchet gate caught it).

Pin file: `tests/issue-3371-r4-reflect-construct-newtarget.test.ts` — 15 tests,
all passing at the CI fork heap in a single fork. It lists the
"getter must run" rows and the "validation must win" rows as SEPARATE groups on
purpose: a patch that moves the prototype read earlier turns the first group
green and the second red.

### Review round 1 (2026-09-05)

**Verdict: r4 kept its 11 rows but answered SIX shapes wrongly where base
refused. All six now keep base's refusal, verbatim.** The r4 arm treated
"the compile error is gone" as the goal; the actual requirement is that a
program either answers what node answers or does not compile. Every clause of
the new gate (`classifyRuntimeNewTargetSite` in
`src/codegen/expressions/reflect-construct-newtarget.ts`) is a measured wrong
answer, not a precaution.

Worktree `/home/user/js2/.claude/worktrees/wf_fa32f3a5-7d2-1`, branch
`claude/es6-test262-standalone-g10c7u` + the lane merge. Oracle: node 22 in
this container (the five refusal pins re-run identically on node 25). Probe
sources under `/home/user/js2/.tmp/rev3371/p/` and this worktree's `.tmp/q/`.

| # | Shape | node | r4 lane | now | Fix |
| --- | --- | --- | --- | --- | --- |
| F1 | class NewTarget (`p/m1.js` driver, `p/h1.js` DataView) | `C.prototype` | `Object.prototype` / `DataView.prototype` | **refusal** | A class's prototype object is not reified in standalone: `C.prototype` compiles to `null` **on base too** (`.tmp/q/n_clsfacts.js` — base and lane both answer "null"), and `__reflect_is_constructor` has no class arm. Nothing to take the prototype from, so the site refuses. Aliases (`const NT = C`) refuse through `oracle.variableInitializerOf`. |
| F2 | bound NewTarget, no own `prototype` (`p/h3b.js` DataView, `p/m6.js` Uint8Array) | intrinsic default | `undefined` / `null` | **h3b = node**; m6 residual | §10.1.14 step 3 — the whole carrier write is now gated on `Type(proto) is Object` (the `construct-return-value.ts` idiom: separate null test, `typeof`-object OR `typeof`-function). Skipping the write leaves the intrinsic default, which is the spec answer. |
| F3 | target reads `new.target` (`p/b_newtarget.js`) | `C` | `undefined` (guard throws) | **refusal** | The statically-resolved target declaration is scanned for a `new.target` meta-property; a hit refuses the site. `new.target` is an i32 class-id global (#2023) — narrowing the site, not inventing the value. |
| F4 | class NewTarget behind a call (`p/g3b.js`) | constructs | `TypeError: newTarget is not a constructor` | **refusal** | Subsumed by the identifier-only rule below plus F1. |
| F5 | evaluation order (`p/g3.js`) | 238 | 39 | **refusal** | NewTarget must be a bare IDENTIFIER. The reorder r4 was asked for is not available: the fallback route hands target+arguments to `compileNewExpression`, which evaluates AND constructs in one step, and §26.1.2 puts the IsConstructor(NewTarget) check *before* construction — there is no seam between the argument list and the allocation. An identifier's evaluation has no side effect, so reading it early is unobservable; every other spelling refuses instead of being reordered. |
| F6 (new, found this round) | a NewTarget `prototype` installed by a descriptor write (`.tmp/q/n_getter_ok.js`, `n_defprop.js`) | the installed object | `Object.prototype` | **refusal** | `__native_construct_N` stores the supplied prototype only when it passes `ref.test $Object`; an object-literal carrier fails that test and is dropped in silence. The driver route now requires the NewTarget binding's `prototype` to be provably untouched (no assignment, no `defineProperty`/`defineProperties`/`setPrototypeOf`/`assign`, no second binding, no `with`/`eval`). |
| F7 (new, found this round) | an `Array` target (`.tmp/q/n_arraytarget.js`) | `NT.prototype` | `Array.prototype` | **refusal** | The instance carrier has no `$proto` field, so the post-construction [[SetPrototypeOf]] is a no-op — while `Object.getPrototypeOf` on an Array answers correctly, so the wrong value is genuinely observable. A named blacklist (`Array`, `Map`, `Set`, `RegExp`, `Function`, the wrapper constructors, `Proxy`, the weak collections) refuses. A user-class or in-file-function target that the driver route does not take refuses for the same reason. |

**Rows — 24 owned (`.tmp/final-rows.txt`, `--isolate … --standalone`,
`COMPILER_POOL_SIZE=2`, 2026-09-05):** `{ pass: 12, fail: 9, compile_error: 3 }`
against the lane's `{ pass: 12, fail: 12 }`. **All 11 kept rows plus the
positive control still pass.** Three rows moved `fail → compile_error`; none
was passing, and each is a refusal restored on purpose:

- `language/expressions/new.target/value-via-reflect-construct.js` — F3, the
  target reads `new.target`.
- `language/expressions/super/call-construct-invocation.js` — F3, same.
- `built-ins/Object/subclass-object-arg.js` — F7, `class O extends Object` is a
  class target whose instance has no settable prototype.

**Control corpus — 218 rows, 0 lost (`.tmp/final-controls.txt` +
`.tmp/retry4-out.txt`, 2026-09-05):**

| | base 46c12b01d6 | r4 lane | this round |
| --- | --- | --- | --- |
| pass | 156 | 166 | **166** |
| fail | 54 | 51 | 49 |
| compile_error | 8 | 1 | 3 |

The raw run reported `pass: 162 / compile_error: 7`; four
`Function/prototype/bind/15.3.4.5-*` rows hit the 15 s per-row compile budget
under a loaded box and **pass when re-run alone at `COMPILER_POOL_SIZE=1`**
(`.tmp/retry4-out.txt`), which the lane protocol requires before a
`compile_timeout` counts. The two extra `compile_error`s versus the lane are
the F3 refusals (`new.target/value-via-reflect-construct.js`,
`super/call-construct-invocation.js`) — both were **`compile_error` on base as
well**, so nothing regressed against base either.

Byte identity: every non-#3371 probe compiles to the SAME bytes as the r4 lane
(`.tmp/bytes.mts` over `p/z_plain.js`, `p/z_bindonly.js`, `p/k_shared.js`,
`.tmp/q/n_ta_plain.js`, `.tmp/q/n_oc.js` — this round adds zero drift; the two
that differ from base differ on the lane too, from r4's bound-function
classifier arm).

**Residuals this round did NOT close, each attributable to a defect OUTSIDE
this arm — measured on base, not assumed:**

- `Object.getPrototypeOf` on a *dynamically typed* typed-array view answers
  `null` on **base** (`.tmp/q/n_ta_dyn_proto.js`: node 1, base 2, lane 2), and
  on a Promise or a class instance likewise (`.tmp/q/n_base_reads.js`: node 15,
  base 10 — only the Array and plain-object arms are right). So `p/m6.js` and a
  Promise/class-instance target read a wrong prototype with or without this
  work; the #3371 arm is not the thing answering wrongly, which is why those
  targets are NOT blacklisted (blacklisting them would drop the two passing
  `Promise/get-prototype-abrupt*` rows for no correctness gain).
- Under `--target wasi`, `Object.getPrototypeOf` on a dynamic DataView or
  typed-array view **traps on base** (`.tmp/q/n_dv_getproto.js`,
  `n_ta_dyn_proto.js`, both `RUN_THROW` on base). `p/h3b.js` and `p/m6.js`
  therefore still throw on wasi; the trap is that pre-existing reader, not the
  NewTarget path. Everything the gate refuses refuses identically on wasi
  (pinned).
- **Still unbounded by construction:** a target expression whose value is not
  statically resolvable (a parameter — the shape the kept typed-array rows use,
  `testWithTypedArrayConstructors(TA => …)`). The runtime `ref.test` carrier
  arms decide there; if such a target turns out to be an `Array` at runtime the
  prototype write is a silent no-op. Closing it would cost rows 3-8, so it is
  recorded rather than refused.

**Pins.** `tests/issue-3371-r4-reflect-construct-newtarget.test.ts` is now 29
tests, all green at `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, single fork, on node
22 AND node 25. Two r4 parity probes were REPLACED, not deleted: both used an
ordinary-function target with a descriptor-written NewTarget `prototype`, the
shape F6 shows is unsound. The getter-propagation property they pinned is now
pinned on the shape the kept `custom-proto-access-throws` rows use (a DataView
target, a bound NewTarget with a throwing getter); the descriptor-write shape
itself moved into the new
`#3371 review r1 — refusals kept` block, which runs every refused shape on
BOTH `standalone` and `wasi` and asserts a compile error carrying `(#3371)`.
The r3 pins (`tests/issue-5195*`, `issue-5309*`, `issue-5312*`) are 225/225
green; `issue-5313`'s compile-work budget fails identically on base
(pre-existing, untouched).

**Gates.** `check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit`, `lint` — all exit 0, bare and with
`LOC_GATE_BASE=$(git rev-parse origin/main)`.

## Handoff (2026-09-05, session claude/es6-test262-standalone-g10c7u)

**Shipped in this PR (r1 slice):** the runtime `Get(NT, "prototype")` read for
`Reflect.construct(F, args, NT)`, the bound-function `[[Construct]]` arm in the
standalone IsConstructor classifier, the ordinary-`[[Construct]]` driver route,
and — from review round 1 — the refusal gate `classifyRuntimeNewTargetSite`
plus the §10.1.14 `Type(proto) is Object` check on the carrier write. Net on the
owned list: 11 of 23 rows flip compile_error → pass, the positive control
holds; 218-row control (Reflect/construct, new.target, super,
Function/prototype/bind) 166 pass vs 156 on main, zero lost, nine collateral
wins in `Function/prototype/bind`. Pins: `tests/issue-3371-r4-reflect-construct-newtarget.test.ts`
(29, node 22 and 25). The fix-round review (a second single-reviewer pass,
attacking over-refusal against base's own 2-arg / `NT === F` / static-assignment
shapes) was still running at wind-down; its verdict, if it found anything, is
in this PR's thread or the next session's handover.

**What the review round established, and what it means for the next slice.**
The arm can *fetch* `NT.prototype` but usually cannot *install* it: only the
DataView window struct and the ordinary-function driver accept a prototype; a
class instance, an Array, an ordinary function's closed struct and a
descriptor-written prototype all swallow the write silently. `C.prototype` on a
class compiles to `null` in standalone on main (no reified prototype object),
and `__reflect_is_constructor` has no class arm. So every shape the gate now
refuses is a shape that needs its own carrier or a reified class prototype —
not a smaller patch to this arm.

**Residuals — 12 owned rows, in the order to take them:**

1. `new.target` as a runtime VALUE (2 rows: `new.target/value-via-reflect-construct.js`,
   `super/call-construct-invocation.js`) — today an i32 class-id module global
   keyed by class name (`src/codegen/new-target.ts`, #2023). Needs an externref
   carrier and every `new` / `super()` / `Reflect.construct` site writing it;
   `super()` must forward the derived constructor's own runtime NewTarget. This
   also unblocks #5316 step 3 (Proxy `[[Construct]]` NewTarget forwarding).
2. Reified class prototypes in standalone (unblocks class NewTargets — the
   most common shape users write — and `built-ins/Object/subclass-object-arg.js`).
3. Post-read re-validation on DataView (`custom-proto-access-detaches-buffer.js`)
   and read-before-allocation on ArrayBuffer (the 7 PiB row): both need the
   prototype read moved inside the builtin's own construct path.
4. The remaining carrier rows listed under "Residuals — 12 rows" above.

Pre-existing and NOT this arm's: `Object.getPrototypeOf` on a dynamically typed
TypedArray view answers `null` on main; Promise and class-instance
`getPrototypeOf` are wrong on main; on wasi `getPrototypeOf` on a dynamic
DataView/TA view traps on main (probe files under `.tmp/q/` in the fix-round
worktree while it exists; the shapes are one-liners and are described in the
review-round subsection).

### Review of round 1 — verdict (2026-09-05, single reviewer, 40+ probes)

**No regression against main.** Structurally, `classifyRuntimeNewTargetSite`
and the second refusal (`applyRuntimeNewTargetPrototype` returning false) sit
inside the `distinctNewTarget && staticNewTargetProto === undefined` branch,
which is exactly the branch main refused unconditionally; empirically no probe
was a compile error on the fix and OK on main. Main's own paths are untouched
row-for-row: 2-arg `Reflect.construct`, `NT === F`, and the static
`NT.prototype = …` shape with F an ordinary function, class, Array, Uint8Array,
Object, Promise, DataView. Byte-identical to the lane on programs without
`Reflect.construct` on all three targets. Pins 29/29 on node 22 and 25.

**Six over-refusals against the r4 LANE (programs main refused, the lane
answered correctly, round 1 refuses again).** Conservative losses, not wrong
answers; they are the round-2 list, cheapest first:

1. `targetReadsNewTarget` descends into nested ordinary function declarations
   and expressions, whose `new.target` is their own — stop the descent there
   (arrows and class field initialisers must keep inheriting). Probe
   `b5_nt_nested_newtarget.js`: node 7, lane 7, round 1 refused.
2. `UNSETTABLE_PROTOTYPE_CONSTRUCTORS` lists Boolean, String and Symbol by
   family; measured, those wrapper carriers DO take the prototype patch (lane
   = node for all three, Symbol's TypeError included). Drop the three; keep
   Array, Number, Map, Set, RegExp, Function, which were measured to discard it.
3. `prototypeIsPristine` counts every same-NAME binding in the file with no
   scope check, so an unrelated parameter named like the NewTarget refuses the
   site (`m2_shadow.js` vs `m1_control_noshadow.js`). Resolve through the
   oracle's symbol for the binding instead of `name.text`.
4. `prototypeIsPristine` treats a MUTATION of `NT.prototype`
   (`NT.prototype.tag = 9`, `Object.assign(NT.prototype, …)`, and even
   `Object.defineProperty(NT, "prototype", {value: {…}})`) as replacing the
   slot; the slot still holds a plain `$Object`, which is what
   `__native_construct_N`'s `ref.test $Object` accepts. Lane answered all three
   correctly; the code comment citing the defineProperty shape as the rationale
   is wrong as written.
5. In-file function targets the driver declines are refused on the claim that
   the post-construction prototype patch is a no-op on a closed struct; the
   same instance shape reached through the `unknown`-target carrier route
   (`k1_target_param.js`) takes the patch and answers node. The refusal keys on
   how well the target resolves, not on the carrier property it names.
6. The §10.1.14 guard comment says it repaired the typed-array carrier too;
   measured, only DataView changed (17 = node, was 20); the typed-array answer
   is unchanged (null) because that reader is broken on main.

Probe files: `/home/user/js2/.tmp/rv/p/*.js` with harness `.tmp/rv/cmp.mts`
(base / lane / fix / node) while the container lives; every shape is a
one-liner quoted above.

## Implementation Plan — r2 (2026-09-05, Fable lane; Opus-medium implements)

Scope: the six lane-only over-refusals from the round-1 verdict above, cheapest
first. Every step re-admits a program the r4 lane answered correctly and round 1
refused; nothing here touches the shapes round 1 refused for a WRONG answer
(class NewTarget, non-identifier NewTarget, `new.target` read in the target's
own body, non-object prototype on a carrier). All in
`src/codegen/expressions/reflect-construct-newtarget.ts` unless stated.

1. **`targetReadsNewTarget` stops at nested ordinary functions.** In
   `readsNewTarget`, do not descend into `FunctionDeclaration`,
   `FunctionExpression`, method declarations, getters/setters or class
   constructors nested in the target's body — each has its own `new.target`.
   Keep descending into arrow functions, class field initialisers and static
   blocks (they inherit). Probe `.tmp/rv/p/b5_nt_nested_newtarget.js`
   (node 7); keep `c2`/`c6` (a direct read, an arrow read) refused.
2. **`UNSETTABLE_PROTOTYPE_CONSTRUCTORS` drops Boolean, String, Symbol.**
   Measured: those wrapper carriers take the post-construction prototype
   patch (`e_Boolean` 1, `e_String` 1, `e_Symbol` TypeError = node). Keep
   Array, Number, Map, Set, RegExp, Function, each of which was measured to
   discard it; re-measure all nine before committing and record the table.
3. **`prototypeIsPristine` resolves the binding by symbol, not by name.**
   Replace the file-wide `name.text` count with `ctx.oracle`'s declaration
   identity for the NewTarget identifier (the same `declarationsOf` route r4
   used); an unrelated parameter or local of the same name in another scope
   must not count. Probes `m2_shadow.js` (node 7) vs `m1_control_noshadow.js`.
4. **Mutation of `NT.prototype` is not replacement.** Only an assignment whose
   LEFT side is exactly `NT.prototype` (or a `defineProperty`/`defineProperties`
   call whose target is `NT` and whose key is the literal `"prototype"`, or
   `Object.setPrototypeOf(NT, …)`) replaces the slot. `NT.prototype.tag = 9`,
   `Object.assign(NT.prototype, …)` and `Object.defineProperty(NT.prototype,
   …)` mutate the object the slot already holds, which stays a plain
   `$Object` and passes `__native_construct_N`'s `ref.test $Object`. Probes
   `b2_driver_protomut.js`, `b7`, `c3` (node 7 each). Fix the code comment
   that cites the `defineProperty(NT, "prototype", {value: {…}})` shape as
   the rationale: measure it — if the descriptor-written object-literal
   carrier IS dropped by the `ref.test`, keep refusing that one shape and say
   so precisely; if it is not, admit it.
5. **In-file function targets use the carrier route the `unknown` target
   already takes.** `classifyRuntimeNewTargetSite` returns `undefined` for
   `targetKind.kind === "function"` when the driver declines; `k1_target_param.js`
   shows the same instance shape through the `unknown` route takes the generic
   `__object_setPrototypeOf` patch and answers node. Route a declined in-file
   function target through that carrier path instead of refusing, ONLY where
   the measured answer equals node (`j6_reassigned_target.js` → 3); if any
   in-file function shape still reads a wrong prototype, keep the refusal for
   that shape and name it.
6. **Doc-comment correction** in `applyRuntimeNewTargetPrototype`: the
   §10.1.14 guard repaired DataView only; the typed-array carrier still
   answers `null` because its `Object.getPrototypeOf` reader is broken on main
   (`f2_ta_bind_noproto.js`). No code change.

Measurement protocol: base = a `git archive origin/main` tree; oracle node 22,
changed test files also under node 25. Harness `.tmp/rv/cmp.mts` (base / fix /
node) with the probes in `.tmp/rv/p/` while the container lives — re-create any
missing probe from the one-liners in the verdict section. Every admitted shape
must equal node on standalone AND wasi; every shape still refused must carry
the verbatim `(#3371)` error on both targets.

Acceptance: (a) the 11 kept rows and the positive control still pass, and the
218-row control corpus (built-ins/Reflect/construct, language/expressions/
new.target, language/expressions/super, built-ins/Function/prototype/bind) loses
zero rows against origin/main — compile timeouts re-run alone at
`COMPILER_POOL_SIZE=1` before they count; (b) tests/issue-3371-r4-reflect-
construct-newtarget.test.ts gains one pin per step (admitted shape = node) and
keeps its `refusals kept` block green on standalone and wasi; (c) programs
without `Reflect.construct` byte-identical to origin/main on standalone, wasi
and host; (d) all gates green bare and with `LOC_GATE_BASE=origin/main`;
growth grants in this file's frontmatter with a dated rationale.

## 2026-09-05 r2 implementation (Opus)

**What this round is.** r2 implements the six lane-only over-refusals from the
round-1 verdict. It is a **soundness round, not a row-count round**: the owned
test262 rows are unchanged (12 pass / 12 non-pass, base and branch, set-diff
empty in both directions). What changed is the set of PROGRAMS the compiler
accepts — five shapes that node answers and round 1 refused now compile and
answer node, and four shapes the plan wanted admitted are shown by measurement
to answer WRONGLY and keep the refusal.

Worktree `/home/user/js2/.claude/worktrees/wf_eb120fff-87d-1`, branch
`worktree-wf_eb120fff-87d-1`, spawn base `origin/main` **c9a8b48616** plus the
plan commit 6f445141d3. `origin/main` advanced to 2257b950ee during the
session; the A/B base tree is c9a8b48616 (`git archive`, `.tmp/base`, verified
byte-equal to `c9a8b48616:src/codegen/expressions/reflect-construct-newtarget.ts`).
Oracle node 22 in this container; harness `.tmp/cmp.mts` (base / branch / node),
probes `.tmp/p/*.js`. Every number below is a run executed in this session.

### Steps — outcome per plan step

| Step | Plan asked | Outcome |
| --- | --- | --- |
| 1 | `targetReadsNewTarget` stops at nested ordinary functions | **Done as asked.** `readsNewTarget` stops at every scope that owns a `new.target` (function declaration/expression, method, accessor, class constructor); arrows, field initialisers and static blocks still inherit. |
| 2 | drop Boolean, String, Symbol from `UNSETTABLE_PROTOTYPE_CONSTRUCTORS` | **Only Symbol dropped.** The plan's premise does not survive re-measurement — see the table below. |
| 3 | `prototypeIsPristine` resolves the binding by symbol | **Partly.** The binding COUNT is gone (that was the over-refusal). The WRITE clauses must stay name-keyed; the reader they protect is itself name-keyed. |
| 4 | mutation of `NT.prototype` is not replacement | **Done as asked**, plus the measurement the plan requested for the descriptor-write shape. |
| 5 | in-file function targets use the `unknown` carrier route | **Narrowed four times.** Only a target that does NOT resolve to one unreassigned function declaration is admitted. |
| 6 | doc-comment correction | **Done**, with both carriers measured. |

### Step 1 — a nested function's `new.target` is its own

| probe | node | base | branch |
| --- | --- | --- | --- |
| `b5_nt_nested_newtarget.js` (nested function declaration) | 7 | `(#3371)` CE | **7** |
| `b5b_nt_nested_fnexpr.js` (nested function expression) | 7 | `(#3371)` CE | **7** |
| `c2_direct_newtarget.js` (the target itself reads it) | 3 | `(#3371)` CE | `(#3371)` CE |
| `c6_arrow_newtarget.js` (an arrow in the target reads it) | 3 | `(#3371)` CE | `(#3371)` CE |

### Step 2 — the wrapper constructors, re-measured

Run with `UNSETTABLE_PROTOTYPE_CONSTRUCTORS` emptied, `--target standalone`:

| target | node | admitted | verdict |
| --- | --- | --- | --- |
| Array | 1 | 0 | prototype not recorded — keep refusing |
| Map | 1 | 0 | prototype not recorded — keep refusing |
| RegExp | 1 | 0 | prototype not recorded — keep refusing |
| Set | 1 | 0 | prototype not recorded — keep refusing |
| Function | 1 | LEAK | pulls a `js2wasm:runtime-eval` import — keep refusing |
| Boolean | 5 | 7 | dispatch stays nominal — keep refusing |
| Number | 5 | 7 | dispatch stays nominal — keep refusing |
| String | 5 | 3 | dispatch stays nominal — keep refusing |
| Symbol | 1 | 1 | never constructs; TypeError = node — **DROPPED** |

**The correction.** The plan's evidence for Boolean/String was a probe that only
compares `Object.getPrototypeOf(o)`. That probe passes. A probe that ALSO reads
a method through the patched chain does not: `o.valueOf()` answers the
primitive where node answers the wrapper object, and `String`'s `o.length` is
wrong too. Admitting them would convert a compile error into a wrong answer.
The nominal dispatch is pre-existing — with no `Reflect.construct` in the
program at all, `Object.setPrototypeOf(new Boolean(true), P)` reads back 2 on
BASE where node reads 1 (`.tmp/p/g_wrapper_setproto_base.js`; the String twin
is 6 vs node 5) — but a defect being older is not a licence to compile new
programs onto it.

`Number` was on the plan's keep-list for the wrong reason (it was said to
discard the prototype; it records it). It keeps the refusal for the same reason
Boolean and String do.

### Step 3 — resolve the binding, keep the write clauses name-keyed

| probe | node | base | branch |
| --- | --- | --- | --- |
| `m2_shadow.js` (a helper's parameter is also called `NT`) | 7 | `(#3371)` CE | **7** |
| `m5b_shadow_nodefprop.js` (an inner `const NT`, untouched) | 3 | `(#3371)` CE | **3** |
| `m1_control_noshadow.js` | 7 | 7 | 7 |
| `m3_control_nomut.js` | 7 | 7 | 7 |
| `m4_nt_reassigned.js` (a real reassignment) | 0 | 0 | 0 |
| `m5_nt_block_shadow_mutates.js` (a slot write to the inner `NT`) | 3 | `(#3371)` CE | `(#3371)` CE |

**Why the write clauses stay name-keyed.** The compiler's model of a function's
`prototype` slot is itself name-keyed. `.tmp/p/m5e_read_only_base.js` contains
no `Reflect.construct` at all — an outer `function NT(){}` and an inner
`const NT = function(){}` whose prototype slot is redefined — and the OUTER
`NT.prototype` reads null on **base** (base 5, node 6). With the write clauses
symbol-resolved, `m5_nt_block_shadow_mutates.js` compiled and answered 1 where
node answers 3. So symbol resolution is used for what it can decide (is this
identifier's binding declared once here?) and the spelling for what the reader
can actually distinguish.

### Step 4 — mutation vs replacement, and the descriptor-write measurement

| probe | node | base | branch |
| --- | --- | --- | --- |
| `b2_driver_protomut.js` (`NT.prototype.tag = 9`) | 7 | `(#3371)` CE | **7** |
| `b7_object_assign_proto.js` (`Object.assign(NT.prototype, …)`) | 7 | `(#3371)` CE | **7** |
| `c3_defineprop_on_proto.js` (`Object.defineProperty(NT.prototype, …)`) | 7 | `(#3371)` CE | **7** |
| `d1_defineprop_slot.js` (`Object.defineProperty(NT, "prototype", …)`) | 7 | `(#3371)` CE | `(#3371)` CE |
| `d3_setprotoof_nt.js` (`Object.setPrototypeOf(NT, …)`) | 3 | `(#3371)` CE | `(#3371)` CE |

**The plan's open question, answered.** With every refusing clause disabled,
`d1_defineprop_slot.js` compiles and answers **1** where node answers **7** —
the instance lands on `%Object.prototype%`, neither `getPrototypeOf(o) === P`
nor `o.tag === 9` holds. The descriptor-written object-literal carrier IS
dropped by `__native_construct_N`'s `ref.test $Object`; the code comment citing
that shape as the rationale is correct as written, and now carries the
measurement. The shape is refused twice over: TypeScript synthesises an expando
declaration for that `defineProperty`, so the in-file declaration count is 2.

`d3` is a deliberate conservative keep, not a defect: admitted, it measured 3 =
node, but `Object.setPrototypeOf(NT, …)` can change what `NT.prototype`
resolves to for a NewTarget with no own `prototype`, and the gate does not
require the NewTarget to be a function declaration.

### Step 5 — the in-file function target, narrowed four times

The plan's blanket version (route every declined function target to the carrier)
produces six wrong answers. Each narrowing below is one of them:

| probe | node | base | blanket | branch |
| --- | --- | --- | --- | --- |
| `j6_reassigned_target.js` (target is a reassigned `let`) | 3 | `(#3371)` CE | 3 | **3** |
| `j10_const_alias_target.js` (`const T = F`) | 3 | `(#3371)` CE | 3 | **3** |
| `j12_generator_target.js` | 1 | `(#3371)` CE | 1 | **1** |
| `d1_defineprop_slot.js` | 7 | `(#3371)` CE | 1 | `(#3371)` CE |
| `m5_nt_block_shadow_mutates.js` | 3 | `(#3371)` CE | 1 | `(#3371)` CE |
| `d3_setprotoof_nt.js` | 3 | `(#3371)` CE | 1 | `(#3371)` CE |
| `j7_spread_args.js` (static target, spread) | 7 | `(#3371)` CE | 0 | `(#3371)` CE |
| `j8_many_args.js` (static target, 10 args) | 3 | `(#3371)` CE | 1 | `(#3371)` CE |
| `j9_reassigned_target_spread.js` (dynamic target, spread) | 7 | `(#3371)` CE | TRAP | `(#3371)` CE |
| `j11_async_target.js` (`async function` target) | 1 | `(#3371)` CE | 0 | `(#3371)` CE |

The mechanism the round-1 refusal named — "the post-construction patch is a
no-op on a closed instance struct" — is real, but it applies only when the
ordinary `new` lowering can pick the closed-struct path, which needs the target
to resolve statically. A target it cannot resolve takes the generic
`__object_setPrototypeOf` route, exactly as an `unknown` target does on base
(`k1_target_param.js`: node 3, base 3). So the branch admits only a function
target that does NOT resolve to one unreassigned function declaration, and
still requires: standalone, `prototypeIsPristine`, the driver's argument-shape
limits, and that the target is not an `async function`.

### Step 6 — the §10.1.14 guard repaired DataView only

| probe | node | base | branch |
| --- | --- | --- | --- |
| `f1_dv_bind_noproto.js` (DataView, bound NewTarget with no own prototype) | 3 | 3 | 3 |
| `f2_ta_bind_noproto.js` (Uint8Array, same) | 3 | 1 | 1 |

Comment corrected; no code change. `Object.getPrototypeOf` on a
dynamically-typed typed-array view answers null on base with no
`Reflect.construct` in the program, so no guard in this arm can repair what
that reader reports.

### One regression, found by the row run and repaired

Step 3's first cut required the NewTarget identifier to have exactly one
declaration. A lib global has many (`Array` is an interface plus a var plus
`ArrayConstructor`), so
`built-ins/Reflect/construct/return-with-newtarget-argument.js` — one of the
eleven rows r4 gained — went **pass → compile_error**. The count is now over
declarations in THIS source file only: a lib global has zero, a genuine second
in-file binding still refuses, and TypeScript's synthesised expando declaration
for `Object.defineProperty(NT, "prototype", …)` is in-file, so `d1` stays
refused by that clause too.

### Rows — 24 owned (23 + the positive control)

`.tmp/rows-owned.txt`, `npx tsx scripts/run-test262-paths.mts --isolate …
--standalone`, `COMPILER_POOL_SIZE=2`, 2026-09-05; base tree `.tmp/base`
(`git archive` of c9a8b48616), branch tree this worktree.

| | base c9a8b48616 | branch |
| --- | --- | --- |
| pass | 12 | **12** |
| fail | 9 | 9 |
| compile_error | 3 | 3 |

**Rows lost: 0. Rows gained: 0. Non-pass set-difference: empty in both
directions.** All eleven rows r4 gained plus the positive control
`return-without-newtarget-argument.js` still pass.

### Probe sweep — 44 probes, standalone and wasi

`.tmp/sweep2-standalone.txt` and `.tmp/sweep-wasi.txt`:

- **standalone:** every probe that compiled on base answers identically on the
  branch (zero base-drift); every newly-admitted probe equals node; every
  remaining refusal carries the verbatim `(#3371)` error.
- **wasi:** only the two `Symbol` probes differ from base, both to node's
  answer. The step-5 branch is gated on `ctx.standalone`, so a wasi build sees
  base's refusal for every other shape.

### Byte identity — programs without the distinct-NewTarget arm

`.tmp/bytes.mts`, sha256 of the emitted binary, base vs branch, three targets:

| program | standalone | wasi | host |
| --- | --- | --- | --- |
| `z_plain.js` (classes, `new`, `super`, a nested `new.target`) | SAME | SAME | SAME |
| `z_views.js` (DataView, typed array, bind, setPrototypeOf) | SAME | SAME | SAME |
| `z_reflect_other.js` (2-arg construct, `NT === F`, static `NT.prototype = …`) | SAME | SAME | SAME |

`BYTE-IDENTICAL: all` — main's own `Reflect.construct` paths are untouched.

### Control corpus — 218 rows, 0 lost

`built-ins/Reflect/construct/**` + `language/expressions/new.target/**` +
`language/expressions/super/**` + `built-ins/Function/prototype/bind/**`
(`.tmp/rows-controls.txt`, 218 rows), same isolated standalone runner,
`COMPILER_POOL_SIZE=2`, both trees run concurrently under identical box load,
2026-09-05:

| | base c9a8b48616 | branch |
| --- | --- | --- |
| pass | 166 | **166** |
| fail | 49 | 49 |
| compile_error | 3 | 3 |

Zero rows changed status in either direction; the non-pass set-difference is
empty both ways. **No `compile_timeout` in any of the four runs**, so the
re-run-alone step the lane protocol requires did not apply.

### Pins

`tests/issue-3371-r4-reflect-construct-newtarget.test.ts` — **42 tests, all
green** at `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, `--pool=forks
--poolOptions.forks.singleFork=true --no-file-parallelism`, on **node 22 AND
node 25.9.0**. Nine are new this round: five parity pins (one per admitted
step) and four refusal pins (the Boolean wrapper, the `async function` target,
the spread-on-dynamic-target trap, the same-named prototype-slot write). The
refusal block runs on standalone AND wasi.

Two pins were first written with TypeScript spellings that do not compile to
the shape they name, and the first pin run caught both. Both are separate
PRE-EXISTING defects, measured on base:

- `(NT.prototype as any).tag = 9` loses the mutation (3); the plain
  `NT.prototype.tag = 9` answers 0.
- `let T: any = F; T = G;` traps — the `any` annotation, not the NewTarget. On
  BASE, `Reflect.construct(T, [1])` (two arguments, main's own path) on the
  same binding traps identically, and `new T(1)` answers 1 where node answers
  0. The untyped `let T = F` answers node.
  **Corrected 2026-09-06 (review round 1):** "traps" understated it. The shape
  reads a silently WRONG prototype first and traps only on a later field read,
  so it is now refused rather than recorded — see the round-1 subsection and
  residual 3 below.

### Gates

`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit`, `lint` — all exit 0, run bare and with `LOC_GATE_BASE` set to BOTH
the spawn base c9a8b48616 and the advanced 2257b950ee. Growth grants are in
this file's frontmatter. No `scripts/*-baseline.json` was touched.

### Residuals — with mechanisms

Everything r4/round-1 listed stays open; this round adds three, each measured
on base rather than inferred:

1. **The wrapper carriers dispatch nominally.** `Boolean`/`Number`/`String`
   record a patched prototype but keep resolving methods on the intrinsic; on
   BASE, `Object.setPrototypeOf(new Boolean(true), P)` then `o.valueOf()`
   already answers the primitive where node answers the object. Until that
   carrier learns prototype-chain dispatch, those three NewTargets refuse.
2. **The compiler's function-`prototype` model is name-keyed.** A prototype-slot
   write to a same-spelled binding in another scope makes the OUTER
   `NT.prototype` read null on base. That is why `prototypeIsPristine`'s write
   clauses cannot be symbol-resolved, and why `m5_nt_block_shadow_mutates.js`
   refuses.
3. **A dynamic target annotated `any` is REFUSED (corrected 2026-09-06).** This
   entry said the shape "traps" and was "recorded rather than refused". Both
   halves were wrong. Re-measured in review round 1: `let T: any = F; T = G;`
   reads a **silently wrong prototype** first (`b1_dyn_two_fns` answers 4 —
   the probe's not-`NT.prototype` sentinel — where node answers 2) and only
   traps on a following field read (`i3_b1_detail`). A wrong answer is not a
   trap, and this arm may not produce one, so the shape now refuses;
   `dynamicTargetIsAllOrdinaryFunctions` declines any binding with an explicit
   type annotation. The underlying `any`-callee construct lowering is still the
   defect (on base the same binding misbehaves through the plain two-argument
   `Reflect.construct(T, [1])`), and fixing it is still not this arm's job —
   but until it is fixed the site is refused rather than answered.

Unchanged and still owned by other lanes: the `new.target` VALUE carrier
(#2023, 2 rows), reified class prototypes in standalone, the ArrayBuffer/Date/
Error carriers (#5150/#3240/#5156), the DataView post-read detach re-check and
the ArrayBuffer read-before-allocation point, the bound-function NewTarget
forwarding (#4196) and the realm shim, and the Proxy rows (#5316).

### Review round 1 (2026-09-06)

Five findings from the round-1 review of r2, each reproduced base/lane/node
before any edit and re-measured base/lane/fix after. Compile API via `npx tsx`,
`--target standalone` unless stated, oracle node 22, probes in
`.tmp/p/` (the reviewer's set, copied verbatim), harness `.tmp/b3.mts`.

Two of the five (R2-1, R2-2) were the same defect and share a fix.

#### R2-1 + R2-2 — the dynamic function target was gated on its INITIALIZER

`classifyRuntimeNewTargetSite`'s in-file-function branch called
`resolveBindingKind`, which follows `let T = F` to `F` and answers `"function"`.
It never looked at the later assignments, so a binding whose value at the call
site is something else entirely was admitted and answered wrongly — seven
programs where BASE refused:

| probe | shape | node | base | lane | fix |
| --- | --- | --- | --- | --- | --- |
| `c2_dyn_async_untyped` | `T = A` (async fn) | 0 | refuse | **5** | refuse |
| `c3_dyn_arrow_untyped` | `T = () => {}` | 0 | refuse | **5** | refuse |
| `c4_dyn_gen_untyped` | `T = function*(){}` | 0 | refuse | **5** | refuse |
| `o1_dyn_via_const_alias_chain` | `const A2 = A; T = A2` | 0 | refuse | **5** | refuse |
| `o3_dyn_undefined` | `T = undefined` | 0 | refuse | **5** | refuse |
| `o2_dyn_bound` | `T = G.bind(null)` | 2 | refuse | **NaN** | refuse |
| `i5_dyn_target_class_assigned` | `T = C` (class) | 3 | refuse | **13** | refuse |

The first five are the same failure: node throws a `TypeError` because the value
is not a constructor, and the lane returned an object instead (5 = "constructed
something"). `o2` returned `NaN`; `i5` read the wrong prototype AND the wrong
field.

**Fix** — `dynamicTargetIsAllOrdinaryFunctions` in
`src/codegen/expressions/reflect-construct-newtarget.ts`. It enumerates the
value set instead of sampling it: the declaration's initializer plus the
right-hand side of every plain `T = …` in the file, each of which must satisfy
`isUnreassignedOrdinaryFunction` (one unreassigned ordinary function
declaration — no alias hop, no call result, no class, no arrow, no
async/generator). Any write whose value set is not enumerable — a compound
assignment, `++`/`--`, a destructuring target, a `for…in`/`for…of` binding,
`with`, direct `eval` — refuses outright. `resolvesToAsyncFunction` was deleted;
the new predicate subsumes it.

Re-measured, the six shapes that must STAY admitted are unchanged and all equal
node: `c1_dyn_two_fns_untyped` 2, `c5_dyn_two_fns_cond` 2,
`k5_dyn_default_export` 2, `m1_dyn_args` 12, `m2_dyn_objreturn` 7,
`i4_dyn_target_protomut` 0.

#### R2-3 — an `any`-annotated dynamic target read a WRONG prototype

r2 recorded `let T: any = F; T = G` as "traps", and declined to gate on the
declared type on the grounds that a wasm-lowering question does not belong in a
source-shape gate. Measured, the annotated binding is worse than that: it is
silently wrong first and traps only on a later read.

| probe | node | base | lane | fix |
| --- | --- | --- | --- | --- |
| `b1_dyn_two_fns` (`let T: any = F; T = G`) | 2 | refuse | **4** (wrong prototype) | refuse |
| `i3_b1_detail` (same, then reads a field) | 2 | refuse | **trap** | refuse |

`4` is the probe's "prototype is not `NT.prototype`" sentinel, so the lane
answered a wrong prototype with no exception at all.

**Fix** — `dynamicTargetIsAllOrdinaryFunctions` refuses any variable
declaration carrying an explicit type annotation. Consulting the declared type
is legitimate here because the only thing it can do is turn an answer into a
refusal; the residual paragraph in `classifyRuntimeNewTargetSite` that called
this "traps, recorded rather than refused" is deleted. The unannotated twin
(`let T = F; T = G`) stays admitted and equals node — pinned both ways.

#### R2-4 — a nested function that is itself CONSTRUCTED

r2 stopped `readsNewTarget` at every nested ordinary function, on the reasoning
that `inner`'s `new.target` is `inner`'s and both sides answer `undefined`. That
holds only while `inner` is merely called. When `inner` is constructed, node
gives it a defined `new.target` and the class-id lowering still answers
`undefined`:

| probe | node | base | lane | fix |
| --- | --- | --- | --- | --- |
| `k1_nested_ctor_use` (`new inner()` inside the target) | 2 | refuse | **1** | refuse |

**Fix** — the stop is now conditional on `neverConstructed`: a method or
accessor (no `[[Construct]]` at all) always stops the scan; a named function
stops it only when every other mention of its name is the callee of a plain
call; an anonymous function expression stops it only when it is immediately
invoked; a class constructor never stops it. `a3_nested_method` (node 1) and
`a1_nested_fndecl` (node 1) stay admitted and equal node, so the fix is not a
blanket over-refusal.

Two probes measure a PRE-EXISTING defect this fix does not touch, recorded here
rather than fixed: `k1b_attr_no_reflect` and `k1c_attr_toplevel` construct a
function that reads its own `new.target` with no `Reflect.construct` in the
program at all — base, lane and fix all answer 1 where node answers 2. That is
the `new.target` VALUE carrier gap (#2023), not this arm.

#### R2-5 — the ownership comment was wrong about class field initialisers

The doc comment on `ownsNewTarget`/`readsNewTarget` said class field
initialisers and static blocks "inherit" the enclosing `new.target`. Per
§15.7.10 they are `[[Call]]`ed and see `undefined`; `a4_class_field` confirms it
(node 1). The comment is corrected.

The review asked whether treating them as owners — which would admit more —
answers node. **Measured, it does not.** With `PropertyDeclaration` and
`ClassStaticBlockDeclaration` added to the stop set (A/B via a file copy, the
only change in the tree), `a4_class_field` compiles and answers **2** where node
answers 1: the compiled class-field lowering reports a defined `new.target`
there. So the scan keeps descending into them and the site stays refused. The
measurement is written into the comment.

#### Full re-validation

**Probe sweep — 85 probes × 2 targets, base vs fix** (`.tmp/sweep-sa-*.txt`,
`.tmp/sweep-wasi-*.txt`):

| | standalone | wasi |
| --- | --- | --- |
| base-drift (base compiled, fix differs) | **0** | **0** |
| newly admitted (base refused, fix compiles) | 22 | 2 |
| of those, WRONG vs node | **0** | **0** |
| standalone host-import leaks | **0** | — |

Every remaining refusal is the verbatim `(#3371)` error (or, for three probes,
the *other* pre-existing `distinct NewTarget is not implemented for this`
refusal that base also emits).

**Byte identity — 38 programs × 3 targets (standalone, wasi, host).** The
corpus is every probe BASE compiles, i.e. every program that does not reach the
`(#3371)` arm. Comparing this worktree with my edits reverted against the same
worktree with them applied: **0 of 114 hashes differ.**

One caveat, measured rather than assumed. `b8_dyn_asyncarrow` differs in bytes
between the reviewer's base tree and this worktree on all three targets — but it
differs with my edits REVERTED too (`base = lane ≠ pre-edit integration tree`),
so it is inherited from the integration branch `claude/es6-test262-standalone-g10c7u`,
not from this round. Its behaviour is unchanged (node 0, base 0, fix 0).

**Rows — 24 owned**, `npx tsx scripts/run-test262-paths.mts .tmp/rows-owned.txt
--isolate --standalone`, `COMPILER_POOL_SIZE=2`:

| | lane (r2 branch) | fix |
| --- | --- | --- |
| pass | 12 | **12** |
| fail | 9 | 9 |
| compile_error | 3 | 3 |

**Rows lost: 0.**

**Control corpus — 218 rows** (`built-ins/Reflect/construct/**` +
`language/expressions/new.target/**` + `language/expressions/super/**` +
`built-ins/Function/prototype/bind/**`), same isolated standalone runner:
| | lane (r2 branch) | fix |
| --- | --- | --- |
| pass | 166 | **166** |
| fail | 49 | 49 |
| compile_error | 3 | 3 |

**Rows lost: 0**, and the comparison is per-TEST, not per-count: diffing this
run against the lane's own `.tmp/controls-fix.txt` reports `changed: 0` and an
empty non-pass set-difference in both directions. No `compile_timeout` in
either run.

#### Pins

`tests/issue-3371-r4-reflect-construct-newtarget.test.ts` grows by **nine**:
three admitted (R2-1 conditional reassignment, R2-3 the unannotated twin, R2-4 a
nested method) and six refused (R2-1 async, R2-2 the alias chain and the bound
function, R2-3 the `any` annotation, R2-4 the constructed nested function, R2-5
the class field initialiser). The refusal block runs on standalone AND wasi.

**57 tests, all passing, on node 22 AND node 25.9.0**, at
`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
--poolOptions.forks.singleFork=true --no-file-parallelism`.

One honest caveat. In THIS worktree vitest exits **1** on a single unhandled
`[vitest-worker]: Timeout calling "onTaskUpdate"` even though every test passes.
It is not this round's doing, and that is measured rather than assumed:
checking out the unmodified 42-test file at `HEAD` in the same worktree and
running the same command reproduces the identical single error and the
identical exit 1 (42 passed, 1 error). It also survives `--reporter=dot` and an
otherwise idle box. So the test-level result is green on both node versions;
the process exit code is an environment artifact of this worktree, and a future
round should not read it as a pin failure.

#### Gates

`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit`, `lint` — **all exit 0**, run bare (never piped) and, for the two
budget gates, again with `LOC_GATE_BASE=$(git rev-parse origin/main)` =
`22a6e4d51e`. The growth grant for this round is in this file's frontmatter
with a dated rationale. No `scripts/*-baseline.json` was touched.

### Review round 2 (2026-09-06)

Four findings from the round-2 review of the round-1 fix tree
(`worktree-wf_f3919b81-91f-1`, head `81352d81ef`). All four are the same class:
a shape BASE refused with the verbatim `(#3371)` error, which the round-1 tree
ADMITTED and answered wrongly. Node 22 answers `2` in every one. Compile API via
`npx tsx`, `--target standalone`, `COMPILER_POOL_SIZE=2`; probes in the round-1
reviewer's `scratchpad/p/` (copied to `.tmp/r3371r3/p/`), harness
`.tmp/r3/batch3.mts` (three compilers in one process: base = `git archive` of
`6f445141d3`, r1, fix).

| finding | probe | node | base | r1 | fix |
| --- | --- | --- | --- | --- | --- |
| F1 value-set never re-checks `new.target` | `y1_dyn_target_reads_nt.ts` | 2 | refuse | **1** | refuse |
| F2 function-expression initializer | `y3_dyn_fnexpr_init.ts` | 2 | refuse | **4** | refuse |
| F3 JSDoc `@type` bypasses the annotation gate | `w8_jsdoc_js.js` | 2 | refuse | **4** | refuse |
| F3 (same, `@type {Function}`) | `w11_jsdoc_function.js` | 2 | refuse | **4** | refuse |
| F4 named function EXPRESSION proved unconstructible | `c1_namedfnexpr_ctor.ts` | 2 | refuse | **1** | refuse |
| F4 (property-assigned twin) | `c1b_namedfnexpr_prop.ts` | 2 | refuse | **NaN** | refuse |

Controls, all unchanged r1 → fix and equal to node: `y5_ctl_direct_reads_nt.ts`
(the DIRECT target reading `new.target`) stays refused; `y6_fnexpr_second_value.ts`
(the same function expression as a LATER value) stays admitted at 1;
`w9_plain_js.js` (the unannotated `.js` twin) stays admitted at 2;
`w10_ts_any_twin.ts` (`let T: any = F`) stays refused;
`w2_typeof_annotation.ts` stays refused.

#### F1 — the value-set gate never re-ran the `new.target` check

`targetReadsNewTarget` resolves `ctx.oracle.declarationsOf(target)`. For a
REASSIGNED binding that answers the `let T = F` VariableDeclaration, so only
`F`'s identifier was ever scanned; `dynamicTargetIsAllOrdinaryFunctions` proved
each member an unreassigned ordinary function but never looked at a member's
BODY. `G` reading `new.target` was therefore invisible, while the direct control
`Reflect.construct(G, [], NT)` was correctly refused.

**Fix** — `dynamicTargetIsAllOrdinaryFunctions` now ends
`values.every((v) => isUnreassignedOrdinaryFunction(ctx, v) && !targetReadsNewTarget(ctx, v))`,
i.e. the same check the direct-target path runs, on every member.

#### F2 — a function expression in INITIALIZER position

`isUnreassignedOrdinaryFunction`'s first line accepts any non-async
non-generator `ts.isFunctionExpression`. As the declaration's initializer that
gives the binding a different callee lowering which drops the fetched
prototype — `y3` took the `getPrototypeOf(r) !== NT.prototype` branch (4). The
same expression as the SECOND value is fine (`y6` = node). Refusal is the
default, so the initializer position is refused rather than the lowering
chased: `if (ts.isFunctionExpression(declaration.initializer)) return false;`.

#### F3 — the annotation refusal was spelled `declaration.type`

A JSDoc `@type` in a `.js` file compiled with `allowJs` leaves
`declaration.type` undefined, so the JSDoc twin of the already-refused
`let T: any = F` slipped through. New `hasDeclaredType(declaration)` consults
`declaration.type`, then `ts.getJSDocType` on the declaration, its
VariableDeclarationList and the enclosing VariableStatement (a `@type` on a
`let` attaches to the statement).

#### F4 — `neverConstructed` proved too much for a named function EXPRESSION

The name-escape scan calls a named function unconstructible when its NAME never
appears outside a direct call. That is sound for a function DECLARATION and
wrong for an EXPRESSION, which is reached through the variable or property it is
assigned to, never through its own name. `neverConstructed` now returns
`isImmediatelyCalled(node)` for any `ts.isFunctionExpression`, named or not, and
runs the name-escape scan only for `ts.isFunctionDeclaration`. Controls `x1`/`x2`
(plain `new fn()` with no `Reflect.construct`) are wrong on BASE too and stay as
they are — **pre-existing, not this arm's doing**.

#### Optional — the value-set write scan is now symbol-resolved

Done, and it admits exactly the two intended rows. The scan matched `T = …`
TEXTUALLY, so an unrelated helper's written PARAMETER named `T`
(`w1_unrelated_param_named_T.ts`) and a block-scoped shadowing `let T`
(`v6_shadow_block_write.ts`) put `T + 1` and `7` in the value set and refused
the OUTER binding: both were `refuse` on r1 where node answers 2. Each write's
identifier is now resolved through `ctx.oracle.declarationsOf` and counted only
when it resolves to exactly this declaration; the same resolution replaces the
textual match in the `++`/`--` and `for…in`/`for…of` clauses. Both now answer
**2 = node**, and the corpus run below shows nothing else moved — so the
admitted set is exactly (textual-admitted ∪ writes-to-other-symbols).

#### Corpus, probes and bytes

- **89-file corpus** (`/home/user/js2/.tmp/rev3371r2/p/*.ts`, 85 `.ts`), 3-way
  base/r1/fix, `standalone` and `wasi`, separate runs:
  `moved(r1→fix)=0 baseChanged=0` on **both** targets. Zero rows that compiled
  on BASE change answer or compiled-ness.
- **Round-1 reviewer's probe set** (31 files, `standalone,wasi`):
  `moved(r1→fix)=8 baseChanged=0` — exactly the six intended refusals plus the
  two intended admissions, all on `standalone`; no `wasi` row moved.
- **Byte identity**, r1 vs fix, 85 corpus programs × `standalone`/`wasi`/`host`:
  `same=255 diff=0`.

#### Rows

`npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`,
`COMPILER_POOL_SIZE=2`; the 218 controls split into three ≤73-row chunks. No
`compile_timeout` in any run.

| | r1 | fix |
| --- | --- | --- |
| 24 owned | 12 pass / 9 fail / 3 CE | **12 / 9 / 3** |
| 218 controls | 166 pass / 49 fail / 3 CE | **166 / 49 / 3** (73+54+39 across the chunks) |

**Rows lost: 0.**

#### Pins

`tests/issue-3371-r4-reflect-construct-newtarget.test.ts` grows by **eight**:
four refused (F1 `y1`, F2 `y3`, F3 `w8` as a `.js` source with `allowJs`, F4
`c1`) and four admitted (F2's control `y6`, F3's control `w9`, plus the two
optional-scan rows `w1` and `v6`). Both source lists gained an optional
`fileName`, so a `.js` pin compiles under a `.js` name. **69 tests passed on
node 22 and on node 25** (`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
--poolOptions.forks.singleFork`). The single unhandled
`[vitest-worker]: Timeout calling "onTaskUpdate"` documented in round 1 is still
present on node 25 (exit 1 with 69/69 passing) and absent on node 22 (exit 0) —
an environment artifact of this worktree, not a pin failure.

r3 regression pins, in batches of three files: `issue-5195-es2015-class-r2`,
`issue-5195-r3-heritage-check`, `issue-5195-r3-restricted-properties` — 96
passed, exit 0; `issue-5195-r3-review`, `issue-5309`, `issue-5312` — 129 passed,
exit 0.

#### Gates

`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit`, `lint` — **all exit 0**, run bare (never piped).

**One finding worth acting on.** With `LOC_GATE_BASE=$(git rev-parse origin/main)`
= `78f1b2d03c` the LOC gate initially FAILED on
`src/codegen/expressions/calls-closures.ts` 2726 > 2699 (+27) — **not this
round's growth**. `git diff origin/main..HEAD` on that file shows only #5334's
rest-param-wrapper hunks and none of this round's; run against the round-1 head
the same gate names it "granted by …5334…" and exits 0. The grant lives in
`plan/issues/5334-rest-param-wrapper-metadata-illegal-cast.md`, which this
change-set does not modify, so against main it is **stranded**. Restated in this
file's frontmatter per CLAUDE.md, with the note that it lapses once the branch
merges `origin/main` — main's own copy of that file is 2699 with the helper
moved into `callable-property-host-value.ts`, i.e. main has superseded the hunk.
After the restatement both budget gates exit 0 at CI's base. No
`scripts/*-baseline.json` was touched.

### Review round 3 (2026-09-06)

Two findings from the round-3 review of the round-2 fix tree
(`worktree-wf_d4a1eb9d-d1d-1`, head `65efa1ba38`), both the same class as every
round before it: a shape BASE refused with the verbatim `(#3371)` error, which
the round-2 tree ADMITTED and answered wrongly. Plus two **over-refusals** —
programs round 1 answered like node and round 2 refused for a JSDoc type the
declaration does not carry. Compile API via `npx tsx`, `COMPILER_POOL_SIZE=2`,
node 22 as the oracle; probes in `.tmp/rev3371r3/p/` (49 files), harness
`.tmp/r3/b4.mts` (four compilers in one process: base = `.tmp/rev3371r2/base`,
r1 = `wf_f3919b81-91f-1`, r2 = `wf_d4a1eb9d-d1d-1`, fix = this tree).

| finding | probe | node | base | r1 | r2 | fix |
| --- | --- | --- | --- | --- | --- | --- |
| G1 named fn-expression constructs itself | `d1_named_iife_selfnew.ts` | 2 | refuse | refuse | **0** | refuse |
| G1 (plain-JS `new inner(0)` twin) | `d1b_named_iife_selfnew_plain.js` | 2 | refuse | refuse | **0** | refuse |
| G1 (`Reflect.construct(inner,[0])` twin) | `d1c_named_iife_selfreflect.ts` | 2 | refuse | refuse | **0** | refuse |
| G2 shorthand-destructuring write, arrow | `f1d_shorthand_destr_arrow2.ts` | 7 (TypeError) | refuse | refuse | **1** | refuse |
| G2 (a class as the written value) | `f1e_shorthand_destr_class.ts` | 3 | refuse | refuse | **NaN** | refuse |
| G2 (`{ T = 42 }`, defaulted shorthand) | `f1h_shorthand_default.ts` | 7 (TypeError) | refuse | refuse | **1** | refuse |
| G2 (dead-branch shorthand) | `f1_shorthand_destr_write.ts` | 1 | refuse | refuse | 1 | refuse |
| G2 (executed shorthand, ordinary fn) | `f1b_shorthand_destr_exec.ts` | 2 | refuse | refuse | 2 | refuse |
| G3 JSDoc `@type` in a `.ts` file | `c5_ts_with_jsdoc_type.ts` | 2 | refuse | 2 | **refuse** | 2 |
| G3 `@type` on a sibling declarator | `c7_jsdoc_second_declarator.js` | 2 | refuse | 2 | **refuse** | 2 |

The last two G2 rows are conservative losses, not fixes: round 2 happened to
answer them like node because the write it dropped was in a dead branch (`f1`)
or wrote an ordinary function anyway (`f1b`). They are refused again for the
same reason round 1 refused them — the value set is not readable off the source
when the write is a pattern — and a refusal is the sanctioned outcome.

Controls, all unchanged r2 → fix: `d2_named_iife_plain.ts` (a named IIFE that
never mentions its own name) stays admitted at 1 = node; `f1f_destr_renamed.ts`,
`f1g_destr_rest.ts` and `e7_destructuring_write.ts` were already refused through
the resolvable `T` inside the pattern; `c1`/`c2`/`c3` (real JSDoc annotations on
a single declarator in `.js`) stay refused; `c4_jsdoc_param_only.js` stays
admitted at 2; `a0`–`a5`, `b1`–`b7`, `d4`, `d5`, `d6`, `e1`–`e9`, `f2`, `f3` all
unchanged.

#### G1 — a named function EXPRESSION can reach itself by its own name

`neverConstructed` gained an unconditional `isFunctionExpression ⇒
isImmediatelyCalled` arm in round 2 (fixing F4, where a named function
expression assigned to a variable was wrongly proved unconstructible by the
name-escape scan). But a named function expression binds its own name **inside
its own body**, so an IIFE is still reachable from in there:
`(function inner(n){ if (n) { new inner(0); return } … new.target … })(1)`
constructs itself, node reads that `new.target` as defined, and the compiled
class-id lowering reads `undefined` — answer `0` against node's `2`.

The fix keeps the IIFE test and adds the escape scan back for the named case,
scoped to the body that is the only place the self-name is in scope: a named
function expression is unconstructible only when it is immediately called AND
its name never appears in its body except as the callee of a direct
`inner(...)`. The scan is the same one the function-declaration arm uses,
factored out as `nameEscapes(scope, name)`.

#### G2 — the oracle cannot resolve a destructuring shorthand

Round 2 made the value-set write scan symbol-resolved, so `T = …` counts only
when the written identifier resolves to this declaration — which correctly
stopped an unrelated parameter or block shadow from over-refusing. A shorthand
`({ T } = src)` is not resolvable that way: its `T` is a
`ShorthandPropertyAssignment` name and resolves to the object-literal property
(or to nothing), so `writesThis` answered false, the write was **dropped**, and
the value set collapsed to the initializer alone. `f1d`/`f1h` then answered `1`
where node throws a TypeError, and `f1e` answered `NaN` where node answers `3`.

Destructuring targets are matched **textually** again, exactly as round 1 did:
an `ObjectLiteralExpression`/`ArrayLiteralExpression` on the left of `=`, or in
a `for…in`/`for…of` head, that MENTIONS the name anywhere is an unenumerable
write and refuses — shorthand with or without a default, renamed, nested, rest
and spread alike. The symbol-resolved rule is kept for exactly the targets it
can resolve: a bare `T`, `T op= …`, `++T`/`T--`. That is the conservative
direction: a textual match on a pattern can only turn an answer into a refusal.

#### G3 — decided: narrow the two ATTRIBUTION cases, keep the `typeof F` refusal

`hasDeclaredType` consults JSDoc at three levels (declaration, declaration list,
statement) because a `@type` on a `let` attaches to the enclosing statement.
Two of those consults fired where the tag does not type this declaration:

- **A JSDoc tag in a `.ts` file is inert** — TypeScript reads types from syntax
  there and ignores `@type` entirely, so `c5_ts_with_jsdoc_type.ts` is the same
  program as the unannotated dynamic-target control. Narrowed with an
  `isInJSFile` guard (spelled off the file name; the project's TS API surface
  does not re-export `ts.isInJSFile`, which TS7 rejects).
- **A statement-level tag over several declarators types the FIRST one** —
  `/** @type {number} */ let n = 0, T = F` describes `n`. The list/statement
  consults now require a single-declarator list.

Both admitted rows answer **2 = node**.

**`c6_jsdoc_typeof_F.js` (`@type {typeof F}`) stays REFUSED — decided, not
overlooked.** That tag genuinely types the declaration; admitting it would rest
on measuring that this particular annotation leaves the callee lowering alone,
which is a per-annotation result that does not generalise to the next one. The
refusal costs an answer this arm never owed, and the rule stays legible: a
declared type refuses, whatever it says.

#### G4 — declined

`d3_named_fnexpr_called_only.ts` (a named function expression assigned to a
`const` and only ever called) is a conservative loss: round 1 answered 1 = node,
round 2 and this round refuse. Admitting it needs a second textual scan proving
the BINDING never escapes either — and the failure mode of that scan is a wrong
answer, which is precisely the class G1 was called to close in the same
function. Refusal is the default and it is kept.

#### Corpus, probes and bytes

- **Round-3 probe set** (49 files, `standalone`): `moved(r2→fix) = 10`, and the
  ten are exactly the intended set — the eight G1/G2 refusals (all carrying the
  verbatim `… NewTarget.prototype assignment (#3371).` message, checked in full
  rather than through the harness's 110-char truncation) and the two G3
  admissions, both equal to node. Nothing else moved.
- **89-file corpus** (`.tmp/rev3371r2/p/*.ts`, 85 `.ts` × `standalone` + `wasi`,
  170 rows): `moved(r2→fix) = 0`; of the rows that COMPILED on base, `0` changed.
- **Round-1 reviewer's probe set** (31 files, `standalone,wasi`, 62 rows):
  `moved(r2→fix) = 0`, `baseChanged = 0`.
- **Byte identity**, r2-predicate vs fix, measured **in this tree** by swapping
  only `reflect-construct-newtarget.ts` (file-copy A/B, no stash): 85 corpus
  programs × `standalone`/`wasi`/`host` = **255 hashes, 0 differ**. This is a
  predicate-only change.

  A cross-TREE byte comparison against `wf_d4a1eb9d-d1d-1` is **not** a valid
  measurement here and was discarded: that worktree does not carry the
  integration branch's other work, so its `host` bytes differ on 71 of 255
  programs for reasons unrelated to this change (`standalone` and `wasi` were
  identical on all 170).

#### Rows

`npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`,
`COMPILER_POOL_SIZE=2`; the 218 controls split into three ≤73-row chunks. No
`compile_timeout` in any run.

| | r2 | fix |
| --- | --- | --- |
| 24 owned | 12 pass / 9 fail / 3 CE | **12 / 9 / 3** |
| 218 controls | 166 pass / 49 fail / 3 CE | **166 / 49 / 3** |

**Rows lost: 0.**

Per-chunk control split: 73 + (54 pass / 16 fail / 3 CE) + (39 pass / 33 fail).

#### Pins

`tests/issue-3371-r4-reflect-construct-newtarget.test.ts` grows by **six**:
three refused (G1 `d1`, G2 `f1d`, G2 `f1h`) and three admitted (the G1 control
`d2`, plus the two G3 admissions `c5` and `c7`, the last as a `.js` source
through the existing optional `fileName`). **78 tests passed on node 22 and on
node 25**, exit 0 on both (`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 --pool=forks
--poolOptions.forks.singleFork=true --dangerouslyIgnoreUnhandledErrors`); the
`onTaskUpdate` unhandled-error artifact documented in earlier rounds is still
printed on node 25 and still does not fail the run.

r3 regression pins, in batches of three files: `issue-5195-es2015-class-r2`,
`issue-5195-r3-heritage-check`, `issue-5195-r3-restricted-properties` — 96
passed, exit 0; `issue-5195-r3-review`, `issue-5309`, `issue-5312` — 129
passed, exit 0.

#### Gates

`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`--noEmit`, `lint` — **all exit 0**, run bare (never piped).

Both budget gates also exit 0 with `LOC_GATE_BASE=$(git rev-parse origin/main)`
= `a1469a5454`. The round-2 **stranded grant** for
`src/codegen/expressions/calls-closures.ts` no longer fires: the integration
branch now carries a main tip in which #5334's hunk is superseded, so the gate
sees no growth on that file at all. Its restatement in this file's frontmatter
is left in place (it is inert, and removing it would re-strand the grant if the
base moves back). `src/codegen/expressions/reflect-construct-newtarget.ts` is
the only changed source file: 587 → 1072 LOC against main, granted here.

**One TS7 finding worth recording.** The first cut of the G3 narrowing used
`ts.isInJSFile`, which TS7 rejects — the project's `src/ts-api.ts` surface does
not re-export it (`error TS2339: Property 'isInJSFile' does not exist on type
'typeof ts'`), and `npx tsc` alone would not have caught it. Replaced with a
local file-name predicate matching `src/checker/multi-file-paths.ts`'s existing
convention.
