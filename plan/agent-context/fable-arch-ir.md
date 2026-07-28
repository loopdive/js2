# fable-arch-ir — context summary (fable-final sprint spec window, 2026-07-18)

One-shot Fable architect, spec-first lane: three plan PRs, 13 issues spec'd,
7 skipped with recorded reasons. All specs are append-only
`## Implementation Plan (Fable, 2026-07-18)` sections, verify-first against
current main (every mechanism re-read in source, not trusted from issue prose).

## PRs produced (all against loopdive/js2, head = ttraenkler fork)

| PR | Branch | Scope |
| --- | --- | --- |
| **#3330** | `plan-fable-ir-eval-specs` | IR ratchet: #2855 (umbrella sequencing + promotion verdicts + #3341 Slice-A re-spec + #2953 residue), #2856 (last-14 capability plan: imported-callee calls / first-class fn+arrow values / module-scope mutable bindings), #2951 (class-member skip re-grounded on the #3143/#3203 allowlist; receiver-domain gap + skip-parity-escalation hazard), #1930 (Slice-3 salvage + V1–V8 verdict table recorded on main), #1066 (eval re-chartered as Tier 1w vs the ladder doc; §14-aligned WIT with `js-env` resource) |
| **#3334** | `plan-fable-mop-specs` | Standalone builtins/MOP: #2963 Phase 2 (dispatch-fix prerequisite OBSOLETE — all-externref reified-closure convention; tiered real-bodies worklist), #2916 Slice B/C (B0 `$BuiltinCtor` branded `$Object` subtype substrate + `__instanceof_check` RHS ladder), #2622 (`$MapSub` branded subtype of `$Map` composing with the #2917/PR-#3324 real-backing authority), #2651 (M3 stays parked on #2580; intrinsic-VALUE half = #2916 B0, build-once/consume rule) |
| **#3337** | `plan-fable-gap-specs` | #2860 fresh census + ladder; value-rep trio #2141 / #2106 / #2763 |

## Load-bearing findings (the things a successor must not re-derive)

1. **LIVE miscompile on main (task #1 in TaskList, unclaimed):**
   `isI32SafeExpr` minus-arm (`src/codegen/function-body.ts:453-456`) accepts
   unary `-x` → `Object.is(-x, -0)` wrong. The FIX EXISTS on stranded branch
   `upstream/issue-1930-slice3-i32-matchers` @ `724c272065` (2026-07-02, never
   PR'd) with the full three-question doctrine. Salvage = extract-onto-fresh-
   branch, never merge the stale branch. Spec in #1930's plan.
2. **#2860 honest gap is 8,231** (baselines `5c6d3092`, compiler `9d216ada`):
   generators+Promise leaks ≈ 2,546 (#3178, rank 1), TypedArray ~960,
   property model ~550, Array ~512. `__dynamic_import` (107) has NO owning
   child — PO decision open (recommend #1046 later phase). No new child
   issues warranted; nine-slice 07-12 cut stands, re-weighted.
3. **Flag/regime state verified 2026-07-18:** `undefinedSingleton` default
   TRUE (#2106 singleton half SHIPPED; #3331 audit done);
   `tag5ValueEqClassifier` default TRUE (#2141 S3a done via #2040 A1);
   `honestAnyBoxing` default false (#2141 S4 = the remaining flip, gating
   #745 S5 and shrinking #3053 U3b); `unionAnyRep` opt-in (#745 S2–S4
   landed 07-16).
4. **Cross-issue substrate rules established in the specs:** #2916 B0
   `$BuiltinCtor` is the ONE branded ctor-carrier — #2651 M3 and #2622
   consume it (never mint a second); `body-shape-rejected` is NOT promotable
   to STRICT at corpus-zero (verdict table in #2855, per the #3341 re-scope);
   #3037 CS3 is answered by #3053's U3/U3b/U4 ladder — do not spec it again.
5. **Skips with reasons (do not re-spec):** #2175 (v2 spec executing), #3037
   (CS3 = #3053 U3), #3053 (spec complete through U4), #3055 (fix gated on
   #3056), #2917 (PR #3324 is design authority), #2773 (fable-2773t
   executing), #745 (fable-gamma executing; S5 gated on #2141).

## Open threads left for the lead

- Sprint worktree `plan-fable-final-sprint` has one unpushed local catch-up
  merge of upstream/main (conflicts resolved to main's side) — push or drop.
- #2106: recommend close-out after the N1–N3 numeric-carrier leg (or split
  it out); stale `assignee: ttraenkler/opus-regexp` should be cleared.
- #2860 PO decision: `__dynamic_import` ownership.
- The #1930 salvage task is the highest-value small item on the board (a
  real correctness fix, already written, ~S to land).
