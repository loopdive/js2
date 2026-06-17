---
id: 2033
title: "custom iterables ([Symbol.iterator]): spread emits invalid wasm (CE), destructuring reads NaN — only for-of consults the protocol"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterators
goal: core-semantics
related: [1320, 1052]
origin: "2026-06-10 spec-conformance sweep (iterators agent): verified on main"
---

# #2033 — spread/destructuring assume vec-shaped structs

## Problem

```ts
const obj = {
  [Symbol.iterator]() {
    let i = 0; const data = [10, 20, 30];
    return { next: () => i < data.length
      ? { value: data[i++], done: false }
      : { value: 0, done: true } };
  }
};
// for-of: works ("10,20,30")
[...obj]                      // wasm: CompileError: i32.add[1] expected type
                              //   i32, found struct.get of type externref
const [first, second] = obj;  // wasm: "NaN,NaN"   node: 10,20
```

## Root cause

Spread: `src/codegen/literals.ts:~2507-2571` assumes a vec-shaped struct
(struct.get field 0 = i32 length) for ref-typed spread operands — the
iterable's struct field is the externref iterator closure. Destructuring:
`src/codegen/statements/destructuring.ts:949ff` struct path never consults
`[Symbol.iterator]`, reads non-existent numeric fields → NaN. Spec
§13.2.4.1/§8.6.2: both constructs must use the iterator protocol; for-of
already does.

## Fix direction

When a ref-typed spread/destructuring source isn't a known vec, route
through the same iterator-protocol lowering for-of uses (GetIterator +
step loop).

## Acceptance criteria

- Both repros match Node; vec fast paths unchanged
- Invalid-wasm CE eliminated

## Dupe check

#1320 (in-progress) covers only the Array.from/Iterator.from externref
bridge; #1052 (in-review) is overridden Array.prototype[Symbol.iterator].
New.

## Resolution (2026-06-16)

Spread and array-destructuring now consult the iterator protocol for
user-defined iterables, exactly like for-of (spec §13.2.4.1 / §8.5.2 — both are
GetIterator consumers).

New shared module **`src/codegen/custom-iterable.ts`**, kept deliberately
separate from the for-of machinery in `loops.ts` so this does NOT overlap the
in-flight #1320 iterator work — no edits to `compileForOfDirectIterator` or any
shared iterator runtime:

- `isCustomIterable(ctx, srcType)` — true when a `ref`/`ref_null` struct carries
  a registered `[Symbol.iterator]()` (`${structName}_@@iterator`). Known vecs,
  native generators, native strings and externref JS iterables are handled by
  the existing earlier branches; this only fires for the object-literal /
  class-instance iterable case those branches didn't cover.
- `emitDrainCustomIterableToVec(...)` — drives the protocol via the
  `__iterator` / `__iterator_next` JS-host bridge (the same primitives for-of
  uses for arrow-`next` iterables), draining into a doubling-capacity WasmGC
  array, then **trims the backing array to exactly the yielded length** before
  `struct.new $vec`. The trim matters: the canonical `$vec` invariant is
  `array.len(data) === $length`, and the typed-array destructure reads
  out-of-range against `array.len`; a capacity-padded array would mask OOB
  elements as default-fill `0` and break binding defaults
  (`const [a, b, c, d = 99] = obj`).

Wiring:
- **`src/codegen/literals.ts`** (array-spread `ref`/`ref_null` branch) — when
  the source is a custom iterable, drain it into a result-element vec and treat
  it as a normal materialized vec spread. This is the headline CE: spread used
  to fall into the generic vec path and read the iterator-closure externref as
  an i32 length → `i32.add expected i32, found struct.get of type externref`.
- **`src/codegen/statements/destructuring.ts`** (`compileArrayDestructuring`,
  non-vec struct case) — drain to a vec then destructure it through the proven
  typed-vec path (`destructureParamArray`), giving correct element values,
  skips/elisions, and binding defaults. Previously read non-existent numeric
  struct fields → NaN.

### Scope

Targets the JS-host iterator bridge (host mode), which the issue verified on.
The standalone/WASI native iterator runtime only covers canonical `$Vec`
producers today (#1320 Slice 1) — a generic object iterable still traps there
under for-of as well, so standalone is left to #1320, out of scope here. The
charCodeAt/slice-by-code-unit residual the issue mentions is unrelated.

### Test Results

- `tests/equivalence/issue-2033-custom-iterable-spread-destructure.test.ts` —
  8/8 pass via `assertEquivalent` (runs the wasm with the host iterator bridge
  and compares to Node):
  - spread: sum of yielded values (was invalid wasm), `.length`, mixed with
    literal elements, spread→for-of round-trip;
  - destructure: `[a, b]` (the headline repro, was NaN), `[a, b, c]`, binding
    default on exhaustion (`d = 99`), elision (`[, second, third]`).
- No regressions across the destructuring (50), spread (46) and
  iterator-protocol-custom (4) equivalence suites. The 2 pre-existing
  `symbol-basic` failures (`Symbol.iterator is a constant`, `well-known symbols
  are consistent`) fail identically on `origin/main` — not from this change.
- `npm run typecheck` + `npm run lint` (Biome) clean.
