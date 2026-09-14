// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";
import { buildTargetTaggedTry } from "../../../wasm/physical/exception-control.js";

/** Bound frame fields and resume handle; this engine neither reserves nor resolves resources. */
export interface AsyncFrameStepResources {
  readonly stateTypeIdx: number;
  readonly sentField: number;
  readonly errorField: number;
  readonly modeField: number;
  readonly throwMode: number;
  readonly resumeFuncIdx: FuncHandle;
}

/** Already emitted state instructions, retained by identity until publication. */
export interface AsyncFrameStateBody {
  readonly id: number;
  readonly body: Instr[];
}

export interface AsyncFrameStateChainInput {
  readonly frameLocal: number;
  readonly stateTypeIdx: number;
  readonly stateField: number;
  readonly states: readonly AsyncFrameStateBody[];
  readonly completed?: AsyncFrameStateBody;
}

/** One original handler region, including finally-only regions and absent versus zero bindings. */
export interface AsyncFrameHandler {
  readonly id: number;
  readonly parent: number;
  readonly finalizerBody: Instr[];
  readonly catchState?: number;
  readonly catchBinding?: {
    readonly name: string;
    readonly local?: number;
    readonly spillField?: number;
  };
}

export interface AsyncFrameDispatchInput {
  readonly target: { readonly wasi: boolean; readonly standalone: boolean };
  readonly stateTypeIdx: number;
  readonly stateField: number;
  readonly modeField: number;
  readonly nextMode: number;
  readonly frameLocal: number;
  readonly resultPromiseLocal: number;
  readonly reasonLocal: number;
  readonly handlerLocal?: number;
  readonly exnTag: number;
  readonly settleRejectIdx: FuncHandle;
  readonly chain: Instr[];
  readonly handlers: readonly AsyncFrameHandler[];
  readonly completedStateId?: number;
  readonly hostGetCaughtIdx?: FuncHandle;
}

/** Step-adapter locals: param 0/1 = (caps, value); local 2 = the cast frame. */
export function buildStepAdapterLocals(stateTypeIdx: number): LocalDef[] {
  return [{ name: "$frame", type: { kind: "ref", typeIdx: stateTypeIdx } }];
}

/**
 * `__async_step_f<name>_{fulfill,reject}(caps, value) -> externref`: cast caps
 * back to the frame, store the settled value into `SENT_FIELD` (and, for the
 * reject adapter, the reason into `ERROR_FIELD` + `MODE_FIELD=MODE_THROW`), then
 * call the resume function. This is the funcref enqueued on the awaited
 * promise's reaction list and run by the microtask drain.
 */
export function buildStepAdapterBody(resources: AsyncFrameStepResources, reject: boolean): Instr[] {
  const capsLocal = 0;
  const valueLocal = 1;
  const frameLocal = 2;
  const body: Instr[] = [
    { op: "local.get", index: capsLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: resources.stateTypeIdx },
    { op: "local.set", index: frameLocal },
    // SENT_FIELD = value (the settled awaited value the continuation reads).
    { op: "local.get", index: frameLocal },
    { op: "local.get", index: valueLocal },
    {
      op: "struct.set",
      typeIdx: resources.stateTypeIdx,
      fieldIdx: resources.sentField,
    },
  ];
  if (reject) {
    // ERROR_FIELD = reason; MODE_FIELD = MODE_THROW (2). (Slice-1 surfaces the
    // reason via SENT for the fast path; the throw-on-rejected-await refinement
    // reads ERROR/MODE — wired here so the field is populated.)
    body.push(
      { op: "local.get", index: frameLocal },
      { op: "local.get", index: valueLocal },
      {
        op: "struct.set",
        typeIdx: resources.stateTypeIdx,
        fieldIdx: resources.errorField,
      },
      { op: "local.get", index: frameLocal },
      { op: "i32.const", value: resources.throwMode },
      { op: "struct.set", typeIdx: resources.stateTypeIdx, fieldIdx: resources.modeField },
    );
  }
  body.push(
    { op: "local.get", index: frameLocal },
    { op: "call", funcIdx: resources.resumeFuncIdx },
    { op: "ref.null.extern" }, // dropped by the drain
  );
  return body;
}

/** Assemble the existing nested dispatch without cloning the owner's emitted state bodies. */
export function buildAsyncFrameStateChain(input: AsyncFrameStateChainInput): Instr[] {
  const { frameLocal, stateTypeIdx, stateField, states, completed } = input;
  // Nested if-chain dispatch (`if(state==s){body}else{…}`), mirroring the
  // generator trampoline. Recursion depth == state id (dense, validated), so
  // each arm's `br`-to-loop depth is `id + 2` inside `buildStateBody`.
  const buildStateArm = (i: number): Instr[] => {
    if (i >= states.length) {
      // (#3178) Synthetic COMPLETED arm (async gens only): fulfil `{value:
      // undefined, done: true}` and RUN NO LEADS. The real settleDone state
      // carries trailing body statements as leads, so completion (uncaught
      // throw / `.return()` / `.throw()`) must NOT re-dispatch there —
      // §27.6.3.x: a completed generator executes no further body. Terminal
      // arm; anything else is a machine bug (unreachable).
      if (completed !== undefined) {
        return [
          { op: "local.get", index: frameLocal },
          { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: stateField },
          { op: "i32.const", value: completed.id },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: completed.body,
            else: [{ op: "unreachable" }],
          },
        ];
      }
      return [{ op: "unreachable" }];
    }
    const st = states[i]!;
    const then = st.body;
    return [
      { op: "local.get", index: frameLocal },
      { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: stateField },
      { op: "i32.const", value: st.id },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then,
        else: buildStateArm(i + 1),
      },
    ];
  };
  return buildStateArm(0);
}

/** Assemble routed or plain rejection dispatch from fully bound physical data. */
export function buildAsyncFrameDispatch(input: AsyncFrameDispatchInput): Instr {
  const {
    target,
    stateTypeIdx,
    stateField,
    modeField,
    nextMode,
    frameLocal,
    resultPromiseLocal,
    reasonLocal,
    handlerLocal: inSrcTryLocal = -1,
    exnTag,
    settleRejectIdx,
    chain,
    handlers,
    completedStateId,
    hostGetCaughtIdx,
  } = input;
  const routedDispatch = handlers.some((h) => h.catchState !== undefined);
  const setField = (fieldIdx: number, value: number): Instr[] => [
    { op: "local.get", index: frameLocal },
    { op: "i32.const", value },
    { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx },
  ];
  const catchFinallyInstrs: Instr[] = [];
  for (const region of handlers) {
    const fbody = region.finalizerBody;
    if (handlers.length === 1) {
      catchFinallyInstrs.push(
        { op: "local.get", index: inSrcTryLocal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: fbody,
        },
      );
    } else {
      catchFinallyInstrs.push(
        { op: "local.get", index: inSrcTryLocal },
        { op: "i32.const", value: region.id },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: fbody },
      );
    }
  }
  // (#2867 Gap 2) Throw → reject routing. A genuine throw — a bare `throw e`, or
  // a rejected await re-thrown by a state prelude's MODE_THROW arm — must settle
  // the result `$Promise` REJECTED, not escape uncaught (trap / strand pending).
  // Wrap the whole `block { loop { if-chain } }` dispatch in `try`/`catch $exn`.
  // Suspend / settle `return`s exit cleanly (a `return` in `try` skips `catch`),
  // so only a real throw reaches the handler.
  //
  // (#2906 3c) The shared reject tail (also the routed dispatcher's default
  // route): replay any region's await-free finalizer, reject the result
  // promise, and (async gens) re-point at the synthetic COMPLETED arm.
  const rejectTail: Instr[] = [
    // (#2906 Gap 3) run the finally before rejecting, if the throw crossed
    // the try region (inline no-op array when the body has no finally).
    ...catchFinallyInstrs,
    { op: "local.get", index: resultPromiseLocal },
    { op: "local.get", index: reasonLocal },
    { op: "call", funcIdx: settleRejectIdx },
    { op: "drop" },
    // (#3178) §27.6.3.5 AsyncGeneratorStart step 4.f–g: an uncaught throw
    // COMPLETES an async generator ([[AsyncGeneratorState]] = "completed")
    // in addition to rejecting the current result promise. Re-point
    // frame.STATE at the synthetic leads-free COMPLETED arm so a
    // subsequent `.next()` fulfills `{value: undefined, done: true}`
    // instead of re-driving the throwing step and rejecting again (the
    // 280-test yield*-GetIterator/next error-semantics cohort surfaced
    // by the F2 async-completion channel, #3417). NOT the settleDone
    // state — that one carries trailing body statements as leads and
    // would re-execute them. Plain async FUNCTIONS are untouched (no
    // re-entry exists; gate keeps their bytes identical).
    ...(completedStateId !== undefined ? setField(stateField, completedStateId) : []),
  ];
  if (routedDispatch) {
    // (#2906 3c) ROUTED dispatcher: `block { loop { try { chain } catch $exn {
    // route } } }`. The route turns an abrupt completion raised while a
    // catch-carrying region is active into a STATE TRANSITION: bind the reason
    // to the catch param (local now, spill for later suspends), consume the
    // throw (MODE=NEXT — the prelude re-throw arm must not re-fire on stale
    // MODE inside the catch chain), point STATE at the region's catch entry,
    // and `br` the loop (depth 2 from inside the route's `if`: if=0, try=1,
    // loop=2). No active region (or a region without a catchState) falls
    // through to the shared reject tail, exactly the pre-3c behavior.
    const routeCore: Instr[] = [];
    for (const region of handlers) {
      if (region.catchState === undefined) continue;
      const bindInstrs: Instr[] = [];
      if (region.catchBinding !== undefined) {
        const paramLocal = region.catchBinding.local;
        if (paramLocal !== undefined) {
          bindInstrs.push({ op: "local.get", index: reasonLocal }, { op: "local.set", index: paramLocal });
        }
        const spillField = region.catchBinding.spillField;
        if (spillField !== undefined) {
          bindInstrs.push(
            { op: "local.get", index: frameLocal },
            { op: "local.get", index: reasonLocal },
            { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: spillField },
          );
        }
      }
      routeCore.push(
        { op: "local.get", index: inSrcTryLocal },
        { op: "i32.const", value: region.id },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...bindInstrs,
            ...setField(modeField, nextMode),
            ...setField(stateField, region.catchState),
            { op: "br", depth: 2 }, // if(0) → try(1) → loop(2): re-dispatch
          ],
        },
      );
    }
    routeCore.push(...rejectTail);
    // `catch $exn`: the thrown reason is on the stack.
    const route: Instr[] = [{ op: "local.set", index: reasonLocal }, ...routeCore];
    // (#3587) HOST lane `catch_all` parity: the legacy try/catch lowering also
    // catches FOREIGN JS exceptions (a host import throwing, e.g. a TypeError
    // from a property op) via `catch_all` + `__get_caught_exception`. Without
    // this arm, claiming a try/catch shape on the host backend would let a
    // synchronous host throw inside the try region ESCAPE the machine (result
    // promise strands pending) where the legacy path caught it. The arm
    // retrieves the recorded exception and runs an identical route —
    // `structuredClone`d, never aliased (one Instr[] must not sit in two
    // branches; DCE/late-import walkers would double-remap it). Native lane
    // (`wasi`/`standalone`) has no JS sidecar — no catch_all, byte-identical.
    let catchAllRoute: Instr[] | undefined;
    if (hostGetCaughtIdx !== undefined) {
      catchAllRoute = [
        { op: "call", funcIdx: hostGetCaughtIdx },
        { op: "local.set", index: reasonLocal },
        ...(structuredClone(routeCore) as Instr[]),
      ];
    }
    return {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            buildTargetTaggedTry(target, { kind: "empty" }, chain, [{ tagIdx: exnTag, body: route }], catchAllRoute),
          ],
        },
      ],
    };
  } else {
    const dispatch: Instr[] = [
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: chain }],
      },
    ];
    // (#3587 / #5322) HOST-lane `catch_all` parity for the NON-routed
    // dispatcher too. An async body with no try/catch of its own still has to
    // reject its result promise when a FOREIGN JS exception is raised while it
    // resumes — the canonical shape is a compiled function the HOST invoked
    // (`o.m(x)` on an `any` receiver goes out through `__extern_method_call`,
    // and the host calls back in) that throws. Without this arm that exception
    // is not `$exn`-tagged, escapes the state machine, and the result promise
    // STRANDS PENDING: the awaiting test never settles and the throw surfaces
    // as an unhandled rejection that kills the process. #3587 added the arm
    // only to the routed dispatcher, so exactly the try/catch-free bodies —
    // the common case — kept escaping. Measured witness: hono
    // `utils/body.test.ts`, whose 37 results were all lost to one such throw.
    const plainCatchAll: Instr[] | undefined =
      hostGetCaughtIdx !== undefined
        ? [
            { op: "call", funcIdx: hostGetCaughtIdx },
            { op: "local.set", index: reasonLocal },
            ...(structuredClone(rejectTail) as Instr[]),
          ]
        : undefined;
    return buildTargetTaggedTry(
      target,
      { kind: "empty" },
      dispatch,
      [
        {
          tagIdx: exnTag,
          body: [{ op: "local.set", index: reasonLocal }, ...rejectTail],
        },
      ],
      plainCatchAll,
    );
  }
}
