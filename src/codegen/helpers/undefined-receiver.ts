// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4555) ES5 §10.4.3 — an `undefined` thisArg is NOT an installed receiver.
 *
 * `f.call(undefined)` / `f.apply(undefined)` and a bare `f()` get the same two
 * answers: the global object in sloppy code, `undefined` in strict code. The
 * `this` reader already produces both, but only from a NULL `__current_this` —
 * its non-null arm means "a real receiver was installed".
 *
 * On the singleton regime `undefined` is the non-null `$undefined` box, so
 * installing a thisArg verbatim sent that arm the wrong way and sloppy
 * `f.apply(undefined)` yielded `undefined` instead of the global object.
 * (`f.apply(null)` was already right, because null installs as null.)
 *
 * Every receiver-install site therefore normalises through here. The tag-1 test
 * cannot collide with #4203's explicit-null marker: that value is minted inside
 * the named-this trampoline and never arrives as a thisArg. Off the regime
 * `undefined` has no guaranteed non-null externref spelling, so the sequence
 * degrades to the bare `local.get` and the install stays byte-identical.
 */
import type { Instr } from "../../ir/types.js";
import { ensureAnyValueType, undefinedSingletonActive } from "../any-helpers.js";
import type { CodegenContext } from "../context/types.js";

/** The externref to install for the thisArg held in `localIdx`. */
export function installableReceiverInstrs(ctx: CodegenContext, localIdx: number): Instr[] {
  const thisVal: Instr[] = [{ op: "local.get", index: localIdx }];
  if (!undefinedSingletonActive(ctx)) return thisVal;
  if (ctx.anyValueTypeIdx < 0) ensureAnyValueType(ctx);
  const t = ctx.anyValueTypeIdx;
  if (t < 0) return thisVal;
  const boxed: Instr[] = [{ op: "local.get", index: localIdx }, { op: "any.convert_extern" }];
  return [
    ...boxed,
    { op: "ref.test", typeIdx: t },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        ...boxed,
        { op: "ref.cast", typeIdx: t },
        { op: "struct.get", typeIdx: t, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "ref.null.extern" }],
          else: thisVal,
        },
      ],
      else: thisVal,
    },
  ];
}
