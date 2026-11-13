---
id: 7153
title: "WASI: nested arrays still stringify as [object Object] — the WASI __to_primitive vec arm never reserves the array ToString driver"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-27
completed: 2026-10-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: builtins
goal: correctness
parent: 6979
related: [7147]
loc-budget-allow:
  # 2026-10-27: one `vecReduce` line that admits WASI to the existing vec arm of __to_primitive
  - src/codegen/object-runtime.ts
func-budget-allow:
  # 2026-10-27: same single `vecReduce` line, inside the __to_primitive block
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #7153 — WASI nested-array ToString

Found during the review of PR #6908 (#7147). On `--target wasi`,
`[1,[2,[3]]].join(",")`, `String([1,[2]])` and `` `${[1,[2]]}` `` still print
`[object Object]` for the nested element on base and head: the WASI
`__to_primitive` vec arm never reserves `__array_to_primitive_string` (the
native `Array.prototype.toString` driver that #7147 fixed for gc native-first
and standalone), while the WASI inline join still emits the cycle-guard
enter/leave and the `__extern_toString` call as dead weight.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the three programs with `--target wasi` (run under `node:wasi`),
   dump WAT, confirm the vec arm of the WASI `__to_primitive` returns the
   generic object string.
2. Route the WASI vec arm through the same driver `#7147` uses on the other
   no-host lanes (one spelling: the driver is lane-neutral; only the
   reservation site differs) and reserve it where the WASI runtime builds its
   ToString table; the cycle guard then stops being dead weight on WASI.
3. Tests: extend `tests/equivalence/issue-7147-nested-array-join.test.ts` (or
   a sibling) with a WASI lane for the nested, cyclic, `String` and template
   cases; bytes on gc host-assisted, gc native-first and standalone must stay
   identical.

## Resolution (2026-10-27)

`ensureObjectRuntime`'s `__to_primitive` block gated the whole non-`$Object`
arm (arguments brand, vec, own-method prefix, class driver) on
`reserveArgumentsLengthBrand`, which is standalone-only, so on WASI a vec fell
through unchanged and `__any_to_string` rendered it `[object Object]`. A new
`vecReduce = arrayLikeReduce || ctx.wasi` admits WASI to the vec arm alone: it
registers `$__vec_base`, reserves the existing lane-neutral
`__array_to_primitive_string` driver (filled by the existing
`fillArrayToPrimitive`), and passes no arguments / own-method / class bindings.
The WASI inline join's cycle guard and `__extern_toString` call are now live.

Test: `tests/equivalence/issue-7147-nested-array-join.test.ts` — every row now
also runs on `--target wasi` (nested, cyclic, mutual cycle, `String(...)`,
template literal, custom separator, objects / null / undefined, a cycle one
level down), except `flat()` (a wasi compile error, #2717) and the three
throwing-element rows (a module that can throw imports WASI, which the
equivalence harness does not provide).

Bytes (unoptimized, 35 programs = 13 playground examples + 18 equivalence
sources + 4 array rows, base vs head): gc native-first and standalone 70/70
identical. WASI changes only in modules that emit `__to_primitive`: the 4
array-stringifying rows (+260..+561 B) and playground `js/algorithms`,
`js/classes`, `js/async` (+563..+595 B; the driver lands wherever the WASI
object runtime emits `__to_primitive`, whether or not an array is stringified).
The 18 equivalence sources on WASI are byte-identical.

Left out: a WASI array whose element is a closed object literal with its own
`toString` (`[{ toString() { return "o"; } }].join()`) still prints
`[object Object]` on base and head — WASI's `__to_primitive` has no
`__class_to_primitive` arm (standalone-only), a separate gap.
