---
id: 7073
title: "issue-tests wave 15 (grep/other): re-pin 20 root suites whose assertions went stale by design while the detector was blind"
status: done
sprint: Backlog
assignee: "ttraenkler/wave15-grep-other-sentinels"
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: test-maintenance
area: tests
language_feature: n/a
goal: ci-hardening
related: [7014, 7072, 7074, 7075, 7076, 7077]
requested_by: ttraenkler/wave15-grep-other-sentinels
---

# #7073 — wave 15 stale-test re-pins (grep / other slice)

Follow-up of #7014. Each suite below was red on upstream/main e8699e30ee
because its assertion described a state that changed ON PURPOSE; every edit
cites the commit/issue that changed it in a comment, and no assertion was
weakened to admit a wrong value — where the old pin recorded a spec-WRONG
answer, the new one asserts the spec answer (checked under node).

| file | why stale | now asserts |
|---|---|---|
| emit-encodeinstr-failloud | `br_table` got a payload + encoding (#2952 s4, 4b1f8a402a) | the full `0x0e vec(labelidx) labelidx` bytes |
| es5-standalone-array-nonindex-keys | `a[2^32-2] = 1` no longer traps (sparse index writes) | `length === 2^32-1` (§10.4.2.1), both lanes |
| issue-1058-multifile-… | the dynamic-dispatch miss it pinned now reaches the callback | `42` and still no illegal-cast trap |
| issue-1500 | `async function` exports return Promises (they completed synchronously when pinned; one pin passed vacuously on a truthy Promise) | awaited values; missing fetch is a rejection |
| issue-1501 | import descriptors carry `paramCount` (#4150, a41115bc78) | the descriptor incl. `paramCount: 0` |
| issue-1536 | Error names come from a shared string global, not inline code units; `--target wasi` imports `wasi_snapshot_preview1` | caught `e.name === "<Ctor>"`, no `env` import, WASI no-op stub |
| issue-1644 | `function asAny(x: bigint): any { return x; }` is return-narrowed to i64 and inlined, so no box is emitted | a two-arm `any` return keeps the externref carrier, `$BigInt` present |
| issue-1751 | WIT annotation renamed "Core provider import" (dbccc693f6) | the new annotation |
| issue-1778 | headline call wraps over lines with an IR caption (fa1e5df779); the standalone report is CI-refreshed every merge (exact 4,368/43,106 snapshot) | argument-shape regexes; coherent summary invariants |
| issue-1933 | `legacyRegExpState` became a required field (dbccc693f6) | `name?:` or `name:` |
| issue-2098 | trap-unknowns header names the kinds (#4141, c6c42ce7d0) | `…: 2 (compile_timeout 2) ===` |
| issue-2998 | the object-LHS `instanceof` proto walk is native now (the deferred host leak closed) | no `__instanceof_check`, answers `1` |
| issue-3994 | the pre-pass reads `ctx.oracle` + indexed-write maps | an inert oracle in the hand-built context |
| issue-6706 | JS-host Test262 retired; job parked with `if: false` (ae7991db21) | the parked condition |
| report-standalone-category-edition-scope | Temporal is ES2026 since #5173 | every visible category carries a published edition |
| typed-export-signatures | host modules import `string_constants`; `b?: number` rides externref (undefined ≠ NaN) | `buildImports`; required param + result stay f64 |
| issue-1355d | the pins ran trap results that break §10.5 proxy invariants (node throws for all three) | legal traps that exercise the same forwarding |
| issue-2984 | "KNOWN GAP" pinned a non-writable write LANDING; the store path now honours `writable:false` (strict module → TypeError) | TypeError, `WeakRef.length` stays 1 |
| issue-4165 | same strict-mode write to a non-writable `name` now throws at module init | the throw is caught; the pinned properties unchanged |
| issue-3119 | non-callable `@@iterator` now throws the §7.4.3 TypeError instead of degrading | the TypeError |

## Regression proof (the re-pinned suites)

`tests/emit-encodeinstr-failloud.test.ts`, `tests/es5-standalone-array-nonindex-keys.test.ts`,
`tests/issue-1058-multifile-generic-callback-registration.test.ts`, `tests/issue-1355d.test.ts`,
`tests/issue-1500.test.ts`, `tests/issue-1501.test.ts`, `tests/issue-1536.test.ts`,
`tests/issue-1644.test.ts`, `tests/issue-1751.test.ts`, `tests/issue-1778.test.ts`,
`tests/issue-1933.test.ts`, `tests/issue-2098.test.ts`, `tests/issue-2984-ctor-carrier-own-props.test.ts`,
`tests/issue-2998.test.ts`, `tests/issue-3119.test.ts`, `tests/issue-3994.test.ts`,
`tests/issue-4165-bfn-name-writable-gate.test.ts`, `tests/issue-6706-native-first-lane-providers.test.ts`,
`tests/report-standalone-category-edition-scope.test.ts`, `tests/typed-export-signatures.test.ts`.
