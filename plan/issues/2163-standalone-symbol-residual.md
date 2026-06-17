---
id: 2163
title: "Standalone Symbol conformance residual (~240 tests)"
status: in-progress
sprint: 63
created: 2026-06-15
updated: 2026-06-16
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: symbol
goal: standalone-mode
parent: 483
---

# Standalone Symbol conformance residual

## Problem

Symbol constructor / `typeof symbol` and `toNumeric` Symbol TypeError landed
in #483, #1564 (`done`). The host-vs-standalone baseline diff (sha
`31fa7e099`, 2026-06-15) shows **240 tests pass in host mode but fail
standalone**, attributed to Symbol semantics — currently **untracked**.

## Evidence

- `__symbol_register_desc` (368) and `__box_symbol` (325) host-import leaks
  in the gap; well-known symbols, registry (`Symbol.for`/`keyFor`), and
  argument validation.

## Acceptance criteria

- Standalone pass count for `built-ins/Symbol` rises toward host parity.
- No `__symbol_*` / `__box_symbol` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #483. Part of sprint-62 standalone catch-up (rank 9 by gap
impact).

---

## Slice 1 (2026-06-16) — `Symbol()` creation no longer leaks a host import

**Landed.** Triage showed the dominant Symbol standalone failure was the
**foundational one**: every `Symbol()` / `Symbol(desc)` call failed to
instantiate standalone. `compileSymbolCall` (`src/codegen/literals.ts`) lowers a
symbol to a unique i32 counter id, and (#1467) also called
`env::__symbol_register_desc` to register the description with the JS host —
**unconditionally**, so standalone/wasi modules carried an unsatisfiable import
and `Symbol()` was a hard runtime failure.

**Fix:** the description registration is a pure JS-host fast path (the symbol
value is just the i32 id, which is all `typeof s === "symbol"` and symbol
identity/distinctness need). Gate the host registration on JS-host mode; in
`noJsHost` mode only evaluate the description argument for side effects. Host
mode unchanged (the 2 pre-existing `symbol-basic` well-known-constant failures
on main are orthogonal). Test: `tests/issue-2163.test.ts` (creation, typeof,
distinctness, identity, side-effecting desc arg, well-known iterator — 6/6).

### Remaining slices (issue stays open) — triage 2026-06-16

- **`.description` standalone** leaks `__symbol_description` + `__box_symbol`.
  Standalone the symbol is a bare i32 id with no stored description — supporting
  `.description` needs **native description storage** (a Wasm-native id→string
  map paralleling the host registry). Medium slice.
- **`Symbol.for` / `Symbol.keyFor` registry** leaks `__symbol_for` /
  `__symbol_keyFor` — needs a native id↔key registry (same native-storage
  infra as `.description`). Medium slice; pairs naturally with description
  storage.
- **`Symbol#toString()`** hits a late-import index-shift CE (#2043 class) —
  separate codegen bug, independent of the above.
