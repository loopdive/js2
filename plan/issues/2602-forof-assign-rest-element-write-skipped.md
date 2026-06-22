---
id: 2602
title: "for-of/for-await assignment-destructuring rest element (...y) write is skipped — y never gets the rest slice"
status: done
completed: 2026-06-22
assignee: ttraenkler/senior-developer
sprint: Backlog
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, destructuring, for-of, async
language_feature: for-of, for-await-of, array assignment destructuring, rest element
related: [2580, 1373b, 2574]
discovered_by: "#2580 M2 slice 1 (the .length-on-any reader exposed it)"
blocks: [2580]
---

## Problem

`for ([x, ...y] of [[1, 2, 3]])` (and `for await`) — an ASSIGNMENT-destructuring
loop head (the targets `x`, `y` are pre-declared, not bound by the loop) — never
writes the rest slice `[2, 3]` to `y`. The 8 test262 files
(`language/statements/for-await-of/async-*-dstr-array-rest-*`) assert
`y.length === 2`, `y[0] === 2`, `y[1] === 3`.

These PASS on `main` today — but only because the failure is **latent**: nothing
currently re-reads `y` through a path that surfaces the missing write. The #2580
`.length`-on-any reader DID: it recompiles the `y` identifier and reads the SOURCE
array (length 3), not the rest slice (length 2). Confirmed both **sync** for-of
AND **async** for-await assignment-rest forms fail under the reader (faithful
`runTest262File`), so this is NOT async-specific — it is the for-of/for-await
ASSIGNMENT-destructuring rest path in general.

## Root cause (diagnosed, #2602)

In `src/codegen/statements/loops.ts`, the for-of assignment-destructuring lowering
**SKIPS the spread/rest element**:
- `compileForOfAssignDestructuringExternref` (~line 2098): the per-element loop has
  `if (ts.isSpreadElement(el)) continue;` (~line 2144) — the `...y` target is
  dropped, never assigned.
- The other `isSpreadElement(el)` site (~line 3741) also `continue`s.
- The tuple/vec assignment paths (~1792–1960) don't handle spread at all.

So the LHS `y` of `[x, ...y]` is **never PutValue'd** (spec §13.15.5.5
ArrayAssignmentPattern / IteratorBindingInitialization rest step). `y` is a
pre-declared `var`/`let` (a module GLOBAL in the test shape — `localMap.get("y")`
is `undefined` at the read site), so it retains whatever it held before (the
source array or a stale value). Diagnostic from the reader site:
`[2602] .length on 'y' localMap=undefined exprType=externref` → `y` resolves as a
global, and the global was never updated with the rest slice.

(Note: BINDING destructuring `const [a, ...rest] = …` and the string-rest path DO
handle rest, via `__extern_slice` → `local.set restIdx`, loops.ts ~1375 and
destructuring.ts ~1253. The gap is specifically the **assignment** form in the
for-of head.)

## Why this is NOT a bounded "canonical local" fix (STOP-AND-FLAG)

The tech-lead's guard: bounded canonical-local fix → attempt; deep refactor → flag
for a specialist. This is the latter:
- The rest-element ASSIGNMENT write is **unimplemented** in 2–3 distinct for-of
  destructuring paths (externref / tuple / vec), each with its own element loop;
  implementing it means computing the rest slice (`Array.prototype.slice`-style /
  `__extern_slice` or a native vec slice) and PutValue-ing it to a target that may
  be an identifier (local OR global), a property access, or an element access
  (per the #1258 LHS-target generality already in the externref path).
- It intersects async (the for-await state machine) AND sync, AND the
  global-vs-local resolution the #2580 reader exposed.
- It is spec rest-semantics work (§13.15.5.5 + IteratorDestructuringAssignment-
  Evaluation rest), not a one-line local canonicalization.

So this needs a destructuring/async specialist (the user just prioritized async;
related #1373b IR async CPS, #2574 array-destructure-default). It **blocks #2580
M2 slice 1**: the `.length`-on-any reader cannot fire for the rest-`y` receiver
class until `y` is correctly assigned the rest slice.

## Repro (faithful runner)

Apply the #2580 slice-1 reader (re-enable the `.length`-on-any arm), then:
```
node .tmp/run8.mjs   # the 8 for-await array-rest files → FAIL (y.length=3, want 2)
# sync for-of: language/statements/for-of/dstr/array-rest-*.js also FAIL under the reader
```
Without the reader the 8 are latent-pass. Reduced `compile()` probes do NOT
faithfully reproduce — use `runTest262File`.

## Fix direction (for the specialist)

Implement the rest-element write in the for-of assignment-destructuring paths:
compute the rest slice from the iterated element (drop the first N already-bound
elements) and PutValue it to the `...y` target (identifier local/global, or
property/element access via `__extern_set`, mirroring the #1258 element handling).
Validate the 8 for-await + the sync for-of array-rest tests + the #2580 slice-1
reader (re-enabled) all green via the faithful runner; full-gate merge_group.

## Implementation (done — #2602)

All work is in `src/codegen/statements/loops.ts`. Two new helpers + four wired
spread sites cover every for-of / for-await assignment-destructuring path:

- **`emitVecRestAssignment`** — the source element is a WasmGC **vec struct**
  (`[1,2,3]` lowers to `{ length, data }`). Builds the rest slice **natively**
  (`array.new_default(restLen)` + `array.copy` from `restStartIndex` +
  `struct.new` of the SAME vec type) — a byte-identical mirror of the
  binding-form vec rest (`const [a,...r]=…`, loops.ts ~1488). **Why native, not
  `__extern_slice`:** an `extern.convert_any` of a vec struct hands the host
  `__extern_slice` a WasmGC struct externref it cannot `arr.slice()` (its
  `_isWasmStruct` arm only handles tuple structs with `_N` fields). Native build
  also keeps standalone import-free. Recurses into a nested-pattern rest target
  (`for ([...[x]] of …)`) via `compileForOfAssignDestructuring`.
- **`emitForOfRestAssignment`** — the source element is already an **externref**
  (the externref-array fast path `compileForOfAssignDestructuringExternref`, and
  the generic iterator path `compileForOfIteratorAssignDestructuring` used by
  any-typed iterables / generators / **for-await**). Uses `__extern_slice(elem,
  i)` exactly like the plain `[a,...r]=arr` assignment-form rest
  (assignment.ts ~1628), then PutValues the externref slice — coercing to the
  target's declared type when typed (`coerceType` externref→vec reconstructs a
  vec from the JS-array externref via its guarded arm). The TUPLE branch also
  routes here: `__extern_slice`'s `_isWasmStruct` arm DOES slice tuple structs,
  so `extern.convert_any` + slice is correct there.

Both helpers PutValue to an identifier rest target — a **local OR a pre-declared
module global** (the for-of head's existing global-sync shadow-local pattern,
#1258). A property/element rest target (`[...obj.x]`) is left unwritten, matching
the pre-#2602 silent drop (no regression; rare, separate sub-case).

The async **for-await** state machine reuses the same iterator lowering
(`compileForOfIterator` → `compileForOfIteratorAssignDestructuring`), so the
single externref-path fix covers sync iterator AND for-await with no
async-specific code.

### Validation
- Faithful `runTest262File` over the full `array-rest-*` family
  (`for-of/dstr` + `for-await-of`): **+13 fail→pass, 0 pass→fail** vs the
  committed baseline. The headline `array-rest-after-element` + nested-array +
  elision variants flip; remaining fails are out-of-scope sub-features
  (iterator-close abrupt completions, `put-prop-ref` rest targets, `yield`-in-
  pattern, `put-const`/`put-let` TDZ) that were already failing.
- `tests/issue-2602-forof-assign-rest.test.ts` (6 cases): sync vec, `[...y]`,
  module-global rest, **async for-await**, `[a,b,...rest]`, standalone native vec.
- No new CE / invalid-wasm; broad-impact change validated authoritatively in the
  `merge_group` floor gate.

**Unblocks #2580 M2 slice 1:** the `.length`-on-any reader can now fire for the
rest-`y` receiver class — `y` correctly holds the rest slice (length 2), not the
stale source array (length 3).

### Out of scope (follow-ups, all pre-existing failures, not regressions)
- Rest into a property/element-access target (`for ([...obj.x] of …)`).
- Iterator-protocol close / abrupt-completion semantics on rest
  (`array-rest-iter-{rtrn,thrw}-close*`).
- `yield`-in-rest-pattern; `put-const`/`put-let` TDZ throw-on-rest.
