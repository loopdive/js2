---
id: 5242
title: "A compiled class reached as a VALUE has no constructor bridge — 'compiled class constructor Duration bridge unavailable'; Temporal add/subtract construct Duration dynamically and throw"
status: done
completed: 2026-08-31
assignee: ttraenkler/senior-dev
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5242 — dynamic class-value construction has no constructor bridge

## Problem

After #5241 (PR #5350) un-hijacked the method calls, Temporal arithmetic now
reaches the polyfill and fails one level deeper:
`Temporal.PlainDate.from("2020-03-04").subtract({days: 1})` (and
`.add("P1D")`) throws `TypeError: compiled class constructor Duration bridge
unavailable` — in the SINGLE-MODULE lane, so it is not a provider-seam
defect. The polyfill constructs `Duration` through a class VALUE (its
intrinsics registry, `new (ce("%Temporal.Duration%"))(…)`), and a compiled
class reached as a value has no CONSTRUCTOR bridge: #5239 fixed the
`Object.create(value.prototype)` instance-minting path, but `new value(…)` /
Reflect-style construction through the host still finds no
`__class_construct_*`-equivalent export.

## Direction

Adjacent to #5239 (same registry-variable spelling, construct path instead
of create path). Reduce with a plain class reached via a registry object:
`const K = reg.K; new K(1,2)` through the host / dynamic lane. Emit or route
a constructor bridge the way #5239's `__object_create_class_instance` matches
prototypes — likely match the class-value mirror to its `struct.new` ctor by
identity, host-side `_construct`/callable-mirror arm in `src/runtime.ts` +
emission next to `emitClassMemberKindExports`. Mind the init-window channel
(#5202) — the polyfill constructs during module init.

## Acceptance criteria

1. Plain-class reduction: `new (reg.K)(…)` constructs a real instance
   (fields, methods, getters) — single-module and linked lanes; new
   `tests/issue-5242-*.test.ts` failing on base with a passing
   direct-identifier control.
2. `Temporal.PlainDate.from("2020-03-04").subtract({days: 1}).toString()` →
   `"2020-03-03"` single-module (provider lane may stay blocked by #5225's
   consumer-literal argument — measure and report per lane). Update harness
   KNOWN_GAPS accordingly.
3. No regressions in issue-5239/5241/5237/5223/5221/4628 + linker family;
   equivalence gate at baseline. Gates green.

## Notes

- Found by dev-5241 (PR #5350 "Reported, NOT fixed"); `subtract` fails
  identically on its base, so pre-existing. Sibling of #5239.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Implementation notes (2026-08-31)

### Root cause — TWO defects behind one message

The filed hypothesis ("no `__class_construct_*`-equivalent export exists") was
right about the fix and incomplete about the cause. `compiled class constructor
<Name> bridge unavailable` was reachable two independent ways, and both had to
be closed before Temporal's `Duration` could be constructed:

1. **The mirror froze a stale export view.**
   `_makeClassCtorMirrorForHost` built `callbackState = { getExports: () =>
   exports }` from the `exports` argument of the crossing that first minted the
   mirror, and the mirror is then cached in `_hostProxyCache` for the life of
   the module. For a class declared at top level that first crossing happens
   inside the wasm `start` section, where the only view available is the
   partial #5202 start-export registry (or nothing at all). Frozen, that view
   contains no `__call_fn_*` for the constructor — so a `new` on the class
   value threw for the module's whole run, long after the real exports existed.
   Measured: the frozen view had 19 entries where the live one has 59.

2. **The only route back into Wasm topped out at arity 4.**
   The mirror dispatched through `_wrapWasmClosureUnknownArity`, whose
   free-function arm uses `__call_fn_<N>` for N ≤ 4 and is emitted at all only
   when the module needs generic closure dispatch for some other reason.
   `Duration`'s constructor takes TEN parameters. Worse, `__call_fn_4` returns
   **null** for an unmatched closure rather than failing, and the mirror's
   `[[Construct]]` arm degrades a non-object result to `{}` — so once (1) was
   fixed in isolation the error simply changed to `Missing internal slot
   slot-years` from inside the polyfill, several frames away from the cause.

### What was built

- `src/codegen/class-value-construct.ts` — `__class_construct_<Class>_<arity>`,
  ABI `(externref × arity) -> externref`, calling `<Class>_new` with the same
  per-parameter coercion and result boxing the #5204 externref-backed METHOD
  bridges use. One export per class; the arity is in the name because there is
  exactly one constructor per class, so no metadata export is needed.
- Gate: `ctx.classCtorHostRegistered`, populated where
  `__register_class_ctor` is actually emitted (`expressions/extern.ts`). A
  module that never lets a class escape as a value emits identical bytes.
- The export joins the #5202 start-export channel
  (`CLASS_CONSTRUCT_EXPORT_PREFIXES`), so construction DURING module init
  works. This is not a nicety: on base the init-window construct throws inside
  `WebAssembly.instantiate` itself, i.e. the program never starts.
- Runtime: `_classCtorCallbackStates` records the LIVE export source per class
  object at registration; the mirror prefers it over its snapshot (the snapshot
  still answers during init, so init-window behaviour is unchanged).
  `_resolveClassConstructBridge` resolves and caches the bridge per export view.

### Deliberately NOT done

- **Rest-parameter constructors** (`constructor(...args)`) and constructors with
  a formal that has no externref boundary coercion (i32/i64/f32 native
  annotations, struct/vec refs) get no bridge and keep today's generic-closure
  behaviour. Widening either would need its own ABI contract, exactly as #5204
  decided for the method bridges.
- **The provider lane's Temporal arithmetic.** Measured on both sides today with
  a fresh `JS2WASM_TEMPORAL_CACHE` per run: the `knownGaps` block of
  `tests/dogfood/report/temporal-global.json` is byte-identical before and
  after. The residue there is the object-literal argument crossing the seam —
  #5225.
- **The `dateAdd` destructuring-parameter null.** After this change every
  single-module Temporal arithmetic row fails with `Cannot destructure 'null'
  or 'undefined'` from the ISO calendar's `dateAdd(e, {years=0, months=0,
  weeks=0, days=0}, i)`. Control: `add({days:1})` constructs no Duration at all
  and fails with the SAME message and the SAME stack on base, where no
  constructor bridge was involved. So it is a separate argument-marshalling gap
  on the dynamic method bridge (`__extern_method_call` → `__call_fn_method_3`),
  adjacent to #5221's destructuring work.
- **Un-marshalling the `__construct` / `__construct_closure` RESULT.** Those two
  imports exist only for compiled callers, and the host `[[Construct]]` arm
  hands back a `_wrapForHost` proxy, so returning the raw struct instead looked
  like an obvious companion fix (a constructor stores state keyed by the raw
  `this`, the caller then reads through the proxy). It was built, measured, and
  **removed**: with the bridge in place every probe answers identically with and
  without it, and the only observable difference was the *wording* of an
  unrelated pre-existing throw (`until` moved between two failure messages, both
  wrong). An unvalidated marshalling change on a path this hot is not worth
  carrying, so this PR is exactly the two root causes above.
- **`Temporal.Duration.from({days:1})` answering `"PT0S"`.** Wrong on base and
  wrong after, unchanged by this work; recorded here so it is not rediscovered
  as a regression.

### Cross-lane surprise worth keeping

In the LINKED lane the new path is now better behaved than the old one: an
instance minted through the host ctor mirror answers every member across the
seam, while a plain `new K(…)` inside the provider still loses them
(`label is not a function`). That asymmetry is pinned in the test rather than
asserted away — it belongs to the #5237 cross-module identity family.
