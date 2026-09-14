---
id: 6489
title: "standalone: `new <runtime ctor value>(a0 … a8)` with MORE than eight arguments evaluates to null and never evaluates its arguments — the construct-driver admission ceiling was the `__call_fn_method_<N>` range"
status: done
completed: 2026-09-14
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/s24-lane
created: 2026-09-14
---

## Problem

Under `--target standalone`, `new <constructor VALUE>(…)` answers **null**, with
none of its argument expressions evaluated, as soon as the call site has **nine
or more** arguments — but only when the callee is a constructor the compiling
module does not own. A module-local class takes the per-class tag-dispatch
fallback and is correct at any arity, which is why this never showed up in a
single-module probe.

Measured on this branch's base, across the link, provider = the unmodified
`@js-temporal/polyfill` (`.tmp/s24/link3.mjs`):

| call site | base | expected |
| --- | --- | --- |
| `new Temporal.Duration(1 × 8)` | instance | instance |
| `new Temporal.Duration(1 × 9)` | **null** | instance |
| `new Temporal.Duration(1 × 10)` | **null** | instance |
| `new Temporal.PlainDateTime(2000, 5, 2, 12, 34, 56, 987, 654, 321)` | **null** | instance |
| 10 arguments, each a marked call | **null, marks never run** | marks run in order |

The consumer's view of the failure is the polyfill's own guard, several frames
later: `ToTemporalDuration(null)` falls into its string branch and
`RequireString` throws **`TypeError: expected a string, not null`**.

## Root cause

`tryCompileNativeConstructFromValue` (`src/codegen/expressions/new-super.ts`)
declined above `MAX_NATIVE_CONSTRUCT_ARITY` (8). That constant is **not** a
property of the construct driver — it is the range over which
`closure-exports.ts` emits the `__call_fn_method_<N>` dispatcher family
(`/^__call_fn_method_([0-8])$/`), used by the driver's ordinary
module-local-closure tail. Every other arm of the driver — class, link-boundary,
proxy, runtime-marker — already packs an argument VECTOR and is arity-generic.

Declining is not a graceful fallback. For a callee the module does not own there
are no candidate classes for `emitDynamicNewFallback` to tag-dispatch on, so the
site lands on the pre-existing `ref.null.extern` no-match base — and that base
is emitted *instead of* the argument evaluation, so the arguments are dropped
too. Same signature as #6485, one ceiling further out.

## Fix

- `MAX_DYNAMIC_CONSTRUCT_ARITY = 16` (new) is the call-site admission ceiling
  and the fill/scan bound; `MAX_NATIVE_CONSTRUCT_ARITY = 8` keeps its real
  meaning, "the highest arity `__call_fn_method_<N>` exists for".
- Above 8 the driver's ordinary tail packs an argv and calls `__apply_closure`
  — the same terminal its runtime-marker arm already uses. Gated strictly on
  `arity > MAX_NATIVE_CONSTRUCT_ARITY`, so the long-standing
  `methodCallIdx === undefined` case at arities ≤ 8 (a driver reserved only for
  Proxy → admitted-JS construction) keeps its exact previous null tail and every
  module that compiled before stays byte-identical.

## Acceptance

- `new <foreign ctor value>(…)` with 9–16 arguments constructs, and evaluates
  its arguments left to right.
- A driver of arity ≤ 8 is byte-identical.
- `tests/issue-6489-dynamic-new-arity.test.ts`: single-module + linked-pair
  witnesses, plus the arity-8 no-change control.
