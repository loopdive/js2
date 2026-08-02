---
id: 4088
title: "An array literal whose object-literal elements have DIFFERENT member counts null-derefs — uncatchable trap on ordinary JavaScript"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: correctness
related: [3593, 2093, 3189, 4064, 4085]
---

# An array literal of object literals with differing member counts traps

Split out of **#3593** on 2026-08-02. #3593 was filed as an `Iterator.zip`
defect; ablation showed `Iterator.zip` is not involved at all, and the real
defect is general array-literal lowering. It is filed separately **because a
misleading title is expensive here**: #1906's wrong error string caused four
consecutive misaimed fixes (#3983/#3984/#3991/#4032). Nobody hitting an
array-literal trap would search an issue named "Iterator.zip null deref", and
nobody triaging Iterator work should inherit an array-lowering bug.

## Repro — this is the whole thing

No `Iterator`, no `Symbol`, no test262 harness, and no consumer beyond reading
`.length`:

```js
var arr = [{ a() {}, b() {} }, { c() {} }];
if (arr.length !== 2) throw new Error("len");
// RuntimeError: dereferencing a null pointer in __module_init()
```

Because it traps with no consumer, **the null is created when the array literal
is built**, not when something reads it.

Reproduces via plain `compileAndInstantiate` — no harness needed.

## The measured rule

**An array literal traps iff two of its object-literal elements have DIFFERENT
NON-ZERO member counts.**

| array literal | result |
| --- | --- |
| `[{a,b},{c}]` — 2 vs 1 | **TRAP** |
| `[{c},{a,b}]` — 1 vs 2 | **TRAP** (symmetric) |
| `[{a,b,e},{c}]` — 3 vs 1 | **TRAP** |
| `[{c},{a,b,e}]` — 1 vs 3 | **TRAP** |
| `[{a:1,b:2},{c:3}]` — **data** properties, 2 vs 1 | **TRAP** |
| `[{a,b},[1,2]]` — objlit vs array literal | **TRAP** |
| `[{a,b},{c},{a,b}]` — three elements, 2/1/2 | **TRAP** |
| `[{a,b},{c,d}]` — 2 vs 2, **disjoint names** | pass |
| `[{a,b},{a,b}]` — 2 vs 2, same names | pass |
| `[{a,b},{}]` — 2 vs **empty** | pass |
| `[{a,b}]` — single element | pass |

Properties of the rule, each measured rather than inferred:

- **Symmetric** — order does not matter.
- **Independent of member NAMES** — 2-vs-2 with completely disjoint names
  passes, so the lowering is not keying on the name set.
- **Independent of data-vs-method** — `{a:1,b:2}` behaves like `{a(){},b(){}}`.
- **Empty `{}` is exempt** — probably typed differently (`any`-ish) rather than
  as a struct shape.

Together these point at array-literal **element-type lowering keying on field
count**, with a mismatch yielding a null rather than a widened element type or
a loud refusal.

### ⚠ A refuted hypothesis — do not re-form it

The obvious theory is that the element type is taken from the **first** element,
making the rule asymmetric: `[{a,b},{c}]` would trap while `[{c},{a,b}]` would
be safe. **Measured: both trap.** The first-element-wins story is tidy and
wrong. Stated here explicitly because it is the natural hypothesis and would
otherwise cost the next person a day.

## Blast radius — real, and NOT sized

`[{a(){},b(){}}, {c(){}}]` is ordinary JavaScript, not an exotic shape, and the
failure is an **uncatchable trap** (the module aborts; it cannot be caught as a
`TypeError`). Same severity class as **#4064** (a parameter failing to shadow a
module-level function, silently infinite-recursing) and **#4085**
(`JSON.stringify([1,2,3])` returning `"null"`).

**The affected population is UNMEASURED and no figure should be invented for
it.** In particular it must *not* be sized from the single test262 file that
surfaced it (`built-ins/Iterator/zip/iterables-iteration.js`) — that file is
where it was noticed, not a measure of where it occurs. Sizing is the first
work item.

## Where to look

`src/codegen/literals.ts::compileArrayLiteral`, together with
`src/codegen/array-element-typing.ts` (which documents itself as the module
`compileArrayLiteral` reads element-kind decisions from). The question to
answer first is what element type is chosen when the object-literal elements
have different field counts, and where the null is materialised.

## ⚠ Instrument warning for whoever fixes this — READ BEFORE WRITING A PROBE

**The first version of the probe for this defect passed all nine cases while
the defect was live.** It called:

```ts
await WebAssembly.instantiate(result.binary, {});   // ← WRONG
```

so every program died at `Import #0 "string_constants": module is not an object
or function` **before running a single instruction**, and the assertions
(`expect(...).not.toBe("trap")`) were trivially true. The probe answered
honestly about a question nobody asked.

- **Use `compileAndInstantiate` from `src/runtime-instantiate.ts`**, which
  builds the real import object.
- **The tell that caught it:** *shapes already measured as failing reported
  green.* When an instrument disagrees with a measurement you already trust,
  suspect the instrument, not the code.
- This was the third instrument in one day failing this way (a
  constant-folded RegExp probe, a `grep -E "\t"` watcher that flagged a green
  PR, and this) — each answering correctly about a **different** question than
  the one asked.

`tests/issue-4088.test.ts` therefore ships **four `ok`-asserting controls**
whose only job is to prove the harness can still tell a trap from a setup
failure. **Keep them.** The five live-defect cases are `it.fails` (#2093 form):
they pass while the trap exists and turn **red** the moment it is fixed, which
prompts flipping them to plain `it` rather than letting a stale skip rot.

## Acceptance criteria

- `[{ a() {}, b() {} }, { c() {} }]` and the other TRAP rows above run without
  `dereferencing a null pointer`.
- The four control rows still pass (no regression in same-arity / empty /
  single-element lowering).
- `tests/issue-4088.test.ts`'s five `it.fails` cases are flipped to `it` and
  pass.
- The `null_deref` trap-category count does not increase.
- The affected population is **measured** before any claim about impact.
