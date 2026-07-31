---
id: 3900
title: "perf: gc-native toLowerCase/toUpperCase costs ~2.2 µs per 23-char conversion and emits an 11.7 KB module — the worst absolute outlier on the perf page"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
depends_on: [3898]
related: [3899, 3901, 1970]
---

# #3900 — `toLowerCase`/`toUpperCase`: 2.2 µs per 23-char conversion, 11.7 KB module

## Status: open

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
