---
sprint: 55
status: planning
created: 2026-05-23
---

# Sprint 55 Plan

## Issues

| ID | Title | Feasibility | Depends on |
|----|-------|-------------|------------|
| [#1586](1586-explicit-allocation-sites-in-ir.md) | IR preparation: explicit allocation sites with stable identity and metadata hooks | medium | — |
| [#1587](1587-ownership-and-access-semantics-analysis.md) | Static analysis pass: ownership and access semantics on IR values | hard | #1586 |
| [#1588](1588-string-encoding-tracking-utf8-wtf16.md) | String encoding tracking: prove UTF-8 guarantees for zero-copy Component Model interop | medium | #1586 |
| [#747](747-escape-analysis-for-stack-allocation.md) | Escape analysis for stack allocation (Phase 1 of #652) | hard | #1586, #1587 |

## Theme

**IR foundation for ownership-based optimization.** #1586 introduces stable allocation
identity in the IR, #1587 derives ownership/access semantics, #747 uses those to
scalar-replace non-escaping allocations. #1588 is a separate parallel track on the
same IR foundation (string encoding tracking).

## Notes

- #1586 must land first; #1587, #1588, and #747 all depend on it.
- #1587 is `feasibility: hard` — needs architect spec before dispatch.
- #747 is `feasibility: hard`. Original spec (2026-05-21) targets #743 (whole-program
  analysis) + #746 (shape inference) as dependencies. For sprint 55, the architect
  should re-scope #747 to use the new IR ownership pass (#1587) as its analysis
  substrate — the IR-native path is cleaner than the original AST-walk approach.
- #652 (compile-time ARC, full version) and #746 (inline property tables) remain in
  backlog as larger follow-ups; #747 is the narrower Phase 1.

## Carry-in from sprint 54 (added 2026-05-23 at sprint 54 closeout)

The sprint 54 compressed cycle did not execute the planned W1–W3
spec-compliance harvest. The following issues were either un-attempted
in sprint 54 or carried over from earlier sprints. They are now in
`plan/issues/sprints/55/`:

| ID | Title | Source | Status at carry-in |
|----|-------|--------|--------------------|
| #1589A | Object-literal field-type + __extern_has_idx null semantics (Hot Spot A real fix) | s54 (was ready) | ready |
| #1553b | decl-dstr: typed-struct object delegation | s53 → s54 → s55 | in-progress |
| #1553c | decl-dstr: externref-fallback object delegation | s53 → s54 → s55 | blocked (on #1553b) |
| #1553d | decl-dstr: array delegation | s53 → s54 → s55 | blocked (on #1553c) |
| #820d | class/dstr async-gen-meth `unresolvable` cast | s53 → s54 → s55 | ready |
| #1471 | host-indep: boxing/unboxing | s52 → s55 | ready |
| #1472 | host-indep: object/property ops | s52 → s55 | ready |
| #1473 | host-indep: error/exception ops | s52 → s55 | ready |
| #1474 | host-indep: pure-Wasm RegExp | s52 → s55 | ready |
| #1130 | Array methods getter-observing property access | backlog → s55 | ready |
| #1116 | Promise resolution & async error handling (210 fails; #436 landed a slice) | backlog → s55 | ready |

S55 planning should re-prioritise these alongside the IR-foundation work
(#1586/#1587/#1588/#747). The destructuring chain (#1553b → #1553c →
#1553d) needs single-thread ownership; #820d hangs off the same
param-list closure machinery. The host-indep series (#1471–#1474) should
be claimed sequentially by a single "runtime owner" dev (per the
s54 plan's conflict analysis — same `runtime.ts` regions).
