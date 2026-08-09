---
id: 3665
title: "Standalone RegExp: Unicode properties of strings and finite v-set algebra"
status: done
assignee: ttraenkler/codex-regexp-completion
sprint: 77
created: 2026-07-26
updated: 2026-07-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: regexp
goal: standalone
parent: 2161
depends_on: [3652]
related: [2591, 3549, 3567]
files:
  - src/codegen/regex/parse.ts
  - src/codegen/regex/unicode-string-data.generated.ts
  - src/codegen/regex/unicode-string-properties.ts
  - src/codegen/regex/wasm-array-literal.ts
  - scripts/generate-regexp-string-properties.mjs
  - tests/issue-3665.test.ts
  - tests/issue-2591-vflag-q-string-disjunction.test.ts
---

# Standalone RegExp Unicode string sets

## Measured problem

The fresh authoritative standalone baseline contains 469 generated Unicode
property-escape rows. Its 17 recorded non-pass rows were rechecked through the
maintained unified Test262 worker under the repository contract, Node 25.9.0 /
Unicode 17:

- current `main` (`dde8800c`): **6 pass / 11 fail**;
- predecessor #3652 (`b532d175`): **10 pass / 7 fail**.

The six baseline compile timeouts are stale and pass live. #3652 recovers the
four real code-point step-cap failures. The remaining seven rows are exactly
the ECMAScript `v`-mode properties of strings: `Basic_Emoji`,
`Emoji_Keycap_Sequence`, and the five `RGI_Emoji*` sequence properties.

The same missing representation accounts for **41 pattern-language failures**
in the 152-row `built-ins/RegExp/unicodeSets/` baseline:

- six versioned `\p{RGI_Emoji}` rows;
- 35 generated union/intersection/subtraction rows combining `\q{…}`,
  `Emoji_Keycap_Sequence`, and code-point operands.

The other five `unicodeSets` failures are RegExp prototype/property protocol
rows and are not attributed to this parser/compiler slice.

## Root cause

The compile-time host RegExp oracle is effective for code-point sets: scanning
the Unicode scalar range produces compact `CpRanges`, and #3652 carries them in
`CPCLASS`. That scan cannot discover a property's multi-code-point members.
Consequently a direct `\p{RGI_Emoji}` keeps only the members that happen to be
single code points, while #2591 deliberately refuses `\q{…}` inside `&&`/`--`
or beside a property of strings.

This is a representation gap, not a VM gap. The existing AST and bytecode can
already execute a finite string as a `concat` of ordinary Unicode atoms, and
can order alternatives longest-first. The missing layer is a compile-time set
value containing both:

- compact code-point ranges; and
- a finite set of multi-code-point sequences.

Union, intersection, and subtraction must operate on both components before
the result is lowered to the existing alternation/CPCLASS machinery.

## Authoritative data contract

Unicode 17's UTS #51 data files define the relevant properties:

- `emoji-sequences.txt`: `Basic_Emoji`, keycap, flag, tag, and modifier
  sequences;
- `emoji-zwj-sequences.txt`: `RGI_Emoji_ZWJ_Sequence`;
- `RGI_Emoji`: the union of those six sets.

The compiler must not fetch data at runtime or import a host regex engine into
the emitted module. A generator will transform the official version-checked
files into a compact committed TypeScript table with source hashes. The runtime
compiler only decodes that local table lazily. Updating Node/Unicode therefore
requires an explicit regenerated data review rather than silently mixing host
and table versions.

## Implementation plan

1. Generate the six Unicode 17 source sets into compact base-36 sequence data.
   Split single-code-point entries into coalesced ranges at decode time and
   derive `RGI_Emoji` by union, avoiding duplicate stored data.
2. Add a finite v-set evaluator for union, intersection, and subtraction. Host
   enumeration remains the oracle for ordinary code-point operands; `\q{…}`
   and properties of strings contribute finite sequence members.
3. Replace #2591's narrowed refusals with evaluator lowering. Sort final string
   alternatives by descending code-point length, append the CPCLASS arm, and
   reuse the existing regex VM unchanged.
4. Pin direct properties, mixed set algebra, longest-first prefix behavior,
   astral/ZWJ/tag sequences, empty `\q` members, and pure-Wasm validation.
5. Recheck all seven generated property rows and all 41 measured
   pattern-language `unicodeSets` failures under Node 25.9.0.

## Prior attempts deliberately not repeated

- #2591 correctly implemented top-level `\q{…}` union by direct alternation,
  but narrowly refused set operations because it had no first-class string set.
  Extending that source-splicing special case would compound parser branches
  and still could not evaluate intersection/subtraction.
- #3652 correctly compacts code-point membership in CPCLASS. Widening CPCLASS
  to variable-length strings would entangle trie/backtracking semantics with a
  stable one-code-point opcode; finite strings already compile through existing
  CHAR/concat/alternation bytecode.
- Test262's generated `matchStrings` arrays are evidence, not compiler data.
  Production tables come from the official Unicode 17 files, not the test
  corpus.

## Acceptance

- [x] the seven generated property-of-strings rows pass with no host imports;
- [x] the 41 measured string-set `unicodeSets` rows pass without changing the five
      protocol residuals;
- [x] #2591's existing 61 assertions and #3652's CPCLASS/step-budget suites remain
      green;
- [x] the emitted Wasm validates and instantiates with an empty import object;
- [x] typecheck, formatting, stack-balance, silent-fallback, and relevant quality
      ratchets pass.

## Implementation notes

### Why this stays a compile-time set layer

`UnicodeStringSet` preserves one-code-point members as coalesced `CpRanges` and
zero-/multi-code-point members as keyed sequences. Union, intersection, and
subtraction operate independently over those two domains, which is exactly the
ECMAScript set value model. Only the completed value is lowered:

- ranges become one existing `CPCLASS` arm;
- strings become existing `CHAR`/concat arms;
- arms are ordered by descending code-point length.

No property lookup, new opcode, host import, or parallel matcher was added to
the emitted module. Lookbehind reversal and ordinary backtracking therefore
continue through the established AST/bytecode path.

### Why the Unicode data is generated and committed

The generator reads the official Unicode 17 UTS #51
`emoji-sequences.txt`/`emoji-zwj-sequences.txt`, checks the version header, and
records each source SHA-256 in the generated file. It stores the six source
properties in a compact base-36 encoding and derives `RGI_Emoji` as their union,
so the 3,953-member aggregate is not duplicated. Compiler/runtime execution is
offline and deterministic; a newer Unicode release makes regeneration fail
until the version contract is deliberately advanced.

### Downstream Wasm validation boundary found by the authoritative worker

The reference VM and focused standalone cases initially passed, while the exact
worker rerun reached **39/48**: full `RGI_Emoji`, ZWJ, and modifier programs
exceeded V8's 10,000-operand `array.new_fixed` validation limit (largest program
array: 69,849 i32 values). The fix belongs at constant-array materialization,
not in regex semantics: small tables retain one `array.new_fixed`; large tables
allocate the final i32 array and fill it with bounded 8,192-value chunks via
`array.copy`. This preserves bytecode indices and stack balance while producing
valid Wasm for arbitrarily large finite properties.

### Prefix sharing required by the maintained worker

A final replay through the maintained unified worker exposed a second scale
boundary that the earlier one-shot harness did not: the flat longest-first
alternation passed 46/48 rows, but the complete `RGI_Emoji` and
`RGI_Emoji_ZWJ_Sequence` generated tests exhausted the unchanged VM step
budget. Their programs contained 23,283 and 16,733 instructions because every
complete string duplicated its prefix.

The final lowering builds a compile-time prefix trie and emits it with the same
CHAR/CPCLASS/concat/alt nodes. Descendants precede a node's empty terminal arm,
so a longer member still wins over its prefix; the one-code-point range arm
remains after every multi-code-point branch. Trie edges with identical
continuation subtrees share one CPCLASS head, avoiding a root-branch scan for
every concatenated emoji. The programs shrink to 1,313 and 1,072 instructions
without a new opcode or a larger runtime budget.

### Authoritative A/B and regression evidence

Pinned runtime: Node **25.9.0**, Unicode **17.0**, standalone target, maintained
unified original-harness worker.

- Fresh baseline: **0/48 pass** across the seven generated string-property
  failures and 41 `unicodeSets` pattern-language failures.
- This branch (stacked on #3652): **48/48 pass**, no skips or residual failures.
- Focused Vitest: **80/80 pass** across #3665, #2591, and #3652.
- The five remaining UnicodeSets baseline failures live under
  `RegExp.prototype.unicodeSets` protocol/property behavior, not pattern
  compilation; this change neither claims nor masks them.
