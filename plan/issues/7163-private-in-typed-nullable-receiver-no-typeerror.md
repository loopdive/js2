---
id: 7163
title: "Native-first and standalone: `#x in o` with o typed `C | null` returns false for null instead of throwing TypeError"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-31
completed: 2026-10-31
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
parent: 6979
related: [7150, 7162]
---

# #7163 — the #7150 guard never runs on a typed nullable receiver

Found by the fresh-context review of PR #6915 (#7150, finding 4). Pre-existing
on `origin/main`, every lane:

```js
class C { #v = 1; static has(o: C | null) { return #v in o; } }
try { console.log(C.has(null)); } catch (e) { console.log(e.name); }
// node: TypeError     js2: false
```

## Cause (as diagnosed; verify before fixing)

With a static type of `C | null` the receiver is lowered as `ref null $C`,
not externref, so the externref copy the #7150 guard tests
(`src/codegen/binary-ops-in.ts`, `externCopy`) stays undefined and the guard is
skipped; the brand test on null yields `false`.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce with `C | null`, `C | undefined` and `C | null | undefined`
   receivers on gc native-first and standalone.
2. In the typed-receiver arm, when the static type admits `null`/`undefined`
   (ask `ctx.oracle`), emit a `ref.is_null` check before the brand test that
   throws the same TypeError (`buildThrowJsErrorInstrs`, message text as in
   #7150). Receivers whose type excludes nullish stay untouched (byte-identical).
3. Tests: `tests/equivalence/issue-7163-private-in-typed-nullable.test.ts` with the three
   receivers on gc native-first and standalone vs node.

Acceptance: TypeError on null/undefined for nullable typed receivers; non-null
typed receivers byte-identical; host-assisted gc bytes unchanged; equivalence
gate no new regressions.

## Resolution (2026-10-31)

Cause confirmed. `C | null` / `C | undefined` (and `typeof C | null`) lower as a
nullable struct ref; `C | null | undefined` already lowered as externref and
threw correctly. New `emitTypedNullablePrivateInGuard` in
`src/codegen/binary-ops-in.ts` runs on the host-free lanes when the receiver
compiled to `ref_null` and `ctx.oracle.nullabilityOf` admits null/undefined:
`ref.is_null` → the #7150 TypeError (same message constant). Covers field,
method, accessor and static private names. A/B (sha256 of the binary, base =
`HEAD:src/codegen/binary-ops-in.ts`): non-nullable typed receivers, `this`,
`any`, `C | null | undefined`, subclass, and the #7150/#7162 test corpora are
byte-identical on gc, standalone and wasi; only the nullable-typed probe
changed.
