---
id: 7041
title: "tests: stale issue-test pins in the #7014 traps/compile-error slice — binaryen 132 reader features, and refusals the compiler has since lifted by design"
status: done
sprint: Backlog
assignee: "ttraenkler/wave15-traps-ce"
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: test
area: tests
language_feature: n/a
goal: ci-hardening
related: [7014, 7040, 7051, 1744, 1761, 1973, 1868, 2046, 5195, 6651]
requested_by: ttraenkler/wave15-traps-ce
---

# #7041 — stale pins in the #7014 traps/CE slice

Part of the [#7014](7014-issue-tests-detector-red-since-july.md) backlog: the
`issue-tests` detector was blind from July to 2026-10-15, and the slice
"Wasm traps + compile errors" (44 files) is triaged here and in #7040 / #7051.
This issue holds the files whose failure is the TEST being out of date — each
change cites the commit that changed the behaviour, and none weakens an
assertion to accept a wrong value.

## Root causes and fixes

| File | Red since | Cause | Fix |
| --- | --- | --- | --- |
| `issue-1744`, `issue-1761`, `issue-1973` | 11c1ea8307 (Binaryen 132) | `binaryen.readBinary(bytes)` now parses with the MVP feature set and rejects a valid WasmGC module ("distinct rec groups would be identical … use --enable-gc"). The module is fine (V8 accepts it); the READER was misconfigured. | New `tests/helpers/binaryen-read.ts` passes `Features.All` (binaryen.js's optional 2nd `readBinary` arg). |
| `issue-1868` (3 tests) | 5d028548eb | The linear backend lowers `String.prototype.repeat` natively now, so the "must refuse" rows compile. | Moved to a FORMERLY_UNSUPPORTED table asserting valid Wasm + the JS answer (8, 8, 0); `replace` stays a refusal row. |
| `issue-2046` (2 tests) | dbccc693f6 | Standalone Reflect uses the native-first provider (`__reflect_set_receiver`, native `Reflect.apply`), so the compile-time refusals are gone by design. | Assert the semantics the refusals guarded: receiver write (111), accessor `this` = receiver (11), `Reflect.apply` result (5). |
| `issue-5195` (1 test) | — (the leak closed) | `constructor-can-be-generator.js` was pinned as a standalone `__create_generator` leak "owned elsewhere"; it now compiles host-free and passes. The table's contract says the row then moves to the ordinary pass pin. | `STANDALONE_LEAK_OWNED_ELSEWHERE` is empty. |
| `issue-6651-sc1` (2 tests) | 22c5668c0b | Rest-parameter generators lower natively in host-free lanes; the pins said a lane lifting the bail would trip them. | Assert host-free compile AND the test262 row's own answers (`probeParam`/`probeBody` both `'inside'`). |

Both other slice files touched by this wave (`issue-3214`'s overload-set pin,
admitted by #5300 41e4840f7d) travel with their src fix in #7040.

## Measured

On upstream main 0727e2985b, one file at a time:

| File | before (fail/total) | after |
| --- | --- | --- |
| issue-1744 | 3/4 | 0/4 |
| issue-1761 | 9/9 | 0/9 |
| issue-1973 | 1/3 | 0/3 |
| issue-1868 | 3/7 | 0/7 |
| issue-2046 | 2/35 | 0/36 |
| issue-5195-es2015-class-r2 | 1/76 | 0/76 |
| issue-6651-sc1-param-scope-eval-var | 2/16 | 0/16 |

Not touched although it shares the binaryen cause: `issue-2967-engine-convergence`
(5 of its 6 red tests are the reader; the 6th is a real `illegal cast`, see
#7040's residuals — touching the file would trip fix-on-touch), and the
out-of-slice `issue-2856-async-delay-ir` / `issue-4590-bench-loop-prepared-cutover`,
which use the same bare `readBinary` and can adopt the helper.
