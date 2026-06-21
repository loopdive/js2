---
id: 2546
renumbered_from: 2512
title: "standalone: object-key ToPropertyKey (#2042 R2) + native Object.is (#2042 S3 residual)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: objects, computed-member-access, coercion
goal: standalone-mode
related: [2042, 1472, 1917, 1900]
origin: "arch-dynshape #1472 spec R2 (06-17 S1) + S3 residual; TaskList #83, #80"
---

# #2042 R2 — standalone object-key ToPropertyKey hardening

## Problem (file-verified, current main, `--target standalone`)

```ts
const o: any = {};
const k: any = { toString: () => "abc" };
o[k]; // TRAP: "illegal cast"
```

A computed member access whose key is an OBJECT (`obj[{toString:()=>"k"}]`,
`obj[{valueOf:…}]`) trapped with an illegal cast. `__to_property_key` (#2042 S1)
ToPropertyKey'd AnyString and boxed-number keys but returned a `$Object` key
**unchanged**, so it reached the `ref.cast $AnyString` in the `$Object` runtime's
`__obj_find` / `__obj_hash` and trapped. (#2042 S1 PR #1629 fixed numeric/string
keys; object keys were the residual.)

## Fix

`__to_property_key` (`src/codegen/object-runtime.ts`) now routes a `$Object` key
through `__extern_toString` (§7.1.1 ToPrimitive(string) → ToString — the canonical
ToString used by `String(x)` / template literals), yielding the canonical string
key before the downstream cast. Because `__extern_toString` is registered LATER
in the same `ensureObjectRuntime` pass (forward dependency), the object-key arm is
**spliced into** `__to_property_key`'s body (held by reference in `mod.functions`)
immediately after `__extern_toString` registers — inserted before the
unchanged-fallthrough so Symbol/opaque keys still pass through. number / string /
variable keys are unchanged. standalone-only (host/GC mode's `__extern_*` imports
ToPropertyKey themselves).

## Acceptance criteria

1. `obj[{toString:()=>"k"}]` read/write/`in`/`delete` work standalone (no illegal
   cast); a `{toString}` key that yields a numeric string matches the numeric slot.
2. No regression: plain string / integer / variable numeric keys unchanged.

## Resolution (sdev-arrayrep, 2026-06-19)

Splice fix per above. `tests/issue-2042-r2-topropkey-object.test.ts` (8) green:
write+read/read-existing/`in`/`delete`/numeric-string-key via {toString}; string/
integer/variable-key regressions. `tsc` clean; #2042 (S1) / S3 / Reflect / object-
keys suites unchanged (the one pre-existing `non-integer numeric key` failure in
issue-2042.test.ts — `o[1.5]=4; return o[1.5]`→0 — is BROKEN ON MAIN without this
change, a separate float-key READ-path coercion gap, out of scope).

**Out of scope (#1917 engine gap):** a `valueOf`-ONLY object whose `valueOf`
returns a NUMBER stringifies to "[object Object]" (`__extern_toString` /
`__to_primitive`'s valueOf-number recovery), so `obj[{valueOf:()=>2}]` doesn't
match `o[2]`. This R2 fix removes the illegal-cast TRAP and makes the common
`toString`-keyed shape correct; the valueOf-number recovery is the #1917 engine
owner's concern.

## #2042 S3 residual — native `Object.is` (#80)

`Object.is` was a #1472-Phase-B refusal standalone (`__object_is` had no native
impl). Verify-before-claim found the S3 read-natives (getOwnPropertyNames/Symbols/
getOwnPropertyDescriptors) already shipped (PR #1639); the residual refusals were
`Object.is` and `Object.fromEntries`.

Implemented native `__object_is` (SameValue §7.2.10) in `object-runtime.ts` —
tag-dispatched over two boxed externrefs: both number → compare f64 BIT PATTERNS
(`i64.reinterpret_f64`+`i64.eq`, so NaN is SameValue NaN and +0 is NOT SameValue
-0); both boolean → unbox i32; both bigint → `__to_bigint` i64; both string →
value equality (`__str_flatten`+`__str_equals`); both null → equal; else WasmGC
`eq`-heap ref identity. Added `__object_is` to `OBJECT_RUNTIME_HELPER_NAMES` so
`ensureLateImport` routes it native under standalone. The string arm is safe here
(no wasm-opt stack-imbalance like #2508) because `__object_is` lives in the
object-runtime regime, which already calls `__str_flatten`/`__str_equals`
(cf. `__obj_hash`/`__obj_find`) — no cross-regime finalize index shift.

MEASURED: `Object.is(NaN,NaN)`→true, `(+0,-0)`→false, `(0,0)`/`(1,1)`→true,
`(1,2)`→false, booleans, equal/unequal strings by value, object ref identity —
all correct; no `env.__object_is` leak. `tests/issue-2042-s3-object-is.test.ts`
(7) green. (`Object.is(false as any, 0 as any)` reports equal due to the
pre-existing `<bool> as any`→number literal boxing quirk — not this helper.)

**Deferred (S3 residual follow-up):** `Object.fromEntries` still refuses
standalone — it needs native iteration over an entries iterable + `$Object`
build, a larger native-iteration slice than this contained `Object.is` win.
`__defineProperty_desc` stays deferred per the existing #2043 note.
