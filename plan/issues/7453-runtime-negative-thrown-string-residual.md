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

- **Kind export.** `__exn_render_kind(payload) -> i32` (`src/codegen/exn-render-kind.ts`) writes the payload's kind
  into the `__exn_render_*` buffer, or answers -1: an `$Error_struct`'s name (the name `__error_to_string` uses,
  now one shared `errorStructNameInstrs`), a nominal instance's constructor (`$__fnctor_F`, a class struct), and for
  an open `$Object` `[[Get]](o, "constructor").name` through the module's `__extern_get` (the original harness's
  `new Test262Error()` is such an object). A string, a number or null has no kind.
- **Opt-in.** Emitted only under the new `exceptionKindExport` compile option, which every test262 compile site
  sets (worker, linked provider, local runner, fixture lane, fork compiler). Without it the output is byte-identical
  to main: 68 compiles (5 sources + 12 probe scripts × gc/standalone × default/`hostBridge: "always"`) hash equal.
  With it a throwing module grows by 99–531 bytes.
- **Reader.** `readThrownValue` takes an opaque payload's kinds from the kind export of the module that rendered it
  (the consumer or a linked peer). The split at `": "` is gone.
- **Prepared artifact:** not done. It exports no tag, so a thrown value there is still unread (X2).
- **Pins.** `tests/issue-7453-thrown-value-kind.test.ts` (19 tests, standalone and gc; 5 fail on main) and two
  tests in `scripts/test262-prepared-trap-verdict.test.mjs` (fail on main).
- **Measured (real runner, 40 runtime negatives + 40 probes next to `language/statements/throw/`):**

| lane | before pass | after pass | flipped rows |
|---|---:|---:|---|
| ordinary standalone | 47 | 45 | probe `throw "TypeError: x"`, probe `toString` object (pass → fail) |
| ordinary gc (honest) | 47 | 45 | the same two probes |
| gc `TEST262_ORACLE_MODE=linked` | 46 | 45 | probe `throw "TypeError: x"` (the `toString` probe already failed) |
| Prepared (`TEST262_COMPILER_PATH=ir`) | 0 | 0 | none |

  No corpus row flips (33 → 33 on each ordinary lane). `ORACLE_VERSION` 17 → 18.
