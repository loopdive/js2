---
id: 5261
slug: toprimitive-unbox-seam-sibling-policy
status: ready
sprint: Backlog
priority: medium
horizon: m
goal: ir-full-coverage
lane: ir-retirement-r6
feasibility: hard
created: 2026-09-01
requested_by: ttraenkler/opus
parent: 3526
related: [3526, 4208, 3522, 1305, 3168]
files:
  - src/ir/from-ast.ts
  - src/ir/runtime-manifest.ts
  - src/ir/integration.ts
---

# The ToPrimitive `__unbox_number` seam needs its OWN policy — `numberBoundary.unbox` is the wrong authority

## Problem

Two from-ast arms in `emitUnaryToNumber` still pin `__unbox_number` by runtime
symbol, outside the frozen manifest's authority:

- the `extern:Object` OrdinaryToPrimitive arm (`__to_primitive` →
  `__unbox_number`) — **reachable**;
- the closed-literal string sub-arm — **unreachable**, see [#5260].

#3526 F1-S4 was planned to migrate both onto the existing
`NumberBoundaryPolicy.unbox`. Its pre-implementation verification V-A was
written to catch exactly one hazard before that happened, and the hazard is
real, so the sub-slice was **stopped rather than landed**.

## The measured divergence (2026-09-01, on `origin/main` `96f7a3c0`)

`addUnionImports` (`src/codegen/registry/imports.ts:813`) registers the **host
`env` family** on every lane whose `semanticProviders` is not `"native-first"`.
So the raw runtime symbol resolves on GC native-strings — a lane where
`NumberBoundaryPolicy.unbox` is `unsupported`:

| lane | `NumberBoundaryPolicy.unbox` | what the raw symbol resolves to today |
| --- | --- | --- |
| gc-host | `host` | `env.__unbox_number` import — matches |
| standalone / WASI (`native-first`) | `native` | union-native function — matches |
| **gc-native-strings** (`nativeStrings: true`, `semanticProviders: "host-assisted"`) | **`unsupported`** | **`env.__unbox_number` import; the owner compiles and is IR-claimed** |
| linear | disabled | arm unreachable — the shape fails the linear backend outright |

Measured on the reaching fixture (a unary `+`/`-` on an OrdinaryToPrimitive
literal with property-assigned function expressions): on gc-native-strings the
owner reports `emitted` and the module's import list contains
`env.__unbox_number`, while the F1-S1 coercion arm on the *same* lane reports
`late-preparation-unsupported / resolve —
box=unsupported/unbox=unsupported`.

Emitting `js.number.unbox` here would therefore convert a compiling,
IR-claimed owner into a preparation demote. That is a behaviour change, not a
neutral migration, so #3526 F1-S4 recorded it instead of absorbing it. Two
tests in `tests/issue-3526-boundary-residuals.test.ts` pin the divergence.

## The route this issue owns

The F1-S3 precedent applies almost exactly. When the `gen.setReturn` seam's
truth table turned out to be WIDER than `numberBoundary`'s, F1-S3 minted a
**sibling** policy (`generatorNumberBox`) rather than widening the shared one —
because `numberBoundary.box` deliberately has no `"native"` member, so that
helper presence cannot widen the coercion arm's host-only policy.

Same shape here. This seam's measured truth table is:

```
semanticProviders === "native-first" ? "native" : "host"
```

which is neither `numberBoundary.unbox`'s nor `booleanBoundary`'s nor
`generatorNumberBox`'s. It would be the **fourth** policy in the family, and
the four must stay separate even though three of them name the same physical
symbol.

Sketch, mirroring the three landed slices rather than re-deriving them:

1. `ToPrimitiveNumberUnboxPolicy { unbox: "host" | "native" | "unsupported" }`
   on `RuntimeManifestPolicy`, optional, defaulted to a frozen disabled
   constant, canonicalized at builder construction, published resolved.
2. Two provider rows: `host-callable` on the central `number.unbox`
   capability, `runtime-callable` on the union-native symbol. Both keep the
   exact physical target the direct call uses today.
3. Integration projects the truth table above; linear and stdlib-selfhost pass
   disabled (verify by measurement that the arm is unreachable there, as F1-S4
   did for its own seam — do not assume).
4. An owner-local `late-preparation-unsupported` partition beside the existing
   three.
5. The union-import trigger already recognizes attached `js.number.*`
   targets; confirm the new use is covered and that import set, order and
   indices do not move.

## Why this is worth doing rather than leaving

The seam is the last place in from-ast where `__unbox_number` is chosen by
spelling a runtime symbol. Leaving it means the symbol keeps two authorities —
the frozen manifest for the coercion arm, and a hardcoded reference here — and
the F1 family's whole point is that it should have one.

## Acceptance criteria

- The reachable arm emits a provider-free intrinsic and reads no lane fact.
- **Byte-identical on every lane**, including gc-native-strings, where today's
  owner must keep compiling and stay IR-claimed. The two pinning tests in
  `tests/issue-3526-boundary-residuals.test.ts` will need updating; changing
  them is the signal that behaviour moved, so state the new expectation
  explicitly rather than deleting them.
- Import set AND order identical per lane.
- `check:ir-fallbacks` census output-identical.
- Non-vacuity: reverting only the from-ast arm against the kept schema fails
  named tests.
- The four policies stay separate, and a test pins that `numberBoundary.unbox`
  did not acquire this seam's truth table.

## Out of scope

The unreachable string sub-arm ([#5260] decides its fate first — if it is
deleted, this slice has one arm to migrate, not two), `__to_primitive` itself,
the `__ir_dyn_*` family, and `lower.ts:1440`'s defensive
`coerceToF64ForBitwise` unbox, whose retirement is #1305's.
