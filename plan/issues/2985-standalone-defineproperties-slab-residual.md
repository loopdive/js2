---
id: 2985
title: "Standalone: __obj_find illegal-cast on non-string computed keys (bool/bigint/opaque via __to_property_key)"
status: done
completed: 2026-07-02
assignee: ttraenkler/agent-dev-opus
sprint: current
priority: high
horizon: s
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2667, 2992]
origin: "#2965 descriptor-cluster triage — follow-up class 2 (typeof sub-cause already FIXED in #2965)"
---

# #2985 — standalone `__obj_find` illegal-cast on non-string computed keys

## Scope (narrowed, #2751 sizing pass)

This issue was originally the whole `defineProperties` 5-b/6-a slab residual
(~250, mixed bucket). An honest sizing pass (per the budget-window rule) split
it: the **bounded, discrete sub-bug** — the `__obj_find` illegal-cast on
non-string computed keys — is fixed here; the **~250 substrate-scale MOP
residual** (array/arguments own-prop MOP, accessor-attribute fidelity,
destructive `verifyProperty` survival) is re-homed to **#2992**.

## Problem (this slice)

Any computed property key that is neither an `$AnyString`, a boxed number, nor
an `$Object` — a **boolean** (`o[true]`), a **bigint** (`o[10n]`), or another
opaque primitive — reached `__to_property_key`'s fallthrough and was returned
**unchanged**. It then hit the downstream `ref.cast $AnyString` in
`emitClassifyKey` / `__obj_hash`, trapping:

```
RuntimeError: illegal cast  at __obj_find … __extern_set … __module_init
```

`__to_property_key`'s `#2042 R2` arm only ran `__extern_toString` for `$Object`
keys. Boolean/bigint/etc. keys are equally non-Symbol primitives whose
ToPropertyKey is `ToString(ToPrimitive(key,"string"))` (§7.1.1.1 → §7.1.17).

## Fix

Broaden the spliced R2 arm in `ensureObjectRuntime` (`src/codegen/object-runtime.ts`)
from "if key is `$Object` → ToString" to "if key is **NOT a Symbol** → ToString"
(unconditional ToString when symbol keys are disabled). A genuine Symbol still
falls through unchanged (looked up by identity via `__key_equals`, not by string
cast). Standalone-gated (`tpkBodyRef` is only set in standalone) → gc/host lane
byte-inert.

## Acceptance (met)

- `o[true]` / `o[false]` / `o[10n]` set→get→`in`→gOPD→defineProperty→delete-return
  all work in standalone (measured in `tests/issue-2985.test.ts`); previously
  trapped `illegal cast`.
- Symbol, string, number, and object computed keys unchanged (controls pass).
- gc/host output sha256-identical before/after (byte-inert).

## Out of scope → #2992

- Array/arguments own-property MOP; accessor-attribute fidelity; destructive
  `verifyProperty` survival. Note: the delete→re-read tombstone gap surfaced by
  `verifyProperty` reproduces for **plain string keys** too
  (`o["k"]=1; delete o["k"]; o["k"]===undefined` FAILs), i.e. it is a general
  standalone delete-tombstone bug, not key-type-specific — tracked in #2992.
- null/undefined **computed** keys: consistent self-roundtrip today (no trap),
  but `o[null]` is not canonicalised to `o["null"]`; TS also flags these as
  index-type errors. Deferred to #2992.
