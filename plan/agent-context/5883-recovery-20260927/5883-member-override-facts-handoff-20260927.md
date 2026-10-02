# Exact member-override facts extraction

2026-09-27. Source-only task after reading the complete
`5883-exact-admission-activation-plan-20260927.md`. No lifecycle choice or
retry/deferred implementation is included.

Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-captured-iterator-20260927`.
Branch: `codex/5883-captured-iterator-20260927`; base remains `608be80f6`.

## Changed paths for this extraction only

- `src/codegen/expressions/member-override-facts.ts` (new)
- `src/codegen/expressions/calls.ts` (import and public wrapper only)
- `src/codegen/expressions/member-override-scan.ts` (import and broad scan wrappers only)
- `tests/issue-5883-member-override-facts.test.ts` (new)
- `plan/agent-context/5883-member-override-facts-handoff-20260927.md` (this file)

Pure facts API accepts `(sf: ts.SourceFile | undefined, methodName: string)`:
`sourceMethodReassignmentFact`, `sourceMethodDefinitionFact`, and
`sourceMethodOverrideFacts` (assignment OR definition). The only import is the
existing ts-api shim. No compiler-context/runtime dependency, context mutation,
prototype flag, source admission, registration, or graph-wide aggregation.

The two historical walkers and independent WeakMap<SourceFile, Map<name, bool>>
caches moved intact. Missing SourceFile returns false; cached false is retained;
filename is not cache identity. Assignment accepts only EqualsToken with a
property-access LHS and Identifier member name. Definition matching retains
the broad property-callee-name rule, minimum two arguments, literal-string key
or object-literal identifier/string keys; no ambient Object/receiver check.
Nested functions and source positions are unrestricted. Computed keys and
compound assignments remain excluded exactly as before.

Public `sourceHasMethodReassignment(ctx, anchor, name)` and
`sourceHasMethodOverride(ctx, anchor, name)` signatures remain unchanged;
ctx stays unobserved. The combined wrapper preserves assignment-first short
circuiting and the second anchor.getSourceFile() lookup when needed. Receiver-
precise scans in member-override-scan.ts are untouched.

## Source verification and pending execution

Prettier formatted only the four extraction TypeScript files. Scoped diff
whitespace check passed. The wrapper diff contains only delegation/import
changes and removal of the moved walkers/caches. No compiler, typecheck,
Vitest or runtime probe was run; **0/36 authored tests executed**.

Tests copy the pre-extraction baseline walkers (only function names changed),
with independent historical caches, and compare baseline/new/preserved public
wrappers on 32 syntax fixtures, cold/cached results, and three requested names.
Four additional tests cover no SourceFile/unobserved ctx, same-filename distinct
files and reversed file order, historical cache persistence, and wrapper
source-file lookup order. Expected fixture booleans separately constrain the
baseline so agreement alone is not the sole oracle.

The test imports the existing compiler graph to initialize public wrapper
dependencies; in this isolated tree that graph still requires B's missing
iterator-protocol-get module through previously frozen D/A. The NEW pure facts
module itself has no such dependency. Parent can integrate these three source
files independently of any lifecycle work, then run the equivalence suite in
its integrated tree when a serialized slot is available.

Frozen D's four file SHA-256 receipts were rechecked and match the D freeze
handoff exactly. A/D sources and tests, B/Huygens runtime files, existing
fixtures/gates and unrelated Acorn changes were untouched by this task.
No commits, push, merge, or new lifecycle hooks.
