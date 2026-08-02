---
id: 4072
title: "a standalone `throw new TypeError('msg')` ships the Ryu float tables — __any_to_string is monolithic, so any use pulls its number arm"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [4034, 4035, 2969, 1470]
origin: "2026-08-02 — the residual after #4035: every measured standalone program is now <1.1 kB EXCEPT the ones that throw"
---

# #4072 — throwing a constant-message error costs ~18 kB of float formatting

## Problem

After #4035 turned the host-bridge exports off for standalone, every probed
program collapsed to well under a kilobyte — **except the ones that throw**:

| standalone program (`-O3`, bridge off) | bytes |
| --- | ---: |
| class + array + closure + `join` | 1,000 |
| `return [1,2,3]` | 125 |
| `if (n<0) throw new TypeError('neg')` | **19,621** |
| class + array + closure + **throw** | **18,472** |

Section breakdown of the 19,621-byte one: **globals 12,888 (65.7 %)** — the two
Ryu `DOUBLE_POW5_*` tables — plus 6,499 of code. The export section is 28 bytes
(just `run` + `memory`), so this is **not** the bridge and not `_start`: it is
reachable from `run` itself. Same size on `target: "standalone"` as on `wasi`,
with no `_start` in either, which rules out the #2968 uncaught-exception printer.

## Root cause

`throw new TypeError('neg')` constructs an Error whose message routes through
`__any_to_string` — one monolithic dispatcher covering every tag (null,
undefined, i32, f64, bool, string, ref). Its number arm is force-emitted
(#2969, so a thrown raw number renders `"42"` instead of `[object Object]`),
and that arm calls `number_toString` → Ryu → the two constant tables.

The message here is a **string literal**. Nothing in the program can reach the
f64 arm, but the arm is baked into the shared helper, so the whole float
formatter is live.

## Fix direction

Specialise on what the call site can prove:

- when the argument is statically a string (the overwhelmingly common
  `throw new TypeError("literal")`), call a string-only path and never
  reference `__any_to_string`;
- otherwise keep today's polymorphic helper.

An alternative worth pricing first: split `__any_to_string` into per-tag arms
emitted on demand, so the number arm is pulled only by a module that can
actually reach it. That fixes the class rather than one call shape, and would
also shrink `String(x)` sites whose `x` is statically narrowed.

Do NOT simply drop the #2969 force — a thrown raw number must still render its
decimal. The goal is to stop a *string* throw from paying for it.

## Acceptance criteria

- A standalone module whose only `throw` carries a string-literal message
  compiles to < 2 kB at `-O3` and contains no `DOUBLE_POW5` table.
- A standalone module that throws a raw number still renders `"42"` through
  `__exn_render_prepare` when the harness asks for the bridge (#2969's tests
  stay green).
- test262 standalone lane does not regress.

## Dupe check

- **#2969** — force-emits the number arm so a thrown number renders. This issue
  does not undo that; it stops string-only throws from paying for it. Not a dupe.
- **#4034 / #4035** — the two levers already landed (prelude flag, export
  policy). This is the measured residual after both. Not a dupe.
- **#2968** — the WASI `_start` uncaught-exception printer, a different consumer
  of the formatter. Ruled out by measurement here (no `_start` in the binary),
  but it would benefit from the same specialisation.
