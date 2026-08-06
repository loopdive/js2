# W2 — prototype-chain lever: PR body + session notes

**Agent**: `ttraenkler/W2-prototype-chain` · **Issue**: #4172 (allocated via
`claim-issue.mjs --allocate --allow-unscanned`, gh unavailable in container;
claim verified on `origin/issue-assignments`).
**Branch**: `issue-4163-standalone-proto-chain-live` (pushed to `origin` =
upstream `loopdive/js2`). **PR**: to be opened by main agent — body below.

---

## PR title

fix(#4172): make the standalone [[Prototype]] chain live for reassigned F.prototype (+95 on the 219-file ES5 lever)

## PR body

Closes #4172. Largest single mechanism in the ES5 standalone tail (219 files,
`description:`-frontmatter census — see #4008's pickup notes, which this PR
executes).

**Measured, CI-aligned shimmed instrument** (runtime-eval provider shim per
`plan/agent-context/L2-array-exotic-define.md` §2):

| 219-file lever list | pass |
| --- | ---: |
| `origin/main` @ 83e7c4db3 (A/B file-swap) | 0 |
| this branch | **95** |

0 regressions on the list; instrument verified responsive both directions
(95→0 on revert-swap). Blast-radius: 773-file deterministic sample of
`built-ins/Object/**` + `language/{expressions/new,arguments-object,
statements/function}` OUTSIDE the lever list: [before/after — filled in below].
Subsystem unit tests (2660/802/3468/4055/4161 families): 107/107 pass.

The #2660 substrate (S1 escape gate, S2 per-fnctor prototype `$Object`, S3a
`__object_create` reconstruction) already existed and classified the canonical
repro `reconstruct` — three independent gaps kept the chain dead:

1. **S3a G4 only accepted function-LOCAL externref bindings**
   (`fnctorNewResultConsumedAsExternref`, new-super.ts). Top-level
   `var child = new F()` — the dominant test262 shape — is a module-global
   binding; widened to accept a module global whose ALLOCATED slot is
   externref (same read-the-real-slot discipline as the local arm).
2. **The prototype object itself compiled as a closed struct.** `var proto =
   {foo: 1}` has no contextual type → closed struct → `__object_create(proto)`
   seeds `$proto = null`. Fixed by marking proto-SOURCE literals (one-hop
   identifier bindings flowing into `F.prototype = X` for gate-approved
   fnctors, `Object.create(X)`, `setPrototypeOf(_, X)`, `__proto__ = X`) into
   the existing #802 `ctx.dynamicProtoLiteralNodes` promotion
   (scanForDynamicProto), and adding the MISSING third slot-typing consult in
   declarations.ts `moduleInitForcesExternref` (module-global twin of the two
   index.ts consults — the lockstep discipline requires all three).
3. **Clause A missed the descriptor idiom.** `Object.defineProperty(obj, "p",
   attr)` passes `attr` to a CONCRETELY-typed lib.d.ts param, so the
   any/unknown-param check never fired → keep-static → struct. Added: any
   argument of a builtin `Object.*`/`Reflect.*` call is a dynamic consumer.
   Clause B (typed own-field ⇒ keep-typed) and the S3a lowering gate (empty
   body, no args, externref slot) unchanged, so typed fnctors cannot be moved
   off their struct.

Plus the **#4008 "do not re-derive" prerequisite re-land**: `__desc_has_own`
widened from HasOwnProperty to full §7.3.12 HasProperty — final arm delegates
to `__extern_has` (registration moved after it for funcIdx ordering; bag-miss
now falls through instead of answering 0). Measured +0 while the chain was
dead; load-bearing now (probe: inherited `value`/`enumerable` on a
`new Con()` descriptor argument now flow through
`Object.defineProperty`).

**Scope guard**: every widening stays behind the S1 (A)∧(B) gate — the #2660
S2 header records a measured −40 standalone-floor cost for UNSCOPED
interception; nothing here is unscoped. Host/gc lanes: all changed lowerings
are `ctx.standalone`-gated; the classification widening only feeds
standalone-gated consumers.

**Deliberately left out** (follow-ups, same lever):
- `Object.prototype.x = …` named-key visibility (12 files) — #4160's
  proto-index store minus its integer-key gate (probe2 still red).
- Builtin-prototype tests (`String.prototype` S15.5.3.1_A*, `Number.prototype`)
  — different mechanism (builtin proto objects, not user fnctors).
- `hasOwnProperty` returns i32 0/1 where sameValue(false) is asserted —
  preexisting, orthogonal.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

## Session notes (for the next agent on this lever)

- Instrument: `.tmp/w2-{child.mts,run.mjs,probe.mts}` in the worktree
  `/home/user/js2/.claude/worktrees/agent-a0ea534c6e5394997/` — verbatim from
  L2's handoff (known-good, CI-aligned). Rebuild
  `scripts/compiler-bundle.mjs` + refusal provider before every measurement.
- Probes 1/1a/1b/1c/2/3/3b in `.tmp/` cover both shapes + the descriptor
  idiom. probe2 (`Object.prototype.zzz`) is the remaining red one.
- The #4008 trap is real: `gpo:true` while `in:false` was observed live
  (probe2 output) — never trust the identity comparison.
- Remaining-failure clusters on the lever list after this PR: 15 ×
  override-of-inherited define (§8.12.9 step 1), 14 × `accessed !== true`
  (accessor invocation), 8 × missing TypeError arms, 12 × Object.prototype
  named keys, long tail builtin-proto.
