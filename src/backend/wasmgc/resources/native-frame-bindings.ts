// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrBindingId } from "../../../shared/contracts/ir-identity.js";
import type { StructTypeDef } from "../../../wasm/model/module-records.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type {
  PhysicalModuleReservations,
  PhysicalReservation,
  FunctionReservation,
  TypeReservation,
  TagReservation,
} from "../../../wasm/physical/module-reservations.js";
import type {
  PreparedFrameAllocator,
  PreparedFrameHandle,
} from "../../../runtime/wasmgc/async/prepared-async-frame-types.js";

/** Exact object handles; no function-name/index lookup or imported native helpers. */
export class NativeFrameBindings {
  readonly #tokens = new Map<object, PhysicalReservation>();
  constructor(readonly tx: PhysicalModuleReservations) {}
  readonly allocator: PreparedFrameAllocator = {
    function: (handle) => {
      const token = this.#require(handle);
      if (token.kind !== "function") throw Error("native frame: foreign callable handle");
      return { index: token.handle, target: token.object };
    },
    type: (handle) => ({ index: this.tx.physicalIndex(this.#require(handle)), target: handle.target }),
    tag: (handle) => ({ index: this.tx.physicalIndex(this.#require(handle)), target: handle.target }),
  };
  #require(handle: PreparedFrameHandle<object>): PhysicalReservation {
    const token = this.#tokens.get(handle);
    if (!token || token.object !== handle.target) throw Error("native frame: foreign handle");
    this.tx.physicalIndex(token);
    return token;
  }
  #handle<T extends FunctionReservation | TypeReservation | TagReservation>(
    token: T,
  ): PreparedFrameHandle<T["object"]> {
    this.tx.physicalIndex(token);
    const handle = Object.freeze({ bindingId: token.key as IrBindingId, target: token.object });
    this.#tokens.set(handle, token);
    return handle;
  }
  function(token: FunctionReservation, params: readonly ValType[], results: readonly ValType[]) {
    this.tx.physicalIndex(token);
    if (token.object.typeIdx !== this.tx.internFunctionType(params, results))
      throw Error("native frame: callable signature mismatch");
    return this.#handle(token);
  }
  struct(token: TypeReservation): PreparedFrameHandle<StructTypeDef> {
    if (token.object.kind !== "struct") throw Error("native frame: expected struct");
    return this.#handle(token) as PreparedFrameHandle<StructTypeDef>;
  }
  tag(token: TagReservation) {
    this.tx.physicalIndex(token);
    if (token.object.typeIdx !== this.tx.internFunctionType([{ kind: "externref" }], []))
      throw Error("native frame: exception signature mismatch");
    return this.#handle(token);
  }
  assertCurrent(): void {
    this.tx.physicalIndices([...this.#tokens.values()]);
  }
}
