---
id: 3261
title: "standalone: __host_loose_eq / __extern_toString / __date_format leak env::* imports (missing native-helper set membership)"
status: done
completed: 2026-07-17
sprint: current
created: 2026-07-14
priority: medium
feasibility: medium
model: opus
horizon: m
task_type: fix
area: codegen
language_feature: standalone-completeness
goal: standalone-parity
related: [2903, 2860, 3107, 1471, 1470]
---

# #3261 — standalone env::* leaks: `__host_loose_eq` / `__extern_toString` / `__date_format`

**Source:** surfaced by the #3107 `as Instr` cast-elimination non-null-assertion audit
(2026-07-14). Tangential to #3107 (NOT a cast bug) — the audit traced the `?? ensureLateImport(...)`
fallbacks that back several `funcIdx` non-null assertions and noticed three helpers register a
**host** import with no standalone (`--target standalone` / `noJsHost`) native arm.

## Problem

Three runtime helpers are **not members of the standalone native-helper set**
(`UNION_NATIVE_HELPER_NAMES` and siblings). When a standalone build reaches the code paths that
call them, the compiler emits an `env::*` host import (or, for `__extern_toString`, queues a loud
refusal) — violating the dual-mode contract that standalone mode is pure Wasm with **no JS host
imports** (CLAUDE.md "Dual-mode: JS host optional"; the historical host-independence work
#1470/#1471/#1180 closed the same class for other helpers).

| Helper               | Reached from (host lane)                                   | Standalone symptom                          |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `__host_loose_eq`    | `binary-ops.ts` loose-equality (`==` / `!=`) coercion arm  | leaks `env::__host_loose_eq`                |
| `__extern_toString`  | `binary-ops.ts` any→string coercion (string concat, etc.)  | loud refusal / `env::__extern_toString`     |
| `__date_format`      | `builtins.ts` Date formatting (`toString`/`toLocale*`)     | leaks `env::__date_format`                  |

Contrast: the strict-equality sibling `__host_eq` DOES have a native arm (see
`any-helpers.ts:~545` and `array-methods.ts:~779`, which internalise both externrefs and compare
natively). The pattern to follow already exists — these three just never got the same treatment.

`==` coercion, string coercion, and Date stringification are common operations, so real
test262 rows in standalone mode are likely affected (impact not yet measured — see acceptance).

## Fix direction

For each helper, add a Wasm-native arm gated on `noJsHost` (mirror the existing `__host_eq`
native replacement in `any-helpers.ts`), OR route the call through an existing native primitive:
- `__host_loose_eq` → the abstract-equality algorithm over the value-rep tags (much of this
  already exists for `__any_eq`; #1134 landed strict/loose cross-tag coercion — reuse it).
- `__extern_toString` → the native ToString path (native-strings + `__box`/tag dispatch).
- `__date_format` → native Date-to-string (overlaps the standalone Date cluster; coordinate
  with #3174 and the Date-native work).

Do NOT add a new host import without a standalone fallback. Behaviour-preserving on the host lane
(guard the native arm behind `noJsHost`).

## Acceptance criteria

1. Measure first: compile representative standalone cases (`x == y` mixed-type, `"" + obj`,
   `String(new Date())` / `new Date().toString()`) with `--target standalone` and confirm each
   currently emits an `env::*` import for the named helper (the repro).
2. After the fix, none of the three helpers appears as an `env::*` import in a standalone build of
   those cases; the standalone output runs and matches the host-lane result.
3. Add a permanent test (`tests/issue-3261.test.ts`) covering the three standalone paths (the
   #2093 probe-coverage gate requires it).
4. No test262 regression; host-lane byte-identity for the affected functions (the native arm is
   `noJsHost`-gated, so the host lane must be untouched).

## Notes

- Sibling issue **#2903** (`ready`, `model: fable`) covers a *different* host-backed leak family
  (`env.__make_callback` for Promise.then/.catch and Iterator helpers) — keep them separate.
- Feeds the standalone-parity umbrella **#2860**.
- **Tier: `model: opus` / `feasibility: medium`.** Unlike its #2903 sibling, the native
  primitives this needs already exist — `__any_eq` (native loose-equality, #1134) and
  `__any_to_string` (native ToString, #1470). So `__host_loose_eq` and `__extern_toString`
  are mostly a *routing* job: point the remaining standalone arms (e.g. the boolean==string
  arm at `binary-ops.ts:1030`, already flagged `(#2073)` at :1046) at the existing native
  helper, `noJsHost`-gated, byte-identity-guarded on the host lane. That's Opus-appropriate
  refactor work, not novel reasoning.
- **Scope carve-out:** `__date_format` (native Date-to-string) is the one genuinely harder
  sub-part and overlaps the standalone Date cluster — do it under / alongside **#3174**
  (Date-native) rather than block this issue on it. #3261's core deliverable is the two
  routing fixes (loose-eq + extern-toString).

## Resolution (2026-07-17, opus-c) — verified already host-free; locked with a regression guard

**Acceptance criterion #1 (measure first) does NOT reproduce on current main
for the two core helpers.** A `WebAssembly.Module.imports` probe over ~30 varied
`target: "standalone"` programs — covering every arm the issue names
(any==any, str/num/bool loose-eq, concrete string⇄primitive, wrapper objects,
`"" + obj`, `String(any)`, template literals, `a.join(",")`) — shows **zero**
`env::__host_loose_eq` and **zero** `env::__extern_toString` imports. Each module
instantiates against an **empty** import object `{}` and returns the correct,
JS-parity result. The identical programs on the gc-host lane still (correctly)
import `env::__host_loose_eq` / `env::__extern_to_string_default`, confirming the
probe is valid and the standalone lane is genuinely host-free here.

The behavioral gaps were closed by the intervening native standalone work,
*before* this issue was picked up:

- `__host_loose_eq` → the native IsLooselyEqual tail: the two-`any`-externref arm
  routes through `emitAnyEqFromExternTemps` → `__any_eq` (#2081 / #1917), and the
  concrete string⇄number / string⇄boolean arm lowers to the native
  `__str_to_number` scanner + `f64.eq` under `noJsHost` (`binary-ops.ts` #2073).
- `__extern_toString` → its native `registerNative` registration in
  `ensureObjectRuntime` (`object-runtime.ts`), reached by the native ToString
  cascade in `coercion-engine.ts` (`emitToString`) for the dynamic-externref arm.

**No codegen change was needed** — adding a `noJsHost` guard to the residual
un-reached arms (concretely-typed wrapper-object equality, the
`eitherIsString`-loose typed-dispatch arm) would be dead code that the any-
dispatch / native blocks already shadow, and risks a host-lane byte change for
no benefit. Per the issue's own "byte-identity host lane" guidance the honest
outcome is: verify + lock, not speculative routing.

**Delivered:** `tests/issue-3261.test.ts` (the permanent guard required by the
#2093 probe-coverage gate) — asserts the representative equality + ToString
standalone programs emit no `env::*` host imports, instantiate against `{}`, and
produce the correct result (ToString correctness checked in-wasm via a native
`===` compare since a standalone string export is an opaque `ref $AnyString`).

`__date_format` remains carved out to **#3174** (Date-native), unchanged.
