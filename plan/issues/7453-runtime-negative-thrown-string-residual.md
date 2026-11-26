---
id: 7453
title: "test262 runner: a thrown string \"TypeError: x\" still passes a runtime negative expecting TypeError"
status: done
created: 2026-11-22
updated: 2026-11-26
completed: 2026-11-26
priority: medium
horizon: s
goal: ci-hardening
sprint: Backlog
related: [7354, 7459]
# 2026-11-26: the `exceptionKindExport` harness opt-in is one CompileOptions field, its
# CodegenOptions/context fields and one pass-through line; keeping it an opt-in is what
# keeps every production binary (JS environment and standalone) byte-identical.
loc-budget-allow:
  - src/index.ts
  - src/codegen/context/types.ts
  - src/compiler.ts
func-budget-allow:
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #7453 — test262 runner: a thrown string "TypeError: x" still passes a runtime negative expecting TypeError

## Problem

After slice X(a) (#7354) a runtime negative passes only when the thrown value's kind was read. On the ordinary standalone and gc lanes the reader splits the module's own rendered text at the first `": "`, so `throw "TypeError: x"` and an object whose `toString` returns that text still match. Closing it needs the module to export the kind itself (slice X2 in #7354's issue file).

Found on 2026-11-22 during the #7354 slices (Prepared whole-program IR path).

## Acceptance criteria

- `throw "TypeError: x"` fails a negative expecting TypeError on every lane.
- A real `TypeError` still passes.
- No test262 row flips, or `ORACLE_VERSION` is bumped.

## Result (2026-11-26, branch `claude/7453-7459-runtime-negative-verdicts`)

- **Kind export.** `__exn_render_kind(payload, slot) -> i32` (`src/codegen/exn-render-kind.ts`) writes one of
  the two kinds the reader takes from a host value into the `__exn_render_*` buffer, or answers -1: slot 0 the
  payload's `name`, slot 1 its `constructor.name`.
  - `$Error_struct`: the `name` field; the constructor is a user subclass's class (its `$userClassId` brand), else
    the builtin its `$tag` names (`Test262Error`, which shares the `Error` tag, by its name field).
  - Class instance: the class by its `__tag` brand. A structural `ref.test` matched a subclass instance as its
    parent and a same-layout sibling as the first-registered class (review finding, 2026-11-26).
  - Any other object: `[[Get]](o, "name")` and `[[Get]](o, "constructor").name` through the module's own
    `__extern_get`; without one, a `new F()` struct is named only when no other struct shares its layout.
  - A string, a number or null has no kind.
  - E.g. `function E(){}; E.prototype = Object.create(TypeError.prototype); throw new E()` reads
    `["TypeError", "E"]`; a renamed `TypeError` reads `["Foo", "TypeError"]`.
- **Leaf module.** The Error constructor names moved to `src/codegen/registry/error-names.ts` (re-exported from
  `error-types.ts`), so the kind module stays out of the import cycle. The Error `toString` helper reads `name` and
  `message` through one local helper.
- **Opt-in.** Emitted only under the new `exceptionKindExport` compile option, which every test262 compile site
  sets (worker, linked provider, local runner, fixture lane, fork compiler). Without it the output is byte-identical
  to main: 68 compiles (5 sources + 12 probe scripts × gc/standalone × default/`hostBridge: "always"`) hash equal.
  With it a throwing module grows by 99–531 bytes.
- **Reader.** `readThrownValue` asks both slots of an opaque payload: first the module that rendered it, then the
  consumer and the linked peers. It asks whether or not any module could render the payload, so a `TypeError` whose
  `toString` is the empty string still reads `["", "TypeError"]`. The split at `": "` is gone.
- **Not covered (no kind, where a host reader would find one):** a closed object-literal struct
  (`throw { name: "TypeError" }`), and the `name` of a class or `new F()` instance in a module without
  `__extern_get`. A missing kind can only fail a row, never pass one.
- **Known limits, deferred to #7447:** the Wasm reader names an instance's constructor by its brand, so it ignores an
  overwritten `constructor` property; that can only reject a row, never accept one. On the non-Prepared lanes a trap
  still counts when the expected type's name (e.g. `TypeError`) appears in its text, frame names included.
- **Prepared artifact:** not done. It exports no tag, so a thrown value there is still unread (X2).
- **Pins.** `tests/issue-7453-thrown-value-kind.test.ts`: 33 tests on standalone and gc, 26 of them fail on main
  `c3b7be667a`. They include a byte comparison of the option absent and the option `false`.
  `scripts/test262-prepared-trap-verdict.test.mjs` has two more. `scripts/lib/native-eval-boundary-observation.test.mjs`
  no longer expects a kind from a rendering. That file fails on main without a pinned test262 harness checkout, so
  this change did not cause the failure.
- **Byte identity.** With the option off, all 15 compiles of the review's comparison script hash equal on
  `6694a8b839`, on main `c3b7be667a` and on head: 3 sources, each compiled with five option sets (default,
  standalone, wasi, `hostBridge: "always"`, standalone plus `hostBridge`).
- **Measured (2026-11-26, real runner via `TEST262_PATH_FILTER_FILE`):** the 40 runtime negatives plus 40 temporary
  probes next to `language/statements/throw/`, run on main `c3b7be667a` and on head:

| lane | main pass | head pass | flipped rows |
|---|---:|---:|---|
| ordinary standalone | 47 | 45 | probe `throw "TypeError: x"`, probe `toString` object (pass → fail) |
| ordinary gc (honest) | 47 | 45 | the same two probes |
| gc `TEST262_ORACLE_MODE=linked` | 46 | 45 | probe `throw "TypeError: x"` (the `toString` probe already failed) |
| Prepared (`TEST262_COMPILER_PATH=ir`) | 0 | 0 | none |

  No corpus row flips (33 → 33 on each ordinary lane), the same result as before the review fixes.
  `ORACLE_VERSION` 17 → 18.
