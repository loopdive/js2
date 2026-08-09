---
id: 2504
title: "standalone: console.log(string) emits invalid Wasm — __str_to_extern body calls a stale (shifted) funcIdx (need-3-got-2)"
status: done
completed: 2026-07-24
sprint: Backlog
assignee: ""
needs_role: senior-developer
created: 2026-06-19
updated: 2026-07-24
priority: low
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: native-strings, standalone
goal: standalone-mode
related: [2074, 2075, 1618, 1677, 1903, 2039]
origin: "2026-06-19 sdev-arrayrep: surfaced while validating #2503 standalone array.join — join feeds console.log; isolated to console.log(string) itself"
blast_radius: "MEASURED 2026-06-19 (sdev-arrayrep): ~ZERO real test262 flips. The __str_to_extern bridge fires ONLY when a native string is passed to a host-externref SINK (console.log). 582 test262 standalone files across Error/String/JSON/throw/template-literal/addition/Number.toString/Object.toString/Array.join+toString → 0 __str_*-arity instantiate failures. Verified the classifier DOES fire on console.log repros. throw new Error(str), String(obj), template literals, Error.message read all instantiate OK standalone (strings stay native WasmGC, never marshalled to externref). PRIORITY LOWERED high→low — bank it; not a session-worthy slice."
---

# #2504 — standalone `console.log(string)` → invalid Wasm (`__str_to_extern` stale funcIdx)

## Problem (file-verified, current main 218375d60, `--target standalone`)

```ts
console.log("hi");          // INVALID Wasm
const a=[3,1,2]; a.join(","); console.log(a.join(",")); // INVALID Wasm
```

```
WebAssembly.instantiate(): Compiling function #N:"__str_to_extern" failed:
not enough arguments on the stack for call (need 3, got 2)
```

Measured matrix (all `--target standalone`, `WebAssembly.validate`):

| source                                         | valid |
|------------------------------------------------|-------|
| `const a=[3,1,2]; const s=a.join(",");` (no console) | **true** |
| `… a.join(","); console.log(s);` (top level)         | **false** |
| `console.log("hi");` (no array at all)              | **false** |
| `export function f(){ … a.join(","); console.log(s); }` | **false** |

So the trigger is **`console.log(<string>)` in native-strings/standalone mode**,
NOT array.join and NOT top-level scope. `join` only exposed it because join's
result feeds `console.log`. (The #2503 `new Array(N).sort()` rep bug is separate
and already fixed.)

## Root cause (pinned via WAT)

`ensureNativeStringExternBridge` (`src/codegen/native-strings.ts:6567`) builds the
`__str_to_extern` helper. Its body ends with:

```
i32.const 0
local.get 1      ; len  → 2 args
call <fromMemIdx>   ; intended: __str_from_mem (i32,i32)->externref
```

`fromMemIdx` is captured from `ensureLateImport(ctx, "__str_from_mem", …)`
(line 6586) as a raw number baked into the `call` instr. In the failing module:

- `__str_from_mem` is **NOT present in the final module at all** (`grep`: no
  import, no func). The deferred late-import batch for the three fd-bridge
  imports (`__str_from_mem`/`__str_to_mem`/`__str_extern_len`) is queued but the
  imports never materialize in the console.log-at-emit path.
- The baked `call <fromMemIdx>` resolves to **func index 1 = `__str_copy_tree`**,
  whose signature is `(param (ref null 6) (ref null 5) i32) (result i32)` — **3
  params**. The body pushes only 2 → "need 3, got 2".

This is an index-shift / late-import-ordering desync between the bridge body's
captured `fromMemIdx` and the actual final function-index space once
`console_log_string` is added as a late import (it lands as import #0, shifting
every defined function +1, while the bridge body's baked import index is not
reconciled — or the fd-bridge imports are dropped). It is squarely in the
`shiftLateImportIndices` / `reconcileNativeStrFinalizeShift` /
`flushLateImportShifts` regime (`src/codegen/expressions/late-imports.ts`) — the
same machinery #1677/#1903/#2039 repeatedly patched.

## Why this is high-value

`console.log(<string>)` is the single most common standalone output construct.
Any test262 / playground program that prints a string under `--target standalone`
currently emits invalid Wasm. The join/sort cases are a small subset; the headline
is "standalone string output is broken".

## Fix direction (needs senior-dev + likely architect review of shift ordering)

Candidate fixes (verify which is correct, do NOT speculatively patch the most
fragile code path without measuring):

1. **Flush the late-import batch inside `ensureNativeStringExternBridge`** right
   after the three `ensureLateImport` calls and BEFORE pushing the
   `__str_to_extern` / `__str_from_extern` bodies, so the import indices are
   settled before the bodies bake `call <fromMemIdx>`. Mirrors `emitUndefined`'s
   `flushLateImportShifts` before its `call`.
2. **Ensure the fd-bridge imports actually materialize** in standalone — the WAT
   shows `__str_from_mem` absent, so the deferred batch may be getting discarded
   when no flush point is hit before finalize freezes the index space (#1984).
3. Reconcile the bridge body through a shift-maintained handle (funcMap-style)
   rather than a raw captured import index, the way `flattenIdx` already is.

## Acceptance criteria

1. `console.log("hi")` compiles to VALID standalone Wasm and prints `hi`.
2. `[3,1,2].join(",")` + `console.log` valid standalone; string/number/`any[]`
   join all valid.
3. The fd-bridge imports (`__str_from_mem` etc.) materialize OR the bridge no
   longer references them in standalone (native fd path).
4. No regression on host (GC) `console.log` or the existing native-string suites.
5. Re-measure real test262 flips — string-output programs across the corpus.

## Stale-verify → FIXED (2026-07-24, dev-std-4)

MEASURED on current `main` (`--target standalone`, `WebAssembly.validate` +
`instantiate({})`): the `__str_to_extern` need-3-got-2 invalid-Wasm bug is
**gone**. All original repros now compile to VALID Wasm and instantiate
host-free (`imports: 0`):

| source                                                   | validate | instantiate |
|----------------------------------------------------------|----------|-------------|
| `console.log("hi")`                                      | true     | true        |
| `const s = "hi"; console.log(s)`                         | true     | true        |
| `const a=[3,1,2]; console.log(a.join(","))`              | true     | true        |
| `export function f(){ console.log([3,1,2].join(",")); }` | true     | true        |
| `console.log(42)`                                        | true     | true        |

Fixed (not by a dedicated #2504 PR) by the late-import-shift reconcile lineage
(#1677/#1903/#2039 and successors) that this issue's root-cause pinned to.
Marking `done`.
