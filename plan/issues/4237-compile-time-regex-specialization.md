---
id: 4237
title: "exploration: compile-time regex specialization — lower literal patterns to per-pattern wasm functions at build time (the AOT analogue of Irregexp's JIT tier)"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-12
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen
language_feature: regexp
goal: backend-agnostic-ir
related: [679, 682, 4236]
# id 4237 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: the ONLY open PR was PR 4243, which
# introduces no issue files. The id coincides with a closed PR number — PR
# numbers and issue-file ids share GitHub's sequence but not a namespace
# (precedent: issue 4235 / PR 4235, issue 4236 / PR 4236).
---

# #4237 — exploration: compile-time regex specialization

## Motivation (measured 2026-08-08, session benchmarks)

Three data points frame the problem (workload:
`/([a-z]+[0-9]+)@([a-z]+)\.([a-z][a-z][a-z])/` over 200 subjects × 500 iters,
`.tmp/bench-regex.mjs`):

| Engine | Time | Why |
| --- | --- | --- |
| V8 (native) | 6.5 ms | Irregexp **JIT tier**: each pattern compiled to specialized native code |
| QuickJS libregexp (wasm) | 112.1 ms | generic bytecode interpreter |
| js2wasm's own engine (wasm) | 121.7 ms | generic interpreter — statistical tie with libregexp |

The 18× gap is NOT "native vs wasm" — it is **specialized-per-pattern code vs
a generic interpreter loop**. Both wasm engines interpret; both lose by the
same margin.

Size (measured, `.tmp/regex-size.mjs` A/B compile): our engine costs
**≈75.5 KB raw / ≈30 KB gzip marginal per module** (21,188 → 96,737 raw with
one regex literal) — and it is codegen'd into *every* regex-using module.
For comparison, a standalone libregexp-only artifact builds at 115,480 raw /
53,211 gzip, **shared** across modules (4 WASI imports, recipe proven
2026-08-08 in `.tmp/lre-only/`, quickjs-ng v0.16.1 pin — see #4236).

## The idea

Regex patterns are almost always compile-time literals. js2wasm sees them in
the AST. So do at **build time** what Irregexp's fast tier does at **runtime**:
compile each literal pattern to a specialized wasm function — the automaton
unrolled into concrete branches/loops over the subject, no pattern
interpretation at all. Dynamic `new RegExp(str)` falls back to the shared
generic engine (ours or libregexp — that choice is #4236's builtin-routing
question and stays orthogonal).

This is the js2wasm thesis applied to regex, and it composes with either
backend lane and either fallback engine.

## Two ways to build the specializer

### A. From-scratch subset compiler (start here)

Pattern → NFA/DFA-ish node network → wasm emitter, for the common literal
subset (char classes, alternation, quantifiers, captures, anchors,
non-greedy). Anything outside the subset falls back to the generic engine —
so correctness risk is bounded by construction: the specializer only ever
*claims* patterns it fully understands.

- No external dependencies, no toolchain change, pure TS in the compiler.
- The hard correctness surface (Unicode case folding, lookbehind, named
  groups, property escapes) is simply *not claimed* in v1.

### B. Irregexp front-end + a `RegExpMacroAssemblerWasm` backend (upgrade path)

V8's Irregexp is layered: parser → AST → node network → optimization passes
(Boyer-Moore lookahead, quick checks) → code generation against an abstract
`RegExpMacroAssembler` interface with per-CPU backends. The compiler half runs
wherever the compiler runs — i.e. **on the host at js2wasm build time**; only
a wasm-emitting backend for the ~40-operation macro-assembler interface is
missing. Key facts established in the 2026-08-08 discussion:

- Most interface ops lower trivially (load char, compare, advance, register
  read/write, backtrack-stack push/pop).
- The real problem is **irreducible control flow**: Irregexp emits
  label-and-goto code with a backtrack stack that jumps to popped labels.
  Structured wasm needs a dispatch-loop lowering (`loop` + `br_table` over a
  state var). Works; costs some branch overhead vs native fallthrough.
- The front-end does not stand alone: it wants `Isolate`, `Zone`, V8 strings,
  flags. SpiderMonkey imported Irregexp in 2020 by writing exactly this
  V8-emulation shim and carries a permanent re-sync burden with V8's tree —
  that shim is the majority of the work, not the backend.
- The shim's C++ never ships: it runs in the *compiler* (native addon or a
  wasm blob the TS compiler calls), so the wasi toolchain is untouched.
- What you buy: V8's battle-tested parser + optimization passes — the place
  where regex-engine cost actually lives is correctness edge cases, and B
  gets them for free where A must decline them.

**Sequencing decision (2026-08-08): A first, B as the upgrade path.** The
architecture is identical either way (literal → specialized wasm fn at build
time, generic engine for dynamic patterns), so nothing built for A is thrown
away if B lands later; B becomes worth it if/when A's declined-pattern rate
on real corpora is high enough to matter.

## Acceptance criteria (exploration)

- [ ] Prototype the A-path specializer for a minimal subset (literal chars,
      `[...]` classes, `+ * ?` quantifiers, `|`, capture groups, `^ $`) and
      benchmark 3–5 representative patterns against the current engine on the
      `.tmp/bench-regex.mjs` harness. Target: demonstrate ≥5× on hot literal
      patterns; record where the remaining gap to V8 comes from.
- [ ] Measure claim rate: over the regex literals in test262 + the npm-compat
      corpus, what fraction does the subset specializer claim vs decline?
- [ ] Size check: specialized functions replace nothing by themselves — the
      generic engine still ships for dynamic patterns and declined literals.
      Measure per-pattern code size and the module-size delta at 1/10/50
      literals; state at what point specialization should switch itself off.
- [ ] Semantics audit: `lastIndex`/`g`/`y` statefulness, `exec` vs `test` vs
      `String.prototype.match/replace/split` routing — specialized matchers
      must be reachable from all of them or the win evaporates in practice.
- [ ] Decide and record: does the fallback engine stay ours, or switch to the
      shared libregexp artifact (#4236 builtin routing)? The specializer is
      orthogonal but the *decline path* lands on whichever engine ships.
- [ ] Go/no-go on B with a cost estimate grounded in A's measured decline
      rate (shim scope, sync policy against V8's tree, dispatch-loop overhead
      measured on a hand-written pilot pattern).

## Non-goals

- Runtime regex compilation inside the wasm module (ship-the-compiler
  defeats the size story; dynamic patterns take the generic engine).
- Replacing the generic engine — it remains load-bearing for `new RegExp`
  and declined patterns regardless of A/B.
- Any change to the #4236 slice sequence; this issue is independent of the
  QuickJS boxed-tier adoption and merely shares the libregexp artifact
  option with it.

## Path B staged estimate — and the bytecode-backend route (2026-08-08)

Design update that supersedes the "~40-method C++ `RegExpMacroAssemblerWasm`"
framing above: Irregexp already has TWO codegen backends — the native
macro-assemblers and `RegExpBytecodeGenerator` (its interpreter bytecode).
Since we only need Irregexp at BUILD time, use the bytecode backend
unmodified and write the **bytecode → wasm translator in TypeScript inside
js2wasm**. The bytecode is pattern-specialized linear code (~50 opcodes);
the optimization passes (Boyer-Moore lookahead, quick checks) run before
bytecode emission, so they are preserved. C++ work then reduces to making
V8's `src/regexp` parser+compiler subset build standalone.

| Stage | Work | Estimate |
| --- | --- | --- |
| Spike | vendor V8 `src/regexp` subset + SpiderMonkey-style shim (fake `Isolate`, `Zone`, strings, flags), emscripten → wasm blob the TS compiler calls at build time; compile one pattern, dump bytecode | days-to-a-week; go/no-go = "does the subset link standalone" |
| MVP | TS bytecode→wasm translator (dispatch-loop lowering — `loop` + `br_table` over a state var — for the irreducible backtrack jumps), wired into both lanes' literal path, fallback-on-unsupported-flag; decline `\p{…}` in v1 (drags in ICU) | ≈ 1 budget window |
| Coverage | `lastIndex`/`g`/`y`, capture materialization per lane, `match`/`replace`/`split`/`exec` routing, test262 `built-ins/RegExp` + differential fuzz vs native V8 | ≈ 1 window (shared with path A — not B-specific) |
| Standing | pin a V8 revision; `src/regexp` churns faster than quickjs-ng, occasional real re-sync | ongoing, small |

Total ≈ 2–3 windows to tested integration vs ≈ 1 window for path A; the
spike front-loads nearly all uncertainty. Calibration: SpiderMonkey's 2020
import was multi-month, but included runtime execution, GC integration, and
JIT-tier bridging — all skipped here. Honest ceiling: the bytecode route
keeps the node-network optimizations but loses native-emission peepholes,
and the dispatch loop costs branch overhead vs fallthrough — target
**5–10× on hot literal patterns**, not the full 18×; B's edge over A is
correctness breadth (V8's parser + case-folding tables), not extra speed.

Fallback-engine note: the split-module proof in #4236 ("Feature-subset
builds + the split regex module") means the decline path can be the ONE
shared libregexp module serving both lanes — the specializer never has to
carry a per-module generic engine.

---

# Implementation Plan (joint with #2723) — measured 2026-08-12

**Read this together with `plan/issues/2723-standalone-regex-linear-nonbacktracking-matching.md`.**
The two issues are not independent. #2723 asks for a *non-backtracking* matcher;
#4237 asks for *AOT per-pattern emission*. Measured below: neither is worth
building alone, and together they are one program.

- The non-backtracking algorithm is what makes AOT emission **safe to emit**
  (it dissolves #1539's recorded objection — verified against the code, §3).
- AOT emission is what makes the non-backtracking algorithm **fast** (a
  *generic* linear VM would be slower than today's backtracking VM, not faster —
  §2).

## 1. Verdict up front

**Recommend (c) HYBRID — but a different hybrid boundary than either issue
currently describes.** Build the non-backtracking matcher **only** as an
AOT per-pattern emitter for literal patterns in the linear-safe subset; keep
the existing generic backtracking VM verbatim for everything it declines.
Explicitly **do not** build the generic `__regex_run_linear` interpreter that
#2723's Slice A specifies (§2 says why).

Do **not** pursue (b) port/embed. Two independent reasons, and the first is
sufficient: the measurement below shows a from-scratch specializer reaches
**1.34× of V8's Irregexp** on this backend, so there is no headroom left for a
ported engine to buy. Beyond that, this lane is WasmGC with no linear memory
and no C++ toolchain in the pipeline (#4237's own path-B estimate is 2–3 budget
windows, most of it a V8-emulation shim with a permanent re-sync burden).

Do not pursue (a) *as stated* either — "implement the non-backtracking
algorithm natively" reads as a second generic VM, which is the thing §2 rules
out.

## 2. The measurement that decides it

Harness `.tmp/regex-ceiling.mjs` — five lanes in ONE process, interleaved with
rotating order, min-of-9-rounds after 3 warm rounds, **checksums asserted equal
across every lane before any timing**. Lane `standalone` (WasmGC), workload =
#4237's own pattern and shape: `/([a-z]+[0-9]+)@([a-z]+)\.([a-z][a-z][a-z])/`
over 200 subjects × 500 iterations, `.test()`.

| lane | what it is | min ms | vs node | module bytes |
| --- | --- | ---: | ---: | ---: |
| `node` | V8 Irregexp (JIT tier) | **13.15** | 1.00× | — |
| `engine` | today's generic backtracking bytecode VM | **318.86** | 24.25× | 115,509 |
| `nfa` | specialized bit-parallel NFA, written in the **dynamic** lane | 136.88 | 10.41× | 109,436 |
| `nfa-i32` | same NFA with **native i32 locals** — the shape a hand-emitter produces | **17.65** | **1.34×** | 68,580 |
| `floor-i32` | i32 lane, same loop, transitions removed (scan only, no early exit) | 20.68 | 1.57× | 68,299 |

Three things fall out, and all three change the plan:

1. **`engine / nfa-i32` = 18.1×.** #4237's headline 18× reproduces exactly —
   and it is now shown to be **achievable inside this backend**, not a
   native-vs-wasm gap. A specialized non-backtracking matcher lands within
   **1.34×** of V8's JIT tier.
2. **The win is SPECIALIZATION-TO-RAW-i32, not the algorithm.** The same NFA
   expressed through ordinary dynamic-lane codegen (`nfa`) is only **2.33×**
   better than the current engine. The remaining 7.8× is the lane (boxed
   arithmetic, `charCodeAt` dispatch), which only a *hand-emitting* specializer
   removes. **Consequence: a generic linear interpreter is the wrong artifact.**
   It would carry the algorithm's higher per-character constant factor
   (a PikeVM does more work per char than a backtracker on non-pathological
   patterns) with none of the specialization win. #2723's Slice A as written is
   therefore superseded — see the note appended to that issue.
3. **The 18× is the MATCHER-INTERNAL ceiling; the end-to-end multiple will be
   lower, and by how much is not yet measured.** In `nfa-i32` the whole module
   is in the native-i32 regime, so the per-subject call overhead is native too.
   In the real integration only the *emitted matcher* is raw i32 — the `.test()`
   call site stays in whatever lane the caller is (flatten the subject, read the
   struct fields, `call_ref`). That is per **call**, not per character, so it
   does not scale with subject length; at 100 k calls it is plausibly 5–10 ms
   against this workload's 17.65 ms, i.e. an end-to-end multiple somewhere in
   the **10–16×** band rather than 18×. The dynamic-lane `floor` row (46.91 ms)
   is **not** the right proxy for it — that number is per-*character*
   `charCodeAt` dispatch, which an emitted matcher removes entirely by reading
   `array.get_u` off the flattened string data itself. Slice 1 must measure the
   real boundary cost rather than inherit either estimate.
4. **The transitions are free; the scan is the cost.** `nfa-i32` (17.65 ms,
   with early exit) is *faster than* `floor-i32` (20.68 ms, no matching work at
   all but no early exit). The eight state-transition blocks cost nothing
   measurable above the per-character loop itself. This is what licenses the
   simple "one unrolled block per NFA position" emission strategy in §4 instead
   of anything cleverer.

### Size: #4237's 75.5 KB figure is measured against the wrong base

`.tmp/regex-size.mjs`, standalone lane, A/B compile:

| base module | +1 regex literal | marginal for 2nd…5th literal |
| --- | --- | --- |
| numeric only (`n * 2 + 1`) | **+72,859 raw / +33,530 gz** | +382…+501 raw |
| already uses strings (`charCodeAt` loop) | **+7,062 raw / +2,572 gz** | +419…+525 raw |

#4237 measured the first row (21,188 → 96,737 ≈ +75.5 KB) and attributed it to
the regex engine. **~66 KB of it is the native-string runtime**, which every
string-using module already pays. The regex engine's own marginal cost is
**≈7 KB raw / 2.6 KB gz**. So:

- the "specialization lets us drop a 75 KB engine" argument is **not available**
  — the recoverable ceiling is ~7 KB raw, and only in a module where *every*
  pattern is claimed and no `new RegExp(dynamic)` exists;
- conversely the size *risk* of per-pattern emission is small: each specialized
  matcher is a few hundred bytes of straight-line code, against a +419…+525 raw
  per-literal cost the bytecode path already pays. Size is close to a wash and
  is not a reason either way. Measure it per slice anyway (acceptance below).

### Claim rate — what the specializer can actually take

`.tmp/regex-census.mjs`, **2,784 regex literals** extracted from real shipped
JS (react-dom cjs builds + every `dist/` and top-level `.js` in the repo's
`node_modules`), each parsed with our own `regex/parse.ts` and analysed for
Glushkov positions and features:

| bucket | count | share |
| --- | ---: | ---: |
| linear-safe (no backref, no lookaround, parses) | 2,639 | 94.8 % |
| … of which ≤32 positions (fits one i32 word) | 2,538 | **91.2 %** |
| … of which ≤64 positions (fits one i64 word) | 2,592 | **93.1 %** |
| … ≤64 positions **and capture-free** | 1,988 | **71.4 %** |
| lookaround | 91 | 3.3 % |
| backreference | 25 | 0.9 % |
| refused by our parser today | 29 | 1.0 % |
| >64 positions | 47 | 1.7 % |

Position distribution among linear-safe literals: **median 2, p75 7, p90 17,
p99 131, max 3,686.** The long tail is real but tiny; a one-word bitset covers
the overwhelming majority, and the decline path is free (§5).

### The honest negative — this will NOT move the acorn dogfood

`.tmp/regex-hits.mjs` instruments `RegExp.prototype.{test,exec}` and the
`String.prototype` regex methods during acorn's self-parse (the only quotable
workload). 35,633 distinct regex operations:

| origin | operations | share |
| --- | ---: | ---: |
| **runtime-constructed** (`new RegExp("^(?:" + words.join("|") + ")$")`) | 29,265 | **82.1 %** |
| literal | 6,368 | 17.9 % |

Acorn's hot regexes are its keyword/reserved-word predicates, **built at
runtime from word lists**. An AOT specializer cannot claim them *by
definition* — and they already have a dedicated runtime fast path
(`REGEX_ANCHORED_LITERAL_ALTS_MARKER` + `buildIndexedAnchoredLiteralAltSearch`,
#3673 round 29), which is a better structure than any NFA would be for a
200-way keyword alternation.

So the ceiling on acorn is **17.9 % of a 4.04 % bucket ≈ 0.7 % of runtime**,
assuming specialization makes those operations free. That is at or below this
box's resolvability (#3927 §6; #4157's ±0.3 pp floor). **Do not justify this
work on the acorn number and do not expect the profile to move.** Its
justification is (i) regex-heavy workloads — the 18× above, reproducible on
demand, (ii) conformance: ReDoS immunity and retirement of the spurious
`RangeError` for every claimed pattern (#2723's actual goal), (iii) it is the
only structure that gets #2723's conformance win *without* a perf regression.

## 3. Verifying the architectural premise against the code

#1539's recorded rationale ("Implementation Notes (sd-1539, 2026-06-03) —
bytecode VM, not specialised emission") rejects per-pattern emission because a
**backtracking** matcher needs an explicit backtrack stack, so specialized
emission would have to *generate* backtracking control flow — "nested
`block`/`loop`/`br` with a save/restore stack, as raw `Instr[]`, recursively,
per pattern … the single hardest-to-verify thing to emit in raw Wasm".

**That objection is entirely specific to backtracking, and it does dissolve.**
Verified by construction, not by analogy — the emitted skeleton is:

```
func $__re_test_p<N>(sdata, soff, slen, start) -> i32
  local CUR:i64, NEXT:i64, CH:i32, SP:i32
  SP = start ; CUR = 0
  block $done
    loop $step
      br_if $done  (SP >= slen)
      CH = sdata[soff + SP]
      CUR = CUR | START_CLOSURE          ;; unanchored seed, constant
      NEXT = 0
      ;;  ---- one sibling block per NFA position, all at the SAME depth ----
      if (CUR & (1<<i)) != 0 { if <class-test on CH> { NEXT |= FOLLOW_i } }   ;; × nPositions
      if (CUR & ACCEPT) != 0 { return 1 }
      CUR = NEXT ; SP = SP + 1
      br $step
  return 0
```

Every per-position block is `{ op: "if", blockType: { kind: "empty" }, … }`:
it consumes nothing and produces nothing at its boundary, and its nesting depth
is a **constant 2**, independent of the pattern. The only `br`s are the loop's
own `br $step` / `br_if $done`, at fixed depths the emitter writes literally.
There is no depth arithmetic derived from AST nesting anywhere — which is
precisely the bug class #1539 was avoiding. Pattern structure enters **only**
as `i64` constants (`FOLLOW_i`, `START_CLOSURE`, `ACCEPT`) and as the class-test
comparison sequence. Stack balance is structurally guaranteed rather than
argued.

Everything the emitter needs already exists in the `Instr` union: `i64.{const,
and,or,eqz,shl}` (`i64.const` takes a `bigint`), `array.get_u` on
`ctx.nativeStrDataTypeIdx`, and `ref.func` / `call_ref` with typed function
references (`src/ir/types.ts:380-382`) for the dispatch in §4.

**Conclusion: the premise holds.** Recorded here so #1539's note is read as
"backtracking emission is unsafe", not "specialized emission is unsafe".

## 4. Where it hooks in

The carrier is `$NativeRegExp` (`regexp-standalone.ts:803-810`,
`ensureStandaloneRegExpStruct`). A `RegExp` value flows through variables,
parameters, object fields and `externref` round-trips, and `emitRegexSearchCall`
reads `prog`/`classTable` off the struct at the *call site* and calls the
generic `__regex_search`. **So specialization must travel with the value, not
with the call site.**

- **Append field 7 `matcher: (ref null $ReMatcherFn)`** to `$NativeRegExp`
  (append-only; field[1] must stay `i32` — the `getArrTypeIdxFromVec` vec-struct
  heuristic documented at `regexp-standalone.ts:795-801` is load-bearing).
  `$ReMatcherFn = (ref $NativeStrData, i32 off, i32 len, i32 start) -> i32`.
- `emitStandaloneRegExpStruct` pushes `ref.func $__re_test_p<N>` when the
  specializer claims the pattern, `ref.null` otherwise.
  `ensureDynamicStandaloneRegExpCompiler` (the in-wasm runtime compiler for
  `new RegExp(str)`) pushes `ref.null` unconditionally — dynamic patterns are
  never claimed, which is exactly the 82 % of acorn traffic above.
- The `.test` path (`tryCompileStandaloneRegExpTest` → `emitRegexSearchCall`)
  becomes: `if (matcher != null) call_ref` else the existing
  `__regex_search` call, byte-for-byte unchanged. **One branch, one new field,
  zero change to the existing VM.** A statically-resolved literal receiver can
  additionally skip the branch and `call` the specialized function directly;
  that is an optimization, not the mechanism.

This shape is why the work is additive and non-disruptive: the backtracking VM,
its bytecode, `regex/vm.ts` and every existing test keep working untouched, and
the specializer is a pure addition that can be flag-disabled to a measured null.

## 5. Slice ladder

Each slice is one PR. Every slice's decline path is "leave `matcher` null" —
free, and the reason correctness risk is bounded by construction.

- **Slice 1 — `test()` only, capture-free, ≤64 positions.**
  New `src/codegen/regex/glushkov.ts` (AST → positions, First/Follow/Accept
  bitsets — pure TS, unit-testable with no Wasm) + `src/codegen/regex-specialize.ts`
  (bitsets → `Instr[]`) + the struct field and the one-branch dispatch.
  **Claims 71.4 % of real-world literals.** Delivers the 18× above, ReDoS
  immunity and no spurious `RangeError` for every claimed pattern.
  *Correctness note that makes this slice safe:* a boolean existence query has
  no leftmost-first obligation, so the bitset needs no priority order. That is
  **not** true of `search`/`exec` — see Slice 2.
- **Slice 2 — leftmost START (`search`, `String.match` index, `split`).**
  A pure bitset gives the smallest match **END**, which is *not* JS semantics:
  `/abc|b/` on `"abc"` ends earliest at 2 (via `b` at index 1) but JS returns
  the match at index 0. Requires per-position origin tracking (keep the
  **smallest** start on merge) and committing only when no thread with a
  smaller start survives. Still linear, higher constant factor.
- **Slice 3 — captures (`exec`).** Needs priority order, i.e. a specialized
  PikeVM (ordered thread list + capture slots), because among matches at the
  same start the greedy/lazy alternative order decides. Claims the remaining
  23.3 % of ≤64-position literals. Expect a smaller multiple than 18×.
- **Slice 4 — >64 positions (multi-word bitset) and lookaround.** The 1.7 % +
  3.3 % tail. Lowest value; do last or never.

**Backreferences stay on the backtracking VM permanently** (matching them is
NP-hard; the step cap is the correct, defensible defense *there*), together
with the ~0.003 % nullable-lazy-plus CIN/CDN case #2723 documents, every
runtime-constructed pattern, and anything a slice declines.

## 6. Acceptance / gates (every slice)

- `npx vitest run tests/issue-1539-standalone-regex.test.ts tests/regex-bytecode.test.ts`
  green, **checked by exit code, never by piping to `tail`/`head`**.
- Differential: for every claimed pattern, the specialized matcher's answer must
  equal the generic VM's answer *and* the host `RegExp`'s, over a shared
  subject corpus. Cheap to make exhaustive because the specializer declines
  freely — a wrong claim is the only way to be wrong.
- acorn dogfood keeps **checksum 422 / 4,642 nodes**. Expect **no** wall-clock
  movement there (§2's honest negative); a *regression* is the real signal.
- `.tmp/regex-ceiling.mjs` re-run before/after; `.tmp/regex-size.mjs` for the
  module-size delta at 1/5 literals.
- Ship behind an env flag (`JS2WASM_REGEX_SPECIALIZE`, default ON once
  measured) so the null is reproducible on demand, per the #4185 precedent.
- Run test files in small batches (`--pool=forks --poolOptions.forks.maxForks=2`);
  the full suite OOMs in this container.

## 7. What this supersedes

- #4237's **path B** (Irregexp front-end + bytecode→wasm translator): **closed
  as unnecessary.** Path A reaches 1.34× of V8; B's own honest ceiling was
  "5–10×, not the full 18×", for 2–3 budget windows and a permanent V8 re-sync
  burden. Its stated advantage was correctness breadth, which the measured
  94.8 % linear-safe rate plus a free decline path makes unnecessary.
- #4237's **size argument**: corrected, ≈7 KB raw not 75.5 KB (§2).
- #2723's **Slice A** (generic `__regex_run_linear` interpreter + router):
  superseded by AOT emission — see the note appended to #2723.
