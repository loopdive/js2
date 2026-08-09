---
id: 4099
title: "standalone: __object_keys and __object_keys_forin ignore FLAG_ENUMERABLE — every non-enumerable own property is enumerated"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES5
language_feature: object-enumeration
goal: standalone
horizon: m
parent: 2860
related: [3976, 4098]
origin: "found while making standalone class prototypes real objects (#3976, senior-dev-3976-class-elements, 2026-08-02)"
---

# `__object_keys` / `__object_keys_forin` ignore `FLAG_ENUMERABLE`

Both helpers walk `__obj_ordered(o)` and push **every** live entry's key. Neither
tests `FLAG_ENUMERABLE` (bit 1 of `$PropEntry.$flags`, field index 2). Verified
in `src/codegen/object-runtime-enumeration.ts`: the constant `FLAG_ENUMERABLE` is
referenced **exactly once** in that whole file (~line 990, inside an unrelated
spread/assign helper) and in **neither** enumeration helper —
`__object_keys` (body ~106-172) and `__object_keys_forin` (body ~219+) both push
unconditionally after only a null/tombstone check.

```js
var o = {};
Object.defineProperty(o, "x", { value: 1, enumerable: false });
Object.keys(o);            // should be []          — standalone leaks ["x"]
for (var k in o) { … }     // should not yield "x"  — standalone yields it
```

## Why it has stayed invisible

`verifyProperty` **masks it**. `isEnumerable(obj, name)` (propertyHelper.js:149)
ANDs the for-in scan with `__propertyIsEnumerable(obj, name)`, and
`__propertyIsEnumerable` **does** honour the flag. So a leaked for-in key still
yields the correct final answer, and the whole `propertyHelper` corpus is blind
to this defect. Only a test that inspects `Object.keys` / `for…in` directly can
see it.

## Why it matters now

#3976 made standalone class prototypes real `$Object`s with their methods
installed **non-enumerable**. That is spec-correct, but it means
`for (k in C.prototype)` now yields the method names where it previously yielded
nothing (the old defaulted-struct prototype had no `$Object` entries at all). So
#3976 did not create this defect, but it **widened its reach** to every class
prototype. #4098 (instance fields, which ARE enumerable) needs this correct in
the other direction to be verifiable at all.

## Fix

Add the enumerable test to both helpers' entry filter. The exact instruction
sequence already exists in the same file (~line 980-995) and can be copied:

```
local.get <e> ; ref.as_non_null ; struct.get $PropEntry 2
i32.const FLAG_ENUMERABLE ; i32.and ; i32.eqz ; i32.eqz   ;; normalise to 0/1
```

`__getOwnPropertyNames` must **not** get this filter — it lists non-enumerable
own keys by design.

## Sizing discipline — measure before believing

This is a **general** change to the enumeration path of every `$Object`, and
this repo has a precedent (#4017/#4055) where wiring an own-property answer at
the general point cost **684 host-free regressions**. So:

- The expected direction is *fewer* keys. Any object whose properties were
  created with flags that omit the enumerable bit will now vanish from
  `Object.keys` — check the `FLAG_INTERNAL` (`0x10`) slot users and the
  `__obj_insert` call sites that pass explicit flags, since those are exactly
  where a non-`FLAG_DEFAULT` (`0x07`) entry comes from.
- Ordinary `o.x = v` uses `FLAG_DEFAULT`, which includes enumerable, so the
  common path is unaffected — **confirm that by measurement, not by reading**.
- Run a regression control over the standalone-passing population and re-run
  every apparent regression **solo** before believing it.

## Acceptance criteria

- `Object.keys` and `for…in` exclude non-enumerable own properties;
  `Object.getOwnPropertyNames` still includes them.
- Measured fail→pass and pass→fail with denominators, plus the regression control
  above.
