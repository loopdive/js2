// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../../wasm/model/instructions.js";

/** The registered name read, in either the host or native string representation. */
export type ErrorNameValue =
  | { readonly kind: "global"; readonly index: number; readonly representation: "gc" | "externref" }
  | { readonly kind: "callable"; readonly handle: number; readonly representation: "gc" }
  | { readonly kind: "legacy-missing" };

/**
 * (#6651 cluster C) The `message` slot producer.
 *
 * §20.5.1.1 step 3 defines `message` **only when the argument is not
 * `undefined`**, so `new Error()` and `new Error(undefined)` have no own
 * `message` while `new Error("m")` does. `fillErrorStructMessageOwnPropArms`
 * already answers `hasOwnProperty`/gOPD/`delete` from "field 1 is non-null",
 * which makes this the one place the distinction has to be made.
 *
 * The plain `local.get 0` is correct only when the caller can pass an absent
 * argument as a NULL externref. A derived builtin subclass cannot: the
 * implicit `class Err extends TypeError {}` forwarder has a fixed arity, so
 * `new Err()` pads slot 0 with the canonical `undefined` singleton and the
 * field came out non-null. Callers that can tell the two apart pass a
 * `messageSlot` that maps `undefined` back to null.
 */
export function buildErrorConstructorBody(
  structIdx: number,
  tagValue: number,
  argCount: number,
  name: ErrorNameValue,
  /** Replaces the bare `local.get 0` read of the message argument. */
  messageSlot?: readonly Instr[],
): Instr[] {
  const nameInstrs: Instr[] =
    name.kind === "legacy-missing"
      ? [{ op: "ref.null.extern" }]
      : name.kind === "global"
        ? [{ op: "global.get", index: name.index }]
        : [{ op: "call", funcIdx: name.handle }];
  if (name.kind !== "legacy-missing" && name.representation === "gc") nameInstrs.push({ op: "extern.convert_any" });
  const messageInstrs: Instr[] =
    argCount > 0
      ? messageSlot !== undefined
        ? [...messageSlot]
        : [{ op: "local.get", index: 0 }]
      : [{ op: "ref.null.extern" }];
  return [
    { op: "i32.const", value: tagValue },
    ...messageInstrs,
    ...nameInstrs,
    // Preserve the existing stack initializer and lazy property bag.
    { op: "ref.null.extern" },
    { op: "i32.const", value: -1 },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: structIdx },
    { op: "extern.convert_any" },
  ];
}
