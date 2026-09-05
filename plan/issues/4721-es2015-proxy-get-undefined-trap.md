---
id: 4721
title: "ES2015 Proxy get with undefined/null trap forwards the receiver"
status: done
completed: 2026-08-25
created: 2026-08-25
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: Proxy
goal: es2015-test262
related: [3127, 1355, 2616, 2618]
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/object-runtime.ts::ensureObjectRuntime
assignee: ttraenkler/codex
---

# #4721 — ES2015 Proxy `get` trap-absent receiver forwarding

## Scope

Fix the bounded ES2015 Test262 residual
`test/built-ins/Proxy/get/trap-is-undefined-receiver.js`, where a `get: null`
handler and a handler with no `get` property must forward the original
receiver through the target's `[[Get]]`. Keep nearby controls limited to the
trap distinctions and call shape needed to prove the fix: missing,
`undefined`, `null`, non-callable, nested Proxy forwarding, and explicit trap
receiver forwarding.

## Live baseline (upstream/main `483b862ed5`, 2026-08-25)

Runs used `scripts/harness-flip-probe.ts`, which executes the authentic
assembled Test262 harness and first proves a must-pass and must-fail control.
The scoped eight-file matrix was run independently for each compiler lane;
counts include all eight rows and therefore have no silent-empty result.

| lane | controls | pass | fail | total |
| --- | --- | ---: | ---: | ---: |
| host | must-pass=pass, must-fail=fail | 2 | 6 | 8 |
| standalone | must-pass=pass, must-fail=fail | 1 | 7 | 8 |

The exact residual fails in both lanes:

- host: `TypeError: Cannot access property on null or undefined` at the first
  `assert.sameValue(p.attr, p)`.
- standalone: `Expected SameValue(«undefined», «null») ...` at the same
  assertion.

The explicit trap controls pass on host and standalone:
`get/call-parameters.js` is 2/2, proving the trap call path and explicit
receiver argument are present on both lanes. The non-callable control passes on
host but fails standalone (no TypeError), so the implementation must preserve
the existing host behavior while making standalone `GetMethod` distinguish
missing/`undefined`/`null` from a present non-callable value.

Full baseline rows are recorded in the local probe artifacts
`.tmp/issue-4721-baseline-host.jsonl` and
`.tmp/issue-4721-baseline-standalone.jsonl` (ignored and not committed).

## Diagnosis

Two independent representation gaps caused the exact residual:

* A top-level binding initialized by `new Proxy(...)` retained the target's
  inferred structural Wasm type. A guarded cast therefore converted the Proxy
  carrier to null before the Proxy MOP ran. `moduleInitForcesExternref` now
  keeps direct Proxy and `Proxy.revocable` bindings as externref.
* Standalone `$Proxy` is intentionally not a `$Object` subtype. Consequently,
  `Object.create(new Proxy(target, {}))` discarded the Proxy prototype before
  the ordinary `[[Get]]` walk. The native prototype helper recursively unwraps
  only proxies whose stored `get` trap is absent/undefined/null; the resulting
  `$Object` target remains in the ordinary chain and receives the fresh object
  as `this`. Proxies with a present trap are not silently bypassed.

Finally, standalone `__proxy_get_dispatch` previously invoked every present
`get` value as a closure. Its trap-present arm now applies `GetMethod`'s
callability check and throws `TypeError` for a non-callable value. Missing,
`undefined`, and `null` are normalized to the existing null trap sentinel and
continue through the target-forwarding path.

## Implementation plan

1. Trace `__reflect_get_receiver`/host Proxy bridge forwarding and the
   standalone `__proxy_get_dispatch` path. (Complete; the host path was
   already receiver-aware, while standalone prototype storage and the
   top-level binding cast were the missing pieces.)
2. Make the narrowest shared change that passes the exact receiver test and
   keeps a present non-callable trap throwing `TypeError`; do not broaden to
   other Proxy MOPs or descriptor/array infrastructure. (Complete.)
3. Add focused regression coverage under `tests/issue-4721.test.ts` for host
   and standalone compilation, including missing/`undefined`/`null`,
   non-callable, nested receiver forwarding, and explicit trap receiver
   forwarding. (Complete.)
4. Re-run exact Test262 controls on both lanes, then TS5, TS7, typecheck,
   lint, format, and prepush checks. Keep compiler source changes at or below
   180 LOC.

## Test Results

Focused Test262 harness matrix after the source change (each run had the
must-pass/must-fail structural controls):

| lane | exact + minimal controls | pass | fail |
| --- | --- | ---: | ---: |
| host | receiver, undefined, no-property, non-callable, call-parameters | 5 | 0 |
| standalone | receiver, undefined, no-property, non-callable, call-parameters | 5 | 0 |

Final harness outputs are `.tmp/min4721-host-final.jsonl` and
`.tmp/min4721-standalone-final.jsonl` (ignored local artifacts). The focused
Vitest regression `tests/issue-4721.test.ts` also passes all 6 cases (3 cases
per lane).

The three nested target-is-Proxy files in the broader eight-row probe remain
outside this bounded change: `trap-is-undefined-target-is-proxy.js`,
`trap-is-missing-target-is-proxy.js`, and `trap-is-null-target-is-proxy.js`.
They continue to expose pre-existing array/host-object prototype-carrier gaps
in both lanes; the exact receiver and all minimal acceptance controls pass.

The source delta is 131 changed lines across the four changed source files,
below the 180-line cap. Focused regression coverage is in
`tests/issue-4721.test.ts`.

Validation completed before integration: `typecheck:ts5` and
`typecheck:ts7` both exit 0; the focused Biome lint and Prettier checks pass;
the repository-wide `pnpm run lint` exits 0 with the repository's existing
1,672-diagnostic suppression warning; `pnpm run format:check` exits 0; and
the oracle/coercion ratchets both pass. The #3765 numeric-local parity lane
passes all 18 tests. The pre-push hook will repeat its typecheck, lint,
format, ratchet, parity, and integrity gates after the final upstream merge.
