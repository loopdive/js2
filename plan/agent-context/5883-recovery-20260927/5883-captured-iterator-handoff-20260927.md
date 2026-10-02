# Lane A: captured Promise vector iterator handoff

2026-09-27. Source implementation complete; compilation/runtime acceptance NOT measured.

Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-captured-iterator-20260927`.
Branch: `codex/5883-captured-iterator-20260927`.
Base/HEAD observed: `608be80f6beef338665fdcdb834e7d9b9f20b925`.
Contract: full lane A of `5883-acquisition-captured-next-plan-20260927.md`.

## Changed paths

- `src/codegen/promise-vector-iterator.ts` (new).
- `tests/issue-5883-promise-vector-iterator.test.ts` (new).
- `plan/agent-context/5883-captured-iterator-handoff-20260927.md` (this file).

No shared protocol, central iterator, legacy Promise, drive, fixture, budget,
or acceptance-gate file was edited. Existing modified
`website/public/acorn/acorn.wasm` was left untouched. No Git mutation,
commit, push, or merge. The initial normal status hit an LFS sandbox write
error; subsequent status disabled the LFS filter for that read only.

## Implemented contract

`ensurePromiseVectorIteratorRuntime(ctx, fctx): void` reserves/emits:

- `__promise_vector_iterator_acquire(externref) -> externref`.
- `__promise_vector_iterator_step(externref) -> (i32, externref)`.
- `__promise_vector_iterator_close_throw(externref, externref) -> externref`.

The sole record construction captures the exact iterator, exact once-read next
value, and false done bit. No callability validation of next occurs in acquire.
Acquisition uses genuine boxed well-known Symbol.iterator (id 1), semantic Get,
`__is_callable`, and the normal `__apply_closure` bridge with an empty
`__objvec_new` argument vector. Object validation uses `externIsObjectInstrs`,
including function objects and excluding null/primitives.

Step invokes the captured next with the actual iterator receiver, reads done
once using the existing `__is_truthy` ToBoolean provider, skips value on terminal
results, and returns canonical undefined for done. Its JS-tagged handler marks
the record done and rethrows the identical reason for next/result/done/value
failures. The already-done path calls no user code.

Close marks done before late Get(return), treats null/undefined as absence,
checks other values for callability, and calls with the actual iterator receiver
and zero arguments. Original reason remains in parameter-local 1 across user
calls. Return results are discarded without done/value reads or awaiting.
Only the JS exception tag is caught; Wasm traps/unrelated tags escape.

Registration warms all allocating dependencies before private type/handle
reservation and detached body construction, flushes with the active fctx,
resolves callees by name, and emits each body once. Each instruction occurrence
is fresh. Per-context phases are registering/reserved/emitted/failed. Reentry
after reservation is idempotent; a forbidden dependency cycle before reservation
throws explicitly instead of returning absent handles. Failed registration is
not subsequently treated as success. No runtime scratch is module-global.
The private struct has no entry in generic JS `structFields` metadata.

## Integration dependencies and source witnesses

B's `src/codegen/iterator-protocol-get.ts` is intentionally absent in this
checkout. The source imports its agreed `ensureIteratorProtocolGetRuntime(ctx,
fctx)` and requires `__iterator_protocol_get(receiver,key) -> externref`.
No fallback facade or stub was created. Parent must integrate B before even
loading this module for compilation.

C must wire reflective VALUES to the real live producer. D must call this ensure
before constructing detached caller instructions and use these three names
through funcMap. The registration tests can run after B; the production tests
require B+C+D. Finalized predicate/call-bridge inventories must include B/C's
native callable shapes; A does not install a separate call dispatcher.

Concrete dependency witness (not executed):
`const a = [1]; a[Symbol.iterator] = () => ({next: () => ({done:true})});`
must make observable Promise.all(a) produce `[]`, not `[1]`.
Without D the real source cannot reach A at all; without B the semantic lookup
cannot resolve. This is an integration prerequisite, not a reduced A contract.

## Verification and remaining test needs

Source-only instruction honored: no compiler, typecheck, Vitest, test262, or
runtime probe was run; Huygens retains the serialized slot until parent grants
otherwise. Prettier formatted only the two new TypeScript files.

The new suite defines 56 cases, **0 executed / 56 authored**:
two registration/IR identity checks plus 27 cases for each of all/race.
Coverage includes private/unexported/idempotent registration, no shared Instr
identities or catch-all, invalid/throwing iterator methods, callable iterator
and result objects, truthy done, captured-next mutation, exact receiver/arity,
six primitive iterator results, six acquisition/step error forms with no close,
and eight late-return/close precedence variants. Production tests compile real
all/race calls, check host-free instantiation and no private helper exports;
they do not fabricate a production caller or claim full reachability proof.

Parent still needs serialized type/build/runtime validation and fixes indicated
by those results. In particular run the new suite after integration; exercise
direct repeated step-after-done and close-twice behavior with a focused substrate
harness if needed; validate nested/reentrant close reasons and JS-tag vs Wasm
trap distinction; test late-import shifts with a nonempty active/saved caller
body and registration-cycle failure. Run the exact plan's full P/C/L/S matrix,
immutable twelve sources, DCE/type/stack/zero-import and preservation checks.
No passing count, source-budget grant, or acceptance claim is implied.
