---
id: 4747
title: "ES2015 StringIteratorPrototype Symbol.toStringTag"
status: done
sprint: current
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
assignee: "codex/4747-es2015-string-iterator-tag"
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: es2015
language_feature: string-iterator-prototype
goal: host-and-standalone
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-proto-tostring.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::emitIteratorPrototypeSingleton
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-proto-tostring.ts
  - tests/test262-restore-builtins.ts
  - tests/issue-4747.test.ts
---

# #4747 — ES2015 StringIteratorPrototype Symbol.toStringTag

## Scope and baseline

The authoritative source baseline is upstream/main at 9efc8e766 (2026-08-26).
The exact Test262 row is:

- test/built-ins/StringIteratorPrototype/Symbol.toStringTag.js

The row is not covered by the open namespace @@toStringTag PR (#4966) or the
open ArrayIteratorPrototype PR (#4968); those changes do not touch this exact
StringIteratorPrototype row. The existing upstream PR #4747 is merged ABI work
and is unrelated.

Fresh runTest262File evidence on the clean upstream worktree:

| lane | result |
| --- | --- |
| host | **fail** in the strict rerun: actual "Iterator", expected "String Iterator" |
| standalone | **fail**: TypeError: Cannot access property on null or undefined at the tag read |

The test obtains the iterator through Object.getPrototypeOf(''[Symbol.iterator]())
and then checks the own Symbol.toStringTag value and descriptor. Host mode
reaches a generic compiler-owned iterator prototype in the strict harness path
after `verifyProperty` destructively deletes the configurable native tag; the
in-process runner did not snapshot `%StringIteratorPrototype%` even though the
sharded worker does. The host-free path has no reified StringIterator prototype
value. A direct host compile probe confirms that the ordinary native string
iterator itself has the correct host tag; the host lane therefore needs runner
realm restoration parity while the standalone lane needs the compiler-owned
intrinsic routing fix.

## Implementation plan

1. Recognize checker-proven StringIterator values at the standalone
   Object.getPrototypeOf seam and route them to the existing identity-stable
   iterator-prototype singleton, using the "String" kind. Preserve evaluation
   side effects before returning the singleton.
2. Seed the StringIterator singleton's own Symbol.toStringTag data property
   with value "String Iterator" and descriptor flags
   { writable: false, enumerable: false, configurable: true }, sharing the
   existing intrinsic singleton materialization used by adjacent iterator kinds.
3. Extend the standalone Object.prototype.toString classifier only for the
   checker-proven StringIterator carrier, leaving host mode on its dynamic
   path and preserving ordinary arrays/iterators.
4. Snapshot `%StringIteratorPrototype%` in the in-process Test262 host-realm
   restore list so `verifyProperty`'s configurable-property probe cannot leak
   into the strict rerun; this mirrors the already-correct sharded worker.
5. Add the exact host and standalone Test262 row plus positive/negative
   identity and descriptor controls.

## Risks and non-goals

- Do not alter String iteration order, code-point handling, or next(); those
  semantics are covered by existing string iteration tests.
- Do not classify arbitrary iterator-like objects as StringIterator values.
- Keep host behavior observable and ensure the existing host lane remains a
  must-pass control after the standalone routing change.

## Acceptance criteria

- The exact Test262 row passes in both host and standalone lanes.
- The StringIterator singleton has the exact value and descriptor flags above.
- Existing array, map, set, generator, and string iteration focused tests stay
  green; no unrelated iterator kind aliases to the String tag.
- TypeScript, lint, format, issue, and scoped regression gates pass.

## Test Results

- `tests/issue-4747.test.ts`: **4/4 passed** — exact host row, exact
  standalone row, standalone identity/descriptor/tag control, and host
  native/restoration control.
- Adjacent `StringIteratorPrototype/ancestry.js`: **pass in host and
  standalone**. The separate standalone `next/*` rows still expose the
  existing string-iterator `next` limitation (`called value is not a
  function` / `value is not iterable`) and are outside this tag/prototype
  slice.
- TypeScript 7 and TypeScript 5.9 `--noEmit`: **pass**.
- Prettier check, Biome lint, issue-ID, LOC-budget, and function-budget gates:
  **pass**.

## Implementation Summary

- **What was done:** Standalone checker-proven `StringIterator` values now
  resolve through an identity-stable `%StringIteratorPrototype%` singleton;
  its own `Symbol.toStringTag` is seeded as the exact non-writable,
  non-enumerable, configurable data property. The standalone
  `Object.prototype.toString` classifier recognizes only this proven carrier.
  The in-process Test262 realm snapshot now includes the native
  `%StringIteratorPrototype%`, and restoration reapplies descriptor flags when
  a destructive configurable-property probe recreated a property with default
  attributes.
- **What worked:** Reusing the existing iterator singleton seam preserved
  argument evaluation and identity without changing string iteration. Mirroring
  the worker's host snapshot fixed the strict-rerun leak while keeping host
  classification dynamic.
- **What did not work:** The baseline host failure initially looked like a
  compiler tag mismatch; a direct native probe and the worker snapshot showed
  it was also an in-process restore gap. The implementation keeps those causes
  separate.
- **Files changed:**
  `src/codegen/array-object-proto.ts`,
  `src/codegen/expressions/call-builtin-static.ts`,
  `src/codegen/object-proto-tostring.ts`,
  `tests/test262-restore-builtins.ts`, and `tests/issue-4747.test.ts`.
