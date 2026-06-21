---
id: 2169c
title: "Standalone host-free Array.from(iterable) — drain via native __iterator instead of __array_from host import"
status: done
sprint: 64
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: medium
task_type: feature
area: codegen
language_feature: iterators-collections
goal: standalone-mode
parent: 2169
depends_on: [2169b]
---

# Standalone host-free `Array.from(iterable)`

## Problem

`Array.from(x)` (no mapFn) over any iterable lowered to the `env::__array_from`
JS-host import (`calls.ts`, the "Fallback: Array.from(externref/iterable)"
branch). Standalone (`--target wasi`) has no JS host, so the binary pulled an
import a hostless runtime can't satisfy. This is the producer half of #2169
(the `__iterator` driver miscompile was fixed first in #2169b).

## Fix

When `noJsHost(ctx)` and there is no mapFn, drain the iterable natively instead
of calling the host import:

- `ensureNativeIteratorRuntime(ctx)` registers the native `__iterator` /
  `__iterator_rest` funcs (standalone).
- `__iterator(arg)` wraps the arg into an `$IterRec`; `__iterator_rest(rec)`
  drains the remainder into a canonical externref `$Vec` — exactly the value the
  host `__array_from` returned, host-free. (The drain reuses the same `$Vec`
  runtime the for-of / spread consumers already use.)

`Array.from(iter, mapFn)` is NOT handled natively (needs closure dispatch) and
still delegates to the host path. The branch is `noJsHost`-gated, so JS-host mode
is byte-identical/unchanged.

**Depends on #2169b** — the native `__iterator` driver had a `struct.new`
type-index miscompile (shared-arm aliasing → DCE double-remap); without that fix
the drain would VFAIL. This work is built on the #2169b branch.

## Verified (zero host imports, correct values)

- `Array.from(arr.values())` / `.keys()` / `.entries()` — drained correctly.
- `Array.from(generator)` — 33.
- `Array.from(plain array)` — 37.
- `Array.from("abc")` — strings are iterable, drained natively (bonus).
- host-mode `Array.from` unchanged (still delegates, `noJsHost`-gated).
- IR fallback gate OK. Test: `tests/issue-2169c-native-array-from.test.ts` (5/5).

## Out of scope

- `Array.from(new Set(...))` VFAILs with a separate Set-iterator producer bug
  (`struct.new need 4 got 2` — confirmed pre-existing on the #2169b base, not
  introduced here). Tracked under #2162 (Map/Set lane).
- `Array.from(iter, mapFn)` native lowering (closure dispatch) — host-delegated
  follow-on.

## Source

Built 2026-06-18 (sdev-iter) as the #2169 producer follow-on to #2169b, per
tech-lead direction. Filed as a distinct issue (the #2169 claim was stale: no
remote branch, no PR).
