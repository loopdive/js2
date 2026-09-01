---
id: 3371
title: "standalone: Reflect.construct arbitrary distinct NewTarget still refuses 33 ES2015 rows"
status: in-progress
created: 2026-07-17
updated: 2026-09-01
reopened: 2026-09-01
sprint: current
priority: high
horizon: l
feasibility: hard
model: terra
task_type: bugfix
area: codegen, runtime
language_feature: reflect, constructors, prototype chain
es_edition: ES2015
goal: standalone-mode
umbrella: 1781
related: [1472, 1781, 1905, 2026, 2046, 2618, 3240, 4196, 4661, 5138, 5140, 5143, 5150, 5153, 5154, 5156]
origin: "2026-09-01 immutable f841 standalone census; reopened because the prior done closure still refuses arbitrary distinct NewTarget."
checkpoint: ordinary-slice-authorized
---

# #3371 — standalone Reflect.construct with arbitrary distinct NewTarget

## Reopen decision

The prior implementation and closure are stale. On the fresh immutable census
below, 33 ES2015 paths end in the same compile error; this issue is therefore
**reopened** and must not be treated as done. This planning-only audit makes no
production or Test262-source change, creates no GitHub issue, and does not run a
compiler lane.

The former #2046 shared-file ownership gate is now released. Its implementation
was frozen and published only as nonmergeable draft PR #5397; no further source
work is active in that worktree and it is not a prerequisite for this issue.
This implementation branch starts from current upstream main
`2c3c27a54f78df2b71e034080dc509139776a2af`. The ordinary/class four-row slice
below is authorized after a fresh overlap audit, while every view, native,
bound-function, and Proxy carrier remains excluded.

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
| Local #3371 worktrees | `issue-3371-reflect-construct-ordinary-20260901`, current-main branch | Terra owns only rows 10-13 after this plan checkpoint commits. |
| Local #2046 worktree | Frozen at draft PR #5397; shepherded as nonmergeable and unqueued | No active file lease remains. Do not copy its unvalidated production diff. |
| #2046 source overlap | Draft #5397 edits the Reflect.set arm; #3371 owns the distinct Reflect.construct refusal | Keep this slice based on current main and avoid depending on the draft helper. |
| Open remote PR mentioning #3371 | Planning PR #5394, non-draft and queued before this branch was created | This branch carries that plan commit; do not open the implementation PR until its diff against current main is reviewed. |
| Open remote PR touching call-namespace-static.ts | None found | Re-check immediately before implementation. |
| Draft PR #5224 | WIP ES2015 buffers wave 1; changes DataView/buffer support but not call-namespace-static.ts | It does not block the ordinary carrier directly, but it owns adjacent view/buffer substrate for rows 1-9 and 16-17. |

Relevant issue states at this audit: #4661 done; #2026 in progress; #4196 and
#3240 ready; #5138, #5140, #5143, #5153, #5154, and #5156 in review; #5150 is
ready with its adjacent WIP #5224. Re-check both issue and worktree ownership,
not only labels, at the start of each implementation slice.

## Implementation slices and sequencing

Do not make a single patch for all 33 paths.

1. **Release the shared-file gate — complete 2026-09-01.** #2046 stopped as
   nonmergeable draft #5397, this branch was created from current upstream
   `2c3c27a54f`, and no active worktree now leases the Reflect.construct arm.
   Re-audit #2026/#5153/#5154 interfaces before editing and keep the ordinary
   carrier independent of #2046's draft helper.

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

### Safe first slice after the #2046 freeze?

**Yes, conditionally.** With #2046 frozen rather than landing, the four-row
ordinary/class slice is non-overlapping with its parked Reflect.set change and
does not require the #5224 view/buffer files. It is not blanket authorization
for all #3371 work: it must still honor any newly landed #2026/#5153/#5154
interfaces, and all view, native, bound, and Proxy groups remain separately
owned.

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
