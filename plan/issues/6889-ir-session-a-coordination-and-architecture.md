---
id: 6889
title: "Publish Session A IR coordination and durable architecture guidance"
status: in-progress
sprint: backlog
created: 2026-10-07
updated: 2026-10-07
priority: high
horizon: s
complexity: M
feasibility: medium
reasoning_effort: medium
task_type: documentation
area: ir, architecture
language_feature: compiler-internals
goal: ir-full-coverage
model: gpt-6.1-sol
parent: 3518
related: [3029, 3030, 6837, 6865, 6888]
files:
  - plan/issues/6889-ir-session-a-coordination-and-architecture.md
  - plan/log/ir-coordination-session-a.md
  - docs/architecture/target-architecture.md
---

# Publish Session A IR coordination and durable architecture guidance

Session B needs a repository-visible handoff that can be read on another
machine. Session A's local worktrees, chat and ignored evidence are not a
published coordination contract. The user also requires clean, nonduplicated
IR code with cohesive module boundaries, shared semantics and analyses, and
target-specific implementation details behind explicit contracts.

Complete IR behavior, native execution, artifacts and performance remain the
goal. Legacy stays until full parity is established. Publishing this document
does not deliver the local compiler packets or authorize retirement.

## Verified starting authority

- This documentation worktree is
  `/private/tmp/js2-ir-session-a-coordination-20261007`, branch
  `codex/ir-session-a-coordination-20261007`, base/HEAD
  `e7760d1c2af4636ede6a352154d193b234af5fc4` at specification time.
- Canonical assignment commit `3bfd8f46a4` contains `6889.json` with
  `status: in-progress`, owner `ttraenkler/codex-ir-session-a-20261007`,
  the branch above, and write ID `17627-eh9a4kyw`. Claim operations use
  `CLAIM_ASSIGN_REMOTE=upstream`. Astra writes this issue under root's
  delegation; Sol GPT-6.1 Medium implements the documentation sequentially.
- The SAME assignment commit contains the distinct slice file
  `6888-linear-plan-20261007.json`, owner
  `ttraenkler/codex-linear-b-astra-plan-20261007`, status `in-progress`,
  branch `codex/6888-linear-spec-20261007`, write ID `22703-3p7d2b9h`.
  Its separate `6888.json` is merely reserved. Preserve both facts; do not
  confuse the reservation with the active slice claim.
- Root reported no matching branch ref on upstream or the fork at its last
  observation. That is a dated availability observation, not proof that the
  foreign work is absent. The owner label does not establish Session B's
  identity, source-file ownership, agreed scope or readiness. Those remain
  unconfirmed until an actual published scope or direct coordination evidence
  exists. Never overwrite or release the foreign claim.
- No publication is claimed by this specification. Root owns integration,
  evidence reconciliation, shared metadata/C1 and delivery verification.

## Implementation Plan

### 1. Publish one useful cross-machine handoff

Create `plan/log/ir-coordination-session-a.md`. Lead with the full migration
goal, the current canonical-main observation and the publication status. Keep
the document readable without this conversation or local absolute paths.
Link this issue and the existing
[target architecture](../../docs/architecture/target-architecture.md),
[IR coverage goal](../goals/ir-full-coverage.md) and
[backend independence goal](../goals/backend-agnostic-ir.md).

Use a compact table for each active Session A slice: issue ID and actual
title; canonical claim filename/slice and owner; branch/base/head;
exact owned paths and functions; source-packet identity; latest coherent
test-input/source epoch and evidence location; state; next owner/action.
Separate delivered-on-main, published-unmerged, frozen-local and active-local
rows. A passing local packet belongs in its local state, never in delivery.

Obtain current facts from root's frozen receipts and actual canonical claim
records before filling the table. Do not read a worker's mutable fault state
or infer current success from an earlier packet. Record HEAD plus source
hashes when uncommitted changes exist: HEAD alone does not identify a test
epoch. Include exact test population/identities, completed/failed/skipped
counts, terminal exit, command/options/runtime and custody receipt where
available. Mark missing evidence explicitly. Do not extrapolate results from
another backend, a static route count or a partially completed run.

The handoff must cover these presently separate responsibilities without
inventing their final implementation status:

- Source capture: `src/ir/program-source.ts`, notably
  `createSourceMapProjector`, `currentSnapshot`, `normalizationZero` and
  `projectForHead`; associated closed inventory/validator/position-reader
  contracts and the frozen source-scope tests, with their actual owners.
- For-clause semantics and source-scope composition: exact claimed
  `src/ir/select.ts` / `src/ir/from-ast.ts` functions and frozen test packet.
- GC source-map final association: `src/ir/integration.ts` installation and
  finalizer, `src/codegen/peephole.ts:peepholeOptimize`, and root's
  `src/codegen/index.ts` finalization seam. Distinguish a passive probe from
  an implemented repair.
- Linear emission reporting: `src/codegen-linear/index.ts` producer-owned
  per-module report and root's `src/compiler.ts` result construction.
  No attribution from a global last-report observer.
- Requested producer indexing: source/donor/span lookup and immutable-text
  work in `program-source.ts`, with all live currentness guards preserved.
  Static operation-count reasoning is not measured performance parity.
- Remaining genuine assignment-pattern for-of and numeric console-provider
  requirements remain open until their own source/native/artifact evidence
  exists. Shared proof/metadata work stays held until root freezes the final
  functional source epoch.

Use root's latest coherent result, retaining previous red identities and
their causes as historical evidence. In particular, do not erase the original
public L/A fixtures, convert unsupported semantics into accepted fallback, or
claim the documentation fixes any of those failures. The older delivered
handoff is historical; do not copy its obsolete main hash or counts as current.

Publish a concise, sufficient evidence summary in the tracked handoff. Local
`.tmp` paths may be supplementary provenance, but cannot be the only source
for decisions another machine must make. Where a full frozen packet is not
published, include its exact identity and say it is unavailable remotely;
root must arrange a bounded tracked attachment in a separately owned scope
if another implementation actually depends on its contents. Do not copy a
large ignored tree or add broken links to uncommitted issue files.

### 2. Make coordination explicit without inventing agreement

Add a Session B section with the exact observed slice record above, observation
commit/time, and independently observed branch/PR availability. Label identity
and concrete source scope unconfirmed. Record any later acknowledgment with
its real reference before declaring a partition agreed.

State how a subsequent agent safely continues: read this handoff and the
current issue; verify canonical main, full open-PR file lists and exact
upstream claim records; compare file AND function overlap; claim a genuinely
disjoint slice or ask the actual owner to compose it. Shared compiler/index,
metadata and proof writers remain serialized by root. Branch-name similarity,
the word "linear", an issue reservation, or an absent remote ref do not
authorize taking over somebody else's work. Do not message external parties
or publish GitHub issue comments as part of this task.

### 3. Persist the reusable architecture rule in the existing design

Amend `docs/architecture/target-architecture.md` adjacent to "Target directory
layout" and "Reviewable". Preserve existing normative contracts and historical
tables; add a dated subsection linking this issue rather than creating a
competing architecture document. The handoff should link this single rule.

Required content:

- Put shared IR contracts, language semantics, analyses and verification in
  cohesive generic modules. Target-neutral does not mean language-neutral:
  JavaScript semantics may remain explicit without embedding Wasm-specific
  physical types, indices, memory layouts or provider wiring.
- Put WasmGC representation/lowering details and linear-memory
  representation/lowering details in their respective target modules behind
  declared contracts. Eventual C or LLVM backends are illustrative extension
  directions, not implemented capabilities, newly committed projects or a
  reason to introduce speculative interfaces now.
- Keep optimization passes such as inlining and dead-code elimination in
  dedicated optimization modules with explicit inputs, outputs, effects,
  prerequisites, analysis invalidation and verification boundaries. Shared
  algorithms must have one implementation; separate target-specific
  legalization from generic optimization semantics.
- Grow cohesive subfolders around responsibilities rather than adding large
  switches to already oversized files or duplicating helpers in consumers.
  Reuse existing authentic contracts and bounded analyses. Shared interfaces
  must not become generic callback/plugin escape hatches or let detached
  replay import TypeScript/frontend execution.
- Extraction is incremental and issue-scoped. First identify readers,
  writers, source owners and concrete dependency direction; extract one
  cohesive responsibility with a narrow API and compose against current
  main. Preserve observable behavior, provenance/currentness, error types
  and performance evidence. This task performs NO mass relocation, rename,
  framework installation, schema change or compiler implementation.

Add concrete extracted-module review questions: Is this shared semantics or
target representation? Is there already an authoritative implementation?
Are imports/cycles and source-free replay obligations correct? Are mutations
and analysis invalidation explicit? Does the API preserve ownership and fail
closed on missing evidence? Do both actual backend controls and affected
native/artifact tests pass at the same source epoch? Is any performance claim
measured with retained failures and provenance? Distinguish these review
requirements from already implemented CI enforcement; invent no new passing
gate. Astra supplies hard plans before Sol GPT-6.1 Medium implementation.

### 4. Validate and publish through the existing delivery process

This is a documentation-only patch. Sol checks its exact three-file scope,
Markdown formatting, relative links, factual provenance and claim/epoch
consistency. Use applicable normal repository checks/hooks; do not run
compiler suites or benchmarks just to publish prose. Do not update baselines,
waivers, source seals or claim unrelated functionality passes.

Before publication, root checks for an existing appropriate ready PR and
unrelated changes. Update that PR only when its actual ownership/scope fits;
otherwise publish this isolated branch to the verified fork and create one
ready PR targeting canonical upstream main. Preserve normal commit/push
hooks, signatures and branch protections. Verify Thomas Tränkler's author
identity and use Codex co-authorship with the actual Sol GPT-6.1 Medium model
trailer. Never force-push, push directly to main, bypass a hook, manually
override a protected queue or create a duplicate PR. Attach the created PR
to the task and report its real URL and immutable commit identity so Session
B can read the handoff before merge.

The PR/branch publication is a handoff milestone. Only a verified merge
commit on current `upstream/main`, with the intended file contents present,
earns main-delivery credit. Leave any not-yet-known PR/merge identifier
explicitly pending; a documentation commit cannot contain its own future
hash. After merge, root records observed delivery in the next normal update
and reconciles this claim through the standard process. Never mark the full
IR migration or other active source claims complete because this docs PR lands.

## Acceptance

- [ ] Cross-machine handoff contains actual claims, concrete path/function
      ownership, source/test epochs, residual failures and publication states.
- [ ] Session B's observed record is retained without invented identity,
      agreement, branch contents or authority to take over its work.
- [ ] Existing target-architecture document contains the reusable modularity,
      shared-semantics, target-boundary and separate-optimization guidance.
- [ ] C/LLVM are identified only as possible future target examples; no new
      implementation scope, mass relocation or legacy retirement is claimed.
- [ ] Exact documentation scope and ordinary checks pass; the handoff is
      published on the fork through a ready PR with its real URL provided.
- [ ] Main delivery is separately verified by merge ancestry and actual file
      contents; local compiler/proof claims remain distinct and unchanged.

## Specification handoff

Astra authored this implementation plan on the isolated base recorded above.
Once root receives the frozen file hash, ownership of this issue passes
sequentially to the documentation implementer. No tests, commits or publication
were performed by the architecture task.

## Documentation implementation checkpoint (2026-10-07)

The scoped writer prepared `plan/log/ir-coordination-session-a.md` and the dated
module-boundary guidance in `docs/architecture/target-architecture.md`. The
handoff records the actual 16 held IR claims, eight current-day scopes, root's
unpublished 45-file checkpoint, distinct test epochs and positive failures. It
preserves foreign 6888 uncertainty and links only repository-visible documents.

Root review, normal signed documentation commit, fork publication and the actual
immutable commit/PR reference remain pending. This issue remains in progress;
no compiler packet or migration completion is delivered by this prose.
