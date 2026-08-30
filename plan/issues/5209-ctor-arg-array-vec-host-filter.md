---
id: 5209
title: An array-literal constructor argument reaches the host extern-method dispatcher as a compiled vec — `.filter` throws "filter is not a function"
status: done
completed: 2026-08-30
assignee: ttraenkler/dev-5209
sprint: current
priority: high
horizon: m
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5209 — `.filter` on a constructor argument dispatches against a compiled vec

## Problem

Tenth Temporal module-init blocker (#4628). With the full fix stack plus the
#5207 fix (PR #5279), the polyfill advances past "Invalid era data" and stops
at:

```
TypeError: filter is not a function
    at src/runtime.ts:14131          (extern-method dispatcher "no arm matched" throw)
    at invokeReusable                 src/runtime/fixed-extern-method-call.ts:27
    at GregorianBaseHelper_init ← OrthodoxBaseHelper_init ← EthiopicHelper_init ← __module_init
```

Source: the polyfill's `n.filter((e => null != e.reverseOf)).length > 1`
guard. `moduleInitRuns` stays false.

## Reduced repro (dev-5207, verified pre-existing on pristine origin/main; no IIFE involved)

```js
class HelperBase { constructor() {} }
class G extends HelperBase {
  constructor(e, t) { super(); this.eras = t.filter((x) => x.code); }
}
class Sub extends G { constructor(e, t) { super(e, t); } }
new Sub("c", [{ code: "a" }, { code: "b" }]);
// js2wasm: TypeError: filter is not a function · native: works
```

An array literal passed through a derived-class constructor chain arrives at
the `.filter` call site as a compiled vec struct, and the host extern-method
dispatch path (`fixed-extern-method-call.ts`) has no arm for it. Likely fix
direction: either keep the value on the compiled path (compiled `.filter` on
vecs exists) — the dispatch decision is wrongly routing to the host — or
marshal the vec before host dispatch. Decide with evidence; prefer the
compiled path (order-preservation, no host round-trip).

## Acceptance criteria

1. Reduced repro passes host AND standalone; also the polyfill's exact
   `.filter(cb).length` shape and a plain non-class control
   (`function f(t){ return t.filter(x=>x.code); }`). New
   tests/issue-5209-*.test.ts failing on base.
2. Temporal harness measured before/after on the full stack (#5252 → #5258 →
   #5262 → #5264 → #5266 → #5271 → #5279 → this). Advances past
   `filter is not a function`; new later blocker → report precisely for
   filing (coordinator allocates ids); `moduleInitRuns` true → say so LOUDLY.
3. No regressions in issue-5207 tests, array-method scoped runs, equivalence
   shards touching arrays (name them). Gates green.

## Notes

- Found by dev-5207 while validating PR #5279; pre-existing on origin/main
  (unmasked by the #5207 fix, not caused by it).
- Sibling #5210 covers the separate wasm-validation defect found at the same
  time.
- Id #5209 reserved with a degraded PR scan; manually verified against open
  PR head branches 2026-08-30. `check:issue-ids:against-main` arbitrates.

## Implementation notes (dev-5209, 2026-08-30)

### The throw was one of THREE defects on the same statement

`t.filter((x) => x.code)` inside a constructor running at module top level
failed three separate ways, each masking the next. All three are the same
window — in the JS-host lane top-level code runs in the wasm `start` section,
so `callbackState.getExports()` is `undefined` for the whole of module init —
and each is the next facet of the series #5193 → #5202 → #5203 → #5205 opened.

The order matters, because fixing only the reported one makes the bug WORSE:

1. **Dispatch (the reported throw).** `_wrapForHost` gated its vec→host Array
   facade on `getExports()`. During init the vec became the *generic object
   proxy* instead, which has no `filter`, so the extern-method dispatcher fell
   through every arm and threw `filter is not a function` (`src/runtime.ts`
   "no arm matched"). Fixed by giving the dispatcher's marshalling path
   (`wrapHostValue`, and the `_VEC_PRIMITIVE_READ_METHODS` arm) the
   `marshalExports()` view — the strict `exports` local is untouched, because
   most arms below read it as "init has finished".

2. **The callback never ran.** With (1) fixed, `filter` resolved and returned
   `[]`. `__make_callback` builds a bridge whose body is `exports.__cb_<id>`;
   `__cb_*` was not on the start-export channel, so
   `createNativeFunctionCallbackBridge` took its "park until exports exist"
   arm — **returning `undefined` to the caller on the spot**. That is right for
   an async reaction and silently wrong for `filter`/`map`/`some`. Fixed by
   registering `__cb_*` on the #5202 CSV channel and parking only when the
   compiled body is genuinely unreachable.

3. **The field read answered `undefined`.** `x.code` off an untyped callback
   parameter is a dynamic `__extern_get`, which needs `__sget_<field>`. #5205
   already registers that family at init, but `_safeGet`'s probe still asked
   `getExports()`. Fixed to `marshalExports()`.

Defects 2 and 3 are silent. That is why the new tests assert VALUES and why two
rows pin that init and post-init give the SAME answer for the same expression —
"answers differently depending on when it ran" is the actual bug.

### Why the host path, not the compiled path

The issue suggested preferring the compiled path. The evidence says the routing
is not the defect: `t` is an untyped constructor parameter, so `t.filter(cb)` is
a dynamic member call that codegen cannot resolve statically, and the identical
statement AFTER init already went through the host Array facade and was correct.
Only the timing differed. Keeping the value on the compiled path would have
required a new runtime `__is_vec` discriminator at every dynamic member call
site — a much larger change that would not have fixed defects 2 or 3.

### Also worth knowing

- `_wrapVecForHost` now reads exports through a **live slot** shared via
  `_hostProxyExportSlots`, not a captured snapshot. Views are cached for the
  lifetime of the vec, so a view born during init with the partial helper set
  would otherwise have kept it forever.
- The registration gate is decided from the module's IMPORT LIST (any
  `__extern_method_call*`) rather than from each of ~20 emitting call sites.
- `JS2WASM_DOGFOOD_STACK=1` now makes the Temporal harness print the init stack
  for a host-side TypeError. That stack names the polyfill function chain and is
  how the next blocker below was pinned in one run instead of by bisection.

### Measured

| | before (pristine origin/main + stack) | after |
|---|---|---|
| Temporal harness ESM init | `TypeError: filter is not a function` | `TypeError: The comparison function must be either a function or undefined: [object Object]` |
| `moduleInitRuns` | false | false |
| new test file, host lane | 8 of 18 assertions fail | 18/18 pass |

### Next blocker (for filing — id to be allocated by the coordinator)

Same function, one statement further:

```
TypeError: The comparison function must be either a function or undefined: [object Object]
    at Array.sort (<anonymous>)
    at invokeMethod                 src/runtime.ts:10952
    at GregorianBaseHelper_init ← OrthodoxBaseHelper_init ← EthiopicHelper_init ← __module_init
```

`invokeMethod` wraps struct arguments with `_wrapForHost(args[i], exports)`
where `exports = callbackState?.getExports()` — undefined at init — and it never
applies `_maybeWrapCallableUnknownArity` to arguments at all. So a compiled
COMPARATOR closure crosses as an opaque struct and V8's `Array.prototype.sort`
rejects it. Fix direction: `marshalExports` plus callable-wrapping of arguments
on that path. Deliberately NOT done here: `invokeMethod` is the DOM lane's hot
path and adding callable-wrapping semantics to arguments is a behaviour change
that deserves its own issue and its own regression run.
