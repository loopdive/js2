---
id: 4786
title: "ES2015 standalone WeakMap and WeakSet prototype Symbol.toStringTag"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
assignee: "ttraenkler/codex-es2015-next-bounded-fix-8"
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
es_edition: es2015
language_feature: weak-collection-prototype-tostringtag
goal: host-and-standalone
related: [2162]
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
  - tests/issue-4786-weak-collection-tostringtag.test.ts
  - plan/issues/4786-es2015-weak-collection-tostringtag.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
---

# #4786 — ES2015 standalone WeakMap and WeakSet prototype `Symbol.toStringTag`

## Scope and baseline

This issue owns the two exact maintained ES2015 Test262 rows:

```text
test/built-ins/WeakMap/prototype/Symbol.toStringTag.js
test/built-ins/WeakSet/prototype/Symbol.toStringTag.js
```

The source baseline is `upstream/main` at
`fb4efeaa5cb2a374d9b6ff87b4eca217a2ab78f1`, with Test262 submodule revision
`b363f29d3c43c626dc852744ad64a0b48a003693`. The exact baseline probe used
the assembled Test262 harness and QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, capped at two compiler
workers. Host passes both rows; standalone fails both rows at the first tag
read with `undefined` instead of the required string:

| lane | WeakMap prototype tag | WeakSet prototype tag |
| --- | --- | --- |
| host | pass | pass |
| standalone | fail (`undefined` vs `"WeakMap"`) | fail (`undefined` vs `"WeakSet"`) |

The nearby Map/Set prototype tag rows are not controls for this issue: Map is
still red on this current tip and has an independently allocated residual.

## Root cause

Standalone builtin prototypes are represented by `$NativeProto` values. Their
companion seeder currently models the glue's string-keyed method CSV, while
the native `__nproto_hasown` helper rejects all symbol keys except Function's
special `Symbol.hasInstance` arm. WeakMap and WeakSet therefore have no
companion entry for their required well-known `Symbol.toStringTag`, so a
computed read returns `undefined` and `verifyProperty` cannot observe the
required own descriptor.

## Specification basis

ECMA-262 (June 2020) §23.3.3.5,
[`%WeakMap.prototype%[@@toStringTag]`](https://tc39.es/ecma262/2020/#sec-weakmap.prototype-@@tostringtag),
requires the value `"WeakMap"` with writable `false`, enumerable `false`, and
configurable `true`. Section 23.4.3.5,
[`%WeakSet.prototype%[@@toStringTag]`](https://tc39.es/ecma262/2020/#sec-weakset.prototype-@@tostringtag),
requires the corresponding `"WeakSet"` value and attributes.

## Implementation plan

1. Extend the native-prototype glue contract with optional well-known-symbol
   tag metadata and register the WeakMap/WeakSet tags without changing their
   method closure sets or instance collection runtime.
2. Seed the tag as a companion data property with the exact non-writable,
   non-enumerable, configurable descriptor flags, and make the native-proto
   own-property path recognize the symbol by identity and consult that mutable
   companion. Existing dynamic reads and descriptors will then use the normal
   companion table, including deletion/override semantics.
3. Add focused coverage for the exact two rows and controls for values,
   descriptors, identity, and a non-tag symbol. Run exact host/standalone A/B,
   repeats/determinism, and scoped repository gates.

## Acceptance criteria

- Both exact rows pass in host and standalone, with no compile errors,
  timeouts, skips, or unrelated control losses.
- `WeakMap.prototype[Symbol.toStringTag]` and the WeakSet twin retain their
  specified own descriptors; wrong symbols and ordinary collection methods are
  unchanged.
- The standalone output remains host-free and focused TypeScript/lint/format,
  issue metadata, budget, and hook checks pass.
- The implementation stays confined to native-prototype glue/seeding and the
  issue's regression test; no changes to WeakMap/WeakSet instance insertion or
  constructor behavior are included.

## Handoff

Worktree: `/private/tmp/js2-es2015-next-bounded-fix-8`.
Branch: `codex/es2015-next-bounded-fix-8`.
The source checkpoint and exact A/B artifacts will be recorded here after the
focused implementation and current-main verification.
