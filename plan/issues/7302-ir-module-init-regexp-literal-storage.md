---
id: 7302
title: "IR: module-init RegExp literal storage (temporalHelpers ASCII_IDENTIFIER) — measured, 0 units alone; owned by #7106 lever R/S"
status: blocked
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7301, 7106, 3791, 7128]
assignee: "ttraenkler/c-r11"
---

# #7302 — module-init RegExp literal storage

## Problem

#7301 left one `<module-init>` blocker in the 66 temporalHelpers files:
`const ASCII_IDENTIFIER = /^[$_a-zA-Z][$_a-zA-Z0-9]*$/u;`
(`test262/harness/temporalHelpers.js:10`). Its only consumer is
`ASCII_IDENTIFIER.test(propertyKey)` in `formatPropertyName`.

## Measurement (2026-11-07, main `cc27f70d`, wrapped standalone)

Setup:
- 25 temporalHelpers includers: every 60th of `built-ins/Temporal`.
- `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`.
- Probe script: `.tmp/mi.mts`.

**All 25 files have exactly 2 legacy units:** `formatPropertyName`
(`param-shape-rejected`, #7301) and `<module-init>`.

`<module-init>` holds the same three storage refusals in all 25, and the
test bodies' own statements add none:

| statement | refusal | what it needs |
| --- | --- | --- |
| `ASCII_IDENTIFIER = /…/u` | `vardecl-module-storage-unrepresentable` | a RegExp-valued script var (this issue) |
| `SKIP_SYMBOL = Symbol("Skip")` | `vardecl-module-storage-unrepresentable` | a Symbol value on the standalone IR. Legacy stores an `i32`. This is a new value kind, the same one #7301 item 1 needs. |
| `TemporalHelpers = { … }` (a ~1,250-line object literal with methods) | `vardecl-module-storage-unrepresentable` | object-literal module storage with method members (#7106 lever S, #7128) |

**Units this issue would move on its own: 0. Files reaching zero legacy
units: 0.** Even with #7301 stacked, `<module-init>` stays legacy on
`SKIP_SYMBOL` and `TemporalHelpers`, and `formatPropertyName` stays legacy on
`Symbol.keyFor` and on the RegExp argument to `.replace`.

## What legacy emits, and the carrier

- On standalone, the literal is built at compile time:
  - `compileStandaloneRegExpLiteral` (`codegen/regexp-standalone.ts`)
    produces a `$NativeRegExp` struct, which is converted
    (`extern.convert_any`) into an externref global (the dynamic home).
  - `.test` runs in-module through `__regexp_test_carrier`.
- No host import. The value is the open dynamic carrier's object family.
- The consumer, however, does not go through the generic dynamic member-call
  path. It goes through #3791's stable-global special case
  (`staticRegExpTestPlan`), which reads legacy's global directly.

## Ownership: #7106 lever R / lever S (stop)

This is already planned and in flight in another lane:
- #7106 "ES5 lever R" (PR #7154 = R1, held; #7162 = R3) adds a native
  `extern.regex` lowering on standalone. R1 deliberately refuses "a RegExp
  … held in a binding".
- Its plan step 3 folds #3791's `staticRegExpTestPlan` away "once a
  RegExp-valued script var is an `extern` module binding (lever `S`)".
- Lever S's storage table lists `var re = /x/u` → `externref` (dynamic
  home), refused `regexp-constructor-unsupported` on standalone.

An admission here would therefore:
- duplicate R's construction arm before #7154 lands;
- and pre-empt S's binding-kind design.
Both are the R/S lane's to land. It would also move no unit (above).

## Path to the 66 files at zero legacy units

1. Symbol values on the standalone IR: `SKIP_SYMBOL`, and `Symbol.keyFor` /
   `.description` in `formatPropertyName`.
2. #7106 R1 (#7154), then the R/S RegExp-valued script var: this statement
   plus `ASCII_IDENTIFIER.test`. R4 covers `.replace(/'/g, …)`.
3. Object-literal module storage with methods (`TemporalHelpers`; lever S /
   #7128).
4. Dynamic-carrier template substitution, then #7301's default-parameter
   arm.
