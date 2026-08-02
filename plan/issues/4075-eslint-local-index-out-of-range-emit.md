---
horizon: m
id: 4075
title: "ESLint: binary emit fails with local index 65 in an 8-slot frame at function 've'"
status: ready
created: 2026-08-02
updated: 2026-08-02
assignee: unassigned
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, emit
language_feature: multi-module-compilation
goal: npm-library-support
sprint: current
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 2043, 4030, 4045]
---

# #4075 — `local index out of range — 65 (valid: [0, 8))` at emit

## Problem

The **current and only** blocker for an ESLint binary. Everything upstream now
succeeds: zero hard codegen aborts, planning completes, and the compile reaches
binary emit before dying:

```text
Binary emit error: RangeError: Codegen error: local index out of range — 65
(valid: [0, 8)) at function 've' (position 1666, 6 declared locals).
```

Reproduce (~15 min):

```sh
node --max-old-space-size=6144 --import tsx \
  tests/helpers/compile-project-probe.ts <tier1-entry.ts> \
  '{"allowJs":true,"target":"gc","platform":"node","allowFs":true}'
```

where the entry is `tests/stress/eslint-tier1.test.ts`'s Tier 1a source.

## What is known

- Function `ve`, defined-function **position 1666**, **6 declared locals**, and
  the valid range `[0, 8)` implies **2 params**.
- The body references **local 65** — far beyond its own frame.
- **The name is NOT shared.** The emit diagnostic now reports
  `NAME SHARED BY n DEFINED FUNCTIONS` when a defined-function name is
  duplicated, and it did **not** fire here. So this is **not** the #4045
  cross-module collision, despite looking exactly like it.
- **No declaration named `ve` exists** anywhere in the 146-source resolved
  graph — checked across `FunctionDeclaration`, `MethodDeclaration`,
  named `FunctionExpression`, and variable declarations initialised with a
  function or arrow. So `ve` is either compiler-synthesized or introduced by a
  transform (the CJS rewrite and ground-call folding both run before analysis).

## Two candidate causes, not yet distinguished

1. **Genuinely the #2043 late-import index-shift class** the message names — a
   captured local index went stale, or a lookup baked a bogus value.
2. **A body installed against the wrong frame**, i.e. the same *shape* as #4045
   but arrived at by a different route than name collision (an alias, a
   trampoline rebuild, or a finalize pass reusing a slot).

The `(position, locals, name-sharing)` detail added in this session is the
evidence needed to tell these apart; it did not exist before and is what ruled
out the collision reading.

## Suggested next step

Find where the index 65 comes from rather than which function owns it: instrument
`encodeInstr`/`vIdx` to record the *instruction* and its enclosing block when the
breach fires, and correlate 65 against the local count of nearby functions — a
body built for a ~65-local function landing in a 2-param/6-local slot points at
(2), while an isolated bogus index points at (1).

Identifying what produces a function literally named `ve` would also localise it
immediately; a targeted dump of `mod.functions[1660..1670]` names at emit time is
cheap and would show its neighbours' provenance.

## Acceptance criteria

- The origin of function `ve` is identified.
- Cause (1) vs (2) is decided with evidence, not by the message's default
  attribution — the `#2043` text in this diagnostic is a **guess**, and it was
  already misleading once (it fired for #4045's collision).
- A reduced fixture reproduces the breach without ESLint.
- ESLint's Tier 1a entry emits a binary.

## Further evidence gathered (2026-08-02)

### The exact site

```text
local (local.get) index out of range — 65 (valid: [0, 8))
at function 've' (position 1666, 6 declared locals)
```

So it is a **`local.get 65`** — a READ of a local that does not exist in this
frame — not a write and not a computed index.

### `ve`'s neighbourhood (`JS2WASM_EMIT_DUMP=1`, position → frame size → name)

```text
1662   2   ye
1663   3   me
1664  46   xe
1665   3   __fn_tramp_t_cached
1666   8   ve      <-- references local 65
1667  19   ge
1668  30   Ae
1669  42   Ee
1670   2   __get_member_nextPos
```

Every neighbour is a two-letter minified name, so `ve` comes from a **minified
dependency** in the graph (`esquery.min.js` is the likeliest — it is an ESLint
dependency and is shipped minified). That also explains why no *declaration*
named `ve` was found by an AST scan of the resolved sources: the scan looked at
declaration forms, and these names are also introduced by patterns it did not
cover (object-literal properties, class expressions, and the CJS rewrite, which
runs before analysis).

**No neighbour has a frame ≥ 66**, so the body is not simply the adjacent
function's. Module-wide, **322 of 8,225** defined functions have a frame large
enough to own local 65 — too many to guess from; the origin has to be traced,
not inferred.

### A separate finding worth its own triage

The emitted table still contains **61 duplicated defined-function names** after
the #4045 fixes, e.g. `TokenTranslator_init`, `TokenTranslator_new`, `_format`,
`_globToRegExp`, `analyzeScope`, `assertArg`, `__sget_`, `__sset_`,
`__async_resume_fanon_410`. #4045 covered top-level *function declarations*;
these are class members, synthesized helpers and async resume points, which are
named by other schemes. `ve` is **not** among them — which is exactly why the
name-sharing check ruled the collision reading out here — but the duplicates are
a latent instance of the same hazard and should be triaged separately.

### Narrowed next step

Instrument the producer, not the emitter: record which pass last wrote
`mod.functions[1666].body`. Candidates worth checking first, in order —
`replaceDefinedFuncAt`, the `pendingMethodTrampolines` finalize rebuild, and
`fillMethodTrampolines`/`finalizeMethodTrampolines`, since all three overwrite an
existing slot's body after it was first compiled and are therefore the paths that
can pair a body with a foreign frame.
