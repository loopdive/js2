---
id: 7506
title: "BigInt-only JS function gets an i64 parameter from call-site inference and wraps at the call"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7497, 6656]
---

# #7506 — a BigInt-only JS function gets an i64 parameter and wraps a wide BigInt at the call

## Problem

An untyped JavaScript parameter whose every call site passes a BigInt is inferred as the i64 BigInt lane. A BigInt
past 64 bits is wrapped to its low 64 bits at the call, before the callee runs. Found while fixing #7497 (S18); it
is older than #7497's regression.

Measured on `origin/main` 1a726b3e64, `--target standalone`, `hostBridge: "off"`, `allowJs`:

| program | node | we answer |
| --- | --- | --- |
| `function f(t) { return String(t); } f(2n ** 64n) === "18446744073709551616"` | true | false |
| `function f(t) { return t; } f(2n ** 64n) === 2n ** 64n` | true | false |
| the first, plus one call `f("x")` | true | true |
| the first, with `5n` | true | true |
| TypeScript `function f(t: any)`, same call (gc and standalone) | true | true |

The emitted callee is `(func $f (param i64) …)`; the caller passes the wrapped `i64.const 0`.

Also fails at `688eb4de41` (before #6182), so it is not part of #7497's regression. It is why
`function LoS(t) {…}; LoS(2n ** 64n)` with no other caller still answers false after #7497, and it is the
pre-existing gap RV7450 recorded as probes `S2` / `S3` in the 6656 SOURCE (review of #7450): both are called only with
`2n ** 64n`, fail on main and with #7497's fix, and pass with #7497's fix once given a non-BigInt caller.

## Expected

A parameter that can receive a BigInt wider than 64 bits keeps a reference carrier (or the inference refuses i64
when an argument is a wide BigInt constant or any BigInt not provably within i64).

## Acceptance criteria

- The rows above answer like node on standalone and gc.
- Pins fail on main and pass after; bytes unchanged for programs whose BigInt arguments all fit in i64.
