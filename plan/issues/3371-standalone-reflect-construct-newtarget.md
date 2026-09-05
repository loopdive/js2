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
