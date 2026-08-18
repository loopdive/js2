---
id: 4508
title: "IR: feed module-binding storage edges into the prepared-owner fixpoint — module-binding readers seal or withdraw"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-16
assignee: ttraenkler/opus-4508
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
related: [4494, 4462, 4461, 3142]
origin: "#4494's `## Follow-up` — the construction edge closed `class.new`; the other dependency codes `derivePreparedComponentDependencies` can raise (`source-global-outside-component`, module-binding readers, host-provider bindings) were left open, and #4462 pre-built the acceptance tripwire for them"
# The new edge kind is one disjunct in the same `crossesOwnership` predicate
# #4494 extended, plus the input it resolves against. The predicate's candidate
# set cannot be exported without exporting the whole selection transaction, so
# the ~14 functional lines plus the comment recording the UNSOUND alternative
# land in a file that is already over the 1,500-line threshold. `index.ts` takes
# 4 lines for the call-site input.
loc-budget-allow:
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/index.ts
---

## Problem

#4494 established **claim ⇔ preparability parity per component**: a unit may
only claim if the prepared component it lands in can seal. It enforced that for
exactly one dependency code — `foreign-source-unit` raised by a `class.new`
construction edge. Its `## Follow-up` names the gap this issue closes:

> The general parity statement — *a unit may only claim if its component seals* —
> is still not enforced for the other dependency codes that
> `derivePreparedComponentDependencies` can raise
> (`source-global-outside-component`, module-binding readers, host-provider
> bindings). Manifestations 2 and 3 live there.

`recordGlobalReference` (`src/ir/prepared-component-dependencies.ts`) fails a
source-global read closed with `source-global-outside-component` whenever the
global's **storage terminal** is not itself inside the sealed transaction. For
every top-level `var`/`let`/`const` that terminal is the **module-init** unit,
and `preparedExactLexicalModuleInit` (`src/codegen/index.ts`) refuses to prepare
a module-init at all on the `fast` / `nativeStrings` / `standalone` / `wasi` /
`strictNoHostImports` lanes. So on those lanes **every** module-binding reader
that claims is guaranteed to fail preparation after the claim — the exact
post-claim degradation #4494 exists to prevent.

### Measured, on `5f3c86e7`-descended base `fda87df5` + `origin/main`

Base for every A/B below is this branch's merge base, re-measured against
reverted file copies of the three changed sources — not an inherited artifact.

**#4462's manifestation** (`website/playground/examples/js/algorithms.ts`,
standalone). `fibMemo` reads the module-level `const fibCache`:

```
POSTCLAIM build fibMemo: prepared owner …:top-level-function:1 has incomplete dependencies:
  source-global-outside-component: source global source|106:…:module-tdz:0
    belongs to non-candidate storage terminal …:module-init:0;
  source-global-outside-component: source global source|110:…:module-binding:0
    belongs to non-candidate storage terminal …:module-init:0;
  unplanned-abi-binding: …__ir_map_get_num / __ir_map_set_num / __unbox_number /
    __extern_is_undefined / __new_ReferenceError …
POSTCLAIM build main: … foreign-source-unit: … :top-level-function:1 belongs to
  non-candidate terminal …:top-level-function:1
```

**#4461's residual** (`let counter = 0; function read(){return counter}
export function run(){return read()+1}`) is worse than a demotion — on
standalone the base **fails to compile**:

```
[standalone] success=false
  read: unsupported resolve/late-preparation-unsupported
  run:  invariant  invariant/patch/unpatched-slot
  ERROR IR-first (#2138): run failed after its legacy body was skipped … [unpatched-slot]
```

## Fix — a module-binding storage edge, consumed one-directionally

**Edge kind added:** `moduleBindingStorageTerminals` in
`IrIdentityLocalCallEdges` (`src/codegen/ir-first-gate.ts`) — owner →
`{module-init unit}` for every top-level function whose subtree references a
binding declared by the module-init population.

- Name resolution is checker-free, like the existing `recordCall`. Shadowing
  uses the **under**-approximation *"a name declared anywhere inside this owner
  shadows it everywhere inside this owner"*. The bias is deliberate:
  under-recording preserves the status quo exactly (the owner stays a candidate
  and seals or fails as it does today), while over-recording would withdraw an
  owner that prepares fine.
- Attribution is the whole top-level function subtree — a nested arrow's global
  read seals against the same terminal owner, so the subtree is the attribution
  the failure itself uses.
- **Class members are excluded.** `recordGlobalReference` carries sanctioned
  writeback exemptions for accessor-owned module globals
  (`class-setter-writeback-global`, `class-setter-writeback-tdz-global`) that
  seal today; an AST edge cannot see them and would withdraw them.

**Directionality:** one-directional, and resolved against a **new** input —
`preparedStorageTerminalUnitIds`, holding the module-init unit id only when
`preparedExactLexicalModuleInit` admitted it. A reader needs its storage
terminal prepared; the module-init does **not** need its readers prepared (it
lowers its own stores either way). Resolving against `candidates` instead would
be wrong in a different way: the module-init is never a member of the free/class
candidate population, so that test would withdraw every reader unconditionally.

### The forward-only variant was measured and is UNSOUND

The obvious way to avoid the collateral in the table below is a **separate
forward-only closure** — withdraw the reader and its callers, but do not let the
existing bidirectional call closure withdraw the readers' *callees*. Measured on
`algorithms.ts` standalone it produces a hard failure:

```
[standalone] success=false
  fibMemo / main / <module-init>: invariant/build/unexpected-internal-throw
  POSTCLAIM: callable provider runtime|21:__extern_is_undefined was discovered
             after prepared provider planning
```

Leaving a **direct** reader beside a **still-prepared** component lets that
reader's late-discovered runtime providers arrive after the prepared ABI froze.
This is precisely the hazard the existing fixed point's comment names ("retain a
legacy caller"), so the new edge goes into that fixed point rather than beside
it.

## Test Results

### Composition table — `check:ir-only` standalone lane, re-measured

| Unit (`algorithms.ts`, standalone) | Before | After |
| --- | --- | --- |
| `fibIter` | emitted, compile-**once** | emitted, compile-twice |
| `fibMemo` | **`resolve/late-preparation-unsupported`** | **emitted** (IR body) |
| `binarySearch` | emitted, compile-**once** | emitted, compile-twice |
| `quicksort` | emitted, compile-**once** | emitted, compile-twice |
| `joinNums` | emitted, compile-**once** | emitted, compile-twice |
| `main` | **`resolve/late-preparation-unsupported`** | **emitted** (IR body) |
| `<module-init>` | emitted | emitted |

| `check:ir-only` lane | Before | After |
| --- | --- | --- |
| single-host — entries / emitted / IR bodies / legacy / unsupported | 5 / 37 / 37 / 0 / 0 | **byte-identical** |
| standalone — emitted | 20 | **22** |
| standalone — IR bodies | 20 | **22** |
| standalone — unsupported | 17 | **15** (`resolve/late-preparation-unsupported` → 0) |
| standalone — legacy bodies | 22 | **26** |

**The honest trade.** The two gains cost four compile-once demotions, all inside
`algorithms.ts` standalone, and all from the **pre-existing** bidirectional call
closure, not from the new edge: `main` fails to seal on its own
`unplanned-abi-binding`s (`__ir_console_sink_append`,
`__ir_number_to_string_native`, `__ir_string_concat`) independently of
`fibMemo`, so once parity withdraws it, its callees follow by the reverse edge.
Compile-once is *asserted* only on the single-host lane, which is unchanged; the
standalone lane is a coverage ratchet whose tracked floor is `irBodyEmitted`.
`scripts/ir-only-baseline.json` is ratcheted **standalone-lane-only**.

### #4461's residual — healed, not narrowed

| Lane | Before | After |
| --- | --- | --- |
| gc | `read` / `run` / `<module-init>` all emitted | unchanged |
| standalone | **`success: false`** — `read` `late-preparation-unsupported`, `run` `invariant/patch/unpatched-slot` | **`success: true`** — all three emitted with IR bodies |

### Gates

| Gate | Result |
| --- | --- |
| `pnpm run typecheck` | clean |
| `tests/issue-4508.test.ts` | 6/6 |
| `tests/issue-4462.test.ts` | 12/12 — the pinned tripwire flipped, updated to the new truth |
| `tests/issue-4494.test.ts` | 6/6 |
| `tests/issue-3522-ir-class-compile-once.test.ts` | 42/42 |
| `pnpm run check:ir-fallbacks` | OK — no unintended / post-claim / module-level growth |
| `pnpm run check:ir-only` | both lanes at-or-above floors; host lane byte-identical |
| `pnpm run gen:ir-adoption --check` | clean |

## Follow-up

Two of the three codes #4494 listed are now fed into the fixpoint
(`foreign-source-unit` via construction edges, `source-global-outside-component`
via storage edges). The third — **host-provider bindings** — is still
unmodelled: `fibMemo`'s `unplanned-abi-binding` failures on
`__ir_map_get_num` / `__ir_map_set_num` / `__unbox_number` /
`__extern_is_undefined` are *independent* of its global reads and would have
kept it from sealing even with the storage edge alone. They are invisible to an
AST edge (they are discovered by lowering, not by syntax), so closing them wants
a planning-time provider projection rather than a fourth syntactic edge kind.

The four compile-once demotions above are the standing cost of the reverse edge
in the bidirectional closure. Retiring it needs the prepared provider set to be
projected before the transaction freezes, which is the same work.
