// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { pushBuiltinCtorOwnPropSeed } from "./builtin-ctor-own-props.js";
import { reserveBuiltinConstructorIdentityGlobal } from "./builtin-static-globals.js";

/**
 * Same-stack construction and transfer only. Neither preparation nor its token
 * escapes this module. A future detached-drive adapter needs a separately
 * reviewed lifetime contract; this API does not authorize delayed consumption.
 */
export function emitPreparedBuiltinConstructorIdentityRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
): ValType {
  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object")!;

  const globalIdx = reserveBuiltinConstructorIdentityGlobal(ctx, builtinName);

  // (#2984 ctor-carrier own props) The carrier is materialized through a local
  // so the §17/§20 own data properties (`length`/`name`/`prototype`) can be
  // installed on it before its seed completes. Without them the carrier is an
  // EMPTY `$Object`, and every RUNTIME descriptor query
  // test262's `verifyProperty` makes through its any-typed harness parameter
  // (`hasOwnProperty`, `gOPD`, for-in, write, delete) answers "absent".
  const objLocal = allocLocal(fctx, `__builtin_ctor_${builtinName}_obj_${fctx.locals.length}`, {
    kind: "externref",
  });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
    // Publish before seeding: the prototype seed may re-enter this helper via
    // its native-prototype companion. Leaving the global null until after that
    // re-entry lets it mint a second carrier, splitting constructor identity.
    { op: "local.get", index: objLocal },
    { op: "global.set", index: globalIdx },
  ];

  const destination = fctx.body;
  const borrowedDestination = ctx.liveBodies.has(destination);
  const borrowedInit = ctx.liveBodies.has(initBody);
  if (!borrowedDestination) ctx.liveBodies.add(destination);
  if (!borrowedInit) ctx.liveBodies.add(initBody);
  let prepared: PreparedConstructorRead | undefined;
  try {
    fctx.body = initBody;
    try {
      pushBuiltinCtorOwnPropSeed(ctx, fctx, builtinName, objLocal);
    } finally {
      fctx.body = destination;
    }
    prepared = new PreparedConstructorRead(ctx, fctx, destination, [
      { op: "global.get", index: globalIdx },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: initBody, else: [] },
      { op: "global.get", index: globalIdx },
    ]);
    // No allocating operation or callback between materialization and transfer.
    return prepared.append(ctx, fctx);
  } finally {
    prepared?.abandon();
    fctx.body = destination;
    if (!borrowedInit) ctx.liveBodies.delete(initBody);
    if (!borrowedDestination) ctx.liveBodies.delete(destination);
  }
}

/** Private authenticated materialized value, never a recipe or cached identity. */
class PreparedConstructorRead {
  #state: "prepared" | "attached" | "abandoned" = "prepared";
  readonly #locals: FunctionContext["locals"];
  readonly #localCount: number;
  constructor(
    private readonly ctx: CodegenContext,
    private readonly frame: FunctionContext,
    private readonly destination: Instr[],
    private readonly root: Instr[],
  ) {
    this.#locals = frame.locals;
    this.#localCount = frame.locals.length;
  }

  append(ctx: CodegenContext, frame: FunctionContext): ValType {
    if (
      this.#state !== "prepared" ||
      ctx !== this.ctx ||
      frame !== this.frame ||
      frame.body !== this.destination ||
      frame.locals !== this.#locals ||
      frame.locals.length !== this.#localCount
    ) {
      throw new Error("Invalid immediate constructor fragment transfer");
    }
    frame.body.push(...this.root);
    this.#state = "attached";
    return { kind: "externref" };
  }

  abandon(): void {
    if (this.#state === "prepared") this.#state = "abandoned";
  }
}
