---
id: 7376
title: "Harness assembly: emit the runtime shim's print / $262 only where the unit names them"
status: blocked
sprint: current
created: 2026-11-19
updated: 2026-11-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: test262, ir
goal: ir-full-coverage
depends_on: []
related: [7354, 3418, 4626, 3451, 3461]
---

# #7376 — runtime shim on demand

## Problem

`scripts/test262-fyi-runtime.js` defines exactly two top-level bindings,
`var print` and `var $262`, and every single-unit test262 assembly prepends
both. On the Prepared whole-program path (#7354) the shim is a wall of its
own: shim + `var x = 1;` refuses at shim line 4 with "module-level closure
binding 'print' not in module-init Slice 2 scope". The ordinary standalone
pipeline already drops the unused shim before codegen
(`src/deadcode-elide.ts`, #3418); the Prepared path does not.

Measured by lane S14 on main `89e4748241`: of 8,717 positive ES5 files, 21
need `$262` (20 name it, 1 via the `detachArrayBuffer.js` include) and 17 need
`print` (async flag, `doneprintHandle.js`); 8,678 need neither. Over all
editions 47,185 of 53,575 files need neither.

The shim is not the first Prepared stop today (`assert.js:20`, `dyn.typeof`,
comes first), so this removes a wall that sits behind the current one.

## Implementation Plan

- **Module.** `tests/test262-original-harness.ts` only; no `src/` change.
  `harnessSourceParts(meta, async, body?)` gains an optional third argument.
  With it, the runtime part keeps a top-level `var NAME` statement only if
  `NAME` occurs as a token in the rest of the unit (includes, `assert.js`,
  `sta.js`, the iterator-binding preamble and the body), closed to a fixpoint
  over the statements kept. An elided statement leaves its newlines, so every
  harness line number and `bodyLineOffset` are unchanged. The shim stays one
  file.
- **Callers.** `assembleVariant` (the single-unit assembly behind
  `assembleOriginalHarness`, used by the ordinary and the Prepared pipelines)
  passes the body. The native and linked split assemblies and
  `resolveStrictRerun` do not, so they keep the full shim and their decisions
  are unchanged.
- **Reuse.** The #4626 `$262` → `$26_` rename now edits the runtime part
  before the join instead of searching the joined prefix for the shim text,
  which the elision would have broken. `escapeRegExp` and `parseScript` are
  reused; the shim's statement ranges are parsed once and cached.
- **Text-level on purpose.** A name in a string, an `eval` text or a member
  name counts, so the kept set is a superset of the real references and an
  `eval("$262…")` still finds the shim.
- **Quality criterion.** One rule in one place, no second assembly path, no
  per-binding special case: adding a binding to the shim needs no change here.

## Acceptance

1. Ordinary standalone verdicts identical on every affected file, by a run.
2. A Prepared stop-point table before and after.
3. Tests: a body that names `$262` only inside a string or an eval text keeps
   it; a unit that names neither gets no shim binding
   (`tests/issue-7376-shim-on-demand.test.ts`).

## Results (2026-11-19, main `89e4748241`)

- **Ordinary standalone verdicts: identical.** `pnpm run test:262` with
  `TEST262_TARGET=standalone`, the ES5 path set (`TEST262_PATH_FILTER_FILE`,
  9,029 rows the runner selects) and `TEST262_REALM_CANARY=""` for both runs,
  base harness then new: 9,029 pass in each, 0 rows differ. A full-corpus
  run was not feasible on the 4-core box (the realm canary recycled a worker
  per test, about 20 tests per minute).
- **Prepared stop point (8,717 positive ES5 files, primary variant):** the
  first refusal message is identical in every file; no file stops at the
  shim. 1,021 files whose first refusal is "module binding X has no exact
  typed storage" report it at the unit's first top-level statement, which
  moves from shim line 4 to `assert.js:64`. Shim + `var x = 1;` refused at
  shim line 4 before and compiles after.

| first Prepared stop | before | after |
| --- | ---: | ---: |
| `assert.js:20` dyn.typeof has no Prepared intrinsic | 5,704 | 5,704 |
| `propertyHelper.js:132` (type error) | 902 | 902 |
| module binding without exact typed storage, at the first statement | 1,021 (shim:4) | 1,021 (assert.js:64) |
| `with` in strict mode (body) | 182 | 182 |
| other (309 groups) | 908 | 908 |
| compiles | 0 | 0 |

## Reverted, and why (2026-11-26, main `6694a8b8`)

PR #7346 was reverted (#7355). Every merge-group standalone guard failed with
237 pass→other rows, 233 of them `RangeError: Maximum call stack size
exceeded` on linked Temporal rows.

**Reproduced.** 120-row sample, standalone, Temporal provider linked
(`JS2WASM_TEST262_TEMPORAL_STANDALONE=1`): base 105 pass, head 52 pass. All 53
flips are Temporal `name.js` / `length.js` / `prop-desc.js` rows that
overflow the stack. The `TypedArray/prototype/copyWithin` rows fail on base
too, so they are not caused by this change.

**Trigger.** Keeping `$262` restores those rows and keeping `print` does not.
Any `eval` token in the unit is enough: a dead `var $262 = { e: globalThis.eval };`
restores them, while a dead `{ a: globalThis.Array, … }` does not. The shim's
`$262` mentions `eval` in `createRealm` and `evalScript`.

**Root cause: two compiler bugs, which the elision only exposes.**

1. **Overflow, without an `eval` mention.** The IR claims the harness
   `Test262Error`.
   - The cycle is: `new Test262Error` → consumer `__native_construct_1`
     → provider `__js2wasm_link_construct` → provider `__apply_closure` /
     `__call_fn_method_1` → consumer `__fn_tramp_Test262Error_cached` → … for
     ever.
   - It never ends because `this` crosses the link in a per-module
     `__current_this` global. The provider sets its own copy, the consumer
     reads its own null copy, so `this instanceof Test262Error` is always false.
   - The peer-first construct arm (`src/codegen/native-construct.ts`) sends
     consumer closures to the provider because `canonicalRuntimeTypes` makes
     ownership indistinguishable.
   - Fix direction: share the `this` cell across the link, like
     `standalone-link-error-ctor-cells.ts` (#6723 D4).
   - Minimal repro (linked, no Temporal reference needed):
     `function Test262Error(m){ if(!(this instanceof Test262Error)) return new Test262Error(m); this.message=m; } function fail(m){ throw new Test262Error(m); } function ctorOf(t){ return t.constructor; } fail("boom");`
2. **A skipped throw, with an `eval` mention.** In a linked consumer that
   mentions `eval`, `function g(m){ throw "in"; } g(false); throw "after";`
   throws "after". It throws "in" when the module is not linked or does not
   mention `eval`. Every `assert(false, …)` is skipped the same way. So on
   main, where the shim's `$262` mentions `eval`, standalone Temporal rows can
   score passes they did not earn: `verifyProperty(…, {value: "Nope"})`
   passes. With bug 1 cut out, the real verdict of e.g.
   `Temporal/PlainTime/name.js` is `Test262Error: name should be an own property`.

**Consequence for a re-land.** Re-landing this change would show these rows
going from pass to fail (or to overflow until bug 1 is fixed). That would not
be a regression in this change. It would show both linked-lane bugs above. A
safe order:
- fix bug 2, which makes the Temporal false passes visible on main by itself;
- fix bug 1;
- then re-land this change with a full standalone base-vs-head run.

## Suspended Work (2026-11-26)

- Branch `claude/7376-shim-redo` carries the reviewed change (harness
  identical to `ce53c45d`), rebuilt on main `6694a8b8`. It is not for merge
  until bugs 1 and 2 are fixed and have their own issues.
