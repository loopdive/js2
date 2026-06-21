---
id: 2017
title: "assignment to a getter-only object-literal property traps 'illegal cast' instead of throwing strict-mode TypeError"
status: done
completed: 2026-06-17
assignee: sd-b
sprint: 63
created: 2026-06-10
updated: 2026-06-17
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [1092, 1932, 2024]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2017 — [[Set]] failure check missing on accessor-literal write path

## Problem

```ts
const o: any = {
  get x() {
    return 1;
  },
};
o.x = 99;
// wasm: RuntimeError: illegal cast (uncatchable)
// node: TypeError: Cannot set property x ... which has only a getter
```

## Root cause

The accessor-literal path (`src/codegen/literals.ts:258+`) defines real
host accessors, but the compiled assignment path casts/writes without the
strict-mode [[Set]] failure check (§13.15.2 → §10.1.9). Same family as
#1092 (wrong error type, done) and the class-side #2024.

## Fix direction

When the static property model says get-only, emit a throw of TypeError
instead of the struct write.

## Acceptance criteria

- Repro throws catchable TypeError; getter+setter pairs unchanged

## Dupe check

#1092 done; #1932 is accessor double-get (different). New (borderline
low/wont-fix severity — filed for completeness).

## Implementation notes (#2017, sd-b, 2026-06-17) ✓

On current main the write no longer traps "illegal cast" — it silently no-ops
(the getter keeps shadowing), so `o.x = 99; o.x` read `1` instead of throwing.
Spec (ESM is strict) requires a catchable TypeError (§13.15.2 → §10.1.9).

**Fix — the `__extern_set_strict` split (keystone).** Added a strict [[Set]]
host import that mirrors `__extern_set` but throws a CATCHABLE TypeError on the
three §10.1.9 failure cases instead of silently failing:

- getter-only accessor (real JS descriptor with `get`/no `set`, OR sidecar
  `__get_<k>` with no `__set_<k>`, OR symbol-keyed accessor-map entry);
- non-writable own data property;
- new property on a non-extensible object.

`_safeSet` gained a `strict` param; the failure sites that previously `return`ed
silently now `throw` when `strict`. For plain JS objects an explicit descriptor
pre-check (own → prototype walk) makes the throw deterministic regardless of the
bundled runtime's ambient strictness. The throw is catchable in the user's
try/catch via the existing host-import exception bridge (`lastCaughtException` +
the compiled `catch_all`).

The new import carries its own intent type (`extern_set_strict`) so the
intent-driven `resolveImport` switch routes it to the strict handler rather than
sharing `__extern_set`'s sloppy case. Codegen routes only the
accessor-detected property-assignment path
(`compilePropertyAssignmentExternSet`) to it — the path reached precisely when
an accessor descriptor was detected for the property at compile time — so
writable data properties and getter+setter pairs are unaffected. Standalone
aliases `__extern_set_strict` to the native `__extern_set` helper (no host
TypeError bridge there yet; the getter-only throw is host-mode for now).

**Files:** `src/runtime.ts` (`_safeSet` strict param + throws, by-name +
intent-switch `__extern_set_strict` handlers), `src/index.ts` (ImportIntent
union), `src/compiler/import-manifest.ts` (classify → `extern_set_strict`),
`src/codegen/object-runtime.ts` (standalone alias + helper-name set),
`src/codegen/expressions/assignment.ts` (route accessor write to strict).

**Tests:** `tests/issue-2017.test.ts` — getter-only write throws (catchable,
`instanceof TypeError`), getter survives the rejected write, getter+setter pair
still routes to the setter. Regression-checked getters-setters /
accessor-side-effects / define-property-patterns (the 3 accessor-side-effects
failures are pre-existing on main — bare host-bridge harness, unrelated).

**Family:** #1092 (wrong error type, done), #2024 (class-side get-only, done),
#1456 (private get-only, done) — this completes the object-literal side.

## Regression fix (#2017, sendev, 2026-06-18) — strict [[Set]] was over-throwing

The first cut of the strict [[Set]] pre-check over-reached and regressed 5
test262 tests (CI bucket `5e25f0dd855cf9bd`, net was +11 but blocked by the 31%
ratio gate). Root cause: the strict path threw a TypeError beyond the
getter-only accessor case it was meant for, because (a) the plain-JS pre-check
threw for **non-writable DATA properties** and **walked the prototype chain**,
and (b) the `catch` arm blanket-re-threw the engine's own strict TypeError for
any `__extern_set_strict` caller.

The bundled host runtime is an ES module (executes in strict mode), so a plain
`obj[key] = val` for a non-writable data property (`Math.E = 1`,
`Number.NaN = 1`) throws natively — and that throw was being propagated even
though these writes occur in sloppy/`noStrict` SCRIPT context (the test262
default), where §10.1.9 requires a **silent no-op**.

The 5 regressions and their cause:
- `language/types/number/S8.5_A9.js` (`Number.NaN = 1` silent no-op) — over-throw
- `language/expressions/assignment/S8.12.4_A1.js` (`Math.E = 1`) — over-throw
- `language/types/object/S8.6.1_A1.js` (`Math.E = 1`) — over-throw
- `built-ins/Proxy/set/call-parameters-prototype.js` — the proto-walk called
  `Object.getOwnPropertyDescriptor` on the Proxy prototype, firing its
  `getOwnPropertyDescriptor` trap as an observable side-effect (wrong trap order)
- `language/expressions/dynamic-import/returns-promise.js` — collateral of the
  same over-throw on a `globalThis.Promise = fn` write

**Fix (src/runtime.ts `_safeSet`):** narrow the strict throw to the issue's
actual target — a genuine **getter-only OBJECT-LITERAL accessor** (always an OWN
property). The plain-JS pre-check now inspects ONLY the own descriptor and
throws ONLY when `desc.get && !desc.set`; it no longer walks the prototype chain
(kills the Proxy trap side-effect) and no longer throws for non-writable data
properties. The `catch` arm no longer blanket-re-throws on `strict` — the
getter-only case is already handled by the pre-check before the write, so any
engine TypeError reaching the catch (non-writable data / non-extensible / frozen)
diverts to the sidecar exactly as the sloppy path always did. Revoked-proxy
TypeErrors (#2180) are still propagated.

**Tests:** `tests/issue-2017.test.ts` gains two regression guards — a
non-writable built-in data-property write (`Math.E = 1`, `Number.NaN = 1`)
silently no-ops and must NOT throw. All 6 pass. The 4 original feature tests
(getter-only throws / getter+setter routes to setter / getter survives rejected
write / TypeError instance) still pass.

**Verified:** the 4 non-fixture regressed paths pass in-process via
`runTest262File` (incl. the Proxy test — no trap fired). The dynamic-import
fixture test's `globalThis.Promise = fn` write now succeeds in a minimal probe
(error class "Cannot create property 'Promise'" eliminated); CI's fixture-aware
sharded path confirms. `tsc --noEmit` + `npm run lint` clean.
