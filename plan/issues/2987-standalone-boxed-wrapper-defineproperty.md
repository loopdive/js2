---
id: 2987
title: "Standalone defineProperty / gOPD on boxed-wrapper receivers (~18: new String/Number/Boolean)"
status: done
completed: 2026-07-02
assignee: ttraenkler/opus-1c
sprint: Backlog
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2965, 1629]
origin: "#2965 descriptor-cluster triage — follow-up class 4 (boxed-wrapper receivers)"
---

# #2987 — standalone defineProperty / gOPD on boxed-wrapper receivers

## Problem

Follow-up from #2965. ~18 tests do `defineProperty` / `getOwnPropertyDescriptor`
on a boxed wrapper (`new String(...)`, `new Number(...)`, `new Boolean(...)`)
and fail on standalone — the wrapper receiver has no own-property MOP, and for
`new String` the exotic indexed own-properties (`"0".."n-1"` + `length`, all
`w:false, e:true, c:false`) are not modeled.

## Scope / mechanism

- defineProperty on boxed Number/Boolean wrappers (ordinary own-prop MOP on the
  wrapper struct).
- `new String` exotic string-index own properties per spec (10.4.3) for both
  gOPD and defineProperty (redefining an index must respect non-configurability).

## Acceptance

- Measured flip count on the boxed-wrapper defineProperty/gOPD standalone subset
  with zero regressions; gc/host byte-inert.

## Resolution

Measure-first found the boxed **Number/Boolean** wrapper MOP already round-trips
(they build as ordinary `$Object`s carrying their `[[PrimitiveValue]]` slot, so
`defineProperty`/gOPD hit the generic own-prop path — verified, no change
needed). The real gap was the **`new String` exotic string-index own
properties**: the native `__getOwnPropertyDescriptor`
(`src/codegen/object-runtime.ts`) resolves own keys via `__obj_find`, which
misses the String-exotic integer indices (`"0".."n-1"`) and `"length"` (they
have no ordinary `$PropEntry`), so gOPD returned `undefined` and the test trapped
dereferencing the missing descriptor.

Fix: when `__obj_find` misses, a new **String-wrapper exotic arm** recovers the
`[[StringData]]` native string from the FLAG_INTERNAL slot and synthesizes the
§10.4.3 descriptor —

- integer index in `[0, len)` → `{ value: <char>, writable:false,
enumerable:true, configurable:false }`
- `"length"` → `{ value: <len>, writable:false, enumerable:false,
configurable:false }`

reusing existing runtime helpers (`__obj_index_of_key`, `__str_charAt`,
`__str_flatten`, `__str_equals`, `__box_number`/`__box_boolean`). The arm is
gated `ctx.standalone && ctx.nativeStrings`; its 6 locals are emitted only when
active, so the **gc/host AND wasi lanes are byte-identical** to `origin/main`
(verified by sha256 over the compiled binary against the pristine compiler:
gc `edd791f0…`, wasi `78e59b06…` unchanged).

Concrete test262 cases unblocked include `15.2.3.3-3-14`
(`gOPD(new String("123"), "2").value === "3"`) and `15.2.3.3-4-192`
(`gOPD(new String("abc"), "length")` all-false data descriptor), plus every
`verifyProperty`-based test that first reads a String-index/`length` descriptor.

## Test Results

`tests/issue-2987.test.ts` — 10/10 pass (standalone): index-descriptor value +
attrs, `length` descriptor, out-of-range/non-index → `undefined`, ordinary user
own-prop still resolves, Number/Boolean wrapper non-regression, plain-object
skip. Existing `tests/issue-1910-string-wrapper-index.test.ts` (6) and
`tests/issue-2874-standalone-create-descriptor.test.ts` (7) still green.
