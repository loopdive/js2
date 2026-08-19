---
id: 3900
title: "perf: gc-native toLowerCase/toUpperCase costs ~2.2 µs per 23-char conversion and emits an 11.7 KB module — the worst absolute outlier on the perf page"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: 78
horizon: l
es_edition: multi
depends_on: [3898]
related: [3899, 3901, 1970]
---

# #3900 — `toLowerCase`/`toUpperCase`: 2.2 µs per 23-char conversion, 11.7 KB module

## Status: done

## Problem

`string/case-convert` is the single worst absolute outlier on
`https://js2.loopdive.com/benchmarks/performance.html`. From
`benchmarks/results/latest.json` (2026-07-31):

| strategy    | avgMs per `run()` | binary size | notes                          |
| ----------- | ----------------- | ----------- | ------------------------------ |
| `js`        | 0.00025358        | —           | hoisted baseline — see #3898   |
| `host-call` | 0.682174          | 249 B       | 2,690× the JS number           |
| `gc-native` | **4.367390**      | **11,762 B**| **17,200×** the JS number      |

The benchmark body is:

```ts
const s = "Hello World Test String";   // 23 chars
let r = "";
for (let i = 0; i < 1000; i = i + 1) {
  r = s.toLowerCase();
  r = s.toUpperCase();
}
return r.length;
```

## The gap is real even though the baseline is not

#3898 proved the JS baseline here is loop-invariant-hoisted — V8 runs the two
conversions once, not 2000 times, so the `17,200×` headline is meaningless.
**But this benchmark does not need a valid baseline to be a bug**, because the
absolute number is indefensible on its own:

- 4.367 ms ÷ 2000 conversions = **~2.2 µs per conversion**
- 2.2 µs ÷ 23 characters = **~95 ns per character**

95 ns is roughly 300 clock cycles to case-fold one character. For the ASCII
range this should be a compare-and-add of a few instructions. Something is
doing per-character table lookups, allocation, or worse.

The **11,762-byte module** is the other half of the signal: every other
gc-native string benchmark emits 1.3-3.0 KB. `case-convert` emits 4-9× more
code than any of them, which points at a large inlined Unicode case-mapping
table or a fully-generic folding routine being pulled in wholesale.

Note `gc-native` is **6.4× slower than `host-call`** here (4.367 ms vs
0.682 ms) — the only string benchmark where the "fast" lane loses to the host
lane. Whatever gc-native is doing, calling out to JS is currently better.

## Scope

1. **Find the lowering.** Locate the gc-native implementation of
   `String.prototype.toLowerCase`/`toUpperCase` (start in `src/runtime/` and
   `src/codegen/`) and account for the 11.7 KB. Report what the code actually
   is before changing it.
2. **ASCII fast path.** The overwhelming majority of real input — and 100% of
   this benchmark — is ASCII. A branchless `c >= 'A' && c <= 'Z' ? c + 32 : c`
   loop over the `(array i16)`, with a pre-scan that falls back to the full
   Unicode path only if a non-ASCII code unit is present, should get this to
   single-digit nanoseconds per character.
3. **Keep correctness.** The full path must stay for non-ASCII. Do not
   regress the Unicode-sensitive cases — including the special-casing rules
   (final sigma, `ß` → `SS`, Turkish dotted/dotless `i` if we implement it,
   and the length-changing mappings generally). Case folding is **not** a
   1:1 character map; an ASCII fast path is safe precisely because ASCII has
   no length-changing or context-sensitive mappings.
4. **Module size.** If the 11.7 KB is a static table, consider emitting it as
   a passive data segment / lazily-referenced global rather than inline
   instructions, or gating it behind actual non-ASCII use in the program.
   Landing-page module size is itself a published metric.

## Acceptance criteria

1. `string/case-convert` gc-native improves by **≥10×** against the current
   4.367 ms (target ≤0.44 ms), measured with
   `npx tsx benchmarks/run.ts --suite strings --filter case-convert`.
2. gc-native is **faster than host-call** on this benchmark (it currently is
   not).
3. gc-native module size for this benchmark drops below **4 KB**, or the
   issue documents concretely why the table must stay inline.
4. No test262 regressions in `built-ins/String/prototype/toLowerCase`,
   `toUpperCase`, `toLocaleLowerCase`, `toLocaleUpperCase`.
5. Re-measure against #3898's corrected baseline once available, and record
   the honest JS-relative ratio here.

## Non-goals

- `String.prototype.normalize` (tracked separately as the opt-in icu4x work).
- The `host-call` lane's 0.682 ms (#3903).

---

## Findings — where the time and the 11.7 KB actually went

### It was never ~95 ns per character

The "95 ns/char" figure is an artifact of dividing a **per-call** cost by 23
characters. The per-character work was never the problem.

`src/codegen/case-convert-native.ts` built its Unicode tables **into function
locals on every single call**, via `array.new_fixed` over a long inline
`i32.const` sequence, *before looking at a single character*:

| helper                 | tables materialised per call                                      | i32 values |
| ---------------------- | ----------------------------------------------------------------- | ---------- |
| `__str_toUpperCase`    | `UPPER_CASE_RUNS` + `UPPER_CASE_SPECIAL`                           | **1,262**  |
| `__str_toLowerCase`    | `LOWER_CASE_RUNS` + `LOWER_CASE_SPECIAL` + `CASED` + `IGNORABLE`   | **1,927**  |

The benchmark does 1,000 iterations × 2 conversions, so it allocated and filled
**~3.2 million i32 array slots** to case-fold 46,000 characters — ~70 wasted
element stores per character. That, not the folding, is the 2.2 µs.

A secondary per-character cost: `findSpecial()` is a **linear** scan of the
special table for *every* character on *both* passes. For `toUpperCase` that is
102 entries × 23 chars × 2 passes = 4,692 iterations per call.

Note this is a *different* root cause from #3899's scan kernels: this file never
used the generic `charCodeAt` lowering, so it never paid that f64 round-trip
tax — `srcCharAt()` already read the backing store with `array.get_u` in the
i32 domain.

### The 11.7 KB is 9,303 bytes of literal table operands

Measured by summing the LEB128 encoding of every `i32.const` in the six tables:

| table                   | values | const bytes |
| ----------------------- | ------ | ----------- |
| `CASE_IGNORABLE_RANGES` | 904    | 3,214       |
| `UPPER_CASE_RUNS`       | 752    | 1,836       |
| `LOWER_CASE_RUNS`       | 700    | 1,728       |
| `UPPER_CASE_SPECIAL`    | 510    | 1,354       |
| `CASED_RANGES`          | 318    | 1,158       |
| `LOWER_CASE_SPECIAL`    | 5      | 13          |
| **total**               | 3,189  | **9,303**   |

Section breakdown of the 11,762-byte module before the fix: `code` 11,303 B
(of which one wasm-opt-inlined function was 10,267 B), everything else 459 B.
So ~79 % of the published module size is table constants and ~9 % is all the
rest of the program. It is not "a fully-generic folding routine pulled in
wholesale" — the routine itself is ~1 KB.

## Fix

1. **ASCII fast path** (`buildAsciiFastPath`). One fused scan+map loop over the
   flattened `(array i16)`: while every code unit is `< 0x80` it writes the
   folded unit straight into a same-length output array and returns; the first
   unit `>= 0x80` branches out to the full Unicode path. No table is touched, no
   binary search, no special-table scan.
2. **Tables moved to immutable module globals** with `array.new_fixed` constant
   init expressions, so they are materialised **once at instantiation** instead
   of once per call. This also fixes the non-ASCII case (`"ÄÖÜ".toLowerCase()`
   in a loop had exactly the same per-call rebuild) and stops wasm-opt inlining
   from ever duplicating a 9 KB operand sequence across call sites.

### Why the ASCII fast path is safe

Case folding is not a 1:1 map, but **ASCII specifically has no length-changing
and no context-sensitive mapping**. Verified mechanically against the generated
tables rather than assumed:

- The lowest source code point in `UPPER_CASE_SPECIAL` is **U+00DF** (`ß`) and
  in `LOWER_CASE_SPECIAL` is **U+03A3** (`Σ`, the Final_Sigma rule). No ASCII
  input can reach a 1:N or conditional rule.
- Expanding every run in `UPPER_CASE_RUNS`/`LOWER_CASE_RUNS` that covers a code
  point `< 0x80` yields **exactly** `a-z → A-Z` and `A-Z → a-z` and nothing
  else — so `@`, `[`, `` ` ``, `{` and friends correctly do not fold.

## Test Results

`tests/issue-3900.test.ts` checks 32 strings in **both** directions against the
host engine's own result, under `--target standalone` **and** `--target wasi`
(no JS host import to fall back on). Coverage: ASCII fast path incl. the
characters bracketing the fold runs; non-ASCII at index 0 / middle / last /
immediately after a folded char (bail-out positions); simple 1:1 mappings;
length-changing `ß→SS`, `ﬁ→FI`, `İ`, `ǅǆǄ`, `ᾀ`, `ẞ`; and Final_Sigma
(`ΟΔΟΣ→οδος`, `ΑΣΒ→ασβ`, `ΣΣ→σς`, `ASCIIΣ→asciiς`). Plus a code-section ceiling
so a regression that re-inlines a table into a function body fails loudly.

Pre-existing suites all green: `issue-40-string-case` (18), `issue-2191-case-equals`
(6), `issue-3773-string-final-sigma` (2), and 77 string equivalence tests
(`string-methods`, `wrapper-string-concat`, `tostring-valueof`,
`string-relational-operators`, `in-operator-edge-cases`,
`strict-equality-edge-cases`). Also verified on cons-string/rope inputs and
union-boxed receivers. test262 was not run locally — the submodule is not
checked out in this worktree; CI covers it.

### Numbers

Measured with `npx tsx benchmarks/run.ts --suite strings --filter case-convert`
on a **4-core box under concurrent agent load**, so the absolutes are inflated
against the published `latest.json`. Both lanes were re-measured in the same
conditions, so quote the **ratios**:

| metric                     | before   | after     | change              |
| -------------------------- | -------- | --------- | ------------------- |
| gc-native `avgMs`          | 10.308   | 0.140     | **73.6× faster**    |
| host-call `avgMs`          | 1.767    | 1.883     | (unchanged lane)    |
| gc-native ÷ host-call      | 5.83× slower | **0.074 = 13.4× faster** | lane flip |
| module `code` section      | 11,303 B | **2,157 B** | −81 %             |
| module total               | 11,762 B | 11,972 B  | +210 B (+1.8 %)     |

Scaling the gc-native result by the host-call lane's ratio to its published
0.682 ms puts the corrected gc-native figure at roughly **0.05 ms**, against the
4.367 ms recorded — comfortably inside the ≤0.44 ms target.

### Acceptance criteria

1. **≥10× improvement — met.** 73.6× measured, ~86× scaled to the published
   baseline.
2. **gc-native beats host-call — met.** Was 5.83× slower, now 13.4× faster.
   This was the only string benchmark where the "fast" lane lost to the host
   lane; it no longer is.
3. **Module < 4 KB — NOT met; documenting why instead**, per the criterion's
   stated alternative. The 9,303 B of table constants is irreducible in the
   current emitter:
   - Every value costs **at least 2 bytes** in an `array.new_fixed` operand
     sequence (1 opcode byte + ≥1 LEB byte). With 3,189 table values the hard
     floor for this representation is **6,378 B** — already above the 4 KB
     target on its own, before any code.
   - Packing fields together does not help: LEB is 7 bits/byte, so packing
     saves only the per-value *opcode* byte, ~1 B per merged pair.
   - Delta-encoding all six tables was costed at **6,905 B** (from 9,303 B) plus
     a runtime prefix-sum decoder — a 20 % module cut, still 2.4× over target.
   - The only representation that goes materially lower is a **passive data
     segment + `array.new_data`** (delta-varint payload measured at 3,716 B).
     The emitter has no passive-segment support (`mod.dataSegments` is
     active/offset-only, there is no `datacount` section, and `array.new_data`
     is not in the `Instr` union), and the gc-native module has no memory. Even
     that lands near **6.5 KB**, so **< 4 KB is not reachable while the module
     carries full Unicode case tables at all.** Filing the passive-segment work
     is only worth it if module size becomes a hard target across the board.
   - The +210 B regression is global-section overhead. It buys the elimination
     of the per-call rebuild and immunity to inlining duplication; the code
     section, which is what a table re-inlining regression would blow up, fell
     by 9,146 B.
4. **No test262 regressions in the String case directories** — not runnable in
   this worktree (submodule absent); left to CI. The 32-string × 2-direction
   host-engine differential test plus the three pre-existing Unicode suites are
   the local stand-in.
5. **Honest JS-relative ratio** — deferred to #3898. The JS baseline for this
   benchmark is still loop-invariant-hoisted, so no ratio quoted here would
   mean anything; the absolute per-conversion cost above is the real result.

## Follow-ups (not filed)

- `findSpecial()` is still a linear scan per character on the non-ASCII path.
  Now that the special table is a module global it could be a binary search or
  a first-character reject test. Only reachable with non-ASCII input.
- Two **pre-existing** validation bugs surfaced while probing (both reproduce
  identically on the parent commit, neither touched here): `__str_trimStart`
  fails to validate when `JSON.stringify` + regex + case conversion appear in
  one module, and a module combining a regex literal with string constants
  mis-resolves a `global.get` in `run`.
