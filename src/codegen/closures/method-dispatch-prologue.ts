// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Entry prologue shared by every `__call_fn_method_<arity>` dispatcher
 * (`emitClosureMethodCallExportN`).
 *
 * Three steps whose ORDER is load-bearing:
 *
 * 1. Lower the closure operand (local 1) into the internal ref domain and
 *    stash it in `closureAnyLocal`, so the shape `ref.test`s downstream have
 *    an anyref to work on.
 * 2. (#4197) Take the runtime-eval AOT-callable front-guard. It must run
 *    BEFORE step 3: on a hit it `return`s straight out of the dispatcher, and
 *    the carrier's `code` binds the receiver itself by routing through
 *    `__apply_closure`. Running it after the install would leave
 *    `__current_this` clobbered on that early exit with no matching restore.
 * 3. Save the previous `__current_this` for nesting safety and install the
 *    caller's `thisVal` (#1636-S1).
 */
import type { Instr } from "../../ir/types.js";
import { installableReceiverInstrs } from "../helpers/undefined-receiver.js"; // (#4555) §10.4.3
import type { CodegenContext } from "../context/types.js";
import { buildRuntimeEvalCarrierMethodDispatch } from "../runtime-eval-callable.js";

export function buildMethodDispatchPrologue(
  ctx: CodegenContext,
  arity: number,
  closureAnyLocal: number,
  prevThisLocal: number,
  currentThisGlobalIdx: number,
): Instr[] {
  const body: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.set", index: closureAnyLocal },
  ];
  const carrierGuard = buildRuntimeEvalCarrierMethodDispatch(ctx, arity, closureAnyLocal, 0);
  // `null` in every module that minted no carrier — those stay byte-identical.
  if (carrierGuard) body.push(...carrierGuard);
  body.push(
    { op: "global.get", index: currentThisGlobalIdx },
    { op: "local.set", index: prevThisLocal },
    ...installableReceiverInstrs(ctx, 0),
    { op: "global.set", index: currentThisGlobalIdx },
  );
  return body;
}
