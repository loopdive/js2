---
id: 2372
title: "standalone: force dynamic-object-receiver vars onto $Object representation (the dynamic-object family unblock)"
status: done
assignee: ttraenkler/sendev-receiver
completed: 2026-06-19
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: objects, property-descriptors, representation
goal: standalone-mode
related: [1906, 2371, 1629a, 1629b, 1630, 1355, 1472, 1673]
blocks: [2371, 1355, 1629b]
arch_scale: true
---

# #2372 — receiver-representation unblock for the standalone dynamic-object family

> **Single highest-leverage remaining architect item for standalone.** This one
> representation change gates the WHOLE dynamic-object-receiver family:
> `Object.defineProperty` (~235), `Object.create(proto, props)`,
> `Object.getOwnPropertyDescriptor` (#1629b read-back),
> `Object.seal`/`freeze`/`preventExtensions` (#1355 family). Worth a deliberate
> dedicated effort — NOT a session-tail force.

## Problem (the wall)

A `const o: any = {}` (or `var o = {}`) receiver is compiled to a **typed
WasmGC struct**. When such a variable is later the target of a dynamic
property operation — `Object.defineProperty(o, k, descVar)`,
`Object.create(...)`-derived, `o[k] = v` with a runtime key, descriptor
reflection — the *write* goes into the native `$Object` open-hash-map runtime
(`__obj_insert` / `__defineProperty_value` / `__defineProperty_accessor`, all
landed), but the *read* (`o.foo`, `o.hasOwnProperty("foo")`) lowers to
`struct.get` against the typed struct. The struct and the `$Object` are
**different objects**, so the write is invisible to the read.

**Proven** (#2371 spike, 2026-06-19): on a receiver that IS already a `$Object`
(`Object.create(null)`), a dynamic **data** descriptor reads back correctly
(`o.x === 7`) AND a dynamic **accessor** descriptor reads back correctly
(`o.x === 9`). So define + read-back already COMPOSE on a `$Object`. The only
missing piece is putting the receiver on the `$Object` representation. That is
why #2371's correct native define banks 0 test262 alone.

## Fix direction (declaration-time receiver forcing)

Mirror the existing accessor-literal precedent: `initIsAccessorLiteral`
(`src/codegen/index.ts:~12698`) already forces a var to `externref` +
tags `ctx.externrefAccessorVars` BEFORE allocating its local slot, so reads
route through `__extern_get` / the `$Object` path. Extend that pre-pass:

1. **Scan the enclosing function/module body** for the var being a target of a
   dynamic-object op: `Object.defineProperty(<ident>, …)`,
   `Object.defineProperties(<ident>, …)`, assignment from
   `Object.create(<proto>, <props>)` / `Object.create(<proto>)`,
   `Object.seal/freeze/preventExtensions(<ident>)`, and runtime-keyed
   `<ident>[expr] = …`. (Several of these already have narrower hooks —
   `markRuntimeDefinedProperty`, `sidecarDefinedPropertyKeys`,
   `definedPropertyFlags` — but they fire at the WRITE site, AFTER the struct
   slot is allocated, so they cannot retype the receiver.)
2. When detected, force the var to `externref` + tag `externrefAccessorVars`
   (or a new `dynamicObjectVars` set) at declaration time, BEFORE `allocLocal`,
   exactly like the accessor-literal arm.
3. **Un-gate the read hook for data descriptors**: `runtimeAccessorDescriptorKey`
   (`property-access.ts:239`) currently requires `DESCRIPTOR_FLAG_ACCESSOR`;
   data-descriptor defined keys on a forced-`$Object` receiver should also route
   to `emitRuntimeDescriptorGet` / the `$Object` read path. (Once the receiver
   is `$Object`, the plain property-access `$Object` arm already handles data
   reads — the create(null) spike returned 7 without touching this hook — so
   this step may be unnecessary for the bare read but is needed for descriptor
   reflection.)

## The risk (call this out loudly)

Forcing a receiver var off the typed-struct representation **re-types it**, and
risks regressing the **typed-struct fast path for class instances** (the #1673
class-receiver hot path: `struct.get`/`struct.set`, no `$Object` boxing). The
forcing MUST be scoped to genuinely-dynamic `any`-typed plain-object receivers
and MUST NOT capture statically struct-typed class instances or
`resolveStructNameForExpr`-resolvable receivers. A WAT byte-diff of a
class-instance method hot path (and the inline-literal data path) is a required
guardrail. Floor-gate the standalone HW hard — a representation slip can
regress a broad swath at once.

## Acceptance criteria

1. `const o: any = {}; const d: any = {value:42}; Object.defineProperty(o,"x",d);
   o.x === 42` and `o.hasOwnProperty("x") === true` standalone.
2. The `built-ins/Object/defineProperty` ToPropertyDescriptor cluster
   (`15.2.3.6-3-*`, throw + hasOwnProperty=false cases) flips — re-measure the
   ~235.
3. Class-instance struct fast path UNCHANGED (WAT byte-diff; #1673 + class
   equivalence suites green).
4. No standalone HW regression.

## Notes

- #2371 is the native single-descriptor applier this unblocks (committed,
  0-flip-until-this). #1906 (plural) is done. The applier set is complete;
  only the receiver representation remains.
- Recommend an architect spec (functions, the exact body-scan predicate, the
  struct-vs-$Object decision boundary) before dev dispatch — this is `max`
  reasoning_effort and high blast radius.

## Root cause + fix (sendev-receiver, 2026-06-19) — the wall is FAR NARROWER than feared

**Re-grounded against current `upstream/main` + the banked #2371 helper. The
substrate moved (the #2162b pattern): the original "force every `{}` receiver
onto `$Object`" pre-pass is NOT needed.** A receiver `const o: any = {}` already
builds a `$Object` (`__new_plain_object`) in almost every case, and the
define+read-back already composes on a `$Object`. Measured matrix (all
`--target standalone`):

| receiver / descriptor | inline `{value:42}` | dynamic `const d:any={value:42}` |
|---|---|---|
| `const o: any = {}` | **PASS** (struct fast path) | **FAIL → 0** (the only broken cell) |
| `const o = {} as any` | PASS | PASS |
| `Object.create(null)` / `new Object()` | PASS | PASS |
| plain `o.y = 5` write+read on `const o:any={}` | PASS | — |

The **single** failing combination is `const o: any = {}` (explicit `any`
*annotation* + empty literal) targeted by a **dynamic** (non-inline-literal)
`Object.defineProperty`. Read-back returned 0.

### Exact mechanism (verified by WAT)

`collectEmptyObjectWidening` (`src/codegen/declarations.ts:1954`) +
`collectPropsFromStatements` (`:2059`) treat `Object.defineProperty(o,"x",desc)`
as a *static struct-field widening* (lines 2087-2120): they add `x` as a struct
field and register `o` to an anon struct via `widenedVarStructMap`. That fast
path is only sound for an **inline-literal** descriptor — the define then lowers
to `struct.set` and the read-back `o.x` to `struct.get` on the SAME widened
struct field (this is why the inline case passes, byte-for-byte).

But the widening fires **even when the descriptor is a variable** (a *dynamic*
descriptor the pre-pass can't statically resolve): it still registers the struct
(line 2116-2117) with the field typed `externref`. So `o` is built as
`struct.new <N>` → `extern.convert_any` (confirmed in the `$test` WAT: the first
ops are `ref.null extern / struct.new 20 / extern.convert_any`). At the define
site, standalone routes a dynamic descriptor to the native
`__obj_define_from_desc` (#2371), which writes the **`$Object` open-hash
runtime** — a *different* object from the struct. The read-back `o.x` lowers to
`struct.get` against the struct (still 0). Write-to-`$Object` / read-from-struct
→ 0.

### Fix (implemented — surgical, host/gc/wasi byte-identical)

Suppress struct-widening for any **standalone** receiver targeted by at least
one dynamic-descriptor `Object.defineProperty`. The receiver then stays on the
`$Object` representation and BOTH the dynamic write and the read route through
the native runtime consistently.

- `src/codegen/context/types.ts` — new `dynamicDescriptorWidenVars: Set<string>`
  (standalone-only poison set).
- `src/codegen/context/create-context.ts` — init the set.
- `src/codegen/declarations.ts`:
  - `collectPropsFromStatements`: when `ctx.standalone && !isObjectLiteralExpression(descArg)`,
    add `varName` to `dynamicDescriptorWidenVars`.
  - `collectEmptyObjectWidening`: `continue` (skip struct registration) when the
    var is in `dynamicDescriptorWidenVars`. (The poison set is filled by
    `collectPropsFromStatements`, which runs *before* this decision point.)

Host/gc/wasi mode is untouched (the gate is `ctx.standalone`): host keeps the
struct fast path because the host `__defineProperty_desc` import reflects back
through the live-mirror Proxy sidecar. A *mixed* receiver (one inline + one
dynamic define) is poisoned as a whole and routes entirely through `$Object` —
correct, both keys read back.

### Verification

- Direct probes flip the broken cell 0→42 and 0→1 (hasOwnProperty); every
  previously-passing cell stays green.
- **WAT byte-diff vs the #2371 base is IDENTICAL** for: inline-only
  `defineProperty` (struct fast path), class-instance field (#1673 hot path),
  plain `{a,b}` literal, and plain `o.y=` write/read. The change only alters
  receivers carrying a dynamic-descriptor define — minimal blast radius.
- New `tests/issue-2372.test.ts` (7 cases): dynamic data + accessor read-back,
  hasOwnProperty, mixed inline+dynamic, and the three fast-path regression
  guards. All pass.
- The full #1629a/#1629b/#1629-S1/S2/S3/S6 + `ir-frontend-widening` equivalence
  suites pass (61 assertions). (`empty-object-widening.test.ts` fails to *load*
  on `import './helpers.js'` — a missing file absent on `upstream/main` too,
  pre-existing and unrelated.)
- tsc clean; biome introduces 0 new errors (declarations.ts has 3 pre-existing).

### test262 expectation

The `built-ins/Object/defineProperty/15.2.3.6-3-*` ToPropertyDescriptor cluster
uses exactly this shape (`var desc = {...}; Object.defineProperty(o,"foo",desc);
o.hasOwnProperty("foo")`), so it is the direct target. CI bucket-by-path will
give the real flip count; acceptance criterion #4 (≥75% / ~235) was always an
over-estimate (it conflated several root causes — see #1630/#2371). This fix
clears the *receiver-representation* blocker specifically.

## Part 2 — descriptor reification (the SECOND representation half)

The receiver-suppression above was correct but **insufficient alone** (~0 flips
on the real cluster). Measuring against the test262 shape revealed a *symmetric*
half: the **descriptor**. test262 uses `var desc = {...}` (un-annotated), which
the TS checker types as a **closed WasmGC struct**, not a `$Object`. The native
`__obj_define_from_desc` applier runs ToPropertyDescriptor over the descriptor as
a `$Object` (`__hasOwnProperty`/`__extern_get`, which `ref.test $Object`); a
struct descriptor is "not an object" → spurious **TypeError §10.1.6**, trapping at
the define. So both operands must be `$Object`.

Proof matrix (standalone): receiver-`$Object` + descriptor-struct → THROWS;
receiver-`$Object` + descriptor-`as any`($Object) → 42; receiver-`var{}` +
`var desc:any` → 42. Both halves compose only when each stays `$Object`.

### Fix: struct→$Object descriptor reifier (`emitDescriptorStructReify`)

`src/codegen/object-ops.ts` — `emitDefinePropertyDescRuntime`, standalone branch:
when the descriptor compiled to a typed struct (`descType` ref/ref_null with a
resolvable struct name), reify it into a fresh open-hash `$Object` before the
applier call: `__new_plain_object()`, then for each static struct field
`struct.get` → `coerceType(→externref)` (f64/i32/bool/ref all handled) →
`__extern_set(obj, "<name>", value)`. A descriptor that is already a `$Object`
(externref — `as any`, or a `$Object`-built literal) passes through unchanged
(no double-wrap). Accessor `get`/`set` fields are already `externref` boxed
closures — no special-casing.

Emitted **INLINE** referencing `__new_plain_object`/`__extern_set` by
`ensureLateImport` (shift-safe by-name late imports) — NOT a finalize-built
helper body that bakes funcIdxs, so the #2190 late-import-shift hazard does not
apply (verified: fast-path WAT byte-identical to the #2371 base).

### Measured (faithful harness: allowJs + skipSemanticDiagnostics + real buildImports)

`built-ins/Object/defineProperty/15.2.3.6-3-*` (316 files):
- BASE (#2371, pre-fix): **98 pass**
- FIX (both halves): **136 pass** → **+38 flips, 0 regressions** (per-file diff:
  38 gained, 0 lost). Remaining 35 CE identical on base+fix (inline-descriptor
  `verifyProperty` machinery — separate codegen path, out of scope).

+38 is one cluster; the same receiver+descriptor representation gates
`Object.create(proto,props)`, `getOwnPropertyDescriptor` (#1629b), and
`seal`/`freeze` (#1355), so the full standalone CI run should show more.

### Verification (both halves)

- 11 dedicated cases in `tests/issue-2372.test.ts` (receiver + descriptor +
  accessor + mixed + the un-annotated real-test262 shape + §6.2.5.6 conflict
  throw + 3 fast-path regression guards) — all pass.
- WAT byte-identical vs the #2371 base for: inline-only `defineProperty`,
  class-instance field (#1673), plain literal, plain write/read.
- #1629a/b/S1–S6 + ir-frontend-widening suites pass; tsc clean; biome 0 new
  errors.
