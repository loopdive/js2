---
id: 4237
title: "exploration: compile-time regex specialization — lower literal patterns to per-pattern wasm functions at build time (the AOT analogue of Irregexp's JIT tier)"
status: backlog
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
priority: low
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
