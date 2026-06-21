---
id: 2163
title: "Standalone Symbol conformance residual (~240 tests)"
status: done
sprint: 63
created: 2026-06-15
updated: 2026-06-18
completed: 2026-06-18
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

## Slice 2 (2026-06-17, dev-3) — `sym.description` standalone (native id→string storage)

**Landed.** `sym.description` now reads from a module-owned native side table
in `noJsHost` mode, with **zero host imports** — previously it leaked
`__symbol_description` + `__box_symbol` and failed zero-import instantiation.

New `src/codegen/symbol-native.ts`:

- `ensureSymbolDescTable(ctx)` registers a mutable global
  `__symbol_desc_table : ref_null (array (mut (ref null $AnyString)))` (lazily
  allocated; same array shape the native string runtime already uses for its
  split/flatten worklists, keyed by `ref_<anyStr>`). New context fields
  `symbolDescGlobalIdx` / `symbolDescArrTypeIdx` (init -1; shifted in
  `registry/imports.ts` alongside `symbolCounterGlobalIdx`).
- `emitSymbolDescStore(ctx, fctx)` (`[i32 id, ref_null $AnyString] → []`) lazily
  allocates the table (cap 128), grows it ×2 with `array.copy` when a larger id
  arrives, and stores `table[id] = desc`.
- `emitSymbolDescLoad(ctx, fctx)` (`[i32 id] → [ref_null $AnyString]`) returns
  `table[id]`, or null (⇒ `undefined`) when the table is unallocated or the id
  is out of range.

Wiring:

- `compileSymbolCall` (`literals.ts`) standalone branch now coerces the
  description arg to `ref_null $AnyString` and stores it via
  `emitSymbolDescStore` at the reserved id. §20.4.1.1: a literal
  `Symbol(undefined)` registers NO description (still evaluated for side
  effects); `Symbol("")` registers `""` (distinct from undefined).
- `.description` (`property-access.ts`) `noJsHost` branch reads the i32 id and
  loads via `emitSymbolDescLoad`, returning `ref_null $AnyString`. Host mode is
  unchanged (still routes through the `__symbol_description` accessor — verified
  the import is still present in host mode).

### Acceptance criteria

- [x] `Symbol(d).description === d`, `Symbol().description === undefined`,
  `Symbol(undefined).description === undefined`, `Symbol("")` → `""`.
- [x] No `__symbol_description` / `__box_symbol` host-import leak — standalone
  modules instantiate with **zero** imports.
- [x] Host mode `.description` path unchanged.

### Test Results

- `tests/issue-2163.test.ts` — 14/14 (6 slice-1 creation + 8 new slice-2
  `.description`: desc/undefined/`Symbol(undefined)`/empty-string/length/distinct/
  charCode/grow-past-128). New `runStandaloneZeroImports` helper asserts zero
  imports.
- Symbol/string/iterator regression suites (symbol-iterator-protocol,
  issue-1732, issue-1470) — no new failures. (Pre-existing unrelated failures:
  `symbol-async-iterator` instantiates without a `string_constants` import, and
  `#681 typed-array for-of WASI-clean` IR-fallback — both fail identically on
  `origin/main`, verified by reverting this diff.)
- `npm run typecheck` + Biome lint clean (`symbol-native.ts` 0 warnings;
  literals/property-access warnings are pre-existing `as Instr` convention).

### Still carried forward (issue stays open)

- ~~`Symbol.for` / `Symbol.keyFor` registry~~ — **done in slice 3 below.**
- `Symbol#toString()` late-import index-shift CE (#2043 class).

## Slice 3 (2026-06-17, dev-3) — native `Symbol.for` / `Symbol.keyFor` registry

**Landed.** `Symbol.for` / `Symbol.keyFor` now use a Wasm-native global symbol
registry in `noJsHost` mode, with **zero host imports** — previously `Symbol.for`
leaked `__symbol_for` and `Symbol.keyFor` leaked `__symbol_keyFor` + `__box_symbol`
and failed zero-import instantiation.

Added to `src/codegen/symbol-native.ts`:

- `ensureSymbolRegistry(ctx)` registers two parallel growable globals —
  `__symbol_reg_keys : ref_null (array (mut (ref null $AnyString)))` (reuses
  `symbolDescArrTypeIdx`) and `__symbol_reg_ids : ref_null (array (mut i32))` —
  plus a `__symbol_reg_count : i32` global, and two runtime helper functions:
  - `__symbol_for_native(key: ref $AnyString) -> i32`: linear content-equality
    scan via the native `__str_equals` (flattens cons-strings); on miss,
    `++__symbol_counter`, append `(key, id)` (growing both arrays ×2 with
    `array.copy`), record `key` as the new symbol's description in the slice-2
    table, and return the id.
  - `__symbol_keyfor_native(id: i32) -> ref_null $AnyString`: linear scan by id,
    returns the registration key or null (⇒ `undefined`).
  New context fields `symbolReg{Keys,Ids,Count}GlobalIdx` + `symbolRegIdsArrTypeIdx`
  (init -1; the three globals shifted in `registry/imports.ts` alongside
  `symbolCounterGlobalIdx`).

Wiring (`expressions/calls.ts`): the `Symbol.for` / `Symbol.keyFor` handlers gain
a `noJsHost` branch that compiles the key as `ref $AnyString` (resp. the symbol
as i32) and calls the native helper. Host mode is unchanged (still routes through
`__symbol_for` / `__symbol_keyFor` — verified the imports are still present in
host mode).

### Acceptance criteria (slice 3)

- [x] `Symbol.for(k) === Symbol.for(k)` (identity), distinct keys distinct,
  `Symbol.keyFor` round-trip, `keyFor` of an unregistered symbol is `undefined`,
  registered symbol's `.description === key` (§20.4.2.2), `Symbol.for(k) !==
  Symbol(k)`, registry grows past initial capacity (20 registrations).
- [x] No `__symbol_for` / `__symbol_keyFor` / `__box_symbol` host-import leak —
  standalone modules instantiate with **zero** imports.
- [x] Host mode registry path unchanged.

### Test Results (slice 3)

- `tests/issue-2163-registry-standalone.test.ts` — 9/9 (identity, distinct,
  keyFor, unregistered→undefined, description==key, round-trip, re-register,
  for≠plain, grow). All assert zero host imports.
- `tests/issue-2163.test.ts` slice-1/2 — 14/14, unchanged.
- `npm run typecheck` + Biome lint clean (`symbol-native.ts` 0 warnings).
- Host-mode `Symbol.for` still emits `__symbol_for` (regression guard).

## Slice 4 (2026-06-18, dev cs-2163) — native `Symbol.prototype.toString` / `String(symbol)`

**Landed — closes the issue.** `Symbol.prototype.toString()` and the
non-throwing `String(symbol)` form now build the spec descriptive string
natively in `nativeStrings` / standalone mode, with **zero host imports**.

Before this slice `sym.toString()` was a hard **standalone compile error**: with
no Symbol-specific handler it fell through to the generic `.toString()` fallback,
which drops the i32 symbol id and emits `"[object Object]"` via a string-constant
global. In native-strings mode that global resolves to the `-1` sentinel, so
binary emit threw the late-import index-shift CE (the carried-forward `#2043`
class item — `global index out of range — -1`). This was the last untracked
Symbol-semantics gap in the standalone residual.

New `emitSymbolToString(ctx, fctx)` in `src/codegen/symbol-native.ts`
(`[i32 id] → [ref $AnyString]`): loads the description via `emitSymbolDescLoad`,
collapses the `undefined` sentinel to `""`, and concatenates
`"Symbol(" + (desc ?? "") + ")"` (§20.4.3.3.1 SymbolDescriptiveString) using
inline native-string literals and the native `__str_concat` helper — the same
lowering template literals already use. No new host import, no string-constant
global.

Wiring (`src/codegen/expressions/calls.ts`):
- A symbol-receiver branch in `compileMethodCall` (after the bigint `toString`
  block): `toString()` → `emitSymbolToString` (native-strings only);
  `valueOf()` → returns the symbol primitive (the i32 id) itself (§20.4.3.3.4).
- A symbol branch at the top of the `String(...)` handler: §22.1.1.1 step 1 is
  the ONE ToString form that does NOT throw on a Symbol — routed through the same
  native builder. (Implicit coercions — template literals, `+` — still throw via
  `tryThrowOnSymbolStringCoercion`, unchanged.)

Host (JS-host / `target: gc`) mode is untouched — both new branches are gated on
`ctx.nativeStrings`, so the pre-existing host behaviour is unchanged.

### Acceptance criteria (slice 4)

- [x] `Symbol("66").toString() === "Symbol(66)"`,
  `Symbol().toString() === "Symbol()"`, `Symbol("").toString() === "Symbol()"`.
- [x] `String(Symbol("66")) === "Symbol(66)"`, `String(Symbol()) === "Symbol()"`.
- [x] `Symbol("x").valueOf() === Symbol("x")`-instance (identity).
- [x] Registry symbol toString reflects its key (`Symbol.for("k").toString()
  === "Symbol(k)"`).
- [x] No host-import leak — standalone modules instantiate with **zero** imports.
- [x] Host mode `String(symbol)` / `sym.toString()` path unchanged.

### Test Results (slice 4)

- `tests/issue-2163-tostring-standalone.test.ts` — 10/10 (toString of
  desc/undefined/empty, descriptive-string length + first char, distinct
  descriptions, `String(symbol)` ×2, valueOf identity, registry-symbol toString).
  All assert zero host imports.
- `tests/issue-2163.test.ts` (14) + `tests/issue-2163-registry-standalone.test.ts`
  (9) — unchanged, 33/33 across all three files.
- Symbol regression suites (`symbol-iterator-protocol`, `issue-1732`,
  `issue-1470*`, `bigint-string-coercion`) — no new failures. Pre-existing
  unrelated failures verified identical on `origin/main`: `symbol-async-iterator`
  (instantiates without a `string_constants` import) and
  `bigint-string-coercion` (references a missing `tests/helpers.js` — collect
  error, not on main either).
- `pnpm run typecheck` + `pnpm run lint` + `pnpm run format:check` — all clean.

### Out of scope (separately tracked, not a Symbol-semantics gap)

- `Symbol.prototype.toString.call(s)` — the borrowed-method brand path errors
  loudly in standalone (`#1888 Slice 3/4`, "this prototype's borrowed-method
  brand arm is not yet native"), **identically on `origin/main`**. This is a
  generic standalone `.call`-borrowing limitation affecting all prototype
  methods, not Symbol-specific; it is tracked under #1888.
