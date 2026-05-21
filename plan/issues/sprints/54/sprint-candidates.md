---
sprint: 54
status: draft
created: 2026-05-21
author: po-s54
---

# Sprint 54 — Candidate Issues

PO working set for sprint 54 planning. Final selection happens at the planning
meeting once sprint 53 wraps. Baseline numbers are 53's current snapshot:
**28,233 / 43,160 pass (65.5 %)**.

The bulk of sprint 53's work was specification-heavy (architect plans for the
async cluster, with-statement, #1103/#1105, #1553 family, #1352, #1559/#1560).
Sprint 54 is the harvest sprint: take those specs and turn them into merged
PRs, plus crack the two largest backlog umbrellas (#820 and #779) that have
sat untouched all sprint.

## Theme proposal

> **"Decompose, dispatch, deliver"** — turn S53's architect specs into merged
> PRs, decompose the #820 / #779 megabuckets into sized sub-issues, and
> finalise the host-independence track now that PR #408 has cleared the way.

Three parallel tracks:

1. **Carry-forward harvest** — finish the work that S53 specced or set up but
   did not land: #1471–#1474 host-indep, #1042 async-await, #1103/#1105
   wasm-native runtime, ESLint Tier 2 follow-ups, #1158/#1159 destructuring
   iterator semantics.

2. **Umbrella decomposition** — investigate #820 and #779 with a senior dev,
   write 3–5 sized sub-issues each, then dispatch the highest-leverage
   sub-issues in the same sprint.

3. **High-FAIL codegen wins** — pick up the #1522 (~530 FAIL),
   #1529 (~241 FAIL), and #821 (~537 FAIL) tickets that are sized for normal
   dev pairs and don't depend on the umbrella work.

## File-contention map (hot files to avoid scheduling together)

| File | Owned by S53 PR / S54 candidate | Conflict-risk in S54 |
|------|--------------------------------|----------------------|
| `src/codegen/literals.ts` | #1553b/c/d/e (S53 in-flight) | Defer #1556 follow-up until 1553 family lands |
| `src/runtime.ts` | #1471 / #1472 / #1473 / #1474 (S53 carry-forward) | Serial wave — one dev across all four |
| `src/codegen/index.ts` | nearly everything | Unavoidable; rely on PR-merge order |
| `src/codegen/expressions/calls.ts` | #1151 Gap B (S53) | Hold ESLint new-2 (rule-tester polymorphic return) until Gap B merges |
| `src/codegen/class-bodies.ts` | #1394 (already done), method dispatch | Low risk in S54 |

## Candidate table

| # | ID | Title (truncated) | Priority | Feasibility | FAIL est | Track | Spec? | Notes |
|---|------|-------------------|----------|-------------|----------|-------|-------|-------|
| 1 | 1471 | Host-indep: boxing/unboxing in pure Wasm | high | medium | strategic | carry | ✅ exists | Sequential w/ #1472–#1474; one dev; runtime.ts |
| 2 | 1472 | Host-indep: object/property ops in pure Wasm | high | medium | strategic | carry | ✅ exists | follow-up to #1471, same dev |
| 3 | 1473 | Host-indep: error/exception ops in pure Wasm | high | medium | strategic | carry | ✅ exists | follow-up; pairs with #1536 |
| 4 | 1474 | Host-indep: pure-Wasm RegExp | high | medium | strategic | carry | ✅ exists | follow-up; coordinate with #1539 backlog |
| 5 | 1042 | async/await state-machine lowering | high | hard | ~210 FAIL | carry | ✅ S53 async-cluster spec | Now unblocked by #1373/#1373b landing; spec defines AwaitExpression CPS path |
| 6 | 1089 | dynamic `import()` expressions | medium | hard | 429 skip→exec | carry | needs spec | Architect spec needed; touches module-loader + microtask queue (post-#1326c) |
| 7 | 1103+1105 | Wasm-native Map/Set/WeakMap + String methods | high | hard | strategic | carry | ✅ S53 spec | Joint spec exists; split into Map track + String track during planning |
| 8 | 820 | Decompose #820 umbrella + dispatch top sub-issues | critical | hard | up to ~6.9k FAIL | umbrella | needs investigation | Senior-dev to decompose into 3–5 sub-issues, then dispatch wave |
| 9 | 779 | Decompose #779 assert-failure umbrella | critical | hard | up to ~8.6k FAIL | umbrella | needs investigation | Same pattern as #820; pair with #846 sub-issue extraction |
| 10 | 1522 | Invalid Wasm at type-boundary coercion (extern/anyref ↔ struct) | high | medium | ~530 FAIL | high-FAIL | needs spec | NEW (2026-05-20); fits one Sonnet-3.5 dev for ~2 days |
| 11 | 1529 | `illegal cast` umbrella at closure & destructuring param boundaries | medium | medium | ~241 FAIL | high-FAIL | needs spec | NEW; coordinate with #1556 architect spec (already spec-done) |
| 12 | 821 | BindingElement null guard over-triggering | critical | medium | ~537 FAIL | high-FAIL | ready | Mature ticket; well-scoped; pure codegen fix |
| 13 | ESLint-new-1 | source-code.js: anon `enter` closure captures externref into f64 global | high | medium | strategic | ESLint Tier 2 | needs issue file | File issue from `eslint-next-layer-survey.md`; smallest binary, isolated callback |
| 14 | ESLint-new-3 | apply-disable-directives.js: conditional-spread struct shape mismatch | medium | hard | strategic | ESLint Tier 2 | needs issue file | File issue from survey; shape-inference change, may unlock more binaries |
| 15 | 1158+1159 | destructureParamArray iterator semantics (rest/spread + nested empty) | medium | hard | ~200 FAIL | spec-completeness | needs spec | Bundle architect spec (existing recommendation in dep graph); coordinate with #1555 |

Total: **15 candidates**, mix of carry-forward (5), umbrella (2), high-FAIL (3),
standalone (1), ESLint Tier 2 (2), spec-gap (2).

## Stretch / capacity-permitting

Pick up when a slot frees mid-sprint:

| ID | Title | Why stretch |
|----|-------|-------------|
| 983 | WasmGC objects leak to JS host as opaque values (1,087 FAIL) | High-value, but `feasibility: hard`; needs architect spec, coordinate with #1471 |
| 1130 | Array methods observe accessor getters on indices & length (~120 FAIL) | Listed in S53 TaskList but never dispatched; medium-effort |
| 1536 | Wasm-native exception types (`$Error` WasmGC struct + try_table) | Pairs with #1473 host-indep error/exception work |
| 1537 | Wasm-native number formatting (Ryū port) | Pairs with #1471 — eliminates `__box_number`-derived host calls |
| 1538 | Wasm-native JSON.parse/stringify | After #1536 lands |
| 1252 | SameValue f64.ne for NaN / ±0 | DONE in S53 — confirmed at planning; remove from backlog |
| 1253 | OrdinaryToPrimitive returns undefined | DONE in S53 — confirmed at planning; remove from backlog |
| 1383 | Narrower typeof-gated strict-equality fix | `status: in-review` since S51 — needs PO follow-up to confirm landed or close |
| ESLint-new-2 | rule-tester.js polymorphic return widens i32 into anyref slot | Defer to S55 unless capacity opens — touches `expressions/calls.ts` (hot) |

## Issues needing architect spec **before** dev dispatch

| ID | Effort | Specifier | Notes |
|----|--------|-----------|-------|
| 820 (decomp) | 1 day | senior dev (Opus) | Bucket-by-error-message + bucket-by-test-file; write 3–5 child issues with sample tests |
| 779 (decomp) | 1 day | senior dev (Opus) | Same pattern; carry over the existing #846 sub-extraction work |
| 1089 | 0.5 day | architect | Define interaction with #1326c microtask queue; clarify host-loader contract |
| 1522 | 0.5 day | architect | Pin the four call-sites where extern/anyref ↔ struct coercion is wrong; choose between coerceType inline fix vs new helper |
| 1529 | 0.5 day | architect | Coordinate with `#1556` (spec-done) — much may already be answered there |
| 1158+1159 | 0.5 day | architect | Bundle issues; build on the #1555 streaming-iterator design |
| ESLint-new-1 | 0.25 day | PO files issue from survey | Survey already contains the analysis + reproducer |
| ESLint-new-3 | 0.5 day | PO files issue → architect | Conditional-spread struct unification is a known type-inference gap |

## Suggested dispatch wave order

**Wave 1 (sprint open, parallel, low-conflict):**
- #1471 (one dev, runtime.ts owner for the sprint)
- #1522 (separate dev, codegen/type-coercion.ts)
- #821 (separate dev, null-guard emission path)
- File ESLint-new-1 + dispatch (separate dev, closure-capture path)
- Architect: spec #1089 dynamic import

**Wave 2 (after Wave 1 PRs land, ~mid-sprint):**
- Senior dev investigation of #820 → produces sub-issues
- Senior dev investigation of #779 → produces sub-issues
- #1472 + #1473 (sequential on runtime.ts after #1471)
- #1042 async-await state machine (now that #1373 family has merged)
- #1529 (after #1556 architect spec is consumed)
- File ESLint-new-3 + dispatch

**Wave 3 (umbrella sub-issues + standalone harvest):**
- Top 2–3 sub-issues from #820 decomposition
- Top 2–3 sub-issues from #779 / #846 decomposition
- #1474 (final host-indep; pairs with #1539 / #1474 backlog harvest if capacity)
- #1103 (Map/Set; split from #1105 if both can fit)
- #1158 + #1159 (bundled with #1555 if shape allows)

**Wave 4 (long-tail, stretch):**
- #1105 String-method natives
- #1089 dynamic import implementation
- Stretch issues as capacity opens

## Backlog hygiene at planning

Confirm and update these stale statuses before sprint kickoff (per S53 audit
follow-ups + 2026-05-21 review):

- **`#1129` (ToObject auto-boxing)** — TaskList shows completed; `backlog/`
  copy still `status: in-progress`. Flip to `done`, set `completed:` date.
- **`#1352` (RegExp exec result equality)** — TaskList completed; ensure the
  S53 in-progress sub-issue is closed and not re-pulled into S54.
- **`#1471`–`#1474`** — currently `status: ready` in sprints/52/. Move into
  sprints/54/ when S53 closes (PR #408 was the original blocker).
- **`#1373` / `#1373b`** — TaskList completed; confirm `status: done` in
  sprint 52 / 53 files.
- **`#1326c`** — TaskList shows resumed-and-completed; confirm sprints/52/
  file flipped to `done`.
- **#1252, #1253, #1134** — listed `status: done` in backlog already; remove
  from any open lists.

## Risks to flag at planning

1. **PR #408 dependency** — #1471–#1474 are tagged "blocked on PR #408". Plan
   must confirm whether #408 has merged before S54 opens; if not, surface as
   the #1 risk and have the tech lead resolve it on day 1.
2. **Umbrella decomposition discipline** — #820 and #779 have been "next
   sprint's problem" for three sprints. Sprint 54 must commit a senior-dev day
   to actually break them down or the cycle continues.
3. **Hot-file serialisation** — runtime.ts has four sequential consumers
   (#1471–#1474); if dispatched in parallel they will conflict. PO recommends
   **one dev for the entire host-indep series**, not four parallel devs.
4. **Async cluster vs IR async** — #1042 is the AwaitExpression state-machine
   side of the joint S53 async spec; #1373 was the IR claim. Make sure the
   dev picking up #1042 reads the joint spec end-to-end, not just the #1042
   issue body.
5. **Architect bandwidth** — five candidates (#820, #779, #1089, #1522,
   #1158+#1159) need architect input before dispatch. With one architect this
   is a queue, not a parallel resource — PO suggests batching the four
   smaller specs in a single 1-day architect session.

## Out of scope for S54

- `#1100` / `#1101` / `#1102` Wasm-native Proxy / WeakRef / eval — defer
  until #1103 / #1105 prove the wasm-native runtime pattern.
- `#680` pure-Wasm generators — large, no architect spec yet; keep in backlog.
- `#674` SharedArrayBuffer / Atomics — `feasibility: hard`, low priority.
- `#1066` eval in standalone mode — depends on wasm-child-module loader work
  not on critical path.
- Performance tickets (#743 whole-program type flow, #745 tagged-union rep,
  #1199 linear-memory typed arrays) — reserve for a perf-focused sprint.

## Definition of Done (sprint-level)

- Host-independence track (#1471–#1474) fully merged; standalone-mode demo
  re-validated.
- #820 + #779 produce **at least 3 dispatched sub-issues each**, with at
  least one sub-issue per umbrella merged.
- #1042 lands and reduces async/await assertion-failure count by a
  measurable margin (target ≥ 100 FAIL → PASS).
- #1522 lands, retiring its ~530 FAIL bucket (target: ≥ 400 FAIL → PASS).
- At least one ESLint Tier 2 binary (source-code.js or apply-disable-
  directives.js) validates after S54.
- Net test262 pass-rate up vs S54 baseline.

---

*Drafted by PO agent po-s54, 2026-05-21. Ready for tech lead review at
sprint 53 close.*
