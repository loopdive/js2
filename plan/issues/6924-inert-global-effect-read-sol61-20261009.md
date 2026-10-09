---
id: 6924
title: "Finite inert global effect-read implementation"
status: in-progress
sprint: current
created: 2026-10-09
updated: 2026-10-09
task_type: bugfix
area: codegen
reasoning_effort: high
parent: 6922
---

# #6878 inert global effect-read capability — G-only repair

Historical6878 lane marker; canonical issue identity is #6924, distinct from
delete-result PR6548. Historical source names, receipts and assertions below
remain unchanged; this metadata correction does not claim completion.

Status: Sol6.1 High source-only, 2026-10-09. Root explicitly reopened ONLY
src/codegen/analysis/local-number-carrier-proof.ts effect-read context/predicate,
NEW tests/issue-6878-inert-global-effect-read.test.ts and this NEW MD. Not alone:
preserve root/peer/upstream IR and all original fixtures. K helper4121/4122 and N
parent contract remain HOLD. No receiver-domain/parent/ABI/runtime edits.

## Pre-edit implementation plan and source inventory

Read complete frozen437-line Astra repair plan SHA
6bddd2806c7897fb6e960e8e6a180c5ffbcf1f73304506cb66ced9ba3392c996,
applicable repo operating context, original carrier leaf/global identity and closed
effect traversal, original G/N/K fixtures and retained diagnostic epoch receipts.

Production preimage carrier SHA
fc05d8d63b6cc76bc99513aa3a0941642f2630f1215fa44cb8613614e9f17f55.
Read-only receiver636df25aecc363784653ec6a099b691249c521b63b2ccbd3f2a810a64e2fdb5c;
numeric parent9a4542603c069e87b8539dd26fccee19c83cc1558a2ccb0acdccd9381fdca53a.

Add a PRIVATE isInertGlobalRead callback to StringEffectContext. Supply it from
makeLocalCallableDomain, permitting ONLY NaN/Infinity/undefined data-read spellings
AND existing isKnownGlobal exact-library identity/no-shadow/no-write checks. No
name-only or unresolved positives. Missing undefined declaration remains declined;
do not synthesize a global binding or widen library identity. Replace only
identifierSafe's blanket isKnownGlobal read acceptance with this finite capability.
Do NOT redefine isKnownGlobal or change its conversion/member/prototype readers.
CallSafe's dedicated Number/String/Boolean and Math/Date contracts remain intact.
Existing lexical reads and source callable declarations remain unchanged.

Readers: both legacy String completion and assisted bridged P2 completion receive
the same private context. Primitive identity and String key stability remain separate;
R.withQuery final effects/expiry remain mandatory and unchanged. The new read vote
reads original declaration/scope/source shadow/mutation facts; it does not modify
ASTs, oracle caches, incoming calls, eligible parameters, grounded/candidate Sets,
public numeric/property/function publications or runtime state. No new caches.

Add acceptance controls paired on exact unchanged constructor String specimen and
explicit module-context literal String specimen. Cover exact external, distinct
unbound, explicit source ambient, library host-object/member/getter reads; lexical
source positives; NaN/Infinity/undefined; supported conversion/Math/Date calls;
same-named shadows, direct/reflective mutations and String requested/unrelated keys.
No native expansion needed for this source-analysis capability. Original124's
external expectation=false stays byte-identical and authoritative.

## Diagnostic provenance retained, not acceptance expectations

Epoch3 root TERMINAL29470 exit1/3c3ff1,18 unique14PASS/4FAIL/0pending; JSON SHA
b0320c582261d3fdd9019dc4d57632adf42ef1981e8983137f9d3c619fb8e491.
All4 native visits reached500500. Default var/let f64 pass; both off0 actualf64
expectedexternref fail. Two original script-context identity failures remain.
All4 earlier compiler errors disappeared with ONLY the diagnostic static-to-dynamic
helper-import change. This is matched instrumentation-context attribution; complete
transitive module evaluation order was not traced. No universal compiler regression
is claimed from epoch2's errors.

Retained diagnostics fixture is a pre-repair observation epoch, not final acceptance.
Its bad-baseline numeric expectations are NOT modified under this G assignment.
It requires later explicit publication disposition (retain as historical artifact
or separately authorized update/removal). Do not weaken original124 to match it.

## Execution boundary

Root alone formats/typechecks/tests/native/gates and performs source-removal epochs.
Writer does only manual source review, rg/hash/diff and apply_patch. No parser/AST/
compiler/test/install/build/native/gate/format job, commit/push/PR. Freeze source,
new fixture and this MD; all row results and G-only attribution remain UNKNOWN
until root's additive plus original matched runs. No K/N source hunks authorized.

## Additive row population, deferred obligations and freeze handoff

Fixture intended52 unique registrations:24 read/effect rows independently paired
on original constructor and module-marked literal sources (48),3 dedicated legacy
intrinsic-context positives,1 exact original external declaration control. No native
compiles/profiles in this fixture. EXACT original String body is copied without
annotations or renaming; default analysis options and original .ts file name match.
Every row reads actual public verdicts and original AST/declarations. SourceFile
identity receipts/assertions are boolean, never a large-object reporter diff.

The2 safe undefined read rows retain DESIRED positive expectation=true and are
explicit deferred identity obligations, not tests defending a permanent rejection.
Their actual original oracle provenance is logged. If it is absent, this bounded
implementation safely declines; those positive rows may FAIL and require a
separately justified identity proof, not spelling-only admission. No claim of52
passes or of completing undefined support is made before root execution.

Supported Number/String/Boolean and Math/Date calls pin desired positive=true on
the existing legacy literal-module path. No paired constructor false-expectation
was added to defend R's current incomplete inert-call perimeter: source review
finds R.safeCall's library-binding/function lookup and non-String member restriction
may decline those safe calls, and R.safeWrite rejects unrelated intrinsic-prototype
writes. These paired constructor desired-positive obligations remain UNACHIEVED/
UNKNOWN execution, not permanent desired rejections and not authority to modify R.
Root queued a separate Astra plan for that scope. Original requested/unknown String
key mutations, ambient/getter effects and unsupported handles remain negative
capability controls. Lexical Number/NaN data reads remain supported source values.

N public diagnostic result=false versus completed R specimen=true does not resolve
the absent parent candidate/broad contract; K var/let off0 still f64 does not satisfy
desired externref. Both remain HOLD and no change was made to their source/fixtures.
Retained pre-repair diagnostics are not acceptance fixtures and will predictably
need later publication disposition after this G repair; do not change their bad
baseline expectations within this source epoch.

Exact source hunk inventory:1 private context field; identifierSafe now consults
finite inert read capability instead of blanket isKnownGlobal;6-line private
predicate/comment in makeLocalCallableDomain;1 context supply. isKnownGlobal body,
primitive/value/call/prototype/member identity arms, both completion perimeters,
live query callback construction and all source scans/mutation facts unchanged.
This capability is not returned as a new public host API or candidate vote.

Requested minimal root command, in this tree with provisioned Node:
`node node_modules/vitest/dist/cli.js run tests/issue-6878-inert-global-effect-read.test.ts --no-file-parallelism --reporter=verbose`
Retain52 unique fullNames/status/first errors plus `[6878-inert-global-read]`
declaration/source receipts. Then root's unchanged489-row manifest matched diff
against471PASS/18FAIL baseline, and G-only source removal/restoration epochs.
Root alone formats/typechecks/gates; no results inferred from source inspection.

Manual source readback covers all changed production hunks and the complete120-line
new fixture. Carrier1196 lines SHA
3279e740d883d193b444f96b789749096dfaf41902105bd8390ea0e83e7a014d.
Receiver636df25a/parent9a454260/original1246f6534bd/P21883d68faba/
R11588431b10/original412206919e20 independently hashed unchanged. All original489
assertions are preserved; root's nine-file manifest owns the complete matched floor.
No allowance, policy, grant or baseline edit. All52 row outcomes UNKNOWN pre-run.
Fixture SHA da22d6ad4f31fc84c4487e1f06dd753feb3cf1d5c6520e7764bde69a522dfc78.
Fail-closed Number-local nonadmission is not a claim that runtime undefined is
unsupported: existing boxed semantic lowering must remain available, unmeasured
in this analysis-only epoch. No runtime/conformance completion claim is made.
