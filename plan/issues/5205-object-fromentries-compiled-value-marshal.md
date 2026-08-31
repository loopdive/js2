---
id: 5205
title: __object_fromEntries hands a compiled value straight to the host — "object is not iterable" blocks Temporal module init
status: done
sprint: current
priority: high
horizon: s
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/opus-dev-5205
created: 2026-08-29
completed: 2026-08-29
# The `Object.fromEntries` lowering gains the #5193 start-export request (one
# flag + its rationale comment) and the handler gains the two-level marshal.
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - src/runtime.ts
  - src/codegen/init-class-dispatch-helpers.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/runtime.ts::resolveImport
---

# #5205 — `__object_fromEntries` does not marshal compiled iterables

## Problem

Seventh Temporal module-init blocker (#4628 Option A). On a probe tree with
#5252 + #5256 + #5258 + #5262 (+#5264), the polyfill bundle advances past
`__clz30` and stops at:

```
TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))
```

Stack: `Object.fromEntries → src/runtime.ts:14436 → __module_init`.
`moduleInitRuns` stays `false`.

## Mechanism (located by dev-5203)

The handler is a one-liner that hands the compiled value straight to the
host `Object.fromEntries`, which needs `Symbol.iterator`; an opaque WasmGC
vec has none:

```ts
if (name === "__object_fromEntries") return (iterable: any): any => Object.fromEntries(iterable);
```

Its immediate neighbour `__object_assign` DOES marshal
(`_isWasmStruct(s) ? _wrapForHost(s, exports) : s`). Expected to be a
small, well-scoped fix — the same marshalling shape as the neighbour, plus
the #5193/#5202 start-export channel so it also works during the init
window (the failing call IS at init).

## Acceptance criteria

1. Reduced repro: `Object.fromEntries` over a compiled array of pairs, at
   module init AND after init, host lane; new tests/issue-5205-*.test.ts
   failing on base, passing with fix.
2. Temporal harness advances past this error on the full probe stack. New
   later blocker → file it (coordinator allocates ids); `moduleInitRuns`
   true → say so LOUDLY.
3. No regressions in issue-5193/5202/5203 test files + Object.fromEntries /
   Object.assign scoped runs (name them). Gates green.

## Notes

- Blocker chain: #5191 → #5193 → #5201 → #5202 → #5203 → (#5204 capability)
  → this.
- Stack on PR #5264's branch (issue-5204-bridge-f64-params) — sanctioned
  predecessor-stacking; lands after #5252 → #5258 → #5262 → #5264.
- Id #5205 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.

## Implementation notes (2026-08-29, opus-dev-5205)

### The issue named one defect; the call site had two

The mechanism section is right: `__object_fromEntries` was a one-liner that
handed the compiled value to the host, and the host needs `@@iterator`
(§7.4.4 GetIterator) which an opaque WasmGC vec has not. Fixing only that
does **not** fix the Temporal call, because §7.1.19 AddEntriesFromIterable
then reads `Get(entry, "0")` / `Get(entry, "1")` off each **entry**, and a
heterogeneous `[key, value]` pair is a TUPLE struct — fields `_0`, `_1`,
readable only through `__struct_field_names` + `__sget_*`, which are exports
and therefore unreachable during the `start` section.

Measured on the polyfill with only the iterator half fixed: both
`Object.fromEntries` calls RETURNED — with `{ undefined: undefined }`
instead of the ten-key unit table. That is worse than the original throw
(silently wrong data), so the tuple half is not optional.

The neighbour analogy in the issue (`__object_assign`'s `_wrapForHost`) is
the right shape for the *source*, but not for the *pairs*: the proxy answers
property reads, and a tuple's properties are `_0`/`_1`, not `"0"`/`"1"`. It
stays as the last-resort fallback for a struct that is neither vec nor
tuple (an object literal `{0: k, 1: v}`, a class instance).

### What changed (three files)

1. **`src/runtime.ts`** — the handler materialises the SOURCE
   (`_materializeIterable`, already start-export aware since #5193) and then
   decodes each entry with a new `_decodeCompiledPair`, before handing the
   normalised entries to the native `Object.fromEntries` so ToPropertyKey and
   CreateDataPropertyOrThrow stay the engine's.
   `_decodeCompiledPair` is deliberately **shallow** — it rebuilds only the
   pair container and leaves both slots as the compiled references they were.
   The deep `_convertIterableForHost` was the tempting reuse and is wrong
   here: it would replace a compiled array VALUE with a fresh JS copy,
   severing `fromEntries([[k, a]]).k === a` and live mutation, neither of
   which this call site has any reason to break.
2. **`src/codegen/expressions/call-builtin-static.ts`** — the host-lane
   `Object.fromEntries` lowering now sets `ctx.needsInitMarshalHelpers`, so
   #5193's funcref prologue is emitted and `__vec_len`/`__vec_get`/`__is_vec`
   are reachable at init. Without this the runtime fix is inert at module
   top level: the reduced repro still threw with the handler already fixed.
3. **`src/codegen/init-class-dispatch-helpers.ts`** — #5202's name-based CSV
   registration now also covers the STRUCT-READ family (`__sget_*`,
   `__struct_field_names`, `__is_data_struct`). Per-field names are module
   dependent, so they cannot go in #5193's fixed positional ABI; the CSV
   channel already exists for exactly that reason. Runtime side needed no
   change — the registrar stores by name.

### Temporal harness (acceptance criterion 2)

Both rows executed here on 2026-08-29 on the same tree (this branch =
#5252+#5258+#5262+#5264 stack, `git merge origin/main` applied), ESM lane:

| tree | `moduleInitError` |
| --- | --- |
| base (branch without this fix) | `TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))` |
| + this fix | `WebAssembly.Exception` → `TypeError: Cannot access property on null or undefined at 4:10198` |

`moduleInitRuns` is **still false** — this clears the seventh blocker, not
the last one.

**Next (eighth) blocker, diagnosed, NOT an init-window bug:** source
position 4:10198 in the linked bundle is `ct = Intl.DateTimeFormat`. `Intl`
is simply not provided — a scoped probe fails identically at init AND after
init (`typeof Intl.DateTimeFormat` throws "Cannot access property on null or
undefined" in both), so this is a missing-global capability gap, not a
timing one. Reported to the coordinator for id allocation.

Both `Object.fromEntries` calls now return the correct ten-key tables
(verified by tracing the host imports during instantiation).

### Validation

- New `tests/issue-5205-fromentries-init-marshal.test.ts`: 8 cases, each
  pairing an at-init call with an after-init control. On base: **6 failed /
  2 passed** (the two passing are the deliberate controls — a host `Map`
  source and the non-iterable TypeError). With the fix: 8/8.
- No regressions: `issue-5191`, `issue-5193`, `issue-5201`, `issue-5202`,
  `issue-5203`, `issue-5204` (69 passed), plus scoped Object runs
  `issue-965`, `issue-2042`, `issue-2042-fromentries-objvec`,
  `issue-2042-r2-topropkey-object`, `issue-2190b-anytuple-nested`,
  `issue-3161`. `issue-2042-s3` + `issue-3160` have 4 failures in the
  STANDALONE `getOwnPropertyDescriptors` lane — verified identical on base
  (pre-existing, untouched by this change).
- `equivalence-gate.mjs` shards 1–8, lint, typecheck, and the loc/func/
  coercion/oracle/dead-export ratchets all green.
