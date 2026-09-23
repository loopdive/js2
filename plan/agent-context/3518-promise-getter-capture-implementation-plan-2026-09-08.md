# Capture ordinary then once during Promise resolution

High-reviewed implementation contract; implementation delegated to Pauli
(native Astra Low), in a fresh worktree on PR #5765,
`a7fbc6eb6fa8ebcde29529d67e55408592672fee`.

## Evidence and intended behavior

Public comparison controller76198 completed both arms and all24 pairs.
Preservation passed, but semantic acceptance failed on both arms: an ordinary
then getter was read twice and its replacement invoked. The recorded source
baseline and frozen extraction candidate remain immutable. See the adjacent
public result JSON and preflight document for exact identities and scope.

Resolution must synchronously capture the first callable then, enqueue it,
and later invoke that same callable with the original peeled receiver.
Expected trace: getter1, original invocation1, replacement invocation0,
delivered value42, trace1324. Matching the previous wrong result is not success.

## Implementation ownership

Pauli owns `src/runtime/wasmgc/promise/thenable-bodies.ts`,
`src/runtime/wasmgc/promise/resolution-bodies.ts`,
`src/codegen/async-scheduler.ts`, `src/codegen/closed-method-dispatch.ts`,
and focused regression/preservation tests. Parent coordinates the separate
native resource lookup-signature adaptation; no concurrent shared-file edits.

1. Reserve and fill `__promise_lookup_then(externref)` with two results:
   an i32 callability indicator and the captured externref callable.
2. Return the exact callable from the first accessor, field or open-object
   read. Use function-local multi-results, never global scratch, a second Get,
   or an extra capture allocation.
3. Store the captured callable in the existing capability callback field.
   The queued job invokes it through the real applyClosure path with the
   original peeled receiver.
4. Preserve thrown-getter reason identity, synchronous Get versus queued
   invocation timing, native Promise adoption and compiled-method dispatch.

## Verification and landing

- Test capture/replacement, poisoned and noncallable getters, receiver identity,
  two pending resolutions and reentrancy.
- Preserve original donor hashes and the49-control population. Explicitly
  assert intentional behavior deltas rather than silently reseeding history.
- Keep the original public comparison receipts; verify the repaired candidate
  against independently stated semantic expectations, not raw parity alone.
- Freeze changed source identities for parent High review. Serialize heavy
  tests with parent; use normal commit/push hooks and a non-draft upstream PR.

This fix does not establish full native resource filling, prepared-consumer
cutover, strict compiler closure, or direct-codegen retirement. Those remain
separate required migration work.
