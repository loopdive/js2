---
id: 3688
title: "perf: `a === b` with both operands statically `number` boxes, unboxes, and does an object→string comparison"
status: done
completed: 2026-07-31
created: 2026-07-27
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
language_feature: operators
goal: performance
sprint: 78
related: [3673, 3686, 3685, 1584, 1852, 2109]
---

# #3688 — Static-`number` equality goes through the generic ladder

## Problem

`tk[i] === 40`, where the checker knows **both** operands are `number`,
does not compile to `f64.eq`. It emits:

- **4 × `__box_number`**,
- **4 × unbox**,
- **an object→string conversion and a string comparison**, per evaluation.

Measured while investigating the WasmGC/linear split (#3687): this ladder
— not the null-check/cast scaffolding of #3686 — is the GC lane's real
~5x on tokenizer-shaped code. A tokenizer compares the current character
against literal codes on *every* token (`=== 40`, `=== 41`, `=== 32`,
`=== 44`, digit and letter range tests), so this is squarely on the
hottest path any parser has.

For scale, from the #3673 ladder: our compiler runs the typed tokenizer
at ~0.100 ms where node does ~0.033 ms and a hand-written WasmGC
equivalent does ~0.015 ms. #3686's scaffolding was priced at +10-16 %;
this is a multiple, and it is the larger prize.

## Why it happens

Equality lowering is generic: it routes through the runtime's
`__any`-style comparison path that must handle any pair of JS values
(§7.2.15 Strict Equality — number/string/boolean/object/null/undefined,
`-0`/`NaN` rules, and the `$AnyValue` tag lanes). That path is correct
and necessary when the operand types are unknown. The defect is that a
site where the checker has already proven BOTH operands are `number`
still pays for it, instead of narrowing to a direct `f64.eq` (or `i32.eq`
once #3673's i32 work lands).

Note the shape of the bug: the boxing is not the whole cost. An
object→string conversion plus a string comparison per token means the
generic path is reaching a stringly-typed comparison arm for two
statically-numeric operands — worth understanding precisely before
optimising, because it may indicate the fast arms are ordered behind a
slower one rather than simply absent.

## Direction

1. **Diagnose first.** Compile `const a: number = 1; const b: number = 2;
   a === b` and disassemble. Establish exactly which arm is reached and
   why the numeric arm is not, before changing anything. If the numeric
   arm exists but is ordered behind the string arm, the fix is ordering,
   not new lowering.
2. **Narrow at the lowering site** when both operand types are proven
   numeric: emit `f64.eq` directly (with the `-0`/`NaN` semantics of
   strict equality — `NaN !== NaN` and `+0 === -0`, which `f64.eq`
   already gives). Compose with #3673's i32 work: when both sides are
   proven i32, `i32.eq`.
3. Apply the same treatment to the other comparison operators
   (`!==`, `<`, `<=`, `>`, `>=`) if they share the ladder — check, do not
   assume. #2109 fixed a related comparison defect and is the precedent
   for how the narrowing was done there.

## Non-goals

- Changing generic equality for genuinely dynamic operands.
- Any deviation from §7.2.15 for `NaN`, `-0`, or mixed-type comparison.

## Acceptance criteria

- `a === b` with both operands statically `number` emits no
  `__box_number`, no unbox, and no string comparison — verified by
  disassembly, not inference.
- Measured on the #3673 harnesses (`.tmp/tokenize-only.mjs`,
  `.tmp/parser-shootout.mjs`, `.tmp/simd-shootout.mjs`) against the
  established ladder (node ~0.033-0.035 ms · hand-written WasmGC ceiling
  ~0.015 ms · ours ~0.100 ms), with a duplicate-baseline control arm and
  the control band reported.
- **Whole-chain or negative** — the #3673 law, confirmed four times
  (#3683 S4a's f64 fields ~1 %; round 33's peephole never fired; round 36
  measured partial narrowing as a **2.7x pessimization**). If narrowing
  the comparison leaves its operands boxed elsewhere, it can measure
  worse. Verify the whole chain or do not land it.
- Full `tests/equivalence` failure set identical by test NAME; corpus 0
  real gaps; canaries `imports: ZERO`. Equality/`-0`/`NaN` conformance
  pins added.

## Diagnosis (step 1, done before any code changed)

The brief's claim reproduces, but **not** on the shape it first looks like,
and the fast arm turned out to be neither missing nor mis-ordered.

`a === b` with two `number` **parameters** already compiled to
`local.get / local.get / f64.eq`. So did `a === 40`,
`s.charCodeAt(i) === 40`, and `l.pos === 40` on an f64 class field. The
ladder only appears when an operand's **natural lowering is boxed**. The
reproducer is round 38's actual shape — a `number[]` reached through a
class field:

```ts
class St { tk: number[]; pos: i32; … }
s.tk[s.pos] === 40
```

which emitted (standalone, `funcBody` with call targets resolved):

```
array.get → __box_number → __extern_is_nullish ×2 → __extern_is_undefined ×2
→ __typeof_number ×2 → __unbox_number ×2 → __typeof_boolean ×2
→ __unbox_boolean ×2 → __typeof_bigint ×2 → __to_bigint ×2
→ __str_flatten ×2 → __str_equals → ref.eq
```

268 WAT lines for one comparison, including the object→string conversion
and string comparison the issue describes. **The control that identified
the cause:** the byte-identical expression with `<` instead of `===`
compiled to bare `array.get` + `f64.lt`, 45 lines, zero boxing.

The difference is one list. `compileBinaryExpression` computes a
`numericHint` and threads it DOWN into both operand emitters;
`isNumericOp` — the flag that decides whether a hint exists at all —
enumerates `+ - * / % **`, the four relationals and the six bitwise ops,
and **not** `=== !== == !=`. With no hint, each operand is emitted in its
natural representation, and the legacy element-access path's natural
representation is externref, because that is how it expresses the
out-of-bounds `undefined`. The typed dispatch then saw externref × f64,
boxed the f64 side to match, and fell into the generic cascade.

So the fix is neither a new lowering arm nor a reordering: it is giving
equality the hint. That is also why it is **whole-chain** rather than the
partial narrowing round 36 measured as a 2.7x pessimization — the hint
propagates into the operand emitters, so the element read is produced
unboxed in the first place instead of being boxed and then unboxed back.

## Implementation

`src/codegen/binary-ops.ts`, two edits:

1. `bothStaticNumberEq` (computed next to `wrapperEquality`);
2. `numericHint` becomes `isNumericOp || bothStaticNumberEq ? … : undefined`,
   reusing the SAME i32-vs-f64 term list so `bothNativeI32` (the
   `type i32 = number` alias work) lands `i32.eq` for free.

The three remaining i32 terms are self-gating for equality
(`hasI32LocalOperand` requires `isRelational`, `arithI32WithToInt32Wrap`
requires a ToInt32-coercing bitwise parent, `bitwiseI32` requires a
bitwise op), so an equality resolves to `(ctx.fast || bothNativeI32) ?
i32 : f64`. That is deliberate: those three rest on `isI32PureExpr`,
whose add/sub/mul arms are wrap-sound only "under the parent's ToInt32
guarantee", which an equality does not provide — `(a + b) === c` must not
compare wrapped i32s.

### The carve-out, and why it is there (measured, not theorised)

TypeScript's index signatures are unsound: `tk[9]` on a `number[]` is
typed `number` but is `undefined` at runtime. The f64 lowering represents
that as NaN (the project-wide "null/undefined in f64 context → NaN"
convention). NaN and `undefined` agree under **every operator the hint
already covered** — `undefined + 1` and `NaN + 1`, `undefined < 1` and
`NaN < 1` — but they disagree under equality, in exactly one pairing:
`undefined === undefined` is **true**, `NaN === NaN` is **false**.

Measured with a behavioural probe run on both trees: an unrefined gate
flipped `s.tk[9] === s.tk[8]` (both reads out of bounds) from `101` to
`100`. Every other probe was identical, and the full equivalence suite's
failure set was identical by name either way — so this was invisible to
the local gates and would only have been found, if at all, in test262.

The gate therefore also requires **at least one operand that can never be
`undefined`**. That is sufficient, not merely conservative: with one side
a genuine Number, `undefined === <number>` and `NaN === <number>` are
both false, so no observable result can change. The whitelist is
computed-not-fetched expressions (numeric literals, `NaN`/`Infinity`
globals, prefix `- + ~`, nested arithmetic/bitwise) plus identifiers in
f64/i32/i64 slots, which physically cannot hold `undefined`. Element
access, property access and call results are excluded — those are exactly
the expressions that can hand back `undefined` behind a `number` type.

This keeps the whole motivating shape (`tk[i] === 40`, `c === 95`,
`this.tokKind !== 0` — a tokenizer compares a buffer read against a
literal code) and costs only element-vs-element comparison.
`JS2WASM_STATIC_NUMBER_EQ=0` restores the pre-#3688 lowering for
differential testing.

### Operators checked, not assumed

`< <= > >=` were **already** in `isNumericOp` and already narrow — that
was the control that found the bug, and their output is unchanged.
`!==` shares the equality ladder and now gets `f64.ne`. Loose `==`/`!=`
are included because §7.2.15 step 1 makes them identical to strict
equality when both operands are the same type, so the same `f64.eq`
is exact.

## Measured result

Two workloads, all lanes interleaved in one process, `.tmp/simd-shootout.mjs`'s
harness parameters (min-of-14 × 50 reps × 5 rounds), with a
**duplicate-baseline control arm**: the same base compiler builds the same
source twice, producing byte-identical modules, so their delta is the noise
floor.

| lane | run 1 min ms | run 2 min ms | bytes | vs node |
| --- | --- | --- | --- | --- |
| node (JS, V8) | 0.0325 | 0.0319 | — | — |
| `codes` (`tk[i] === 40`, `number[]`) / base | 0.2337 | 0.2275 | 113,184 | 7.14x slower |
| `codes` / base2 (duplicate control) | 0.2373 | 0.2283 | 113,184 | 7.16x slower |
| **`codes` / fixed** | **0.0718** | **0.0713** | **111,890** | **2.24x slower** |
| `strtok` (#3673 string tokenizer) / base | 0.0993 | 0.0999 | 47,771 | 3.13x slower |
| `strtok` / base2 (duplicate control) | 0.0999 | 0.0980 | 47,771 | 3.08x slower |
| `strtok` / fixed | 0.0994 | 0.0978 | 47,771 | 3.07x slower |

- `codes`: control band **1.52 % / 0.37 %**, effect **69.3 % / 68.6 %** ⇒
  **3.26x / 3.19x faster**, an order of magnitude outside the band in both
  runs. Module 113,184 → 111,890 bytes.
- `strtok`: effect **−0.03 % / +2.09 %** against a control band of
  **0.57 % / 1.83 %** — i.e. it lands on both sides of its own band across
  two runs, which is what a null result looks like when the band is
  estimated from a single pair. The decisive evidence is not the timing:
  the compiled module is **byte-identical** base vs fixed, so the effect is
  exactly zero and the ±2 % is entirely harness noise. Expected — that
  source's `=== 32` / `!== 0` sites compare a `charCodeAt` result (already
  f64) against a literal, so they never used the ladder.
- The refined (carve-out) gate and the unrefined one produce a
  **byte-identical** `codes` module, so the carve-out costs nothing on
  this workload: every comparison in it has a literal operand.

Position on the #3673 ladder: node ~0.033-0.036 · hand-written WasmGC
ceiling ~0.015 · our string tokenizer ~0.100 (unmoved) · the `number[]`
tokenizer **0.234 → 0.072**.

Other established harnesses, all unmoved and all with an identical
compiled artifact:

- `.tmp/tokenize-only.mjs`: 0.106 ms (same source as `strtok`).
- `.tmp/simd-shootout.mjs` "OUR compiler (WasmGC)": 0.0995 ms, against
  node 0.0360 and hand-written WasmGC 0.0154 — the published ladder.
- `.tmp/parser-shootout.mjs`: 0.1711 vs 0.1705 ms base; module 50,681
  bytes both.
- Compiled acorn deep-warm: **module byte-identical** (1,214,535 bytes),
  0.655/0.671/0.703 base vs 0.702/0.710/0.725 fixed — pure measurement
  noise on the same artifact. Expected: acorn is dynamically typed, so
  `this.type === tt.name` and friends are not statically `number` and
  correctly do not narrow. `imports: ZERO`, `smoke=4` on both.

## Verification

- `npx tsc --noEmit` clean; `check:loc-budget` OK; `check:oracle-ratchet`
  OK (no new checker calls — the gate reuses the `leftTsType`/`rightTsType`
  the function already had).
- `DOGFOOD_ACORN=1 dogfood:acorn-corpus`: 0 real gaps, every file quirks=0.
- Full `tests/equivalence` (1,646 tests) on base and on the branch:
  **33 failures on both, identical by test name** (`diff` of the sorted
  name lists is empty).
- Pins green: `issue-3673-i31-smallint`, `issue-3683-typed-this-twin`,
  `issue-3683-numeric-fields`, `issue-3683-direct-calls`,
  `issue-3683-arity-padding`, `issue-3685-receiver-flow`, `issue-1712`,
  `issue-2151-nary`, `issue-2109` — 95/95.
  `tests/issue-1817.test.ts` fails 3 `>>>` tests, confirmed identical on
  the stashed base.
- New suite `tests/issue-3688-static-number-equality.test.ts` (18 pins):
  disassembly assertions that the narrowed site emits no `__box_number`,
  no unbox and no string compare; a positive control proving a dynamic
  operand still reaches the ladder; an ON/OFF differential via
  `JS2WASM_STATIC_NUMBER_EQ`; `NaN !== NaN`, `+0 === -0`, fractional
  exactness, `Object.is` as the SameValue contrast, mixed-type,
  union, string/boolean, object-identity and wrapper-object non-goals,
  and the out-of-bounds carve-out.

## Status flip 2026-07-31 — this was already finished; `in-progress` was stale

Closed as `done` on audit, not on new work. The implementation
(`bothStaticNumberEq` + the `JS2WASM_STATIC_NUMBER_EQ` kill-switch in
`src/codegen/binary-ops.ts`), the 18 pins in
`tests/issue-3688-static-number-equality.test.ts`, and the measured result above
all landed in **`8b4d74f1cd3e51`** ("perf(#3688): give statically-`number`
equality the numeric operand hint"), which is on `main`. Only the Follow-on
below remained, and it is explicitly punted to #1584/#1852 rather than owned
here.

Recorded because the stale status actively mis-dispatched work: this issue was
handed out as live work on the strength of #3686's file calling it "the larger
prize" plus a clean-looking (allocation-stub) claim record. **It is a measured
no-op on the acorn target** — the Measured-result section above already records
that compiled acorn is **byte-identical** (1,214,535 bytes) with and without the
fix, because acorn is dynamically typed so `this.type === tt.name` and friends
are not statically `number` and the gate correctly never fires. The 3.2x win was
on a synthetic `number[]` tokenizer. Anyone reaching for this issue to speed up
acorn should stop; see #3685 and #3686 for where standalone parse time actually
goes.

## Follow-on

Element-vs-element comparison (`tk[i] === tk[j]`) is left on the generic
path by the carve-out. Closing it needs a real answer to the
`undefined`-vs-NaN conflation in the f64 lowering — either an
out-of-bounds proof (`0 <= i < len`, which `matchHoistedCharRead` already
does for `charCodeAt`) or a distinct undefined sentinel that equality can
test. The OOB else-branch already emits a *tagged* NaN
(`0x7FF8_0000_0000_001E`), so the sentinel exists; `f64.eq` just cannot
see it. That is #1584/#1852 value-representation territory, not this
issue.
