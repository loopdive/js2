---
id: 2723
title: "standalone RegExp: linear (non-backtracking) matching path — retire the step-limit band-aid + ReDoS (arXiv:2311.17620)"
status: ready
sprint: current
priority: medium
horizon: l
updated: 2026-08-12
goal: standalone-mode
feasibility: hard
depends_on: []
related: [1539, 1474, 1911, 1960, 2671, 4237]
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: regular expressions
---

## Problem

The standalone (pure-Wasm, no-JS-host) RegExp engine is an **explicit-stack
backtracking VM**. The reference/spec implementation is `src/codegen/regex/vm.ts`
(its own header, lines 2-20, calls it a "Reference backtracking VM"); the
hand-emitted Wasm twin is `__regex_run` in `src/codegen/native-regex.ts`. Both
share the same flat `[op,a,b]` bytecode (`src/codegen/regex/bytecode.ts`) emitted
by `src/codegen/regex/compile.ts`.

Three coupled defects all stem from the backtracking architecture:

1. **The step-limit is a band-aid that produces a non-conformant `RangeError`.**
   `runAt` increments a step counter every dispatch iteration and **throws**
   `RangeError("regular expression step limit exceeded")` when it crosses
   `REGEX_STEP_CAP = 1_000_000` (`vm.ts:24`, thrown at `vm.ts:115-116`; the Wasm
   twin throws the same catchable `RangeError` via the `$exc` tag at
   `native-regex.ts:1243-1251`, message `native-regex.ts:29`). This converts
   catastrophic-backtracking hangs into throws — good for ReDoS safety — but it
   **also makes some legitimate heavy matches throw a `RangeError` that no real
   JS engine throws**. That is a direct conformance gap: V8/SpiderMonkey/JSC
   return a normal (possibly slow) result; we throw.

2. **ReDoS is "defended" by throwing, not by being immune.** A backtracking VM
   is *structurally* susceptible to exponential backtracking on patterns like
   `(a+)+$` against `aaaa…!`. The step cap caps the blow-up but at the cost of
   (1). A linear-time matcher is *immune by construction* — it cannot exhibit
   super-linear behavior on any backreference-free pattern, so it needs no cap
   and throws no spurious `RangeError`.

3. **Lookbehind is an ad-hoc atomic recursion, not a principled algorithm.**
   `LOOKAROUND` (`bytecode.ts:48-56`, dispatched at `vm.ts:231-246`) runs the
   sub-program as a **fresh anchored recursive `runAt` attempt** at the current
   position with `dir = behind ? -1 : 1` (#1911). It works, but it is a nested
   backtracking attempt per lookaround occurrence per position — the exact
   construct the reference paper replaces with a principled linear oracle /
   streaming algorithm.

The `__regex_run` backtracking core is **freshly stabilized and under active
development** (in-flight worktrees `issue-2671-regexp`,
`issue-2671e-regexp-lastindex`). This is a **design/feasibility** issue: it must
NOT disrupt that work. The backtracking VM stays; the question is whether to add
a *second*, linear matching path beside it (the V8 "V8Linear" hybrid model).

## Reference

**Aurèle Barrière & Clément Pit-Claudel (EPFL), "Linear Matching of JavaScript
Regular Expressions", arXiv:2311.17620 (2023-11-29).**
<https://arxiv.org/abs/2311.17620> · same research line as V8's experimental
non-backtracking ("V8Linear") engine; ships a ~3.5K-line OCaml reference
prototype.

Techniques, section by section:

- **Base algorithm.** Thompson-NFA simulation (PikeVM-style): an active *thread
  list* of `(pc, registers)`; each bytecode position is processed **at most once
  per input position** (a "processed"/visited array — the *uniform-futures*
  property). O(|r|·|s|) time. No backtracking, no stack of alternatives.
- **§4.1 — nullable quantifier BeginLoop/EndLoop fix.** Correct handling of
  quantifier bodies that can match empty under the NFA construction (merged in
  V8). The current engine's analogue is the `PROGRESS` empty-iteration guard
  (#1959); see "what becomes unnecessary" in the plan.
- **§4.2 — JS capture-reset semantics via a global clock.** Groups inside a
  quantifier must reset to `undefined` on re-entry (§22.2.2.3.1 RepeatMatcher).
  Naive `ClearReg` insertion is **O(|r|²·|s|)**. Their fix: a **global clock**
  incremented per instruction; each thread stores per-group/per-quantifier clock
  values; after a match, **one O(|r|) AST traversal** decides which captures to
  keep by comparing clocks. Keeps the whole matcher at O(|r|·|s|).
- **Leftmost-greedy priority** is encoded purely by Fork/Split *ordering*
  (high-priority branch first) — exactly how `SPLIT a,b` already encodes
  "try `a` first" (`compile.ts:227-300`).
- **§4.3 — lookarounds (the core novelty), 3 phases.**
  1. **Oracle construction** — precompute, per string position, whether each
     lookaround matches: lookaheads ⇒ reverse the sub-regex and scan backward;
     lookbehinds ⇒ scan forward; store in an oracle table. O(ℓ(r)·|s|) space
     (ℓ(r) = number of lookarounds).
  2. **Main match** — forward NFA on the main expr; at a lookaround consult the
     oracle via a `CheckOracle` op, recording the position last used.
  3. **Capture reconstruction** — re-run each *used outermost* lookaround's NFA
     at the recorded position to extract its captures (capture-reset ⇒ only the
     last use matters). Total O(|r|·|s|) time, O(ℓ(r)·|s|) space.
- **§4.4 — captureless-lookbehind streaming variant (the cheap one).** No oracle
  table: compile each lookbehind as an NFA with a `.*?` prefix, run **all in
  parallel** with the main expr, maintain an `LBtable` of booleans (length
  ℓ(r)) updated/queried in O(1) via `WriteLB`/`CheckLB`. Only **O(|r|) extra
  space**, language-independent. **Maps cleanly onto the existing #1911
  lookbehind machinery.**
- **§4.5.2 — linear-size nonnullable-plus construction** (merged in V8): avoids
  the quadratic NFA blow-up of `a+` when `a` is non-nullable.
- **§4.6 — register-representation tradeoff** (drives the Wasm memory design):
  - array copy-on-Fork → **O(|r|²·|s|)** time;
  - **linked list** → **O(|r|·|s|)** time, O(|r|·|s|) space;
  - balanced tree → O(|r|·log|r|·|s|) time, O(|r|²) space.
- **Excluded from linear matching:** backreferences (NP-hard → must stay on
  backtracking); one obscure nullable-lazy-plus CIN/CDN case (~0.003% of real
  regexes).
- **V8 status:** merged — §4.1 BeginLoop/EndLoop, §4.5.2 nonnullable-plus; under
  review — captureless lookbehind (§4.4); not yet — capture-reset clock (§4.2) +
  unrestricted lookarounds (§4.3).

## Acceptance criteria

This is a **feasibility** issue. Done means a **recorded decision**:

1. A verdict — **adopt** (replace backtracking), **hybrid** (both paths + a
   router, V8 model), or **defer** — written in `## Implementation Plan` →
   "Recommendation", with a one-paragraph justification.
2. A rough **effort estimate** and a **slice ladder** (A → … with the
   conformance win each slice unlocks: the spurious step-limit `RangeError`
   tests, ReDoS immunity, lookaround correctness).
3. If "adopt/hybrid": a **concrete first-slice scope** (files, new bytecode ops,
   the §4.6 register representation chosen for Wasm, and the router predicate),
   small enough to land as one PR without disrupting the in-flight #2671 work.
4. Explicit statement of **what stays on backtracking** (backreferences + the
   excluded CIN/CDN case) and why the step-cap remains *correct* there.

---

## Implementation Plan

### Root cause

The engine has exactly one matching strategy — backtracking — so the only ReDoS
defense available is "stop after N steps and throw." A linear (Thompson/PikeVM)
matcher cannot exhibit super-linear behavior on any backreference-free pattern,
so it needs no step cap and throws no spurious `RangeError`. The fix is not to
tune the cap (that just trades false-throw vs. hang) but to add a *second*
matching path for the linear-safe subset and route patterns to it.

### Verdict up front

**HYBRID, phased — adopt the architecture; build incrementally; defer the full
ladder.** Keep `__regex_run` as the default and the *only* path for
backreferences + the excluded CIN/CDN case (where the step-cap is the correct,
defensible defense). Add a linear PikeVM path and a compile-time **router**.
This mirrors V8 (backtracking default + opt-in `V8Linear`). Rationale and effort
are in "Recommendation" at the end.

### Mapping the paper onto the current bytecode/VM

The good news: the existing bytecode already encodes the two things the linear
algorithm most needs.

- **Leftmost-greedy priority is already there.** `SPLIT a,b` = "try `a` first,
  `b` on backtrack" (`vm.ts:152-157`, emitted greedy-first / lazy-swapped at
  `compile.ts:227-300`). In the PikeVM, `SPLIT` becomes a **Fork** that pushes
  *both* successors onto the thread list **in priority order** (high-priority =
  `a` enqueued first). The ordering bytes are identical — only the execution
  semantics change (enqueue both vs. push one + a backtrack frame).
- **`SAVE slot` = a tagged-NFA register write** (`vm.ts:162-167`). Reused as-is;
  the difference is *where* the register lives (per-thread, §4.6) and that the
  capture-reset clock (§4.2) — not `CLEAR` — decides final visibility.
- **`CHAR/CHARI/ANY/CLASS`** consume one unit and advance — in the PikeVM they
  move a thread from the *current* list to the *next* list (the per-position
  step boundary). **`BOL/EOL/WBOUND`** are zero-width — they advance a thread
  in-place within the same position. All reusable unchanged.
- **`MATCH`** in the PikeVM means "this thread reached accept"; because the
  thread list is priority-ordered, the first `MATCH` wins and all *lower*-
  priority threads still in the current list are dropped (leftmost-greedy).

What **becomes unnecessary** on the linear path (do NOT emit these for PikeVM
programs):

- **`PROGRESS` (#1959, `vm.ts:247-255`)** — the uniform-futures *visited[pc]*
  dedup makes a zero-width loop terminate automatically (a pc re-reached at the
  same input position is dropped), so the empty-iteration guard is structurally
  unneeded.
- **`CLEAR` (#1960, `vm.ts:256-265`)** — replaced by the §4.2 clock: groups are
  not eagerly cleared; the post-match O(|r|) traversal compares clock stamps to
  decide which captures survive. (Keep `CLEAR` for the backtracking path.)

New bytecode ops to add (append to `ReOp` — values are stable/baked into the
Wasm dispatch per `bytecode.ts:17-18`, so **append, never renumber**):

| Op | Slice | Purpose |
|----|-------|---------|
| `FORK` (alias of SPLIT semantics, linear) | A | enqueue both successors in priority order. *Can reuse `SPLIT`'s encoding* — distinguish by which VM consumes the program, so possibly no new opcode, just new VM semantics. |
| `BEGIN_LOOP` / `END_LOOP` | A | §4.1 nullable-quantifier loop markers for the NFA construction (replace the `SAVE-scratch`+`PROGRESS` idiom on the linear path). |
| `WRITE_LB` / `CHECK_LB` | C | §4.4 captureless-lookbehind streaming `LBtable` write/query (O(1)). |
| `CHECK_ORACLE` | D | §4.3 consult the per-position lookaround oracle table. |

`compile.ts` changes: add a parallel lowering mode (a flag on `Emitter`, or a
sibling `EmitterLinear`) that (a) lowers quantifiers via `BEGIN_LOOP/END_LOOP`
+ the §4.5.2 nonnullable-plus construction instead of the `SPLIT/JMP/PROGRESS/
CLEAR` idiom, (b) omits `PROGRESS`/`CLEAR`, (c) lowers lookbehind to
`WRITE_LB/CHECK_LB` (Slice C) or to the oracle (Slice D) instead of the #1911
reversed-recursive sub-program. The parser (`parse.ts`) and class table are
shared verbatim — only the AST→bytecode lowering forks.

### Wasm-side thread / register storage (the §4.6 decision)

Recommendation for the hand-emitted standalone Wasm: **WasmGC structs with an
immutable linked-list (cons-cell) register representation** — the §4.6
linked-list option (O(|r|·|s|) time, O(|r|·|s|) space). Rationale: Fork must
"copy" a thread's registers cheaply; a cons-list lets a forked thread **share**
its parent's register list by reference and only prepend its own writes — which
is exactly what WasmGC's structural sharing + GC give for free. The array option
(O(|r|²·|s|), copies all regs on every Fork) is the trap; the balanced tree is
over-engineering for hand-emitted Wasm.

Concrete types (consistent with the existing `$__ReFrame` / `$__ReFrameArr`
pattern in `native-regex.ts:57-97`):

```wat
;; one register write, structurally shared across forked threads
(type $RegCell (struct (field $slot i32) (field $value i32)
                       (field $next (ref null $RegCell))))
;; a live NFA thread: program counter + its register list (+ §4.2 clock stamps)
(type $Thread  (struct (field $pc i32) (field $regs (ref null $RegCell))))
(type $ThreadList (array (mut (ref null $Thread))))
```

The PikeVM keeps **two** `$ThreadList`s (current / next), swapped at each input
position. Dedup uses a `visited` `array i32` indexed by `pc`, sized to the
program length; to avoid an O(|r|) clear per position, stamp it with a
per-position generation counter (`visited[pc] == genStamp` ⇒ already processed
this position) — a standard PikeVM trick, cheap in Wasm. The §4.2 clock is a
single `i32` incremented per instruction; per-group clock stamps ride in the
register list (or a parallel small array per thread).

Slice A (captureless / capture-light, no lookaround, no backref) needs **no**
register list at all beyond match start/end — it is the minimal foundation.

### Hybrid vs. replace — the router

Add a compile-time **router** in front of program selection. It already has all
the information it needs at compile time (the pattern AST + flags are static for
the standalone backend's supported `RegExp` literals / static `new RegExp`):

1. **JS-host mode available** → unchanged: delegate to the host `RegExp`
   (`wasm:js-string` fast path). The linear path is a **standalone-only**
   concern; do not touch the host path or the dual-backend wiring in
   `regexp-standalone.ts`.
2. **Standalone + pattern in the linear-safe subset** (no backreferences; not
   the obscure nullable-lazy-plus CIN/CDN case; lookarounds only once the
   relevant slice lands) → **PikeVM linear path** (`__regex_run_linear`).
3. **Standalone + backreferences / excluded case** → existing `__regex_run`
   backtracking with the step cap **retained** — this is the *correct* residual:
   backreference matching is NP-hard, so a bounded-work cap is the legitimate
   (and spec-permitted-as-implementation-defined) defense, and these patterns are
   a tiny slice of real-world / test262 usage.

Net effect after the hybrid lands: the spurious step-limit `RangeError`
conformance gap **only remains for backreference patterns** — where a cap is
defensible — instead of for every heavy match.

The router predicate is a pure AST walk: `hasBackref(ast) ||
isExcludedCinCdn(ast)` → backtracking; else → linear (gated per slice on whether
the pattern uses lookarounds the current slice supports). Refusal/fallthrough is
free: both VMs already exist behind the same `CompiledRegex` shape.

### Slice ladder (each slice is one PR, additive, non-disruptive to #2671)

- **Slice A — captureless PikeVM linear core + router.** Build
  `__regex_run_linear` for the lookaround-free, backreference-free subset with
  capture *bounds only* (group 0). Implements §4.1 (`BEGIN_LOOP/END_LOOP`) and
  §4.5.2 (nonnullable-plus) in the linear construction; reuses
  `CHAR/CLASS/ANY/SPLIT-as-Fork/SAVE0/MATCH`. Add the router (rule 2/3 above,
  lookaround patterns still routed to backtracking). **Unlocks:** ReDoS immunity
  + removal of the spurious step-limit `RangeError` for the (large) capture-light
  subset. Self-contained, ~1.5–2.5K LOC TS + hand-emitted Wasm.
- **Slice B — tagged captures + §4.2 capture-reset clock.** Add the cons-cell
  register list, the global clock, and the post-match O(|r|) keep/drop
  traversal. Drops `PROGRESS`/`CLEAR` from the linear lowering. **Unlocks:**
  full capture-group correctness on the linear path (so capturing patterns stop
  routing to backtracking and stop throwing spurious `RangeError`).
- **Slice C — captureless-lookbehind streaming (§4.4).** `WRITE_LB`/`CHECK_LB`
  + `LBtable`; **maps directly onto the #1911 lookbehind machinery** but
  language-independent and O(|r|) space. **Unlocks:** linear, principled
  captureless lookbehind; lets lookbehind patterns leave the backtracking path.
- **Slice D — full lookarounds via oracle (§4.3).** `CHECK_ORACLE`, oracle-table
  construction (reverse-scan for lookahead / forward-scan for lookbehind), and
  capture reconstruction by re-running the used outermost lookaround. **Unlocks:**
  full lookaround correctness + linearity; the #1911 atomic-recursion path is
  retired for everything except backreferences.

Lowest-risk first step is **Slice A** — it is the foundation everything else
needs, delivers the headline conformance/ReDoS win for the common subset, and
touches no existing op semantics (it is a *new* VM beside `__regex_run`). (Note:
§4.1/§4.5.2 are *not* standalone wins for the current backtracking encoding —
that path already uses `PROGRESS`/`CLEAR` and a linear-size `plus` lowering — so
they only pay off *as part of building Slice A's PikeVM construction*, not as a
cheap pre-step.)

### Risks / cost

- **Two matchers to maintain.** A second VM (TS reference in `vm.ts` + Wasm twin
  in `native-regex.ts`) doubles the surface that must mirror opcode-for-opcode.
  The router boundary, the shared parser, and the shared `CompiledRegex` shape
  contain this, but every future regex feature now has two homes (or an explicit
  "backtracking-only" route).
- **Capture-reset clock (§4.2) is the subtle part.** Getting the per-group clock
  comparison exactly right against §22.2.2.3.1 RepeatMatcher reset semantics is
  the highest-correctness-risk piece; it is why V8 has *not yet* merged it. Slice
  A defers this entirely (bounds-only); it lands in Slice B.
- **Oracle-table memory in standalone Wasm (§4.3, Slice D).** O(ℓ(r)·|s|) space
  is allocated as WasmGC arrays per match against long inputs — acceptable for
  typical inputs, but a memory-pressure consideration for pathological
  lookaround-heavy patterns on huge strings. Slice C's streaming variant avoids
  this for the common captureless-lookbehind case (O(|r|) space).
- **Interaction with #2671 (lastIndex / global-sticky).** The linear path must
  honor the same `lastIndex` / sticky / global driving the backtracking path
  uses (`search` in `vm.ts:288-304`, the start-position scan in
  `native-regex.ts:1343+`). Schedule Slice A **after** #2671 lands to avoid
  churn on shared driver code.
- **Not covered:** backreferences (NP-hard — stay on backtracking permanently)
  and the ~0.003% nullable-lazy-plus CIN/CDN case (stay on backtracking). The
  step cap is therefore **not** fully retired — it is *narrowed* to exactly the
  patterns where it is the correct defense.

### Recommendation

**HYBRID — adopt the architecture, build incrementally, but DEFER the build
until standalone RegExp conformance is the scheduled priority.** The hybrid
(linear path + router, backtracking retained for backreferences) is the right
end-state: it is V8's own proven model, it converts the step-limit `RangeError`
from a broad conformance gap into a narrow, defensible residual on backreference
patterns only, and it makes ReDoS immunity structural rather than cap-based. It
is *not* an immediate-priority build: it is a multi-slice, multi-week effort
(rough sizing — Slice A ~1–2 dev-weeks / ~1.5–2.5K LOC; the full A→D ladder
~6–10 dev-weeks), the backtracking engine is freshly stabilized and actively
worked (#2671), and higher-value standalone gaps exist right now (native
ToPrimitive ~2,136 ceiling, iterator protocol ~331 FAIL). **Concrete first slice
when scheduled: Slice A** (captureless PikeVM linear core + the compile-time
router), landed *after* #2671, as the self-contained foundation. Until then,
this issue records the design so the slice can be picked up without re-deriving
the mapping. Verdict in one line: **adopt the hybrid design now on paper; defer
implementation; start with Slice A.**

### Files touched (when built)

- `src/codegen/regex/bytecode.ts` — append `BEGIN_LOOP/END_LOOP`, `WRITE_LB/
  CHECK_LB`, `CHECK_ORACLE` to `ReOp` (append-only; do not renumber).
- `src/codegen/regex/compile.ts` — parallel linear lowering mode (or sibling
  `EmitterLinear`); shared parser/class-table.
- `src/codegen/regex/vm.ts` — TS reference `runAtLinear` (PikeVM) beside the
  backtracking `runAt`; the new executable spec for the Wasm twin.
- `src/codegen/native-regex.ts` — hand-emitted `__regex_run_linear` + the
  `$Thread`/`$RegCell`/`$ThreadList` WasmGC types; reuse the `$__ReFrame`
  emission pattern.
- `src/codegen/regexp-standalone.ts` — the compile-time router selecting linear
  vs. backtracking per the AST predicate; host path untouched.

### Adequacy note (architect, 2026-07-12 standalone-family pass)

Reviewed against the 2026-07-12 gap map (~533 standalone RegExp fails across
sub-buckets): the plan above is **already dev-executable as written** (slice
ladder, router predicate, file map, sizing) — no deepening needed. Family
classification: **opus-owned** for Slice A's PikeVM construction + router
(engine design; the §4.x mappings are the load-bearing subtleties), fable-
executable for B–D once A's skeleton exists. Priority vs. the async family:
BELOW #3164/#3132/#2903-R-slices — those retire ~4,000 leaky passes for far
less effort than Slice A's ~1–2 dev-weeks for ~500 fails. Keep `sprint:
Backlog` until the async family's S1/S2 are landed or staffing frees up.

---

## 2026-08-12 — REVISED: the linear path is an AOT EMITTER, not a second VM

**The joint implementation plan now lives in
`plan/issues/4237-compile-time-regex-specialization.md` §1–§7.** Read it before
starting any slice here. This note records only what changed in *this* issue's
conclusions and why; everything above stays valid as the algorithm reference
(the arXiv:2311.17620 §4.x mapping in particular is unchanged and still the
source for Slices 2–4 over there).

### What changed

The plan above recommends **HYBRID = a second generic linear VM
(`__regex_run_linear`) + a compile-time router**. That is superseded. Measured
(`.tmp/regex-ceiling.mjs`, five lanes in one process, order-rotated,
checksum-agreed, lane `standalone`, #4237's pattern and workload):

| lane | min ms | vs node |
| --- | ---: | ---: |
| node (V8 Irregexp) | 13.15 | 1.00× |
| today's generic backtracking VM | 318.86 | 24.25× |
| a specialized bit-parallel NFA, expressed in ordinary **dynamic-lane** codegen | 136.88 | 10.41× |
| the same NFA with **native i32 locals** (what a hand-emitter produces) | **17.65** | **1.34×** |

**The 18× is specialization, not the algorithm.** Routed through generic
interpretation the same non-backtracking automaton is only 2.33× better than
the backtracking VM — and a *generic* PikeVM would not even get that, because
it pays a higher per-character constant factor than a backtracker on
non-pathological patterns (this is precisely why V8 keeps `V8Linear` opt-in
rather than default). So the Slice A artifact as specified above —
"`__regex_run_linear`, one hand-authored Wasm function, one more opcode-for-
opcode twin of `vm.ts`" — would buy this issue's conformance goal at the price
of a **perf regression**, and would double the VM surface to maintain (the risk
this issue already flags first under "Risks / cost").

### The revised shape, and what it does for THIS issue's goals

Emit a **per-pattern specialized non-backtracking matcher** for literal
patterns in the linear-safe subset, hung off a new `matcher: (ref null …)`
field on `$NativeRegExp`; leave `matcher` null for everything else and take the
existing `__regex_run` unchanged. Then, for every claimed pattern:

- **ReDoS immunity is structural**, not cap-based — a Glushkov bitset
  simulation has no backtrack stack to blow up;
- **the spurious `RangeError` disappears** — the specialized matcher has no
  step counter at all, so there is nothing to exceed;
- **lookbehind's ad-hoc atomic recursion is bypassed** for the patterns Slice 4
  eventually claims.

The step cap therefore narrows exactly as this issue wanted, and for the same
reason — just delivered by emission rather than by a second interpreter.

**Measured claim rate** over 2,784 regex literals from real shipped JS:
94.8 % are linear-safe, **93.1 % fit one i64 word (≤64 Glushkov positions)**,
**71.4 % are additionally capture-free** (Slice 1's target). Backreferences are
0.9 % and stay on the backtracking VM permanently, as this issue already
concluded.

### What did NOT change

- The verdict is still **hybrid, phased, backtracking retained** — only the
  *form* of the linear path changed.
- Backreferences and the ~0.003 % nullable-lazy-plus CIN/CDN case stay on
  backtracking with the step cap, where a bounded-work cap is the correct
  defense.
- The `SPLIT`-ordering / `SAVE`-as-register / zero-width-op mapping recorded
  above still holds; the AOT emitter consumes the same `parse.ts` AST, so the
  parser and class table remain shared verbatim.
- The §4.2 capture-reset clock and §4.3 oracle remain the reference for the
  capture and lookaround slices (#4237 Slices 3–4).

### Honest scope limit, recorded here too

82.1 % of the regex operations acorn executes while parsing itself are on
**runtime-constructed** patterns (`new RegExp("^(?:" + words.join("|") + ")$")`),
which an AOT specializer cannot claim. Acorn's regexp bucket is 4.04 % of self
time, so the ceiling on the only quotable dogfood is **≈0.7 % of runtime** — at
or below this box's measurement floor. This work must be justified on
conformance (this issue's own goal) and on regex-heavy workloads, **not** on the
acorn profile. Those runtime-constructed patterns keep the step cap and keep the
existing anchored-literal-alternation fast path; closing the conformance gap for
*them* would need the generic linear VM after all, and is deliberately deferred
until the specializer has landed and the residual is worth pricing.
