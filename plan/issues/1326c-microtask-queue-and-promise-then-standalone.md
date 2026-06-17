---
id: 1326c
title: "Async standalone Phase 1C: microtask queue + Promise.then chained-resolution (follow-up to #1326 Phase 1B)"
status: done
created: 2026-05-08
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/se1
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: async, promises
goal: standalone-mode
sprint: 62
depends_on: [1326]
required_by: [1373b]
---
# #1326 Phase 1C — Microtask queue + Promise.then standalone

## Background

Phase 1B (PR #323) shipped:
- `$Promise` WasmGC struct registry
- `Promise.resolve(v)` / `Promise.reject(r)` standalone path (no JS host)
- Auto-enabled via `ctx.wasi === true`

Phase 1B intentionally left `emitMicrotaskEnqueue`, `emitDrainMicrotasks`,
and `emitStandalonePromiseThen` as throwing stubs. This issue tracks
their implementation.

## Constraint discovered during 1B implementation

The architect's original ~250 LoC estimate for Phase 1C
("microtask queue + Promise.then") **understated the difficulty of the
chained-resolution machinery**. Three concerns surfaced:

### 1. Closures aren't raw funcrefs

js2wasm's user-callbacks (`fn` in `.then(fn)`) are GC closure structs
(`__fn_wrap_N_struct { funcref, ...captures }`), routed through
`__make_callback` for host-callable interop. In WASI standalone mode
there's no host, so the queue must:
- Store the closure-struct ref (as externref or as a typed ref).
- At drain time, `ref.cast` back to a known closure-supertype struct,
  `struct.get $func`, then `call_ref` with `(closureRef, value)` as args.
- This is a **per-closure-signature dispatch problem**: `(closure, externref) → externref` is the
  generic shape, but each user lambda has its own underlying funcref
  signature, so the drain can't just call all callbacks uniformly.

### 2. Chained-resolution requires synthetic wrapper closures

`Promise.resolve(v).then(fn)` returns a NEW pending promise that must
transition to FULFILLED once `fn(v)` completes. To support this:
- Each `.then` call site must synthesise a wrapper closure
  `(value) → { let r = fn(value); chainedPromise.state = FULFILLED;
   chainedPromise.value = r; }`.
- The wrapper closure captures `fn` AND `chainedPromise`; it's
  registered as a Wasm function and stored in the queue.
- Acceptance criterion #2 (".then() chaining runs in correct microtask
  order") strictly requires this — without it, only the first .then's
  callback runs; subsequent .then calls see a still-pending promise
  and never resolve.

### 3. Multi-arity vs uniform-arity callbacks

The microtask queue can only practically hold uniform-shape entries.
Either:
- (a) ALL standalone .then callbacks have signature
  `(externref) → externref` (the value comes in as externref, the
  result goes out as externref); user lambdas of different arity get
  adapted by per-call-site wrappers.
- (b) The queue stores both the callback shape AND the arg shape; the
  drain dispatches via a `call_indirect` against a function table.

Approach (a) is simpler — mirrors how `__make_callback` already
unifies all JS-host callbacks to a single shape. Recommended.

## Strategy

### Part A: Microtask queue infrastructure (~150 LoC, low risk)

Module-level state, registered lazily on first `__microtask_enqueue` use:
- `(global $__microtask_head (mut i32) i32.const 0)` — drain pointer
- `(global $__microtask_tail (mut i32) i32.const 0)` — enqueue pointer
- `(global $__microtask_funcs (mut (ref null $arr_funcref)))` — funcref slots
- `(global $__microtask_args (mut (ref null $arr_externref)))` — externref args
- Initial capacity: `MICROTASK_QUEUE_INITIAL_SLOTS` from Phase 1A scaffold.

Wasm-defined helper functions:
- `__microtask_enqueue(fn: funcref, arg: externref) -> void`:
  - If tail+1 == head OR uninitialised: grow (or allocate initial).
  - `arr_funcs[tail] = fn; arr_args[tail] = arg; tail++`.
- `__drain_microtasks() -> void`:
  - While `head != tail`: pop `(fn, arg)`, advance head, `call_ref fn(arg)`.

### Part B: Promise.then standalone path (~250 LoC, hard)

For each `.then(fn)` call site in standalone mode:

1. Synthesise a per-site wrapper Wasm function `__then_wrapper_<N>` with
   signature `(externref value) -> externref`:
   ```
   (func $__then_wrapper_N (param $value externref) (result externref)
     ;; Captures: fn (closure ref), chainedPromise ($Promise ref)
     local.get $value
     ;; call closure: ref.cast $fn_closure_struct; struct.get $func; call_ref
     ;; result on stack as externref
     local.tee $result
     ;; chainedPromise.state = FULFILLED
     global.get $__chained_N
     i32.const 1
     struct.set $Promise $state
     ;; chainedPromise.value = result
     global.get $__chained_N
     local.get $result
     struct.set $Promise $value
     local.get $result
   )
   ```
2. At the `.then` call site:
   - Read `promise.state` from the receiver.
   - If FULFILLED: `__microtask_enqueue($__then_wrapper_N, promise.value)`,
     return the new chained promise (PENDING).
   - If REJECTED: pass-through (Phase 1C doesn't handle onRejected).
   - If PENDING: append wrapper to receiver's `$callbacks` field
     (requires Phase 1C-extra: upgrade `$Promise.callbacks` from
     placeholder externref to a typed `(ref null $vec_funcref)`).

### Part C: __drain_microtasks export + WASI _start integration (Phase 1D, ~150 LoC)

- Export `__drain_microtasks` so standalone callers can invoke after the
  top-level entry.
- For WASI target: synthesise `_start` that runs user main, then loops
  `__drain_microtasks` until the queue is empty.

## Acceptance criteria

1. `await Promise.resolve(42)` returns `42` in standalone mode after
   `__drain_microtasks()`.
2. `.then()` chaining executes in correct microtask order:
   `Promise.resolve(1).then(x => x + 1).then(x => x * 2)` after drain
   yields 4.
3. Rejection propagates: `Promise.reject('err').then(_, reason => reason)`
   yields the rejection reason.
4. `tests/issue-1326.test.ts` extended with chaining tests in WASI mode.

## Files

- `src/codegen/async-scheduler.ts` — fill in `emitMicrotaskEnqueue`,
  `emitDrainMicrotasks`, `emitStandalonePromiseThen` real bodies +
  helper-func registration.
- `src/codegen/expressions/calls.ts` — wire `Promise.then` standalone
  path (gated on `isStandalonePromiseActive(ctx)`).
- `src/codegen/declarations.ts` — skip `Promise_then` host import
  pre-registration in WASI mode.
- `tests/issue-1326.test.ts` — extend with .then chaining tests.

## Why this is harder than the original spec estimated

The architect's spec at `1326-async-microtask-queue-wasm-scheduler.md`
described funcref→i32 table machinery as "trickiest bit". After Phase 1B
implementation experience, the actual hardest piece is the **chained-
resolution wrapper closure synthesis**, not the table machinery.
Reusing `__make_callback`'s funcref-id handling doesn't help when
`__make_callback` itself isn't available in WASI mode.

The architect should re-read this constraint section before estimating
Phase 1C subtasks.

## Implementation Plan

### Root cause

Phase 1A registered the `$Promise` struct + the `__arr_externref` queue arg
type and parked three throwing stubs (`emitMicrotaskEnqueue`,
`emitDrainMicrotasks`, `emitStandalonePromiseThen`). Phase 1B wired
`Promise.resolve` / `Promise.reject` as standalone struct-new emitters,
but `.then(fn)` is still routed through the `Promise_then` host import
(`src/codegen/expressions/calls.ts:3794`). In WASI mode that import is
unsatisfiable, and even if it were, there is no host event loop to
schedule the callback. Phase 1C needs to (a) materialise the microtask
queue, (b) compile `.then(fn)` to Wasm-native enqueue + chained promise
construction, and (c) drain the queue before the program exits.

The hardest part is **closure invocation in pure Wasm**: the JS-host
`__make_callback`/`Promise_then` import is doing all the dispatch work
today. In standalone mode we must reuse the GC closure struct path
(`compileArrowAsClosure`, `__fn_wrap_N_struct`) instead, then wrap each
`.then` site in a synthesised continuation function that closes over
both the user callback and the new chained promise.

### Design overview

```
┌──────────────────────────────────────────────────────────────┐
│ Module-level state (registered lazily by ensureMicrotaskQueue) │
├──────────────────────────────────────────────────────────────┤
│ globals:                                                     │
│   $__mt_head   (mut i32)      = 0                            │
│   $__mt_tail   (mut i32)      = 0                            │
│   $__mt_cap    (mut i32)      = 0     ; current capacity     │
│   $__mt_funcs  (mut (ref null $__arr_mt_func))   ; funcrefs  │
│   $__mt_caps   (mut (ref null $__arr_externref)) ; captures  │
│   $__mt_args   (mut (ref null $__arr_externref)) ; values    │
│                                                              │
│ types:                                                       │
│   $__mt_func_type = func (param externref externref)         │
│                          (result externref)                  │
│   $__arr_mt_func  = array (mut funcref)                      │
│   $__arr_externref already exists from Phase 1A              │
│                                                              │
│ functions:                                                   │
│   $__microtask_grow      (i32) -> ()                         │
│   $__microtask_enqueue   (funcref, externref, externref)→()  │
│   $__drain_microtasks    () -> ()                            │
│   $__then_wrapper_<N>    (externref, externref) → externref  │
└──────────────────────────────────────────────────────────────┘
```

Three parallel WasmGC arrays — not linear memory. Reasons:
- The args and captures must be externref (GC-rooted automatically).
- Funcref slots cannot live in linear memory anyway.
- Phase 1A already chose array-of-externref for the args buffer
  (`getOrRegisterMicrotaskQueueType` returns the externref array type).
  The "8 bytes per slot" comment in `async-scheduler.ts:34` is stale —
  it described an earlier table-of-funcrefs design that wasn't shipped.
  Phase 1C should replace that comment when wiring the real queue.

### Changes

#### 1. `src/codegen/async-scheduler.ts` — fill in the stubs

##### 1a. Extend `AsyncSchedulerState`

Add fields cached across emit calls so each call site re-uses the same
registered indices:

```ts
export interface AsyncSchedulerState {
  promiseTypeIdx: number;
  microtaskArgsArrTypeIdx: number;          // existing (externref array)
  microtaskFuncArrTypeIdx: number;          // NEW — funcref array
  microtaskFuncTypeIdx: number;             // NEW — (externref,externref)→externref
  microtaskHeadGlobalIdx: number;           // NEW — head pointer
  microtaskTailGlobalIdx: number;           // NEW — tail pointer
  microtaskCapGlobalIdx: number;            // NEW — current capacity
  microtaskFuncsGlobalIdx: number;          // NEW — funcref array global
  microtaskCapsGlobalIdx: number;           // NEW — captures array global
  microtaskArgsGlobalIdx: number;           // NEW — args array global
  enqueueFuncIdx: number;                   // NEW — $__microtask_enqueue
  drainFuncIdx: number;                     // NEW — $__drain_microtasks
  growFuncIdx: number;                      // NEW — $__microtask_grow
  drainExported: boolean;                   // NEW — guard
}
```

Initialise everything new to `-1` (or `false`) in `getOrInitState`.

##### 1b. New helper: `ensureMicrotaskQueue(ctx) → void`

Idempotent. On first call:
- Register `$__mt_func_type` via `addFuncType(ctx, [{externref},{externref}], [{externref}], "__mt_func_type")`.
- Register `$__arr_mt_func` via the existing array-registration helper
  but with an explicit `mut funcref` element. If `getOrRegisterArrayType`
  doesn't accept funcref, add a new small helper
  `getOrRegisterFuncrefArrayType(ctx, mutable: true)` next to it in
  `src/codegen/registry/types.ts` (3 lines — mirror the externref array
  registration).
- Push three i32 globals (`$__mt_head`, `$__mt_tail`, `$__mt_cap`) with
  `init: [{ op: "i32.const", value: 0 }]`, `mutable: true`.
- Push three `ref null …` globals (`$__mt_funcs`, `$__mt_caps`,
  `$__mt_args`) with `init: [{ op: "ref.null", … }]`, `mutable: true`.
  Use the existing `closures.ts:3117`-style `ctx.numImportGlobals +
  ctx.mod.globals.length` index allocation.
- Emit `$__microtask_grow`, `$__microtask_enqueue`,
  `$__drain_microtasks` (see §1c, §1d, §1e).
- Store every typeIdx / funcIdx / globalIdx in `state`.
- Set `drainExported = false` (drain is exported later by Part C).

Use `MICROTASK_QUEUE_INITIAL_SLOTS = 8192` from the existing constants;
ignore `MICROTASK_QUEUE_SLOT_BYTES` (linear-memory artifact — delete
it or annotate as deprecated).

##### 1c. `$__microtask_grow(i32 newCap)` — Wasm body

```wasm
(func $__microtask_grow (param $newCap i32)
  ;; If globals are null, allocate from $newCap directly.
  ;; Else: allocate new arrays of $newCap, copy live slice [head..tail), reset head=0, tail=newLen.
  (local $oldFuncs (ref null $__arr_mt_func))
  (local $oldCaps  (ref null $__arr_externref))
  (local $oldArgs  (ref null $__arr_externref))
  (local $oldHead i32)
  (local $oldTail i32)
  (local $oldCap  i32)
  (local $i       i32)

  global.get $__mt_funcs  local.set $oldFuncs
  global.get $__mt_caps   local.set $oldCaps
  global.get $__mt_args   local.set $oldArgs
  global.get $__mt_head   local.set $oldHead
  global.get $__mt_tail   local.set $oldTail
  global.get $__mt_cap    local.set $oldCap

  ;; allocate new arrays (length = $newCap, init = null)
  ref.null func  local.get $newCap
  array.new $__arr_mt_func
  global.set $__mt_funcs
  ref.null extern  local.get $newCap
  array.new $__arr_externref
  global.set $__mt_caps
  ref.null extern  local.get $newCap
  array.new $__arr_externref
  global.set $__mt_args

  ;; If oldFuncs null, head/tail already 0 — nothing to copy.
  local.get $oldFuncs  ref.is_null
  if  i32.const 0 global.set $__mt_head
      local.get $oldTail global.set $__mt_tail
      ;; nothing to copy
      local.get $newCap global.set $__mt_cap return
  end

  ;; Copy live slice [head, tail) into new arrays starting at index 0.
  ;; (Linear; tail > head by construction — see enqueue: we grow before
  ;; wrap so we never have a wrapped queue in this implementation.)
  local.get $oldHead  local.set $i
  block $done
    loop $copy
      local.get $i  local.get $oldTail  i32.eq  br_if $done

      ;; dst = i - oldHead (compact at front)
      global.get $__mt_funcs
      local.get $i  local.get $oldHead  i32.sub
      local.get $oldFuncs  local.get $i  array.get $__arr_mt_func
      array.set $__arr_mt_func

      global.get $__mt_caps
      local.get $i  local.get $oldHead  i32.sub
      local.get $oldCaps  local.get $i  array.get $__arr_externref
      array.set $__arr_externref

      global.get $__mt_args
      local.get $i  local.get $oldHead  i32.sub
      local.get $oldArgs  local.get $i  array.get $__arr_externref
      array.set $__arr_externref

      local.get $i  i32.const 1  i32.add  local.set $i
      br $copy
    end
  end

  i32.const 0 global.set $__mt_head
  local.get $oldTail  local.get $oldHead  i32.sub  global.set $__mt_tail
  local.get $newCap  global.set $__mt_cap
)
```

Type-cast funcref array operations the same way other array opcodes
appear in the IR — they may need `as unknown as Instr` until the Instr
union grows (cf. CLAUDE.md "Key Patterns" — 158 occurrences). Add
`{ op: "array.new", typeIdx }`, `{ op: "array.get", typeIdx }`,
`{ op: "array.set", typeIdx }` to the Instr cast list if not already
present.

##### 1d. `$__microtask_enqueue(funcref $fn, externref $caps, externref $arg)`

```wasm
(func $__microtask_enqueue
      (param $fn funcref) (param $caps externref) (param $arg externref)
  ;; Lazy first-allocate / grow on full.
  global.get $__mt_funcs  ref.is_null
  if
    i32.const 8192  call $__microtask_grow   ;; MICROTASK_QUEUE_INITIAL_SLOTS
  end
  global.get $__mt_tail  global.get $__mt_cap  i32.eq
  if
    global.get $__mt_cap  i32.const 1  i32.shl   ;; double
    call $__microtask_grow
  end

  global.get $__mt_funcs  global.get $__mt_tail  local.get $fn
  array.set $__arr_mt_func
  global.get $__mt_caps   global.get $__mt_tail  local.get $caps
  array.set $__arr_externref
  global.get $__mt_args   global.get $__mt_tail  local.get $arg
  array.set $__arr_externref

  global.get $__mt_tail  i32.const 1  i32.add  global.set $__mt_tail
)
```

##### 1e. `$__drain_microtasks()`

The drain loop pops one entry at a time so that callbacks enqueued
**during** drain (chained `.then` resolutions) are picked up in the
same drain — this is what makes `Promise.resolve(1).then(x=>x+1).then(x=>x*2)`
deliver `4` in a single drain call.

```wasm
(func $__drain_microtasks
  (local $fn   funcref)
  (local $caps externref)
  (local $arg  externref)

  block $done
    loop $drain
      global.get $__mt_head  global.get $__mt_tail  i32.eq  br_if $done

      global.get $__mt_funcs  global.get $__mt_head
      array.get $__arr_mt_func  local.set $fn
      global.get $__mt_caps   global.get $__mt_head
      array.get $__arr_externref  local.set $caps
      global.get $__mt_args   global.get $__mt_head
      array.get $__arr_externref  local.set $arg

      global.get $__mt_head  i32.const 1  i32.add  global.set $__mt_head

      ;; call_ref through known signature, ignore result (the wrapper has
      ;; already stored it on the chained promise before returning).
      local.get $caps  local.get $arg  local.get $fn
      ref.cast (ref $__mt_func_type)
      call_ref $__mt_func_type
      drop

      br $drain
    end
  end
)
```

Notes:
- `call_ref` requires a non-null `(ref $T)`, hence `ref.cast`. Funcref
  is already non-null in our queue because we only enqueue valid
  trampolines. If a future enqueue path could push `ref.null func`,
  add `ref.as_non_null` after the array.get instead.
- The cast typeIdx is `state.microtaskFuncTypeIdx` (the
  `__mt_func_type` registered in §1b). Reuse it; do not re-register
  on every drain.
- Error handling: see §3 (error handling) — wrap each `call_ref` in a
  try/catch that funnels exceptions to the chained promise via the
  wrapper's own try block. Drain itself never unwinds.

##### 1f. Fill in `emitMicrotaskEnqueue`

The Phase 1A signature is preserved but the body now compiles to a
straight `call $__microtask_enqueue`. Today the helper takes
`funcRefInstrs` and `argInstrs` but no captures slot — extend the
signature to take three arrays (callers in §2 push three sub-streams).

```ts
export function emitMicrotaskEnqueue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcRefInstrs: Instr[],
  capsInstrs: Instr[],
  argInstrs: Instr[],
): void {
  ensureMicrotaskQueue(ctx);
  const { enqueueFuncIdx } = (ctx as CodegenContextWithScheduler).asyncScheduler!;
  for (const i of funcRefInstrs) fctx.body.push(i);
  for (const i of capsInstrs)    fctx.body.push(i);
  for (const i of argInstrs)     fctx.body.push(i);
  fctx.body.push({ op: "call", funcIdx: enqueueFuncIdx });
}
```

##### 1g. Fill in `emitDrainMicrotasks`

```ts
export function emitDrainMicrotasks(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureMicrotaskQueue(ctx);
  const { drainFuncIdx } = (ctx as CodegenContextWithScheduler).asyncScheduler!;
  fctx.body.push({ op: "call", funcIdx: drainFuncIdx });
}
```

##### 1h. Upgrade `$Promise.callbacks` field

Phase 1A registered `callbacks` as `externref` (placeholder). Phase 1C
needs a typed vector of pending continuations because chained `.then`
on a **pending** promise must remember the continuation until resolve
fires.

Replace the field's type with `(ref null $__vec_mt_pending)` where
`$__vec_mt_pending` is a registered struct of:

```
struct $__mt_pending_entry {
  fn      funcref
  caps    externref
  next    (ref null $__mt_pending_entry)   ; singly-linked list
}
```

(A vec/array could also work but the linked-list lets us append cheaply
without preallocating.) Registration goes in `getOrRegisterPromiseType`
under the existing struct registration logic. Bump
`ctx.structFields.set("$Promise", …)` to match the new type.

**Migration risk**: any existing code reading
`$Promise.callbacks` as externref will break. Today the field is only
written (to `ref.null.extern`) in `emitStandalonePromiseResolve` /
`emitStandalonePromiseReject` — both initialise the slot. Change those
two lines to `ref.null` of the new type. Grep
`extern\.convert_any.*\$Promise|\$Promise.*callbacks` to confirm no
other consumer exists.

##### 1i. Implement `emitStandalonePromiseThen`

```ts
export function emitStandalonePromiseThen(
  ctx: CodegenContext,
  fctx: FunctionContext,
  promiseInstrs: Instr[],
  fnClosureInstrs: Instr[],
  fnClosureType: ValType,       // the wrapper struct type of the user closure
): ValType { ... }
```

Note the **signature change**: Phase 1A's stub takes raw `fnInstrs`.
Phase 1C must know the closure's wrapper struct so the synthesised
wrapper can `ref.cast` back. Caller in §2 passes
`compileArrowAsClosure`'s returned `ValType` (which is
`{ kind: "ref", typeIdx: structTypeIdx }`).

Body:

1. **Allocate the chained promise** as a PENDING `$Promise` and stash
   in a local `$chained`:
   ```
   i32.const 0                              ;; PENDING
   ref.null extern                          ;; value
   ref.null (ref null $__mt_pending_entry)  ;; callbacks
   struct.new $Promise
   local.set $chained
   ```
2. **Materialise the wrapper-captures struct**. Register (lazily,
   per-call-site or shared) a struct type
   `$__then_caps_<sigKey>` with fields:
   ```
   struct $__then_caps {
     fn       (ref $fn_closure_struct)   ;; user lambda
     chained  (ref $Promise)              ;; new pending promise
   }
   ```
   Use the cache pattern from `funcRefWrapperCache` keyed on the user
   closure's struct typeIdx so identical signatures share a struct.
   Emit `struct.new $__then_caps` with the two captured refs and
   `extern.convert_any` so the captures slot can be stored as
   externref in the queue.
3. **Synthesise `$__then_wrapper_<N>`** once per `(fnClosureTypeIdx,
   captureSlotTypeIdx)` pair. Cache on
   `state.thenWrappers: Map<string, number>`. The function:
   ```
   (func $__then_wrapper_N
         (param $caps externref) (param $value externref)
         (result externref)
     (local $capsTyped (ref $__then_caps))
     (local $result    externref)

     ;; Unpack captures.
     local.get $caps
     any.convert_extern
     ref.cast (ref $__then_caps)
     local.tee $capsTyped

     ;; Call user closure with $value.
     ;;   user_fn signature is (ref $fn_closure_struct, externref) → externref
     struct.get $__then_caps $fn       ;; (ref $fn_closure_struct)
     local.get $value                  ;; externref arg
     local.get $capsTyped
     struct.get $__then_caps $fn
     struct.get $fn_closure_struct $func
     ref.cast (ref $user_fn_type)
     call_ref $user_fn_type
     local.set $result

     ;; chained.state := FULFILLED
     local.get $capsTyped
     struct.get $__then_caps $chained
     i32.const 1                       ;; FULFILLED
     struct.set $Promise $state

     ;; chained.value := result
     local.get $capsTyped
     struct.get $__then_caps $chained
     local.get $result
     struct.set $Promise $value

     ;; Drain pending continuations attached to chained (the case where
     ;; another .then was queued while chained was still PENDING).
     local.get $capsTyped
     struct.get $__then_caps $chained
     call $__promise_fire_pending      ;; helper, see §1k

     local.get $result
   )
   ```
   **Errors:** wrap the user `call_ref` in a try/catch so a throw
   resolves the chained promise to REJECTED instead of unwinding the
   drain loop. The runtime exception tag is `__exn` (used elsewhere
   for try/catch); follow the existing pattern in
   `src/codegen/statements/try.ts`.

4. **Add the wrapper's funcIdx to `ctx.mod.declaredFuncRefs`** so the
   binary emitter generates the declarative element segment
   (mirror `closures.ts:3109`).

5. **At the `.then` call site**, emit (after pushing `promise` to a
   local `$p`):
   ```
   ;; Read $p.state. If FULFILLED → enqueue. If REJECTED → set chained
   ;; rejected & return. If PENDING → append to $p.callbacks.
   local.get $p  struct.get $Promise $state
   i32.const 1  i32.eq
   if
       ;; enqueue (wrapperFuncref, capsExternref, $p.value)
       ref.func $__then_wrapper_N
       <capsExternrefInstrs>
       local.get $p  struct.get $Promise $value
       call $__microtask_enqueue
   else
       local.get $p  struct.get $Promise $state
       i32.const 2  i32.eq
       if
           ;; REJECTED — pass-through (Phase 1C scope: no onRejected).
           local.get $chained  i32.const 2
           struct.set $Promise $state
           local.get $chained
           local.get $p  struct.get $Promise $value
           struct.set $Promise $value
       else
           ;; PENDING — append (wrapperFuncref, capsExternref) to
           ;; $p.callbacks linked list (helper, see §1j).
           ref.func $__then_wrapper_N
           <capsExternrefInstrs>
           local.get $p
           call $__promise_append_pending
       end
   end
   ```
6. Return `local.get $chained; extern.convert_any` so the type matches
   what call sites already expect (`externref` from
   `emitStandalonePromiseResolve`).

##### 1j. Helper: `$__promise_append_pending(funcref, externref caps, ref $Promise p)`

Builds a `$__mt_pending_entry`, prepends it (or appends — order matters,
ECMA-262 ¶ 27.2.1.6 says insertion order). Prepend is cheaper but
violates order; use append with a tail-walk (loop until next is null),
or store entries in reverse and walk in reverse when firing. Pick
**append via tail walk** for clarity — `.then` chains are rarely deep.

##### 1k. Helper: `$__promise_fire_pending(ref $Promise p)`

Walk `p.callbacks` linked list head→null; for each entry,
`__microtask_enqueue(entry.fn, entry.caps, p.value)`. Set
`p.callbacks` to null after firing.

Called from `emitStandalonePromiseResolve` (when transitioning a
pending promise to fulfilled — N/A for `Promise.resolve(v)` which
constructs a fulfilled promise directly, but the helper IS needed by
the `__then_wrapper_N` body above after the wrapper sets
`$chained.state = FULFILLED`).

##### 1l. Export drain + wire into WASI `_start`

```ts
export function exportDrainAndIntegrateWasiStart(ctx: CodegenContext): void {
  if (!isStandalonePromiseActive(ctx)) return;
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.drainFuncIdx === -1) return;   // queue never used
  if (state.drainExported) return;
  ctx.mod.exports.push({
    name: "__drain_microtasks",
    desc: { kind: "func", index: state.drainFuncIdx },
  });
  state.drainExported = true;
}
```

Call this from `src/codegen/index.ts` immediately before
`addWasiStartExport(ctx)` runs (lines 1020, 2922). Then modify
`addWasiStartExport` so its body becomes:

```ts
const body: Instr[] = [{ op: "call", funcIdx: targetIdx }];
const sched = (ctx as any).asyncScheduler;
if (sched && sched.drainFuncIdx !== -1) {
  body.push({ op: "call", funcIdx: sched.drainFuncIdx });
}
```

This is what Acceptance Criterion #1 needs to pass without the test
manually invoking `__drain_microtasks`.

#### 2. `src/codegen/expressions/calls.ts` — gate `.then` on standalone mode

At line ~3791 (`if (isPromiseReceiver)`), insert a standalone branch
BEFORE the existing host-import path:

```ts
import { isStandalonePromiseActive, emitStandalonePromiseThen, ensureMicrotaskQueue } from "../async-scheduler.js";

if (isPromiseReceiver) {
  if (isStandalonePromiseActive(ctx) && method === "then" && expr.arguments.length === 1) {
    // Compile receiver promise (externref) → local, callback → GC-closure path.
    compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
    const pLocal = allocLocal(fctx, "__then_p_extern", { kind: "externref" });
    fctx.body.push({ op: "local.set", index: pLocal });

    // Force the callback through compileArrowAsClosure (GC struct path) —
    // bypass isHostCallbackArgument's host-callback decision because the
    // queue stores closures as GC refs, not __make_callback handles.
    const cbType = compileArrowAsClosure(ctx, fctx, expr.arguments[0]! as ts.ArrowFunction);
    if (!cbType || cbType.kind !== "ref") {
      reportError(ctx, expr, "standalone Promise.then requires a closure literal");
      return { kind: "externref" };
    }

    // Push receiver back, drop into emitStandalonePromiseThen.
    const promiseInstrs: Instr[] = [{ op: "local.get", index: pLocal }];
    const fnInstrs: Instr[] = [];  // emitStandalonePromiseThen consumes
                                   // the top-of-stack closure ref it just placed
    return emitStandalonePromiseThen(ctx, fctx, promiseInstrs, fnInstrs, cbType);
  }

  if (isStandalonePromiseActive(ctx) && (method === "catch" || method === "finally")) {
    // Phase 1C: .catch / .finally not yet covered. Fall through to host
    // path (which throws in WASI) so the failure is loud, OR emit a
    // pass-through that returns the receiver unchanged. Recommend
    // pass-through with a TODO so tests don't trap on unrelated code.
    return passThroughPromise(ctx, fctx, propAccess.expression);
  }

  // ... existing host-import path unchanged
}
```

**Important**: do NOT call `flushLateImportShifts` in the standalone
branch — it has no host import to flush. Also, do NOT pre-coerce the
callback to externref before passing into `emitStandalonePromiseThen`
— the standalone path needs the typed `(ref $fn_closure_struct)`.

The `passThroughPromise` helper can be a small internal that compiles
the receiver to externref and returns it (acceptance criterion #3
covers `.catch` in a follow-up; do NOT silently swallow rejections,
add an explicit comment + TODO referencing #1326d/Phase 1E).

For `.then(onFulfilled, onRejected)` (two-arg form): defer to a
follow-up. Emit a compile-time warning and fall back to single-arg
behaviour: drop the onRejected argument, run only onFulfilled.

#### 3. `src/codegen/declarations.ts` — skip host imports in WASI

Line 1000: extend the `ctx.wasi` skip-list. Today:
```ts
if (ctx.wasi && (method === "resolve" || method === "reject")) continue;
```
Becomes:
```ts
if (ctx.wasi && (method === "resolve" || method === "reject" || method === "then")) continue;
```

The `then` host import currently comes through the **late** import
path (`expressions/calls.ts:3801` `ensureLateImport`), not this
collection loop, so this skip is defensive — confirmed by the
existing comment at lines 990-993. If the late-import path is reached
in WASI mode for `.then`, that's a routing bug; add a `console.error`
diagnostic from `ensureLateImport` when `ctx.wasi && importName ===
"Promise_then"`.

For `Promise_then2` / `Promise_catch` / `Promise_finally` — keep the
existing host-import path for now; Phase 1C only addresses single-arg
`.then`. Add an issue link comment.

#### 4. `src/codegen/index.ts` — call the drain hook

At each `addWasiStartExport(ctx)` site (lines 1020, 2922), prepend
`exportDrainAndIntegrateWasiStart(ctx)` so the export is registered
before `addWasiStartExport` reads the function table.

Also: scan top-level statements for any `.then(...)` call OR `await`
expression, and pre-call `ensureMicrotaskQueue(ctx)` so the globals
are registered even if every `.then` is compiled inside a function
that never runs at module init. This avoids a "drain export refers
to nonexistent function" build error when only main() uses Promises.
Cheaper alternative: register the queue lazily on first
`emitStandalonePromiseThen` call AND skip drain integration if
`state.drainFuncIdx === -1` (already in §1l). Use the cheaper path.

#### 5. `tests/issue-1326.test.ts` — extend coverage

Add WASI-mode test cases (use `compileToWasi` or the existing pattern
in this file):

```ts
test("standalone Promise.resolve.then yields value after drain", async () => {
  const src = `
    let result = 0;
    Promise.resolve(42).then(v => { result = v; });
    // _start auto-drains; result must be 42 on exit.
    export function getResult(): number { return result; }
  `;
  const { exports } = await compileAndInstantiate(src, { wasi: true });
  exports._start();
  expect(exports.getResult()).toBe(42);
});

test("chained then evaluates in microtask order", async () => {
  const src = `
    let result = 0;
    Promise.resolve(1)
      .then(x => x + 1)
      .then(x => x * 2)
      .then(x => { result = x; });
    export function getResult(): number { return result; }
  `;
  const { exports } = await compileAndInstantiate(src, { wasi: true });
  exports._start();
  expect(exports.getResult()).toBe(4);
});

test("then on pending promise (manual resolve)", async () => {
  // Use Promise.resolve so the receiver is fulfilled before .then —
  // a true PENDING test needs a Promise constructor with executor,
  // which is Phase 1E scope. Skip with TODO.
});

test("await on Promise.resolve in async fn returns value", async () => {
  // Sanity: the existing await passthrough in expressions.ts:952
  // discards Promise wrapping for direct await, so this should keep
  // working after the .then plumbing is in place.
  const src = `
    async function f() { return await Promise.resolve(7); }
    let result = 0;
    f().then(v => { result = v; });
    export function getResult(): number { return result; }
  `;
  // ... expect 7
});
```

Keep the existing JS-host tests in this file untouched — they must
still pass to prove the gate (`isStandalonePromiseActive`) protects
the host path.

### Wasm IR pattern summary (cheat-sheet for the dev)

```
;; Enqueue (called from .then site, FULFILLED branch):
ref.func $__then_wrapper_N
<capsExternref>
<promise.value>
call $__microtask_enqueue

;; Drain (auto-called from _start after __module_init):
loop until head == tail:
  fn   = funcs[head]
  caps = caps[head]
  arg  = args[head]
  head += 1
  call_ref fn (caps, arg)   ; result dropped

;; Inside wrapper (synth per .then site):
result = user_fn(value)             ; via closure-struct dispatch
chained.state = FULFILLED
chained.value = result
__promise_fire_pending(chained)     ; cascade
return result
```

### Edge cases

- **`.then(fn)` where `fn` is not a literal arrow** (e.g. identifier or
  parameter): fall back to host path with a diagnostic; Phase 1C
  covers literal closures only. The wrapper synthesis depends on
  knowing the closure's wrapper struct typeIdx at compile time.
- **Promise already rejected**: chained promise inherits the rejection
  reason but `onRejected` is NOT invoked (Phase 1C scope). Document
  as deviation from spec until Phase 1D.
- **Wrapper closure has zero captures from the user lambda**: still
  goes through `compileArrowAsClosure`; the resulting struct just has
  the funcref field. The wrapper-captures struct still holds
  `(fn, chained)`.
- **`.then` chained off a non-Promise value** (e.g. mistakenly off
  `number`): the existing `isPromiseReceiver` guard at line 3789
  prevents this; no change needed.
- **Queue grows during drain**: enqueue checks `tail == cap` and grows
  in-place; the drain loop re-reads globals on every iteration, so it
  picks up the new array references correctly.
- **Microtask throws**: the wrapper's internal try/catch routes the
  exception to `chained.state = REJECTED; chained.value = exception`.
  Drain continues with the next entry. A throw escaping the wrapper
  would unwind drain and corrupt the queue's head pointer — guard
  against it.
- **Async function returning Promise vs raw T**: the await passthrough
  at `expressions.ts:905` is unchanged; `await` still operates
  synchronously on the raw T. `.then(fn)` on an `asyncCall()` result
  goes through `wrapAsyncReturn` first (line 910) producing a real
  `$Promise` in standalone mode (uses `emitStandalonePromiseResolve`),
  then through `.then` standalone path. Verify with the fourth test.
- **`asyncScheduler` state shadowing**: Phase 1A stuffs it on
  `ctx as any`. Phase 1C should promote to a typed field on
  `CodegenContext` in `context/types.ts`. Optional, but recommended.

### Risk register

1. **Funcref array support** — confirm
   `getOrRegisterArrayType` accepts a funcref element type. If not,
   add `getOrRegisterFuncrefArrayType` (3-line copy). Trip-wire:
   `valid` will reject `array funcref` if the Wasm binary writer
   uses `0x6f` (externref code) for the elem type; verify it emits
   `0x70` (funcref).
2. **`addFuncType` arity** — `__mt_func_type` is `(externref,
   externref)→externref`. Confirm `addFuncType` is the canonical
   helper; some sites use `ctx.mod.types.push({ kind: "func", … })`
   directly. Either is fine, but using `addFuncType` keeps
   deduplication consistent.
3. **Declarative funcrefs** — every funcref pushed via `ref.func` in
   a constant context (or used in `array.set` on a funcref array)
   must be in `ctx.mod.declaredFuncRefs`. Add the wrapper +
   trampoline indices when synthesised. Symptom of missing this:
   "uninitialised ref.func" validation error.
4. **`$Promise.callbacks` type change** — verify no test currently
   reads `$Promise.callbacks` as externref. Grep
   `struct.get.*Promise.*callbacks` and
   `Promise.*structFields.*callbacks`. If any consumer exists,
   migrate alongside.
5. **late-import shift** — adding the queue's func defs allocates
   `funcIdx` slots. If `ensureMicrotaskQueue` is called during a
   function body emit (which §1f and §1g do), the funcIdx-shift
   machinery (`addUnionImports` style — see CLAUDE.md "addUnionImports
   shifts function indices") may be needed. **Recommendation**: call
   `ensureMicrotaskQueue` only **before** any function-body emit
   begins — e.g. in `collectDecls` after the existing Promise import
   block, gated on `isStandalonePromiseActive(ctx)`. The drain export
   is the only post-emit work; it doesn't shift indices because it
   only adds an export entry.
6. **`compileArrowAsClosure` reentry** — the `.then` site currently
   calls `compileExpression` on the arrow with target type
   `{externref}` (line 3811), which routes through
   `compileArrowAsCallback`. The standalone branch must call
   `compileArrowAsClosure` directly to bypass the host-callback
   decision. Make sure `compileArrowAsClosure` is exported from
   `closures.ts`; if it isn't, export it.

### Estimated test262 gain

Standalone (WASI) bucket only. The current standalone Promise sub-
bucket has ~80 tests gated on Promise.then / await chaining (estimate
from `benchmarks/results/test262-current.jsonl` `built-ins/Promise/*`
filtered by `wasi: true` runs). Expected pass-rate uplift in WASI
config:
- `Promise.resolve().then(...)` chains: +25-40 tests
- `Promise.reject().then(_, …)`: 0 (Phase 1C doesn't handle onRejected)
- `async/await` over Promise: +10-15 tests (relies on existing await
  passthrough + new .then)
- `Promise.all/race` on standalone: 0 (aggregators still throw)

**Total estimated gain: +35-55 standalone tests**. JS-host mode
unchanged.

### Out-of-scope (defer to follow-ups)

- `onRejected` callback (2-arg `.then`, `.catch`)
- `.finally`
- `new Promise(executor)` standalone (needs custom resolve/reject
  capture — Phase 1E)
- `Promise.all/race/allSettled/any` standalone (Phase 1F)
- Async iteration / `for await` standalone
- Microtask draining between exported function calls (Phase 1D — the
  current design only drains at `_start` exit)

### Test files to verify

- `tests/issue-1326.test.ts` — extended (§5 above)
- `test/built-ins/Promise/resolve/resolve-thenable.js` — fulfils when
  drain runs
- `test/built-ins/Promise/prototype/then/identity-not-callable.js` —
  exercises pass-through on non-function arg (covered by the diagnostic
  fall-back to host path; in WASI this will hit the "not a literal
  arrow" branch — verify the test's expected error matches)
- `test/language/expressions/await/async-await-interleaved.js` — await
  passthrough still works after .then plumbing


## Completion (2026-06-16, se1, sprint 62)

Both Phase 1C-A (queue infra) and Phase 1C-B (`emitStandalonePromiseThen`
chained resolution + rejection routing) have **landed on `main`** (PRs
#405 + follow-ups). Confirmed on current `main` HEAD (`e424a7d3a`):

- `pnpm exec vitest run tests/issue-1326.test.ts` → **14/14 pass**, including
  the Phase 1C-B acceptance cases: "drains chained `.then` callbacks in
  microtask order" and "routes rejected promises through the `onRejected`
  continuation".
- `src/codegen/async-scheduler.ts` has a real `emitStandalonePromiseThen`
  body (no throwing stub); `.then` standalone dispatch incl. two-arg
  `onRejected` is wired at `src/codegen/expressions/calls.ts:6513`.

The Suspended Work below (PR #405, "Phase 1C-B remaining") is historical —
that follow-up work has since merged. Flipped `in-progress` → `done`.
`#1373b` (the `required_by` dependent) is now unblocked.

## Suspended Work (historical — completed; see Completion note above)

- **PR**: https://github.com/loopdive/js2/pull/405
- **Branch**: `issue-1326c-microtask-standalone`
- **Worktree**: `/workspace/.claude/worktrees/issue-1326c-microtask-standalone/`
- **HEAD SHA**: `29b8726c3cb1ed67540b81a765f600986e74030a`
- **State**: ci-wait
- **Done (Phase 1C-A)**:
  - Replaced Phase 1A throwing stubs `emitMicrotaskEnqueue` / `emitDrainMicrotasks` with real Wasm bodies
  - Two parallel WasmGC arrays (`funcref` + `externref` captures + `externref` args), lazy first-alloc, grow-by-doubling
  - `__microtask_grow` / `__microtask_enqueue` / `__drain_microtasks` Wasm-defined helpers
  - `__drain_microtasks` export (gated on queue actually being registered)
  - WASI `_start` wrapper auto-appends drain call after entry
  - `tests/issue-1326c.test.ts` — 4/4 passing; `tests/issue-1326.test.ts` updated to reflect new behavior
- **Remaining (Phase 1C-B — separate PR)**:
  - `emitStandalonePromiseThen` real body — synthesised continuation wrappers closing over user closure struct + chained $Promise
  - `.then` call-site dispatch in `src/codegen/expressions/calls.ts`
  - `$Promise.callbacks` field upgrade to typed pending-continuation list
  - Acceptance criteria #2 (chained .then ordering) + #3 (rejection propagation)
- **Resume**: when ci-status JSON arrives at `/workspace/.claude/ci-status/pr-405.json` with matching SHA, run `/dev-self-merge 405`. After merge, create issue #1326d (Phase 1C-B) referencing the Phase 1C-B marker left in `emitStandalonePromiseThen`'s throw.
