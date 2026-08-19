---
id: 4199
title: "Standalone: a TOP-LEVEL expando write onto a builtin namespace singleton (Math.x = …, JSON.x = …) is dropped from __module_init"
status: done
assignee: ttraenkler/W17
completed: 2026-08-07
sprint: 78
created: 2026-08-07
updated: 2026-08-18
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: builtins, property descriptors, module init
goal: standalone-gap
related: [4176, 4098, 4197, 2907, 2671, 3468, 1907, 1888]
---

# #4199 — top-level `Math.x = …` / `JSON.x = …` compiles to nothing (standalone)

## Symptom

```js
Math.configurable = true;
Object.defineProperty(obj, "property", Math);   // test262 15.2.3.6-3-91
delete obj.property;                            // does nothing — descriptor was empty
```

`Math.hasOwnProperty("value")` is `false` after `Math.value = "D"` at top level.

## Root cause: the statement is never emitted, not mis-lowered

`collectDeclarations` (`src/codegen/declarations.ts`) keeps a top-level
assignment statement only when its assignment ROOT resolves to something it
recognises — a module global, a top-level function, `globalThis`. `Math` is a
BUILTIN identifier, so `getAssignmentRootIdentifier` finds no root and the whole
statement is discarded. It compiles to **nothing**.

The bisect that settles it — the identical write from inside a function body
already worked, before any change:

| form | result on `main` + #4177 |
| --- | --- |
| `Math.value = "D";` at top level, then `defineProperty(obj,"p",Math)` | `obj.p === undefined` |
| `function s(){ Math.value = "D"; } s();` then the same define | `obj.p === "D"` |
| `var c = Math; c.value = "D";` then the same define | `obj.p === "D"` |

The write ARM is correct: `Math` as a bare value resolves to the
identity-stable extensible `$Object` namespace singleton
(`emitBuiltinNamespaceObject`, #2907) and the ordinary property-write arm stores
into it via `__extern_set`. **Keeping the statement is the whole fix.**

Sixth recorded instance of the module-init COLLECTION elision family, one level
shallower than #4176's `<Builtin>.prototype.<name>`: #2671
(`Test262Error.thrower`), #2992 (top-level `delete`), #3468 F1
(`assert.sameValue`), #3592 (`throw`), #4176.

## Why it matters — the §8.10.5 descriptor-carrier idiom

ES5 `ToPropertyDescriptor` reads its fields off an arbitrary object, and a large
test262 family builds that object by hanging fields on a builtin. This is the
single largest tractable slice of the remaining ES5 descriptor residue.

## Measurements

Base: `origin/main` `d40692a3c2` + fast-forward merge of
`origin/issue-4197-consumer-mode-fn-decl-getter` (`a37f5c90f3`; PR #4177, open).
Standalone baseline JSONL re-fetched `--force`, row stamp `7.8.2026 05:05:53`.
Driver: `runTest262File(..., "standalone")` with the `js2wasm:runtime-eval`
namespace shimmed in by wrapping `WebAssembly.instantiate` (#4163 unlanded).

**Instrument recovery, two-sided, before touching anything:** on the 558-file
ES5 descriptor lever the local run reproduced **284 pass / 274 fail**; all 178
CI-passing files reproduced, **0 lost**, and the 106 newly-passing were exactly
#4197's claim.

| measurement | before | after |
| --- | ---: | ---: |
| 558-file ES5 descriptor lever | 284 pass | **322 pass** (**FIXED 38, BROKE 0**) |
| blast radius — every corpus file writing a `Math`/`JSON`/`Reflect` expando (63) | 6 pass | 44 pass (FIXED 38, BROKE 0, 0 signature drift) |

## The census this came out of (274 residue by spec algorithm, n/558)

| n/558 | mechanism |
| ---: | --- |
| **108** | **M1 ToPropertyDescriptor (§8.10.5) over a non-literal descriptor carrier** |
| 54 | M2 Array exotic `[[DefineOwnProperty]]` (§15.4.5.1) |
| 41 | M4 attributes of a *builtin's own* property (27 of them `gOPD`) |
| 20 | M9 other |
| 15 | M5 ordinary §8.12.9 on a non-plain `O` |
| 14 | M6 `[[Prototype]]` shadowing / inherited attributes |
| 11 | M3 Arguments exotic (§10.6) |
| 8 | M8 `getOwnPropertyNames` |
| 3 | M7 `Object.create` argument handling |

Two negative results worth keeping, so the next lane does not re-derive them:

**The descriptor READ side is not the defect — do not rewrite it.** A 14-carrier
matrix, each `<carrier>.value = "D"; Object.defineProperty(obj,"property",<carrier>)`:

| carrier | verdict |
| --- | --- |
| plain object · function · array · `arguments` · the global object | PASS |
| `new String` · `new Number` · `new Boolean` · `new Date` · `new RegExp` · `new Object` | PASS |
| **`Math`** · **`JSON`** (statically named namespace) | **FAIL** → this issue |
| **`new Error()`** (and `new TypeError()` etc.) | **FAIL** → #4098, out of scope |

**`SITE-PROPS-BAG-NOT-AUTHORITATIVE` is 14 files and is a SYMPTOM of M1, not a
bucket.** #4047 measured that arm at +6 and reverted it; it should not be
re-litigated a third time as though it were its own lever.

## Implementation

`src/codegen/builtin-write-keeps.ts` (new) holds both builtin-receiver keep
predicates. `isBuiltinProtoWriteTarget` (#4176) MOVED here unchanged;
`isBuiltinNamespaceExpandoWriteTarget` (#4199) is new; `collectDeclarations`
now calls one `shouldKeepBuiltinReceiverWrite(ctx, left)` instead of carrying
two predicates and two comment blocks. **Both the LOC and function budgets pass
with no allowance** — declarations.ts and `collectDeclarations` both shrink.

### Scope, and the cases that must STAY dropped

- **Namespaces**: only the three #2907 bare-value carriers whose
  `SUPPORTED_STATIC_PROPS` list is EMPTY (`Math`, `JSON`, `Reflect`) — pure
  namespace singletons, so a kept write cannot collide with a claimed
  identifier-level fast path. `Array`/`Object` excluded (they claim `isArray` /
  `keys`); the Error-family carriers excluded (constructors; `new` /
  `instanceof` resolve before identifier resolution, and #4098 owns their
  instance-side storage).
- **Property names**: only names NOT on the namespace's own static surface.
  Correctness in both directions, not timidity:
  - `Math.PI = 3` — `Math.PI` is `{[[Writable]]: false}` (§21.3.1), so dropping
    that write is the SPEC-CORRECT outcome; keeping it would be a regression.
  - `JSON.stringify = fn` — the call site resolves statically through
    `BUILTIN_STATIC_METHOD_ARITY`, so a bag entry would be a SECOND storage the
    reader never consults. An honest no-op beats silent divergence; patching
    builtin statics is separate, measured work (cf. the #2623 P-7b
    `Promise.resolve` arm, host/GC-only for the same reason).
- **Computed keys** (`Math[k] = v`) declined — the own-static-surface test is
  undecidable at compile time and admitting it would let `Math["PI"] = 3`
  through the back door.
- **Shadowing** (`var Math = {}`) declined — already owned by the collection's
  module-global arm.
- **Standalone only.** Host/GC output is byte-identical (the predicate runs
  behind `ctx.standalone`).

## Verification

`tests/issue-4199.test.ts`. Four end-to-end cases are RED on the unpatched base
and green on this branch. The **precondition** case (the same write from inside a
function body) is green on BOTH — it is what makes this a collection bug rather
than a storage bug, and a fixture that only exercised the in-body form would
have passed on unpatched main and proved nothing. Predicate-level scope guards
cover every declined shape.

`Math.PI` shadowing could not be asserted end-to-end: reading `Math.tag` when a
user `const Math` shadows the builtin still hits the #1907
builtin-static-value-read refusal, a SEPARATE pre-existing defect that
reproduces identically without this change.

## Not fixed here (findings for the next lane)

- **#1907 has surviving refusals.** It is `status: done` (sprint 75), yet
  `Math.<expando>` as a VALUE READ is still
  `Codegen error: … built-in static property value read is not supported in
  --target standalone`. This issue makes the WRITE land; the read-back of an
  expando through the static path stays refused.
- **`undefined.writable` returns `undefined` instead of throwing** in
  standalone. This is why the 24 `gOPD`-on-builtins tests report
  `desc.writable === undefined` rather than a TypeError — the descriptor really
  is `undefined` and the member read silently succeeds. Worth its own issue.
- **`<Ctor>.prototype.constructor` is missing entirely** (17 of the 27 M4 `gOPD`
  files): `Error.prototype.constructor`, `Object.prototype.constructor`, … all
  read `undefined`, and `gOPD` of them returns `undefined`.
- **M2 (Array exotic §15.4.5.1, 54 files) is the next-largest slice**, and
  **18 of its 54 share one signature** — "Expected a TypeError to be thrown but
  no exception was thrown at all", almost all of them `'O' is an Array` with the
  `length` property or an array-index named property.
