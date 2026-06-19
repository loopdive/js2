---
id: 2371
title: "standalone: for-in enumeration leaks __for_in_* host imports (un-runnable in --target standalone)"
status: in-progress
assignee: ttraenkler/sd1
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, standalone
language_feature: for-in, enumeration
goal: standalone-mode
origin: "2026-06-19 sd1 standalone host-import-leak hunt (object/class/property lane)"
---

# #2371 — standalone for-in leaks `__for_in_*` host imports

## Problem

`for (const k in obj)` in `--target standalone --nativeStrings` registers four
unsatisfiable JS-host imports — `env::__for_in_keys`, `env::__for_in_len`,
`env::__for_in_get`, `env::__for_in_has` — so the module **fails to instantiate**
against an empty import object. for-in is effectively un-runnable in standalone
mode for EVERY receiver shape (object literal, `any`, array, class instance).

```ts
const o = { a: 1, b: 2, c: 3 };
let n = 0;
for (const k in o) n++;   // standalone: LEAKS env::__for_in_keys/_len/_get/_has
```

## Root cause

`declarations.ts:1390` calls `addForInImports(ctx)` whenever `state.forInFound`,
**without** the `!ctx.standalone && !ctx.wasi` host-mode guard that its sibling
iterator-import finalizers carry (`collectIteratorImports` at :1376,
`collectArrayIteratorImports` at :1381). So the host imports are registered even
in standalone mode.

A static-unrolling fallback already exists in `statements/loops.ts:4712` for when
`keysIdx === undefined`, but it never fires in standalone because the imports
ARE registered (so `keysIdx !== undefined`). And the fallback itself is
**incorrect for arrays**: it enumerates the static TS type's `.getProperties()`,
which for an array yields `[length, toString, push, …]` (the Array prototype
methods) instead of the numeric index keys `"0".."length-1"`. It is correct for
object literals and class instances (their `.getProperties()` ARE the enumerable
own string keys, in declaration order).

## Fix (slice 1 — stop the leak; refuse cleanly)

1. **Gate `addForInImports`** on `!ctx.standalone && !ctx.wasi` (matching the
   iterator finalizers at `declarations.ts:1376/1381`), so standalone never
   registers the four `env::__for_in_*` host imports.
2. **Refuse standalone for-in with a clear compile-time diagnostic** in
   `compileForInStatement`'s no-host-import fallback, instead of the previous
   naive static-property unroll.

### Why a full native for-in is NOT in this slice

A correct standalone for-in needs two broad capabilities that a static unroll
cannot provide, so an unroll would *silently miscompute* rather than fail loudly:

- **Native key enumeration over the runtime value.** For an **array** the
  enumerable keys are the integer indices `"0".."length-1"`, which are NOT the
  static array type's `.getProperties()` (those are Array.prototype methods +
  `length`). For an **`any`/index-signature** receiver there is no static key
  set at all.
- **Native dynamic property read by a runtime string key.** The dominant for-in
  body shape is `for (k in o) … o[k] …`, and `o[k]` with `k` a runtime string
  has no native standalone path today — it returns `0`/default (verified:
  `o["a"]` via a runtime `let k="a"` → `0` in standalone, independent of for-in).
  So even an object-literal unroll, which materialises the correct KEY string,
  would let a value-read body compute wrong answers.

Both are tracked as the #2371 follow-up. Refusing is **strictly better** than the
pre-#2371 behaviour, where the host imports were registered and the module failed
to *instantiate* at runtime against an empty host — and it does not regress any
test262 standalone pass count (those tests could never run standalone; the CE
just re-buckets a never-passing test while removing the host-import leak).

## Acceptance criteria

1. for-in in `--target standalone --nativeStrings` emits ZERO `env::__for_in_*`
   imports (object / array / class / any receivers).
2. Standalone for-in produces a clear compile-time diagnostic (CE), not a host
   import leak and not a runtime instantiation failure.
3. Programs without for-in still compile clean in standalone (no spurious
   import / CE).
4. No regression in JS-host mode — host imports still registered and the
   existing for-in + #2066 deleted-property suites stay green.

## Follow-up (#2371 phase 2 — native for-in)

Implement a Wasm-native standalone for-in: enumerate own string keys over the
object struct (and integer indices over an array vec), and route the per-iteration
`o[k]` read through native dynamic-property-read-by-runtime-key. Depends on the
broader standalone dynamic-property-access capability.

## Evidence (2026-06-19 sd1 leak hunt)

Probe over the object/class/property lane (`--target standalone --nativeStrings`)
found for-in the sole leaking construct in that lane — all 29 object-literal /
class / getter-setter / property-access basics were already clean. for-in leaked
the four `__for_in_*` imports for every receiver shape tested (object literal,
`any`, array, class instance).
