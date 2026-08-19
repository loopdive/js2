---
id: 4065
title: "RegExp engine is a separate lever hiding inside String.prototype — M1 REFUTED (51 → 8, consumed by #4016); real lever is the dynamic-pattern refusal under built-ins/RegExp"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
assignee: ttraenkler/L-regexp
related: [4016, 4042, 4056, 4067]
---

# RegExp engine is a separate lever hiding inside String.prototype

> **⚠ The numbers in the ORIGINAL BODY at the bottom are STALE.** They were
> measured 2026-08-01, BEFORE #4016 landed. They are kept for the record and
> corrected in the table below. Do not size anything from them. A stale issue
> body is not inert: four consecutive misaimed fixes
> (#3983/#3984/#3991/#4032) came from trusting one.

## Outcome

**M1 was a false lever.** The task was explicitly to check whether the M1
search-value refusal was still load-bearing *before* implementing against it.
It was not — #4016 (PR #3996) had already consumed it. The real RegExp-engine
lever is one directory over: **#4042's dynamic-pattern refusal under
`built-ins/RegExp`**, not under `String.prototype`. This issue retargeted onto
that and shipped it.

## Instrument validation (before reading any delta)

Fresh standalone baseline, `fetch-baseline-jsonl.mjs --standalone --force`,
row timestamps `2.8.2026, 07:26:36 → 07:37:16`, `oracle_version` 12, lane
`honest`.

| | |
| --- | --- |
| Rows / bad JSON / duplicate `file` keys | **48,619 / 0 / 0** |
| Corpus files that failed to open (`unopenable`) | **0** |
| Official scope | **43,505 run** / 26,087 pass (60.0 %) |
| Goal scope (`es5id` present, or none of `es5id`/`es6id`/`esid`) | **8,545 run** / 6,376 pass (74.6 %) / 2,169 non-pass |

**Agreement with published figures: 2 of 2 denominators reproduce exactly** —
goal-scope run **8,545** (as in both this issue's original census and #4016's)
and official run **43,505** (as in #4016's). Pass counts are strictly higher
than both earlier reports, which is what landed work should look like.
Positive control: 12 files the baseline records as standalone `pass` under
`built-ins/RegExp` → **12 / 12 pass**.

## What this REFUTES about its own original framing

**The two cuts are kept separate and are never summed.**

| Cut | Original claim (2026-08-01) | Measured now | Note |
| --- | ---: | ---: | --- |
| **M1 mechanism cut** — goal-scope non-pass carrying the search-value refusal string | 51 | **8** | all 8 are `replace`; only **4** are host=pass |
| M1 mechanism cut, all-official | ~98 | **36** | |
| **Per-method cut** — `split`/`replace`/`search`/`match` non-pass under `String/prototype` | 91 | **52** | a DIFFERENT cut from the 51/8 above |
| **Area population** — `built-ins/String/prototype`, goal scope | 630 run / 427 pass / 203 non-pass | **642 run / 512 pass / 130 non-pass** | |

The 8 surviving M1 files are **precisely the residual #4016 deliberately
deferred**: `replace` with a function replacer, a separate pre-existing defect.
Reproduced on unmodified `main`: **0 / 8**, all 8 carrying exactly that
refusal. So M1 is not merely smaller — it is *closed*, and what remains is
owned elsewhere.

**The genuine engine lever is #4042's** `Unsupported dynamic regular
expression pattern`: **18 all-official / 10 goal-scope / 10 of 10 host=pass
(100 % reachable)**, living under `built-ins/RegExp`, not `String.prototype`.
"A separate lever hiding inside String.prototype" was pointing one directory
off.

## What shipped

CharacterEscape support in the **runtime** (dynamic) standalone pattern
compiler, plus the tokenisation invariant that had to be fixed first.

### Root cause — a fifth instance of the recurring shape

`ensureDynamicStandaloneRegExpCompiler` walks a runtime-built pattern **four
times**: count program records, find the next `|`, emit the records, and the
anchored literal-alternations fast path. Each walk advanced **one source code
unit at a time and re-derived the character semantics itself** — and only the
*emitter* knew that `.` means `ReOp.ANY`.

That agreed only because every construct the runtime grammar accepted was
exactly one unit wide. The invariant was never written down; it existed as two
independent derivations of the same quantity — `CHARS` (counted) in the first
walk, and the expression `J - I` (source-unit distance) in the third.

This is the shape logged four times on 2026-08-01/02 (#3989, #4077, #4079,
#4081): **a duplicated emission sequence where one copy carries the handling
and another does not.** Here it is duplicated *four* ways, and the invariant is
not even a comment in one copy — it is arithmetic in one and a counter in
another.

### The pre-existing silent wrong answer it was already causing

The fourth walk (`REGEX_ANCHORED_LITERAL_ALTS_MARKER`) copies the pattern's
**source text verbatim** as its match payload. That is only valid when source
text == matched text. Measured on **unmodified `main`**:

```
^(?:a.c|zz)$  ~  "abc"     Node: "abc"     standalone: NO MATCH   <-- wrong
a.c           ~  "abc"     Node: "abc"     standalone: "abc"      <-- right
```

Same construct, two different answers, decided only by whether the pattern is
anchored. Nothing in the population pointed at this; it fell out of reading the
fourth walk.

### Fix

- **`src/codegen/regexp-dynamic-pattern.ts` (new)** — owns the *grammar*
  question ("what is the next token and how wide is it?"). One decoder,
  `__regex_dyn_token`, returning a packed `kind | len << 3 | value << 8`.
  All four walks call it, so token boundaries and character semantics are
  decided in exactly one place. `regexp-standalone.ts` keeps the emission
  plumbing.
- `CHARS` now counts **records**, not source units.
- The SPLIT's second target is a **counted** `ALTN`, never the `J - I`
  source-unit distance.
- The alternations fast path is gated on a new `PLAIN` flag (every token a
  one-unit literal), which is what fixes the `.` defect above.
- The decoder is deliberately conservative: anything it is not certain of is
  `TOKEN_UNSUPPORTED`, which keeps the existing **catchable** `TypeError`.
  A refusal is recoverable; a wrong match is not.

Grammar added: `\xHH`, `\uHHHH`, `\cA`–`\cz`, `\f\n\r\t\v`, IdentityEscape of
any non-alphanumeric, and the Annex B B.1.4 fallback where `\c` **not**
followed by an ASCII letter decodes as a literal backslash of width 1.
Still refused, on purpose: `\d \D \s \S \w \W \b \B \k \p \P`, octal /
back-references, every other `\`+alphanumeric, and `^ $ * + ? ( ) [ ] { }`.

### The budget gates improved the decomposition

The first cut put the token accessors, `flagBit` and `dynamicCharOperand`
inside `ensureDynamicStandaloneRegExpCompiler`, and the per-function ceiling
(#3400 / R-FUNC) rejected it: **824 > 750 (+74)**. The gate's instruction is
*split, don't allow*, and following it was right — the read side of the token
format belongs next to the writer, so packing and unpacking cannot drift apart.
Moving the accessors (plus `flagBit`, which decodes the runtime *flags* string,
and `charOperand`, which turns a decoded unit into its match operand) into
`regexp-dynamic-pattern.ts` put the function back under budget **without an
allowance**.

| file | cap | before | after | |
| --- | ---: | ---: | ---: | --- |
| `src/codegen/regexp-standalone.ts` | 4,261 | 4,280 (+19, #4016's allowance) | **4,261** | **at cap — no allowance** |
| `src/codegen/regexp-dynamic-pattern.ts` | — | — | 534 | new |
| `…::ensureDynamicStandaloneRegExpCompiler` | 750 | 824 (+74) | **under** | — |

`regexp-standalone.ts` ends up **smaller than it was before this change**, and
this PR claims **no `loc-budget-allow` and no `func-budget-allow`**. As in
#4016, following the gate produced a better structure than the design it
rejected.

## Test Results

Harness: `runTest262File(..., "standalone")` — **status only** (its error
category/line are not the CI path, and it does not apply the #2961 host-import
refusal). Serial, single process.

### Funnel — per stage, never collapsed

| Stage | Count | Cut |
| --- | ---: | --- |
| Population — goal-scope non-pass carrying the dynamic-pattern refusal | **10** | mechanism |
| — same, all-official | 18 | mechanism |
| Reachable — of those 10, host=pass | **10 / 10 (100 %)** | reachability |
| **Flipped** | **6 / 10** | measured |

100 % reachability is a property of how the population was selected (a Tier-1
refusal string — every member is conclusively gated on this one mechanism),
not a claim that levers behave this way. The project's reference point is 103
reachable → 34 flipped (33 %).

### Attribution — kill-switch removed

The same 10 files on **unmodified `upstream/main`**, same harness, same
corpus: **0 / 10 pass**, all 10 failing with exactly
`TypeError: Unsupported dynamic regular expression pattern`. That is the
"before" arm; the change is the only difference.

### Flips

| File | before | after |
| --- | ---: | ---: |
| `RegExp/S15.10.2.10_A2.1_T1` (`\cA`–`\cZ`) | fail | **pass** |
| `RegExp/S15.10.2.10_A2.1_T2` (`\ca`–`\cz`) | fail | **pass** |
| `RegExp/S15.10.2.10_A3.1_T2` (`\xHH`) | fail | **pass** |
| `RegExp/S15.10.2.10_A4.1_T2` (`\uHHHH`) | fail | **pass** |
| `RegExp/S15.10.2.10_A4.1_T3` (`\uHHHH`) | fail | **pass** |
| `RegExp/S15.10.2.10_A5.1_T1` (IdentityEscape) | fail | **pass** |
| `RegExp/S15.10.2.8_A3_T15` (200 nested groups) | fail | fail |
| `RegExp/S15.10.2.8_A3_T16` (200 nested groups) | fail | fail |
| `RegExp/S15.10.4.1_A8_T2` (`a\|b\|[]`) | fail | fail |
| `annexB/.../RegExp-control-escape-russian-letter` | fail | fail |

### Why the Cyrillic annexB file did NOT flip, though it was expected to

This is the one prediction that failed, so the reason is recorded rather than
left for the next reader to rediscover.

The Annex B `\c` fallback **is** implemented and **does** work. Measured: all
**three** assertions the file's Cyrillic loop makes pass in isolation for
`\cЖ` — it does not wrap around to `String.fromCharCode(0x416 % 32)`, it does
not match the bare `cЖ`, and it does match the literal text `\cЖ`.

It fails on the **third** loop, which is not about Cyrillic at all
(lines 27–32): it iterates ASCII `0x00`–`0x7F` and yields every character *not*
matching `/[0-9A-Za-z_\$(|)\[\]\/\\^]/`. Measured, that set is **56
characters**, and **6 of them** (`* + . ? { }`) form a quantifier or meta
construct when appended to `\c`. So the test constructs
`source = "\\c" + "*"`, i.e. the pattern `\c*` — under Annex B a literal `\`
followed by `c*`, a **quantifier**. Measured: `\c*` returns
`TOKEN_UNSUPPORTED` (Node returns `"\ccc"`), so the whole file refuses.

The file therefore needs **quantifier support**, not more escape work. Its
`es5id` is `15.10.2.10_A2.1_T3`, which makes it look like a sibling of the
`_T1`/`_T2` files that *did* flip — that resemblance is the trap.

### Differential probe vs Node (Node is the oracle, computed per case)

37 hand-built cases through the genuinely-dynamic path:
**29 AGREE · 8 loud refusals · 0 WRONG · 0 MISS.**

The instrument was validated in **both** directions first. An earlier version
of this probe reported 6/6 green using patterns like `"a" + ".c"` — which
`staticConstStringValue` **constant-folds**, so it silently exercised the
compile-time path and proved nothing. The fold-test control (`(a)b` behind a
function call must produce the unsupported-dynamic `TypeError`) is what
establishes that the probe reaches the runtime compiler at all.

A suspicion this refutes: `.` is **absent** from the old `isRegexMeta` set,
which looked like a bug. It is not — `.` was handled correctly in the emitter.
Checked before reporting.

### Regression guard

**261 files** — every file the fresh baseline records as standalone `pass`
whose source can reach the RegExp **constructor** at all (`/\bRegExp\s*\(/`),
out of **26,087** official baseline-pass rows. The remaining 25,826 cannot
reach `ensureDynamicStandaloneRegExpCompiler` without a constructor call.
Result: **261 / 261 pass, 0 regressed.**

`tests/issue-4065.test.ts` adds 34 cases, including the multi-unit-escape and
escaped-`\|` interactions with alternation, the `.`-in-anchored-alternation
defect, and the eight constructs that must stay loud refusals.

## Deliberately NOT shipped

- **Capture groups in dynamic patterns** (`S15.10.2.8_A3_T15/T16`, 200 nested
  parens). Needs SAVE-slot allocation in the runtime compiler — a different
  mechanism, not an escape.
- **Unanchored alternation + empty character class** (`S15.10.4.1_A8_T2`).
- **Quantifiers**, which is what the Cyrillic annexB file actually needs.
- **The 8 `replace` M1 residuals** — function replacers, #4016's named
  follow-up, not this lever.
- **#4067's god-file split** of engine vs String↔RegExp bridge. A
  consolidation-goal refactor; folding it into a conformance fix was
  explicitly out of scope. The new `regexp-dynamic-pattern.ts` is a
  *tokenisation* subsystem and does not pre-empt that split.
- **Backpatching the SPLIT target** instead of counting `ALTN`. Counting is
  correct and smaller; backpatching would additionally remove an ordering
  constraint, but nothing in the population needs it.

---

# ORIGINAL BODY (STALE — measured 2026-08-01, superseded above)

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Surfaced by L-strwith 2026-08-01 while decomposing the String.prototype area. It is a
DIFFERENT mechanism with a different owner and must not be counted as String work.

POPULATION (fresh baseline, goal scope = es5id present OR none of es5id/es6id/esid):
  built-ins/String/prototype: 630 run / 427 pass / 203 non-pass    [STALE -> 642 / 512 / 130]
  M1 "RegExp / symbol-protocol search-value refusal": 51 files      [STALE -> 8]
  By method, split/replace/search/match account for 91 non-pass     [STALE -> 52]
  (the two figures are DIFFERENT CUTS — 51 is the mechanism classification,
   91 is a per-method count. Do NOT sum or reconcile them silently.)

Adjacent, already in the tail census (PR #3980): "RegExp engine semantics" 68 files
(39 SA-only) and "RegExp unsupported pattern/arity" 21 files (16 SA-only, Tier-1
conclusive refusals). Whether M1's 51 overlaps those 68/21 is UNMEASURED — establish
that before sizing, or you will double-count.

⚠ THE FRAMING THIS CORRECTS: String.prototype was dispatched as "generic receivers,
218 files, top signature `Cannot access property on null or undefined` (31)". All
three parts were wrong. Normalized, that signature is 22 files, and the area carries
**113 distinct signatures across 203 files**. The real decomposition, from reading
test bodies rather than clustering strings:
  M2 generic receiver / ToString(this) .... 69   <- being fixed as #3989
  M1 RegExp / symbol-protocol search value . 51   <- THIS TASK, unowned
  long tail ............................... 52
  M7 not-a-constructor .................... 10
  M4 explicit not-implemented .............  4
  M5 host-import leak .....................  2
So "generic-receiver defects" is about one third of the area, not the whole of it.
This is the third time today a signature census was mistaken for a mechanism census.

DISCIPLINE: file counts are populations, not flip ceilings (measured reference:
103 reachable gated -> 34 flipped, 33%). Validate the instrument against
43,106 official / 25,755 pass (59.7%) and goal scope 8,545 / 6,176 (72.3%) on a
FRESHLY re-fetched baseline (`fetch-baseline-jsonl.mjs --standalone --force`) — the
cached jsonl goes stale within hours and reproduces its own checks exactly while
answering yesterday's question.

Allocate an id at pickup. CLAIM_ASSIGN_REMOTE=upstream, and EXPORT
GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL/GIT_COMMITTER_* or claim-issue.mjs exits 6.
