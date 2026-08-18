---
id: 4513
title: "IR: adopt statically-foldable computed object keys `{ [expr]: v }`"
status: done
completed: 2026-08-16
sprint: 78
priority: medium
horizon: m
area: ir
goal: ir-full-coverage
related: [3518, 4471, 4459, 4502, 4607]
assignee: ttraenkler/dev-computed-keys
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
---

# IR: adopt statically-foldable computed object keys `{ [expr]: v }`

## Problem

Any computed property name in an object literal rejects the **whole containing
function** to legacy. `isPhase1ObjectLiteral` resolves keys through
`phase1PropertyName`, which returns `null` for every `ComputedPropertyName` —
including `{ ["a"]: 1 }`, whose key is a string literal and is therefore
indistinguishable from `{ a: 1 }` after folding.

Legacy already folds: `resolvePropertyNameText` → `resolveComputedKeyExpression`
→ `resolveConstantExpression` (`src/codegen/literals.ts`), and when the fold
succeeds the literal compiles to the same closed struct as a plain key. Only the
IR path treats a folded key as unresolvable.

## Measurement — before (base `76e294c7`, `.tmp/4513/probe.mts`)

`JS2WASM_IR_SHAPE_DIAG=1`, `trackFallbacks: true`. `selector` is
`reason/arm`; `legacy | IR` are the runtime values of the exported function on
the direct and `experimentalIR` paths.

| # | probe | selector reject arm | outcome | legacy \| IR |
| - | ----- | ------------------- | ------- | ------------ |
| a1 | `const k="a"; { [k]: n }` | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| a2 | `{ ["a"]: n }` | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| a3 | `f(n, k: string) { { [k]: n } }` (runtime key) | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| b1 | `{ [0]: n }` | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| b2 | `{ [1+1]: n }`, read `(o as any)[2]` | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | NaN \| NaN |
| c1 | ``{ [`a`]: n }`` (no substitution) | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| c2 | ``{ [`${p}b`]: n }`` (substitution) | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| d | `{ [k]() { … } }` computed method | `body-shape-rejected` / `objectlit-ordinary-to-primitive-method:MethodDeclaration` | `unsupported` | **throws** `m is not a function` \| same |
| e | `class A { [k]() {} }` | `class-member-unsupported` / `<none>` | `unsupported` | 42 \| 42 |
| f | `{ [k]: n, b: 1 }` mixed | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 42 \| 42 |
| g | `{ [key()]: val() }` order counter | `body-shape-rejected` / `nontail-assign-nonprop-lhs:BinaryExpression` | `unsupported` | 12 \| 12 |
| h | `{ a: n }` (baseline, no computed key) | **CLAIMED** | `emitted(body=true)` | 41 \| 41 |
| i | `{ [Symbol.iterator]: n }` | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| j | `{ a: 1, [k]: n }` (computed shadows plain) | `body-shape-rejected` / `objectlit-computed-key:ComputedPropertyName` | `unsupported` | 41 \| 41 |
| k | `let k="a"; k="b"; { [k]: n }` | `body-shape-rejected` / `nontail-assign-nonprop-lhs:BinaryExpression` | `unsupported` | NaN \| NaN |
| l | `{ get [k]() {…} }` | `body-shape-rejected` / `objectlit-property-kind:GetAccessor` | `unsupported` | NaN \| NaN |

Three facts the table settles, none of which were assumable:

1. **The reject is one arm, not many.** Ten of the sixteen probes land on the
   single `objectlit-computed-key` arm; the rest are pre-empted by *other*
   rejects (`g`/`k` never reach the object literal — a module-level `let`
   assignment rejects first; `d` is captured by the OrdinaryToPrimitive
   pre-scan; `l` by `objectlit-property-kind`; `e` is not an object literal at
   all).
2. **Legacy does not support everything either.** `d` (computed method name in
   an object literal) *throws at runtime on the legacy path* — so it is not a
   parity target, it is a legacy bug. `b2`, `k`, `l` return `NaN` on both
   paths. Adopting those shapes would mean matching a wrong answer.
3. **`class A { [k]() {} }` is out of scope by construction** — it rejects at
   `class-member-unsupported`, a different gate on a different node kind, and
   never reaches `isPhase1ObjectLiteral`. Recorded as instructed; unchanged by
   this issue.

## Decision — fold syntactically, claim nothing else

The IR object shape is **static**: `IrObjectShape.fields` is a fixed list of
`{ name, type }`. A key whose value is only known at run time cannot produce
one, so the adoptable set is exactly the keys that fold to a string during
selection.

The selector is **checker-free** — `planIrCompilation` takes a bare
`SourceFile`, and its `scope` is a `ReadonlySet<string>` of *names*, not a value
environment. It therefore cannot reproduce legacy's `resolveConstantExpression`,
which reads `const` initializers and enum tables off a `CodegenContext`. The
fold implemented here is purely syntactic:

| key expression | folds to | why |
| -------------- | -------- | --- |
| `"a"` (StringLiteral) | `a` | literal text |
| `` `a` `` (NoSubstitutionTemplateLiteral) | `a` | literal text, no substitution to evaluate |
| `0`, `42`, `0x10` (NumericLiteral) | `0`, `42`, `16` | `expr.text`, see below |
| `("a")` (parenthesized wrapper of any of the above) | inner | parens are not an operation |

Everything else — identifiers, `Symbol.iterator`, template substitution, binary
expressions, enum members, `let` bindings — keeps rejecting at
`objectlit-computed-key`.

### The numeric guard that measurement deleted

JS canonicalises a numeric key through `ToString(ToNumber(…))`: `{ [0x10]: v }`
is the key `"16"`. The first draft of this slice therefore carried a guard —
admit a numeric key only when `String(Number(text)) === text` — on the stated
premise that the shipped *plain* numeric path (`phase1PropertyName`, which
returns `name.text`) was already wrong for `0x10` / `0.50` / `1e3`, and that
this slice must not add a second wrong spelling.

**The premise was false, and the sweep caught it**: `neg-hex-numeric-key`,
`neg-trailing-zero-numeric-key` and `neg-exp-numeric-key` were all written as
negatives and all came back `CLAIMED` with legacy/IR parity. TypeScript's
scanner **already stores the canonical decimal form** in `NumericLiteral.text`.
Measured directly over 16 spellings:

| source | `.text` | source | `.text` |
| ------ | ------- | ------ | ------- |
| `0x10` | `16` | `1e21` | `1e+21` |
| `0b101` | `5` | `1e-7` | `1e-7` |
| `0o17` | `15` | `0.0000001` | `1e-7` |
| `0.50` | `0.5` | `1_000` | `1000` |
| `.5` | `0.5` | `9007199254740993` | `9007199254740992` |
| `5.` | `5` | `1e100` | `1e+100` |
| `1e3` | `1000` | `123456789012345678901234567890` | `1.2345678901234568e+29` |

`text === String(Number(text))` for all 16, so the guard could never fire. It
was dead code asserting a hazard the compiler does not have, and — worse — it
documented `{ [0x10]: v }` as deliberately rejected when in fact it is claimed
and correct. Removed; the numeric arm is `return expr.text`, which makes a
computed numeric key **byte-identical** to the plain numeric key. That identity
is asserted at runtime (`{ [0x10]: v }` / `{ 0x10: v }` / `{ 16: v }` all agree
with legacy) rather than restated as a comment.

### Selector claim ⇔ lowering parity

The fold lives in a new leaf module `src/ir/property-key-fold.ts` and both
`select.ts` and `isPhase1ObjectLiteral`'s lowering twin `lowerObjectLiteral`
call the same exported `objectLiteralDataPropertyName`. That is not tidiness:
the two files **cannot import each other** (circular), which is why they already
carry two copies of `phase1PropertyName`. Duplicating a *widening* fold as well
would make the claim rule and the lowering rule two texts that can drift — and
drift in this direction is not a missed optimisation, it is a function the
selector claimed and the lowerer then cannot deliver (a post-claim `invariant`,
a hard error under the IR-only policy). One function makes drift impossible.

**No new reject code was minted.** A non-folding computed key reuses the
existing `objectlit-computed-key` arm in the selector and the existing typed
`body-shape-rejected` demote in `from-ast`, because it is the same condition
that arm already names.

The widening is applied at the **object-literal data-property site only**, via a
separate entry point rather than by changing `phase1PropertyName` itself. That
function has 7 other call sites across the two files — class-member naming,
OrdinaryToPrimitive method resolution, prepared-scope method keys — where a
computed name means something different; `phase1MemberName` already documents
that widening there could make Phase B patch the wrong `funcMap` slot. Keeping
the entry points separate holds the blast radius equal to the measurement.

One unplanned precision gain: `{ a: 1, ["a"]: v }` now rejects at
`objectlit-duplicate-key` instead of `objectlit-computed-key`, because the key
folds far enough for the duplicate check to see it. Still rejected, more
accurately labelled.

### Evaluation order

A folded key is a **literal**, so it has no side effects and cannot participate
in an evaluation-order hazard of its own. The order that *is* observable is
between property **values**, and it is preserved for a structural reason worth
stating: `lowerObjectLiteral` lowers initializers in the `expr.properties` loop
(source order) and only sorts `built` by field name *after* every value has been
lowered. The sort therefore permutes the `object.new` operand list, never the
emission order of the value computations.

That is exactly the property a sort-after-lower can silently lose, and a
computed key is the case that makes it visible, because a folded key's field
name need not sort in source position. Pinned with the #4459 side-effect-counter
idiom (`t = t * 10 + k`, so a wrong order reads as a different integer):

- `{ ["b"]: p(1), a: p(2) }` → counter `12`, **not** `21`, even though field
  `a` sorts before field `b`.
- `{ a: p(1), ["b"]: p(2), c: p(3) }` → `123`.
- `{ ["c"]: p(1), ["a"]: p(2), ["b"]: p(3) }` → `123` (all-computed, reverse
  sort order).

Each is asserted equal on the legacy and IR paths *and* against the value the
same source produces under plain V8.

## Deferred, each with the code it keeps rejecting under

| shape | stays at | reason |
| ----- | -------- | ------ |
| `const k = "a"; { [k]: v }` | `objectlit-computed-key` | selector `scope` is a name set, not a value environment; no checker |
| `{ [Symbol.iterator]: v }` | `objectlit-computed-key` | legacy maps it to the reserved `@@iterator` field; IR has no well-known-symbol field convention |
| ``{ [`${p}b`]: v }`` | `objectlit-computed-key` | substitution needs constant propagation |
| `{ [1+1]: v }` | `objectlit-computed-key` | folding arithmetic re-implements `resolveConstantExpression` without its context; legacy reads `NaN` for the round-trip anyway (probe b2) |
| `{ [k]: v }` with a runtime `k` | `objectlit-computed-key` | no static shape exists |
| `{ [k]() {} }` computed method | `objectlit-ordinary-to-primitive-method` | legacy **throws** on this shape (probe d); not a parity target |
| `{ get [k]() {} }` | `objectlit-property-kind` | accessors are unclaimed for plain keys too |
| `class A { [k]() {} }` | `class-member-unsupported` | different gate, different node kind; never reaches the object-literal walker |

## Measurement — after

Same probe, same flags. The `objectlit-computed-key` arm now fires only for
keys that need a value environment:

| probe | before | after |
| ----- | ------ | ----- |
| `{ ["a"]: n }` | `objectlit-computed-key` | **CLAIMED**, `emitted(body=true)` |
| ``{ [`a`]: n }`` | `objectlit-computed-key` | **CLAIMED**, `emitted(body=true)` |
| `{ [0]: n }` | `objectlit-computed-key` | **CLAIMED**, `emitted(body=true)` |
| `{ [0x10]: n }` / `{ [0.50]: n }` / `{ [1e3]: n }` | `objectlit-computed-key` | **CLAIMED**, `emitted(body=true)` |
| `{ [("a")]: n }` | `objectlit-computed-key` | **CLAIMED**, `emitted(body=true)` |
| `const k="a"; { [k]: n }` | `objectlit-computed-key` | `objectlit-computed-key` (unchanged) |
| runtime param key | `objectlit-computed-key` | `objectlit-computed-key` (unchanged) |
| ``{ [`${p}b`]: n }`` | `objectlit-computed-key` | `objectlit-computed-key` (unchanged) |
| `{ [1+1]: n }` | `objectlit-computed-key` | `objectlit-computed-key` (unchanged) |
| `{ [Symbol.iterator]: n }` | `objectlit-computed-key` | `objectlit-computed-key` (unchanged) |
| `{ a: 1, ["a"]: n }` | `objectlit-computed-key` | `objectlit-duplicate-key` (more precise, still rejected) |
| `{ get ["a"]() {} }` | `objectlit-property-kind` | unchanged |
| `{ ["m"]() {} }` | `objectlit-ordinary-to-primitive-method` | unchanged |
| `class A { [k]() {} }` | `class-member-unsupported` | unchanged |

Acceptance sweep `.tmp/4513/sweep.mts` — 30 shapes, each of which must be
claimed-and-emitted with legacy/IR parity or cleanly rejected; a single
`invariant` fails the adoption. Result: **PASS — 0 bad of 30; 18 claimed**
(12 claimed before, all baselines).

## Test Results

| gate | result |
| ---- | ------ |
| `tests/issue-4513.test.ts` | 28 passed |
| `tests/issue-4471.test.ts`, `tests/issue-4459.test.ts` (neighbours) | 62 passed |
| `pnpm run check:ir-fallbacks` | OK — no unintended / post-claim / module-level increase. Base run also captured (`.tmp/4513/fallbacks-base.txt`) via the `.tmp/4513/base/` revert copies: identical, so "unchanged" here is a measurement, not an assumption |
| `pnpm run check:ir-only` (+ `--policy=hybrid`) | READY. Pre-merge A/B against the `.tmp/4513/base/` revert copies: host lane 37/37 emitted before and after; standalone lane 19 emitted / 18 unsupported before and after — this change moves neither. Re-run on the merged tip reads 22 emitted / 15 unsupported on the standalone lane; that delta is main's, not this branch's, and the A/B is what attributes it |
| `pnpm run check:ir-adoption` | clean after regenerating the `ObjectLiteralExpression` row (`--ignore-all-space` diff touches that row only; the rest is table-column repadding) |
| `pnpm run typecheck` | 0 errors (base: 0) |
| `pnpm run lint`, `format:check` | clean |
| `check:loc-budget` | `select.ts` +17, `from-ast.ts` +9, both granted by this issue's `loc-budget-allow` |
| `check:func-budget`, `check:oracle-ratchet`, `check:pushraw`, `check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, `check:speculative-rollback`, `check:coercion-sites`, `check:host-import-policy`, `check:dead-exports`, `check:harness-compile-budget`, `check:issue-ids{,:against-main}`, `check:done-status-integrity`, `check:test-vacuity-shapes` | all OK |
| `scripts/equivalence-gate.mjs`, shards 1–8 | no new regressions |

`check:godfiles` fails on this branch, and also fails without it — every
function it names (`src/codegen/index.ts`, `object-runtime.ts`,
`array-methods.ts`, `native-strings.ts`) is in a file this change does not
touch. It is not run by any workflow.

## Issue-id collision (recorded, because the mechanism is the lesson)

This slice was built as **#4511**. `claim-issue.mjs --allocate` reserved that id
with `pr_scan="degraded"` — `gh` is unavailable in this container, so the
open-PR id universe was never consulted and the tool said so. While the branch
was in flight, `1efe399b` landed the session usage-limit monitor on main **as
#4511**. Renumbered to a freshly reserved **#4513**.

Two things worth keeping:

- The degraded-scan warning was accurate and the collision was the exact one it
  names. A `pr_scan="degraded"` reservation is a *provisional* id, not a clean
  one — re-check before pushing, not just before creating the file.
- `check:issue-ids:against-main` caught it at the pre-push hook, which is where
  it is supposed to be caught. Left unrenumbered it would have failed the
  `quality` gate and, past that, wedged the merge queue (#2531).

## LOC budget

`loc-budget-allow` covers `src/ir/select.ts` and `src/ir/from-ast.ts`. The
growth is one shared fold plus the measured rationale for its boundary — in
particular the numeric-key measurement, which is the part a future widening
would otherwise re-derive incorrectly (as this slice's own first draft did).
