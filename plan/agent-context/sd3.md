# sd3 — session handoff context (sprint 64, 2026-06-19)

Role: developer teammate, focus = standalone-conformance residuals + bounded features.

## Landed (merged)
- **#1938** — linear `number[]` f64 element storage (Part 2). Merged.
  `src/codegen-linear/{runtime,index,c-abi,simd}.ts` — f64 element slots, stride-8.
- **#2379** — route `Uint8ClampedArray` methods natively. One-line fix: added
  `"Uint8ClampedArray"` to `BUILTIN_TYPES` in `src/checker/type-mapper.ts`.
  PR #1740. (Was filed as #2376, renumbered after an ID collision with the
  date-proto-value-read #2376/PR #1733.)

## Open PR (in flight — self-merge path, will land on its own)
- **#2501** — native `[object X]` builtin tag for `Object.prototype.toString.call`.
  **PR #1742** (loopdive/js2), branch `issue-2402-object-prototype-tostring-tag`.
  - Implementation: new module-level `resolveObjectToStringTag(ctx, argExpr)` in
    `src/codegen/expressions/calls.ts` (after the builtin-names set, ~line 227)
    + an interception in the `Type.prototype.method.call` borrowed-method handler
    (right after `typeName`/`methodName`, ~line 3190) that fires for
    `typeName === "Object" && methodName === "toString"`, emitting the
    statically-known §20.1.3.6 tag via the dual-mode
    `stringConstantExternrefInstrs` helper — BEFORE the host/standalone split.
  - Fixes BOTH host (Array/Function/Date were mis-tagged `[object Object]`) and
    standalone (whole `.call(...)` form was a hard CE).
  - `tests/issue-2501.test.ts` (3 passing): host all 9 tags; standalone
    array→14 / `{}`→15 via `.length`, `env=[]` (no host-import leak). tsc clean,
    zero regressions (stash-compared the pre-existing `tostring-valueof`/
    `helpers.js` failures — identical on main).
  - Issue file `plan/issues/2501-object-prototype-tostring-object-tag.md` set
    `status: done` IN the PR (self-merge path — no post-merge flip available).
  - **Deferred phase-2:** `Symbol.toStringTag` (§20.1.3.6 step 15) needs dynamic
    `@@toStringTag` lookup → dynamic-property epic. Banks the bulk of the ~151.
  - Background CI watcher was running (job in /tmp); enqueue via GraphQL
    `enqueuePullRequest` when green, or the auto-enqueue backstop catches it.
    Cross-dev claim still held on the `issue-assignments` ref —
    `node scripts/claim-issue.mjs --complete 2402 ttraenkler/sd3` once #1742 merges.

## Handed off to other agents
- **#1344** (Generator/AsyncIterator prototype receiver TypeErrors) → **sen-1**.
  Suspended after a net-53 standalone regression: `emitBrandCheckTypeError` runs
  error-machinery side effects per-dispatch inline (+346b/generator binary).
  Lead-approved fix: lazy/shared-helper emission mirroring #2025's
  `ensureNullThisTypeError`. `## Suspended Work` in the issue file; claim released.
- **#2202** (`arguments.length` wrong for trailing-comma+spread in generator/
  class-method) → **sen-1**. Suspended: re-compiling the spread mid-call-dispatch
  corrupts the in-flight stack frame — call-dispatch arg-sequencing is #1726/#2079
  territory. (Early late-import-shift bug WAS fixed: `ensureLateImport(__box_number)`
  + `flushLateImportShifts` up front.) `## Suspended Work` written; claim released.
- **#2400** — Wasm-native `decodeURI`/`encodeURI`/`decodeURIComponent`/
  `encodeURIComponent` → **sd5**. Full spec written in the issue file, including
  the infra finding that `__str_to_utf8`/`__str_utf8_to_flat` are
  `--utf8-storage`-gated and ABSENT from default standalone → transcode must be
  inline. (Was filed #2378, renumbered after collision with sd5's range.)

## Filed (stub, unclaimed)
- **#2401** — BigInt typed arrays (`BigInt64Array`/`BigUint64Array`) genuinely
  unmodeled (NOT a `BUILTIN_TYPES` omission — needs i64-bigint-brand ValType, gated
  on the same architect decision as #1349/#1644). Stub only.

## Bug-class notes for whoever picks up object-builtins
- `BUILTIN_TYPES` (src/checker/type-mapper.ts) controls `isExternalDeclaredClass`;
  a native builtin MISSING from it routes methods to `env.<Type>_*` host imports →
  invalid Wasm GC / unsatisfiable standalone. I swept all native typed arrays —
  zero remaining omissions after #2379 (only the genuinely-unmodeled BigInt TAs,
  filed as #2401).
- The `Type.prototype.method.call` borrowed-method dispatch in calls.ts (~3180-3344)
  is gated `if (ctx.standalone && ...)` (~3239) — standalone-only. The #2501
  interception sits ABOVE that gate so it covers both modes.

## ID-collision convention (established this session)
File new issues at **#2500+** to end the number-race with parallel sessions.
