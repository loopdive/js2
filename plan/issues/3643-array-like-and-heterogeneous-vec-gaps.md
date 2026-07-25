---
id: 3643
title: "Three measured host-lane gaps: array destructuring never throws, `Array.from` ignores array-like `length`, and a heterogeneous vec null-derefs in slice/flat"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: bug
area: runtime
language_feature: destructuring, array-methods, iteration-protocol
es_edition: multi
goal: core-semantics
related: [3637, 2836, 3486]
origin: "Measured while auditing #3637. Each item was A/B'd against #3637's merge base and is byte-identical there, so none is caused by #3637 — they are separate, pre-existing gaps that the audit surfaced."
---

# #3643 — three measured host-lane gaps surfaced by the #3637 audit

## Provenance

These were found while enumerating `__vec_len` discriminator sites for #3637 and
were explicitly held **out of that PR's scope**. Every row below was A/B'd
against #3637's merge base (`upstream/main` @ `6f3e43580`) and is **byte-identical
with and without #3637**, so none of them is a regression from that change — the
audit simply walked past them.

Unclaimed on purpose. Three independent slices; take one or all.

## Measurements

Compiled with `compile(src, { fileName: "probe.mjs" })` and run through
`wrapExports`. `host` is what plain V8 answers for the identical source.

### Slice A — array destructuring never performs GetIterator

| source                            | got                        | host        |
| --------------------------------- | -------------------------- | ----------- |
| `var [p] = { a: 1 }`              | binds `undefined`, no throw | `TypeError` |
| `var [p, q] = { a: 1, b: 2 }`     | binds `undefined, undefined` | `TypeError` |
| `function f([p]) {} ; f({ a: 1 })` | **traps** "dereferencing a null pointer" | `TypeError` |
| `var [p] = [7]`                   | `7` (correct)              | `7`         |

§8.6.2 ArrayBindingPattern requires GetIterator(§7.4.2) on the RHS, which throws
`TypeError` for a non-iterable. Array destructuring does **not** route through
the `__iterator` host import — #3637 made `__iterator` itself spec-correct
(`for (x of {a:1})` now throws), and destructuring was measurably unaffected,
which localises the gap to the destructuring lowering rather than the host
import.

Note the two binding forms fail **differently**: a `var` pattern silently binds
`undefined`, a **parameter** pattern traps. Two distinct paths; neither reaches
the spec's TypeError.

### Slice B — `Array.from` ignores `length` on a WasmGC array-like

| source                                         | got     | host             |
| ---------------------------------------------- | ------- | ---------------- |
| `Array.from({ length: 2 })`                    | `[]`    | `[null,null]`    |
| `Array.from({ length: 2, 0: "a", 1: "b" })`    | `[]`    | `["a","b"]`      |
| `Array.from([1, 2, 3])`                        | `[1,2,3]` (correct) | `[1,2,3]` |
| `Array.prototype.slice.call({length:2,0:5,1:6})` | `[5,6]` (correct) | `[5,6]` |
| `({length: 2, 0: 5, 1: 6}).length`             | `2` (correct) | `2`        |

§23.1.2.1 step 6: when the source is **not** iterable, `Array.from` falls back to
`LengthOfArrayLike` + indexed reads. The struct's `length` field is readable
(row 5) and `slice.call` already does the array-like walk correctly (row 4), so
only `Array.from`'s non-iterable fallback is missing for a WasmGC receiver.

### Slice C — heterogeneous vec null-derefs in `slice` / `flat`

| source                        | got                                     | host           |
| ----------------------------- | --------------------------------------- | -------------- |
| `[{x:1}, 2].flat()`           | **traps** "dereferencing a null pointer" | `[{"x":1},2]`  |
| `[o, 1].slice(0)` (`o={x:1}`) | **traps** "dereferencing a null pointer" | `[{"x":1},1]`  |
| `[{x:1}].flat()`              | `[{"x":1}]` (correct)                   | `[{"x":1}]`    |
| `[{x:1},{y:2}].flat()`        | `[{"x":1},{"y":2}]` (correct)           | same           |
| `[o, o].slice(0)`             | `[{"x":1},{"x":1}]` (correct)           | same           |
| `[1, 2].slice(0)`             | `[1,2]` (correct)                       | `[1,2]`        |
| `[1, {x:1}].concat([])`       | `[1,{"x":1}]` (correct)                 | same           |

**The discriminator is heterogeneity, not the presence of a struct.** All-struct
and all-number literals are fine; **mixing a struct with a number in one literal**
traps, and only on the `slice` / `flat` paths — `concat` handles the identical
mixed literal correctly. That points at the element-read lowering for a mixed
literal's vec (a `ref.cast` to the struct type over a boxed number, or a null
element) rather than at the method implementations, and `concat` is the working
control to diff against.

Rows 3 and 4 (`[{x:1}].flat()`, `[{x:1},{y:2}].flat()`) answered `[]` before
#3637 and are correct now — recorded here so a future bisect does not
misattribute them.

## Acceptance criteria

- [ ] Slice A: `var [p] = {a:1}`, `var [p,q] = {...}` and `function f([p]){}`
      called with a non-iterable all throw `TypeError`; iterable RHS unaffected.
- [ ] Slice B: `Array.from` on a WasmGC array-like honours `length` and indexed
      reads, matching `slice.call`'s existing behaviour.
- [ ] Slice C: `[{x:1}, 2].flat()` and `[o, 1].slice(0)` return the host answer
      instead of trapping; the all-struct / all-number / `concat` controls above
      stay green.
- [ ] Each slice's test asserts the **observable value** and is verified to fail
      before the fix.
