---
id: 6716
title: "standalone: an erased object return typed string must not take the native String method fast path"
status: blocked
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
es_edition: multi
language_feature: return-carrier-method-dispatch
goal: standalone-gap
parent: 4016
depends_on: []
blocked_by: ownership-coordination
related: [4016, 2576, 2742, 4096, 4121]
origin: "Atomically reserved 2026-09-28 by claim-issue.mjs; plan-only handoff, with no implementation claim."
---

# #6716 — erased object return / native String method dispatch

## Status and ownership boundary

This is a **plan-only, blocked** follow-up from
[#4016](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4016-standalone-string-search-value-tostring-path).
The atomic reservation is verified on `upstream/issue-assignments`, but the
reservation has no implementation assignee or branch. It authorizes this
handoff, not a carrier, closure, dispatcher, IR, or runtime edit.

The current IR coordination response is deliberately narrow:

- `src/codegen/index.ts` startup/init guards and bootstrap exemptions are
  currently owned elsewhere;
- `closure-exports.ts`, `closure-props.ts`, `object-runtime.ts`, and
  `context/types.ts` are closure-dispatch/class-authority surfaces owned
  elsewhere;
- no current assignment was reported for `statements/control-flow.ts`,
  `type-coercion.ts`, or `expressions/call-receiver-method.ts`.

That is task-local information, **not** global clearance. A future patch must
run a fresh pre-dispatch collision gate and obtain explicit coordination before
touching a return ABI, closure representation, shared carrier coercion, or
static member dispatcher.

## Measured semantic failure

The retained #4016 vnext control has this essential shape:

```ts
let order = 0;
const receiverValue = {
  [Symbol.toPrimitive]() { order = order * 10 + 5; return "a,b"; },
};
function receiver(): string {
  order = order * 10 + 1;
  return receiverValue as unknown as string;
}
function separator(): string { order = order * 10 + 2; return ","; }
function limit(): number { order = order * 10 + 3; return 1; }
function extra(): number { order = order * 10 + 4; return 0; }

try {
  receiver().split(separator(), limit(), extra());
} catch (_) {}
return order;
```

Native Node 24 produces a non-callable-member `TypeError` after receiver and
all call arguments evaluate, so the expected observation is `1234`.
`Symbol.toPrimitive` does not run: direct member access does not call
`String.prototype.split` on this object. The only measured standalone outcome
is instead `1`, rather than `1234`. That establishes a wrong-order/wrong-
dispatch result, but not which compiled carrier or branch produced it; it is
not a request to move the nullish `RequireObjectCoercible` boundary.

The latest fixture-only #4016 receipt is
`.tmp/4016/vnext49-candidate-47fd894d96-20260928.log` at compiler revision
`47fd894d96cc647cbe637741c98a9a60805eb4ff`: 44 pass / 5 fail, with this row
still ordinary red (`1`, expected `1234`). It is evidence for the diagnosis,
not a Test262 gain or a replacement for a dedicated carrier regression suite.

## Source-supported compiler route (emitted branch confirmation pending)

Source inspection supports, but emitted-module evidence has not yet confirmed,
the following candidate value-loss chain:

1. `resolveWasmType` in `src/codegen/index.ts` maps a static primitive
   `string` return to `ref $AnyString` when native strings are active.
2. `compileReturnStatement` in
   `src/codegen/statements/control-flow.ts` supplies that expected return type
   when compiling the erased asserted object expression.
3. `coerceType` in `src/codegen/type-coercion.ts` handles incompatible concrete
   reference types with a guarded `ref.test`/`ref.cast`; on this candidate
   route, the object would fail the `$AnyString` test and be coerced to a null
   native-string carrier.
4. `compileMethodCall` in
   `src/codegen/expressions/call-receiver-method.ts` would then admit the
   native string fast path from the static `isStringType(receiverType)` answer.
5. `compileNativeStringMethodCall` in `src/codegen/string-ops.ts` would receive
   that already-null carrier. If this is the emitted route, its staged split
   entry correctly applies the nullish member-base boundary before argument
   evaluation and has no opportunity to reconstruct the erased object.

If emitted-module evidence confirms this candidate, it distinguishes the
defect from generic `String.prototype` borrowed receiver coercion. The borrowed
form `String.prototype.split.call(object, …)` does call the builtin and
performs its own `ToString(this)` semantics; direct `object.split(…)` must
first perform runtime property lookup and callability.

## Related records that are not the same issue

- [#2576](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2576-anystr-value-rep-string-method-dispatch)
  is complete and handles an opaque `externref`/`any` value that *is* a native
  string at runtime. It does not cover an object erased into a statically
  `$AnyString` return.
- [#2742](https://js2wasm.loopdive.com/dashboard/issue.html?slug=2742-string-prototype-generic-receiver-tostring-this-coercion)
  owns generic borrowed `String.prototype` receiver semantics and explicitly
  excludes `split`/`search` protocol work.
- [#4096](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4096-closed-static-type-member-miss-lowers-to-null)
  is a completed closed-static member-miss slice with a different producer.
- [#4121](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4121-generic-carrier-unboxing)
  is broad numeric carrier work. It is not authorization to generalize this
  string/object result path.

These are cross-links only. This plan does not adopt their code, claims, or
acceptance criteria.

## Semantic requirement

For a direct member call whose static string annotation is erased at runtime,
the compiler must not manufacture a native string or null carrier merely to
use a String method fast path. It must preserve enough runtime value identity
to distinguish:

- a genuine native primitive string, which may retain the native fast path;
- an object whose direct property lookup yields no callable `split`, which must
  evaluate the already-specified arguments and then throw the normal
  non-callable-member `TypeError`; and
- a genuine nullish direct member base, which must still reject before argument
  evaluation.

The solution must not call `ToString` on the object as a shortcut: that would
incorrectly invoke its `@@toPrimitive` and turn a direct member miss into
borrowed-builtin behavior.

## Investigation and implementation plan

1. **Re-establish scope before code.** Run the atomic pre-dispatch gate and
   inspect the live issue-claim ledger immediately before dispatch. Obtain
   explicit approval from the owners of any return ABI/closure/carrier surface
   reached by the chosen design. If that coordination is absent, leave this
   issue blocked.
2. **Create a focused, route-proving control set.** Keep the exact `1234`
   direct-object row. Add a genuine primitive-string return positive control,
   a nullish direct-base ordering control, and a borrowed
   `String.prototype.split.call` object control. Require the object’s
   `@@toPrimitive` counter to remain zero in the direct-member case. Use a
   temporary emitted-route/WAT or context trace only if needed to establish
   where the carrier changes; remove it byte-exactly after the receipt.
3. **Choose a representation-preserving seam, not a string coercion patch.**
   Compare a return-boundary dynamic carrier, a trusted-native-string proof
   attached to return production, and a dispatcher fallback for untrusted
   static string values. Each option must account for declarations, local and
   closure returns, `coerceType` readers, and direct method calls. Do not
   modify `tryStructToString`, `String.prototype` borrowed lowering, or the
   split ROC ordering merely to satisfy this row.
4. **Implement only after coordinated ownership.** Keep the native primitive
   string ABI fast path intact where the runtime value is proven native. Route
   untrusted erased-object values through real property lookup/call behavior;
   preserve return identity and argument order. Any closure/record/layout need
   makes this a coordinated IR/representation slice rather than a local
   string-method change.
5. **Validate a genuine A/B.** Use the same focused fixture on a clean
   unchanged baseline and the implementation candidate, record source and
   fixture hashes, standalone import state, and all row transitions. Keep
   unrelated #4016 protocol, host-global-index, and descriptor residuals
   ordinary and visible. Run the relevant whole-assembly/Test262 cohort only
   after the focused route is correct.

## Acceptance criteria

- The exact direct-object return row observes `1234`, catches a normal
  non-callable-member `TypeError`, and does not invoke `@@toPrimitive`.
- A real primitive string return still uses a correct native String method
  path, with no new import or standalone regression.
- A nullish direct member base remains pre-argument abrupt.
- A borrowed `String.prototype.split.call` object receiver retains its
  independently correct `ToString(this)` behavior; it is not reclassified as a
  direct member call.
- The implementation has explicit owner clearance for every changed
  carrier/closure/dispatcher file, a fresh claim, and a same-fixture A/B
  receipt. No #4016 residual is hidden by a skip, expected failure, source-order
  workaround, or a broad generic coercion change.
