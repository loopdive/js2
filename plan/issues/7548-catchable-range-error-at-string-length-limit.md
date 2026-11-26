---
id: 7548
title: "A catchable RangeError at the native string length limit, without pulling in the whole error runtime"
status: backlog
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: m
task_type: feature
area: runtime, strings
goal: core-semantics
related: [7513, 7442]
---

# #7548 — the string length limit as a catchable RangeError

## Problem

#7513 makes the native-string kernels (concat, the batched concat, `+=` builders, replace / replaceAll / substitution,
`JSON.stringify` output, the regexp-vm replace) **trap** when a result would exceed `NATIVE_STRING_MAX_LENGTH`
(2^30 code units). JavaScript throws a catchable `RangeError: Invalid string length` there, so a program that catches
it (`try { s + s } catch (e) { … }`) still terminates under js2wasm.

A throw was measured and rejected for #7513 (prototype, 2026-11-26, base #7460 df9c70c9). A minimal string module
`export function f(a: string, b: string): string { return a + b; }` grew:

- gc: 13,054 → 38,498 B. Exception tags 0 → 2, functions 62 → 108, globals 11 → 39.
- standalone: 11,974 → 32,501 B.

A throw site pulls in the whole error-object runtime (the RangeError constructor and what it needs), and every module
that concatenates would pay for it.

The pre-existing IR repeat provider and #7460's repeat / pad checks do throw RangeError today, through
`buildThrowJsErrorInstrs`. They pay this cost only in modules that call repeat or pad.

## Direction

Share the error runtime lazily: a throw site references a small entry point whose body pulls in the RangeError
constructor only when the module actually reaches it, or whose cost is shared with modules that already carry the
error runtime. Then switch #7513's trap guard (`__str_check_length`) to throw, and fold the repeat / pad throws into the
same path.

## Acceptance criteria

1. `try { s + s } catch (e) { e instanceof RangeError }` is `true` past the limit, on gc and standalone.
2. A minimal string module grows by a stated, small number of bytes, measured, not by the error runtime.
3. No new host import.
