---
id: 1695
title: "DisposableStack/AsyncDisposableStack prototype residuals decompose into #1596 (callable bridge) + #1330 (well-known Symbol dispatch) — no localized fix"
status: wont-fix
created: 2026-05-28
updated: 2026-05-28
priority: low
feasibility: trivial
reasoning_effort: low
task_type: investigation
area: docs, runtime
language_feature: explicit-resource-management
goal: planning
sprint: Backlog
parent: 820
related: [820h, 1596, 1330, 1640]
---
# #1695 — DisposableStack/AsyncDisposableStack prototype residuals (post-#820h)

## Investigation

The #820n umbrella-status doc (PR #809) listed **~45 fails** in
`built-ins/DisposableStack/prototype/*` + `AsyncDisposableStack/prototype/*` as
a candidate sub-bucket distinct from the #820h brand-check that already
landed.

Re-counted against `.test262-cache/test262-current.jsonl` (2026-05-28
baseline): the actual scope is **15 fails**, not 45. The 45 figure in the
triage included unrelated suite entries (e.g. `disposed/`, root-level
`prototype.js`, `Symbol.dispose.js`, etc.) that already pass. Filtering
strictly to `DisposableStack/prototype/*` + `AsyncDisposableStack/prototype/*`
yields:

```
DisposableStack/prototype/adopt/adds-value-onDispose.js                                 null_deref
DisposableStack/prototype/adopt/puts-value-onDispose-on-top-of-stack.js                 wasm_compile  "[object Object] is not a function"
DisposableStack/prototype/defer/adds-onDispose.js                                       assertion_fail (callback not invoked)
DisposableStack/prototype/defer/puts-onDispose-on-top-of-stack.js                       wasm_compile  "[object Object] is not a function"
DisposableStack/prototype/dispose/disposes-resources-in-reverse-order.js                wasm_compile  "[object Object] is not a function"
DisposableStack/prototype/dispose/does-not-reinvoke-disposers-if-already-disposed.js    assertion_fail (adoptCount off)
DisposableStack/prototype/dispose/throws-suppressederror-if-multiple-errors-during-disposal.js  assertion_fail (no SuppressedError)
DisposableStack/prototype/move/returns-new-disposablestack-that-contains-moved-resources.js    other  "assert is not defined"
DisposableStack/prototype/move/still-returns-new-disposablestack-when-subclassed.js     assertion_fail (subclass instance)
DisposableStack/prototype/use/Symbol.dispose-getter.js                                  wasm_compile  "Symbol(Symbol.dispose) is not a function"
DisposableStack/prototype/use/gets-value-Symbol.dispose-property-once.js                wasm_compile  "Symbol(Symbol.dispose) is not a function"
DisposableStack/prototype-from-newtarget-abrupt.js                                      type_error    "Object method called on null or undefined"
DisposableStack/prototype-from-newtarget-custom.js                                      type_error
AsyncDisposableStack/prototype-from-newtarget-abrupt.js                                 type_error
AsyncDisposableStack/prototype-from-newtarget-custom.js                                 type_error
```

## Root-cause decomposition

The DisposableStack / AsyncDisposableStack prototype methods themselves
(`use/adopt/defer/dispose/disposeAsync/move`) are **already registered as
extern-class methods** in `src/codegen/index.ts:7679-7714` and delegate to
the host's native `DisposableStack.prototype.*`. The protocol stubs that
landed under #820h are spec-correct. No prototype method is missing or
mis-wired.

The 15 residuals decompose into three unrelated, already-tracked root
causes:

### Cluster I — compiled wasm function not host-callable (~10 / 15)

Tests that pass a wasm-compiled closure (`stack.defer(() => …)`,
`stack.adopt(value, onDispose)`) to a host extern method. The compiled
function reaches the host as a `_wrapForHost` struct, not a callable, so
the host's `DisposableStack.prototype.defer/adopt/use` throws
"`[object Object]` is not a function" at the host call site, or the
callback is silently dropped (assertion_fail "callback not invoked /
adoptCount off / SuppressedError not thrown").

This is exactly the same bridging gap tracked by **#1596** (Function.
prototype.apply/call on compiled Wasm functions) and #1640 Cluster B
(Reflect.apply / Reflect.construct on compiled fn). Any host MOP that
*invokes* a compiled function hits this; DisposableStack is one of many
victims, not a distinct fix site.

Files affected: `adopt/*`, `defer/*`, `dispose/disposes-resources-in-reverse-order.js`,
`dispose/does-not-reinvoke-disposers-if-already-disposed.js`,
`dispose/throws-suppressederror-if-multiple-errors-during-disposal.js`.

### Cluster II — well-known Symbol method dispatch (~2 / 15)

`use/Symbol.dispose-getter.js`, `use/gets-value-Symbol.dispose-property-once.js`:
construct `{ [Symbol.dispose]() {…} }`, hand to `stack.use(o)`. The host
DisposableStack.prototype.use calls `o[Symbol.dispose]()`; the well-known
Symbol reaches the host as a real Symbol but the wasm-side object literal
materialised the computed-key method under a non-Symbol key, so the host
`Symbol(Symbol.dispose) is not a function`.

Same shape as **#1330** (RegExp Symbol.search protocol dispatch — well-known
symbol reaches host as real Symbol). Fix belongs in the computed-Symbol-
property-key codegen, not in DisposableStack.

### Cluster III — Reflect.construct newtarget bridging (~3 / 15)

`prototype-from-newtarget-*` tests exercise the `OrdinaryCreateFromConstructor`
/ subclass-newtarget path via `Reflect.construct(DisposableStack, [], NewTarget)`.
Hits `TypeError: Object method called on null or undefined` — same
Reflect.construct compiled-function bridging family as **#1596** / **#1640
Cluster B**.

### Cluster IV — harness artefact (1 / 15)

`move/returns-new-disposablestack-that-contains-moved-resources.js` —
`assert is not defined`. Runner-side harness loading, not a runtime bug;
ignore.

### Cluster V — subclass Species (1 / 15)

`move/still-returns-new-disposablestack-when-subclassed.js` —
`stack2 instanceof DisposableStack` returns false. Subclass Species
behavior for the moved stack; separate concern, low priority.

## Verdict

**No localized DisposableStack fix exists.** The 15 residuals are downstream
manifestations of:

1. Compiled-wasm-function host-callable bridging — **#1596** (~10 fails)
2. Well-known Symbol property-key dispatch — **#1330** (~2 fails)
3. Reflect.construct compiled-fn bridging — **#1596** / **#1640** (~3 fails)
4. Subclass Species — defer (1 fail)
5. Harness — ignore (1 fail)

Once #1596 lands, ~13/15 of these resolve for free. The remaining 2 are the
#1330 Symbol-dispatch shape and the Species subclass case — both belong
elsewhere, not in a DisposableStack-specific issue.

## Recommendation

Close as **wont-fix-standalone / superseded**. Tag the relevant tests for
re-validation when #1596 merges. Do not file a new DisposableStack
implementation issue; the prototype methods are already implemented
correctly via the host extern-class plumbing.

## Files inspected

- `src/codegen/index.ts:7679-7714` — DisposableStack / AsyncDisposableStack
  extern-class registration (methods + properties).
- `src/runtime.ts:3207-3208` — host import re-exports for both classes.
- `.test262-cache/test262-current.jsonl` — 2026-05-28 baseline failures.

## Out of scope

- Implementing #1596 (compiled-fn host-callable bridge) — separate issue,
  in flight.
- Pure-Wasm DisposableStack / AsyncDisposableStack — would be needed for
  standalone mode but is a separate workstream from the JS-host residuals
  here.
