---
id: 4074
title: "a package's shipped `.d.ts` already declares the shape partition #3927 wants to infer — acorn ships 77 discriminated node interfaces, median 3 fields, against a 62-externref union struct"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: objects, classes, compiler-internals
goal: performance
related: [3927, 3780, 3921, 3686, 3685, 1060, 743, 684]
origin: "2026-08-02 — asked during the #3780 gap decomposition whether the compiler used acorn's shipped TypeScript definitions. It does not, and the reason it would be worth doing is narrower and more specific than it first looks."
---

# #4074 — read the declared shape partition instead of inferring it

## Problem

#3927 wants to split a widened fnctor struct into per-shape structs, and files
the analysis as **XL / hard**, sequenced behind three other issues. Its own
framing names the obstacle:

> A per-`type`-string split is not sound in general. Acorn happens to set
> `node.type` before the shape settles, but nothing in the language says a
> constructor's instances partition by a string field, and the compiler cannot
> assume it.

That is correct when the partition must be **inferred**. But for the package
that motivated the issue, the partition is **declared** — acorn ships
`dist/acorn.d.ts`, 883 lines, and it is exactly a discriminated union over the
ESTree node kinds. Measured on the pinned 8.16.0 copy under
`tests/dogfood/.acorn/`:

| | |
| --- | ---: |
| exported interfaces | 83 |
| …carrying a literal `type: "…"` discriminant | **77** |
| fields per discriminated interface — min / median / max | 1 / **3** / 7 |
| union of all distinct field names across them | **164** |
| distinct `type` tags the implementation actually sets (`finishNode`) | 61 |

Against the current lowering, from #3927's own measurement: **one** struct of 69
fields, 62 of them `externref`, **292 B/instance**, at 32,468 `Node`
allocations per 226 KB parse (5.02% of all allocations, ~9.5 MB retained for
the life of the AST).

So the information the analysis would have to derive — *these instances
partition into 77 small, disjoint shapes, discriminated by a string literal* —
is sitting in a file the package already publishes and that the compiler
currently ignores.

## The compiler does not read it today

The npm-compat harness compiles a single in-memory source string:

```js
compile(compileSourceText, { fileName: "acorn.mjs", skipSemanticDiagnostics: true, optimize: 4 })
```

Not `compileFiles` / `compileProject`, so there is no `ts.createProgram` over
the real filesystem and the sibling `acorn.d.ts` is never a root name. Nothing
in `scripts/generate-npm-compat-report.mjs` references `d.ts`, `types` or
`typings`. `acorn.mjs` itself carries **4** JSDoc type annotations in the whole
file, so there is no second channel either.

## Three constraints that shape the design — read these before scoping

**1. A `.d.ts` cannot type the `.js` it sits beside.** TypeScript treats
`acorn.d.ts` as the *declaration for* `acorn.mjs` and substitutes it for
**consumers** who import the module. It is not a mechanism for type-checking or
annotating the implementation — and the implementation is what we compile. So
"just add the `.d.ts` to the program" is not the fix and will silently do
nothing. The declarations must be consumed **deliberately, as a shape
catalogue**, by a new pass.

**2. It covers the AST surface only — not parser state.** This is the limit
that keeps the issue small. Checking the 883-line declaration against the
fields acorn's hot loop actually touches:

| `Parser` field | declared in `.d.ts` | `this.<field>` uses in impl |
| --- | ---: | ---: |
| `pos` | **0** | 182 |
| `labels` | **0** | 24 |
| `context` | **0** | 22 |
| `startLoc` | **0** | 19 |
| `exprAllowed` | **0** | 18 |
| `lastTokEnd` | **0** | 17 |
| `scopeStack` | **0** | 16 |
| `containsEsc` | **0** | 16 |
| `curLine` | **0** | 10 |

The declared `Parser` surface is four things: `options`, `input`, `parse()`,
and the statics. The `type` / `start` / `end` hits elsewhere in the file are on
the **node interfaces**, not on `Parser`.

**Consequence: this does nothing for #3926 (`__extern_get`, 10.4% self time) or
#3685 (`$AnyValue` boxing, 48% of allocations).** Those read parser state, which
is declared nowhere. Scope this to `__fnctor_Node` and say so.

**3. The declaration is a HINT, not a contract — validate it or miscompile.**
Nothing forces an implementation to match its own published types, and acorn
does attach fields the interfaces mark optional or omit (`loc`, `range`,
`sourceFile`, plus parser-internal scratch). A declared shape set must be
**intersected with the observed assignment set** and must fall back to today's
union struct on any assignment outside it. A hint that is trusted blindly is a
wrong-code bug, not a slow one.

## Why this is worth filing separately from #3927

Same goal, different input, and they compose rather than compete:

- #3927 derives the partition by whole-program shape-set analysis. Sound
  everywhere, expensive, XL, and explicitly sequenced behind #3921 / #3686 /
  #3685.
- This reads a partition that is already written down. It applies only where a
  package ships discriminated declarations — but where it does, it supplies
  #3927's "is the set small and statically separable?" answer directly, and
  sidesteps the soundness objection above because the discriminant is
  **declared** rather than guessed.

Ideal end state is one pass with two front-ends: declarations when present,
inference otherwise. Landing the declaration front-end first also gives #3927 a
ready-made oracle to validate its inference against on a real package.

> **2026-08-06 (#3927 pad probe)**: the bound below now has a measured
> coefficient — d(wall)/d(ref-slot) ≈ 0.1%/slot (+36 slots ≈ +3-4% wall via
> the GC bucket; #3927 Results §5-§6), so the full best-case partition is
> worth ≈ 3-5% wall, consistent with this section's estimate. Two structural
> facts additionally CAP what a declared partition can deliver on acorn: the
> tag is applied at `finishNode` (after allocation), and `toAssignable`
> mutates shapes in place across the declared partition — see #3927 Results
> §3. The declared catalogue remains useful as the field-set oracle for the
> hot/cold split's field ranking, not as an instance partition.

## Honest payoff bound — do not oversell this

`__fnctor_Node` is 32,468 instances × 292 B ≈ **9.5 MB** of the **43.9 MB**
allocated per parse (#3780, 2026-08-01). Median declared shape is 3 own fields
plus 3 inherited (`start`, `end`, `type`) ≈ 6 slots ≈ ~40 B. Best case is
therefore ~9.5 MB → ~1.3 MB, about **19% of per-parse allocation**.

Against a GC bucket of 17.4% of self time, that is roughly **3% of wall clock**,
plus some share of `__fnctor_Node_new`'s 3.4% self time from the narrower
structs. Real, retained-not-transient (so it is paid twice — scavenger copy and
promotion), and much cheaper to reach than #3927's XL analysis. But it is a
single-digit-percent lever on a 9.6x gap; it is **not** a route to parity and
must not be scheduled as one.

## Scope

- [ ] A declaration-catalogue reader: given a package entry that ships
      `.d.ts`/`.d.mts`, extract `{ interfaceName, discriminantField,
      discriminantValue, fieldSet }` for every interface carrying a literal
      discriminant. Pure and hermetically testable — no codegen coupling.
- [ ] Plumb the declaration path to the compiler. Today's single-string
      `compile()` entry has nowhere to put it; decide whether this rides on
      `compileProject`'s existing resolution (cf. #1060) or a new explicit
      `shapeHints` option. Prefer explicit: an implicit sibling-file pickup
      would change output for existing callers.
- [ ] Intersect declared shapes with observed assignments; emit per-shape
      structs with a common prefix only where they agree, union struct
      otherwise. Reuse #3927's prefix/subtyping rule (`$__vec_base`), do not
      grow a second one.
- [ ] Report the verdict per constructor under an env-gated census, in the
      house style of `alloc-census.ts` / `proven-receiver-stats.ts`, so
      "declared but rejected" is visible rather than silent.

## Acceptance criteria

- [ ] With the declaration catalogue supplied, acorn's `__fnctor_Node`
      per-instance size drops from 292 B toward the declared median, reported
      as bytes/instance **and** as a `--trace-gc` per-parse delta against the
      43.9 MB baseline.
- [ ] A constructor whose observed assignments exceed its declared shape falls
      back to the union struct, with the divergence named in the census — and a
      test that pins exactly this, built from a fixture whose implementation
      deliberately sets an undeclared field.
- [ ] A package with no `.d.ts` compiles byte-identically to today.
- [ ] `for…in` / `Object.keys` / `in` answer identically before and after for
      every split shape (#3920 shows this surface is already lane-divergent and
      must not be made worse).
- [ ] No standalone test262 regression.

## Dupe check

- **#3927** — infers the same partition by whole-program analysis. This reads a
  declared one and feeds that analysis. Complementary, not a dupe; see the
  section above.
- **#1060** (`ModuleResolver` prefers `types`/`.d.ts`) — about **resolving**
  imports to declarations for consumers. This is about consuming declarations as
  **shape hints for the implementation being compiled**. Different direction.
  Not a dupe, but it is the natural place the plumbing may land.
- **#3686 / #3685 / #3926** — parser-state typing and dynamic property access.
  Constraint 2 above shows the declarations cover none of those fields. Not
  dupes and explicitly not helped by this.
