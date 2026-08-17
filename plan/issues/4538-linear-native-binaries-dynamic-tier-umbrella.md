---
id: 4538
title: "Umbrella: standalone native binaries from the linear lane, with an embedded-engine dynamic tier (ADR-0020 implementation program)"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
related: [1852, 1856, 2860, 4236, 4245, 4404]
# id 4538 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4538 — Umbrella: standalone native binaries from the linear lane

## Goal (project lead, 2026-08-17)

Compile TypeScript to **standalone native binaries**. The linear lane
(`src/codegen-linear/`) is the vehicle; the blocker is that it has no dynamic
value representation, so it can only compile the statically-typed subset.

[ADR-0020](../../docs/adr/0020-linear-dynamic-tier-quickjs-jsvalue.md) records
the decision that unblocks it: the dynamic residue is represented as QuickJS
`JSValue` through the C API, while typed code keeps unboxed scalars and
compile-time-planned layouts. This issue is the umbrella for implementing that
decision and getting a binary out the other end.

## Why this is now schedulable

The two things that made this speculative are closed (#4236):

- **The architecture is proven.** A peer module driving QuickJS over one shared
  linear memory preserves object identity and two-way mutation at 1.86 ns per
  cross-module call.
- **The artifact is genuinely standalone.** A wasi-sdk build of the pinned
  engine imports five `wasi_snapshot_preview1` functions and nothing else —
  zero JS host in the loop.

What remains is entirely on our side of the seam: `src/codegen-linear/` emits
no imports, defines rather than imports its memory, allocates from an arena
whose base collides with the engine's shadow stack, and has no representation,
refcount discipline, or frontier analysis for dynamic values.

## Slices (each independently dispatchable)

| # | Slice | Horizon | Depends on |
| --- | --- | --- | --- |
| #4539 | Link topology: import direction in `c-abi.ts`, emit imports at all, import the memory | l | — |
| #4540 | Heap coexistence: relocate the arena, passive data segments only | l | #4539 |
| #4541 | `JSValue` as the boxed tier: representation, build-time tag fast paths, strings, cycle policy | l | #4540 |
| #4542 | Refcount discipline: a handle-scope / destructor-insertion pass covering exceptional paths | l | #4541 |
| #4543 | Object frontier: tainted-allocation vs exotic wrappers, decided by a measured A/B | l | #4541 |
| #4544 | Native binary emission, size/startup baseline, and pay-for-what-you-use tier elision | l | #4541 |

Ordering rationale: #4539 and #4540 are pure plumbing and unblock everything
else; nothing dynamic can be emitted until a module can import the engine and
allocate without corrupting it. #4543 and #4544 both need a working tier and
can then run in parallel.

## Acceptance criteria

- [ ] A program mixing typed code with a dynamic residue compiles through
      `--target linear`, links against the pinned engine artifact, and runs
      under a WASI runtime with no JS host.
- [ ] The same program is emitted as a **native binary** and runs, with size
      and startup recorded against a committed baseline (#4544).
- [ ] Typed-only programs are **byte-identical** to today's output and pull in
      none of the engine (#4544) — adoption costs nothing where we are already
      fast.
- [ ] Object identity and two-way mutation hold across the typed↔dynamic
      frontier, including for objects reached from `eval` (#4543).
- [ ] No leaks or double-frees on normal or exceptional paths, under a stress
      fixture (#4542).

## Non-goals

- **The WasmGC/browser lane.** `JSValue` cannot hold WasmGC references; that
  lane keeps its own dynamic family and the self-hosted `eval` interpreter.
  Nothing in this program changes it.
- **Replacing the Tier-0 compile-away splice** — most `eval` sites need no
  runtime tier at all and should keep needing none.
- **Adopting the engine's layouts, builtins, or GC for typed data.** ADR-0020
  scopes the exception to the dynamic residue, reached only through the C API.

## Relationship to existing work

- **#4236** is the exploration record and stays the home of the spike
  measurements, benchmark triangle, build recipe, and design Q&A. This umbrella
  is its slice-2 program; the handoff table in that issue maps one-to-one onto
  the slices above.
- **#1852** fixed the linear lane's dynamic representation as a value+tag cell.
  ADR-0020 supersedes that row for this target — #4541 records the amendment
  rather than leaving two contradictory normative tables.
- **#4245** (the cross-heap eval membrane) shrinks substantially if compiled
  dynamic values already live in the engine's heap: same-heap objects need no
  membrane. #4541 must state explicitly which part of #4245 it subsumes for
  this lane, so the two do not get built twice.
- **#2860** (standalone gap) is the conformance metric this program moves.
