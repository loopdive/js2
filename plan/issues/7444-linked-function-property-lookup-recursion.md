---
id: 7444
title: "Standalone linked Temporal rows: own-property reads of provider functions miss, and the consumer's dynamic `new` loops through the provider"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: standalone, test262, codegen
goal: standalone-mode
depends_on: []
related: [7376, 6628, 6643, 6605, 6723, 6748, 5383, 2896, 4437]
---

# #7444 — linked provider functions: own-property misses and a construct loop

## Problem

After #7376 (merge `0ac748482e`, PR 7346) the test262 harness keeps only the
shim bindings a unit names, so most rows no longer carry `$262`. About 227
standalone Temporal rows (`name.js`, `length.js`, `prop-desc.js` and
similar) went from pass to `RangeError: Maximum call stack size exceeded`.
Rows compiled through `compileMulti` (the Temporal lane,
`compileWithTemporalGlobal`) never got the single-source dead-binding
elision, so before #7376 they always carried the whole shim.

Smallest test262 repro: `built-ins/Temporal/PlainDateTime/prototype/subtract/name.js`
on standalone with the Temporal provider linked. Measured on main
`ed0bf0a839`: the 6 repro rows named in the brief all fail with the stack
overflow; each passes when the body also names `$262` (a `// $262` comment
is enough, because the elision is textual).

There are **two** defects, not one. The stack-overflow frames
(`__builtinfn_get_meta` → `__fninst_bag_owns` → `__obj_find`,
`__js2wasm_link_reverse_get` → `__js2wasm_link_local_member_get`) are only
the leaves where the stack ran out. They are not the cycle.

## Diagnosis

### Defect B — own-property reads of a provider function miss (this costs the passes)

`verifyProperty(Temporal.PlainDateTime.prototype.subtract, "name", …)` fails
its first real assertion, `__hasOwnProperty(obj, name)`. A raw (no harness)
Temporal-linked unit shows it directly:

| raw unit (consumer, standalone, Temporal linked) | main |
| --- | --- |
| `Object.prototype.hasOwnProperty.call(PlainDateTime.prototype.subtract, "name")` | **false** |
| `Object.getOwnPropertyDescriptor(subtract, "length")` | **undefined** |
| `Object.getOwnPropertyNames(subtract)` contains `"name"` | **no** |
| `Object.prototype.hasOwnProperty.call(Temporal.Instant, "prototype")` | **false** |
| `Object.prototype.hasOwnProperty.call(PlainDateTime.prototype, "subtract")` | true |
| `subtract.name === "subtract"` (plain `[[Get]]`) | true |

The consumer answers function-instance `name`/`length` through
`__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_push_ownnames`
(`src/codegen/object-runtime.ts` ~L1540, #2896/#4437). Their `ref.test`
arms are spliced in at finalize from the consumer's **own** closure and
builtin-function meta types. A consumer with no such closures of its own
keeps the constant default body (`ref.null.extern`; `.tmp/h1.wat` L5751), so
`__hasOwnProperty` cannot see a provider function's `name`. The provider's
closure structs are canonical runtime types, so when the consumer does
register the same `$fnmeta` struct shapes for its own closures, its arms
recognise the provider's functions too. That is an accident of the
consumer's inventory, not a design.

A class object (`Temporal.Instant`) has the same gap for `prototype`.

### Defect A — the consumer's dynamic `new` hands its own closure to the provider (this turns every failed assertion into a stack overflow)

Once an assertion fails, `assert` runs `throw new Test262Error(message)`.
The minimal raw repro needs neither the harness nor any Temporal call:

```js
var o = {}; o.x = function () {};   // any expando write; selects the dynamic `new` lowering
function T(m) { if (!(this instanceof T)) return new T(m); this.m = m; }
new T("m");                          // stack overflow when the Temporal provider is linked
```

The same unit passes without a provider. The full cycle, with every frame
recorded (`Error.stackTraceLimit = 1e5`, `.tmp/dump.mts`):

```
__module_init → __native_construct_1 (consumer)
  → __js2wasm_link_construct (provider) → __apply_closure → __call_fn_method_1 (provider)
  → __fn_tramp_T_cached (consumer) → `this instanceof T` is false
  → __ir_dyn_construct_1 → __native_construct_1 (consumer) → … (repeats)
```

1. The consumer's arity-N construct driver (`src/codegen/native-construct.ts`,
   the `boundaryPairs` arm ~L688; the argv driver has the twin ~L387) asks
   the peer `__js2wasm_link_callable_kind(callee) & 2` **before** its own
   closure tail.
2. The provider answers through `__is_callable` / `__reflect_is_constructor`
   (`fillStandaloneLinkBoundaryLateTerminals`,
   `src/codegen/standalone-link-boundary.ts` ~L438). Those are structural
   `ref.test`s, and closure structs are canonical across the link, so the
   provider claims **the consumer's own** `T`. The #6643 comment in
   `fillApplyClosure` names the same fact: the predicate is not a statement
   about ownership.
3. The provider cannot construct a consumer closure correctly:
   - it reads `callee.prototype` through its own `__extern_get`. The
     consumer's `T.prototype` is a lazily materialised consumer global (see
     `__ir_instanceof_fn_T`), which the provider never sees;
   - it installs the receiver in **its own** `__current_this`, while the
     consumer trampoline reads the consumer's cell.

   So inside `T`, `this instanceof T` is false and `T` re-enters `new T()`
   forever.

Experiments on this tree (not shipped):

| change | m6 / `new Test262Error` repro | 6 brief rows |
| --- | --- | --- |
| skip the peer construct arm in the consumer | passes | clean `Test262Error` failures (Defect B) |
| share `__current_this` across the link (provider exports it, consumer imports it) | **still overflows** | still overflow |

The second row shows that the receiver cell is not enough. The provider's
`prototype` read is also wrong for a foreign closure.

### Why `$262` hid both

The member that matters is `globalThis.eval`, read in `$262.createRealm`.
Leave-one-out over the shim: only `createRealm` matters. Inside it, only
`{ eval: globalThis.eval }` matters; each other `globalThis.X` alone does
not. A consumer that reads `globalThis.eval` gets the runtime-eval
machinery. Its closure inventory then includes the canonical
`$fnmeta`-bearing struct types, so `__hasOwnProperty` grows the
`__builtinfn_get_meta` arm (718 vs 197 lines, `.tmp/ge.wat` vs `.tmp/h1.wat`)
and recognises provider functions (Defect B hidden). The m6 unit plus
`var zz = { e: globalThis.eval }` also no longer loops (Defect A hidden).
Neither is the shim's direct `eval` call or a line offset.

## Implementation Plan

Two slices. Slice 1 recovers the passes. Slice 2 makes a failing assertion
report itself instead of overflowing, and fixes dynamic `new` across the link.

### Slice 1 — Defect B (own properties of provider-owned values)

- Module: the standalone link boundary (`src/codegen/standalone-link-boundary.ts`
  for the provider terminal, `src/codegen/standalone-link-reverse-peer.ts` /
  `object-runtime.ts` own-property bodies for the consumer arm). Do not grow
  `object-runtime.ts`: put any new arm builder beside
  `boundaryOwnPresenceArm` / `buildOwnPropertyBody`
  (`src/runtime/wasmgc/values/own-property-bodies.ts`).
- Preferred shape: a provider export `__js2wasm_link_get_own_property_descriptor(v, key)`.
  It has the same "mine / not mine" contract as `__js2wasm_link_has` and is
  filled from the provider's own `__getOwnPropertyDescriptor`. The consumer's
  `__hasOwnProperty` / `__object_hasOwn` / `__getOwnPropertyDescriptor` /
  `__getOwnPropertyNames` call it as the miss arm for a value they do not
  own. One terminal covers closures (`name`, `length`) and class objects
  (`prototype`).
- Rejected alternative: registering the canonical `$fnmeta` closure types in
  every consumer. It covers `name`/`length` but not a class object's
  `prototype`, and it keeps answers dependent on struct-shape coincidence.
- Acceptance: the 6 brief rows plus 20 more Temporal
  `name`/`length`/`prop-desc` rows pass on standalone with main's harness. 60
  non-Temporal and 30 other Temporal rows have identical verdicts. JS-host
  (`gc`) output is byte-identical: the arm exists only where
  `isStandaloneLinkConsumer`. Focused test: the raw `hasOwnProperty` /
  `getOwnPropertyDescriptor` table above, compiled through
  `compileWithTemporalGlobal` (no harness). It must fail on main.

### Slice 2 — Defect A (who constructs a closure)

- Module: `src/codegen/native-construct.ts`, both peer construct arms. Reuse
  one predicate; do not copy.
- The consumer must construct its own closures. Shape cannot decide
  ownership, so decide by provenance:
  - **(a)** Gate the peer arm off for values that match this module's
    closure base wrappers (`collectClosureBaseWrapperTypeIdxs`, the #6628
    shape). A provider plain-function constructor that matches the same
    shape is then constructed by the consumer. That is correct only if the
    receiver cell is shared (provider exports `__current_this`, consumer
    imports it; pattern `standalone-link-error-ctor-cells.ts`). Prototype
    reads already forward through `__js2wasm_link_member_get`. Measure the
    residual risk first: per-module `new.target` / `__argc` / `__extra_args`
    globals read by a provider body.
  - **(b)** Keep provider-first, but make the provider's construct read
    `prototype` through the reverse peer for a value its own `__extern_get`
    does not own, and share the receiver cell.
- Decide between (a) and (b) by running both against `tests/issue-6605-*`,
  `tests/issue-6616-*`, `tests/issue-6628-*`, `tests/issue-6748-*` and
  `tests/issue-5383-standalone-temporal-provider.test.ts`. The #6643 note
  records that the broad "locally callable" predicate failed #6605/#6616 for
  apply. Check whether the construct twin has the same dependency.
- Acceptance: the m6 unit above runs on standalone with the Temporal
  provider linked, and a provider-owned plain `function` constructor
  constructed from the consumer still gets its `this`. Focused test
  `tests/issue-7444-linked-dynamic-new.test.ts`: m6 through
  `compileWithTemporalGlobal`. It must fail on main.
- Code-quality criterion for both slices: one ownership predicate shared by
  the apply and construct peer arms; no depth counters; no harness special
  case.

## Notes

- The quickjs eval adapter and the Temporal provider cache are keyed so that
  a local compiler change is not picked up automatically.
  `JS2WASM_TEMPORAL_CACHE=<dir>` with a hand-written
  `prewarm-standalone.json` (`{"key":"local"}`) enables the lane in
  `scripts/run-test262-paths.mts`. Delete `<dir>/temporal-project-*` and
  `<dir>/providers` after every compiler edit, and re-run
  `node --import tsx scripts/build-quickjs-eval-provider.mjs`.
- A trivial hand-written provider (`compileProject` on a 3-line package, the
  `tests/issue-6628-*` helper) did **not** reproduce Defect A. Its
  `callableKind` does not claim the consumer closure. The focused tests
  therefore need the Temporal provider, or a provider that materialises
  `__is_callable` and `__reflect_is_constructor`.
