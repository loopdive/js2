---
id: 6871
title: "An interface extending an unresolvable/any base lowers to a closed struct: pretty-format `format(x, {maxDepth: 3})` gets options NULL — jest expectationResultFactory"
status: ready
sprint: Backlog
created: 2026-10-06
updated: 2026-10-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: npm-library-support
requested_by: ttraenkler/wave11-jest
related: [4394, 6867, 2542]
---

# #6871 — closed struct for an interface whose base is `Omit<any, K>`

## Problem

After #6867, jest `expectationResultFactory.test.ts` still fails 3/7 in Wasm
(measured 2026-10-06). Two of them throw
`TypeError: Cannot access property on null or undefined at 436:7` inside
pretty-format's `validateOptions` (`options.theme`), reached from
`prettyFormat(error, {maxDepth: 3})`.

pretty-format declares

```ts
import type {SnapshotFormat} from '@jest/schemas';
export interface PrettyFormatOptions extends Omit<SnapshotFormat, 'compareKeys'> {
  compareKeys?: CompareKeys;
  plugins?: Plugins;
}
```

`@jest/schemas` does not resolve in the harness checkout, so `SnapshotFormat`
is the error type and `Omit<…>` contributes only index signatures. The
interface registers a closed struct with just `compareKeys` and `plugins`.
The literal `{maxDepth: 3}` writes a key that is not a field, so the #4394
expected-struct diversion declines; the literal becomes its own struct, is
passed through an externref optional parameter, and `format`'s guarded cast to
the closed struct yields null. Reduction: `.tmp`-style two-file fixture with
the interface above and `format(undefined, { maxDepth: 3 })` reading
`options.theme`.

The third failure (`toMatchSnapshot` printing `[object Object]` for the
returned struct) is the snapshot shim's formatting of a compiled struct and is
tracked here as an observation only.

## Implementation Plan

1. In struct registration (`collectInterface`,
   `src/codegen/declarations/struct-type-registration.ts`, and
   `ensureStructForType`), detect a type whose base list includes an
   error/`any` type or that carries a string index signature contributed by
   such a base (`Omit<any, K>`), and do NOT register a closed struct — lower it
   to externref (`$Object`), as #2542 already does for pure index-signature
   types.
2. Alternatively (narrower): let #4394's `tryCompileObjectLiteralAsExpectedStruct`
   decline AND let the call boundary pass an open `$Object` when the expected
   struct's TS type has an index signature.
3. Regression test with an unresolvable type import (untyped dependency is not
   possible here: the trigger is the interface's `extends`), failing on parent;
   control: an interface with a resolvable base keeps its struct.
4. Re-measure jest (`expectationResultFactory` "returns the result if failed",
   "… error.stack not as a string").
