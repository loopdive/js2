// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IrFunctionBuilder — imperative builder for constructing IrFunction values.
//
// Phase 1 keeps the API narrow: allocate params, open a block, emit instrs,
// terminate the block. No control-flow primitives yet (if/loop sugar) — those
// come in Phase 2 together with AST→IR lowering for real control-flow.

import {
  asBlockId,
  asLabelId,
  asValueId,
  closureSignatureEquals,
  irVal,
  irDynamic,
  AllocKind,
  AllocSiteId,
  IrBinop,
  IrBlock,
  IrBlockId,
  IrClassMemberKind,
  IrClassShape,
  IrClosureSignature,
  IrConst,
  IrFuncRef,
  IrFunction,
  IrGlobalRef,
  IrInstr,
  IrLabelId,
  IrObjectShape,
  IrParam,
  IrSiteId,
  IrSlotDef,
  IrTerminator,
  IrType,
  IrUnop,
  IrValueId,
  IrValueIdAllocator,
  irTypeEquals,
} from "./nodes.js";
import type { AllocSiteRegistry } from "./alloc-registry.js";
import type { Instr, ValType } from "./types.js";
// #3954 phase 1 — the builder's payload-shape question ("does this partition
// have a payload, and of what shape?") is a `TagDomain` question.
// #3954 phase 3 (W5) — the builder now HOLDS its domain (constructor arg,
// defaulting to `producer.ts`'s) instead of reaching for the global inside
// `emitUnbox`, and `emitUnbox`/`emitTagTest` take a neutral `TagId`. `js-tag.ts`
// is no longer imported: the builder names no ECMAScript partition.
import { defaultTagDomain } from "./producer.js";
import type { TagDomain, TagId } from "./tag-domain.js";
import type { IrStringConcatMode, IrStringEncoding } from "./string-runtime.js";
import { INTRINSIC_DEFINITIONS, type IntrinsicId } from "./intrinsics.js";

interface OpenBlock {
  readonly id: IrBlockId;
  readonly blockArgs: IrValueId[];
  readonly blockArgTypes: IrType[];
  readonly instrs: IrInstr[];
}

export class IrFunctionBuilder {
  private readonly allocator = new IrValueIdAllocator();
  private readonly params: IrParam[] = [];
  private readonly finished: IrBlock[] = [];
  private readonly valueTypes = new Map<IrValueId, IrType>();
  // Exact i32 values widened to f64. SSA values are immutable, so a later
  // truncation of the widened result can always recover the original i32 even
  // when unrelated instructions were emitted between the two conversions.
  private readonly exactI32Widenings = new Map<IrValueId, IrValueId>();
  private current: OpenBlock | null = null;
  // Block IDs are assigned from a monotonic counter rather than from
  // `finished.length`, so forward references (br_if with a not-yet-opened
  // target) can reserve an ID before its defining block exists.
  private nextBlockId = 0;
  private readonly reserved = new Set<IrBlockId>();
  // Slice 6 (#1169e): Wasm-local slots for cross-iteration mutable state.
  private readonly slotDefs: IrSlotDef[] = [];
  // Slice 6 (#1169e): instrs collected by the for-of body builder land in
  // a side buffer when `bodyBuffer` is non-null; the for-of `body` field
  // captures them as a self-contained sequence rather than appending to the
  // current block.
  private bodyBuffer: IrInstr[] | null = null;
  // Slice 7a (#1169f): generator / async metadata. Set via `setFuncKind`
  // before the first block is opened. Default is `"regular"` (no special
  // treatment in lowering).
  private funcKind: "regular" | "generator" | "async" = "regular";
  // Slice 7a (#1169f): for `funcKind === "generator"` only — the slot
  // index of the `__gen_buffer` Wasm-local. Set when the generator
  // prologue is emitted in from-ast.
  private generatorBufferSlot: number | undefined = undefined;
  // #2952 slice 2 — per-function loop-label allocator (see IrLabelId in
  // nodes.ts). Labels identify loop frames for `br.label`; unlabeled
  // break/continue resolve to the innermost loop's synthesised label.
  private nextLabelId = 0;

  constructor(
    private readonly id: Pick<IrFunction, "unitId" | "name">,
    private readonly resultTypes: readonly IrType[],
    private readonly exported = false,
    // #1586: module-global allocation-site registry. Optional so test builders
    // and any non-module-driven construction work without one — emitters then
    // simply leave `alloc` unset, which is inert at lowering.
    private readonly allocRegistry?: AllocSiteRegistry,
    // #3954 phase 3 (W5): the tag domain the `dynamic` values built here are
    // interpreted against. Defaults to the producer axis's default
    // (`producer.ts`), so every existing caller is unchanged; a non-JS producer
    // passes its own domain instead of the builder reaching for a global.
    private readonly tagDomain: TagDomain = defaultTagDomain(),
  ) {}

  /**
   * #1586: mint a stable allocation-site id for a value-creating instr. Returns
   * `undefined` when no registry is wired (test builders), in which case the
   * instr's `alloc` field stays absent — lowering ignores it either way.
   */
  private allocId(kind: AllocKind, type: IrType, site?: IrSiteId): AllocSiteId | undefined {
    return this.allocRegistry?.fresh(kind, type, site);
  }

  // --- params -------------------------------------------------------------

  addParam(name: string, type: IrType): IrValueId {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: params must be declared before the first block (func ${this.id.name})`);
    }
    const value = this.allocator.fresh();
    this.valueTypes.set(value, type);
    this.params.push({ name, type, value });
    return value;
  }

  // --- blocks -------------------------------------------------------------

  openBlock(blockArgTypes: readonly IrType[] = []): IrBlockId {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: previous block not terminated (func ${this.id.name})`);
    }
    const id = asBlockId(this.nextBlockId++);
    this.current = this.makeOpen(id, blockArgTypes);
    return id;
  }

  /**
   * Allocate a block ID without opening it — for forward references in a
   * terminator that must branch to a block we haven't emitted yet. The caller
   * MUST later activate it with `openReservedBlock(id)` before `finish()`.
   */
  reserveBlockId(): IrBlockId {
    const id = asBlockId(this.nextBlockId++);
    this.reserved.add(id);
    return id;
  }

  /**
   * Activate a previously reserved block ID as the current open block.
   */
  openReservedBlock(id: IrBlockId, blockArgTypes: readonly IrType[] = []): void {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: previous block not terminated (func ${this.id.name})`);
    }
    if (!this.reserved.has(id)) {
      throw new Error(`IrFunctionBuilder: block ${id as number} was not reserved (func ${this.id.name})`);
    }
    this.reserved.delete(id);
    this.current = this.makeOpen(id, blockArgTypes);
  }

  private makeOpen(id: IrBlockId, blockArgTypes: readonly IrType[]): OpenBlock {
    const blockArgs: IrValueId[] = [];
    for (const ty of blockArgTypes) {
      const v = this.allocator.fresh();
      this.valueTypes.set(v, ty);
      blockArgs.push(v);
    }
    return { id, blockArgs, blockArgTypes: [...blockArgTypes], instrs: [] };
  }

  blockArg(slot: number): IrValueId {
    const cur = this.requireBlock();
    if (slot < 0 || slot >= cur.blockArgs.length) {
      throw new Error(`IrFunctionBuilder: block arg slot ${slot} out of range`);
    }
    return cur.blockArgs[slot];
  }

  terminate(terminator: IrTerminator): void {
    const cur = this.requireBlock();
    this.finished.push({
      id: cur.id,
      blockArgs: cur.blockArgs,
      blockArgTypes: cur.blockArgTypes,
      instrs: cur.instrs,
      terminator,
    });
    this.current = null;
  }

  // --- instructions -------------------------------------------------------

  emitConst(value: IrConst, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "const", value, result, resultType });
    return result;
  }

  emitCall(target: IrFuncRef, args: readonly IrValueId[], resultType: IrType | null): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    // #1588 Phase 2: a call that produces a string is a string allocation site.
    // Minting the id is inert at lowering (the encoding analysis reads it; the
    // emitted Wasm is unchanged), and gives the analysis an attachment point
    // for call-result origin rules (JSON.parse, string methods, …).
    const alloc = resultType?.kind === "string" ? this.allocId("string", resultType) : undefined;
    this.pushInstr({ kind: "call", target, args: [...args], result, resultType, alloc });
    return result;
  }

  /** Emit one closed semantic intrinsic before any runtime provider is chosen. */
  emitIntrinsic(id: IntrinsicId, args: readonly IrValueId[], site?: IrSiteId): IrValueId {
    const definition = INTRINSIC_DEFINITIONS[id];
    if (args.length !== definition.signature.params.length) {
      throw new Error(
        `IrFunctionBuilder: ${id} expects ${definition.signature.params.length} argument(s), received ${args.length}`,
      );
    }
    for (let index = 0; index < args.length; index++) {
      const actual = this.typeOf(args[index]!);
      const expected = definition.signature.params[index]!;
      if (!irTypeEquals(actual, expected)) {
        throw new Error(`IrFunctionBuilder: ${id} argument ${index} does not match its semantic signature`);
      }
    }
    const result = this.allocator.fresh();
    this.valueTypes.set(result, definition.signature.result);
    this.pushInstr({
      kind: "intrinsic",
      id,
      version: definition.signature.version,
      args: [...args],
      result,
      resultType: definition.signature.result,
      ...(site ? { site } : {}),
    });
    return result;
  }

  emitGlobalGet(target: IrGlobalRef, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "global.get", target, result, resultType });
    return result;
  }

  emitGlobalSet(target: IrGlobalRef, value: IrValueId): void {
    this.pushInstr({ kind: "global.set", target, value, result: null, resultType: null });
  }

  emitBinary(op: IrBinop, lhs: IrValueId, rhs: IrValueId, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "binary", op, lhs, rhs, result, resultType });
    return result;
  }

  emitUnary(op: IrUnop, rand: IrValueId, resultType: IrType): IrValueId {
    // (#3741) `i32.trunc_sat_f64_s(f64.convert_i32_s(x))` === `x` for every
    // i32 `x`: the widening is exact (every int32 is representable in f64) and
    // the saturating truncation of an exact in-range integer is the identity.
    //
    // This matters because #3741 gives provably-int32 locals an i32 Wasm slot
    // and widens on EVERY read, so that no consumer observes the promotion.
    // Without this cancellation the single most common consumer — an array
    // index, `arr[i]` — would pay `convert` + `trunc_sat` where it used to pay
    // just `trunc_sat`, i.e. the promotion would PESSIMIZE indexed loops.
    //
    if (op === "i32.trunc_sat_f64_s") {
      const exactI32 = this.exactI32Widenings.get(rand);
      if (exactI32 !== undefined) return exactI32;
    }
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "unary", op, rand, result, resultType });
    if (op === "f64.convert_i32_s") this.exactI32Widenings.set(result, rand);
    return result;
  }

  emitSelect(condition: IrValueId, whenTrue: IrValueId, whenFalse: IrValueId, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "select", condition, whenTrue, whenFalse, result, resultType });
    return result;
  }

  /**
   * (#1392) Emit `unary("ref.is_null", val)` — tests a Wasm reference for
   * null. Result is `i32` (1 if null, 0 otherwise). The architect-spec
   * name `emitRefIsNull` mirrors the existing `emitUnary` /
   * `emitBinary` / `emitSelect` family and surfaces the underlying op
   * at the call site so #1375's optional-chain lowering reads naturally
   * (`cx.builder.emitRefIsNull(recv)`).
   *
   * `val`'s IrType MUST be a `val`-kind wrapping a Wasm reference type
   * (`ref` / `ref_null` / `externref` / `funcref`); the verifier and the
   * Wasm validator together reject other operand shapes.
   */
  emitRefIsNull(val: IrValueId): IrValueId {
    return this.emitUnary("ref.is_null", val, irVal({ kind: "i32" }));
  }

  /**
   * (#1392) Emit a value-producing short-circuiting if/else. Both `then`
   * and `else` are pre-collected instruction buffers (typically built
   * via `collectBodyInstrs(...)`); the lowerer emits a Wasm
   * `if (result T) ... else ... end` so only the matching branch
   * executes.
   *
   * `thenValue` / `elseValue` are SSA value IDs DEFINED INSIDE the
   * corresponding arm — the lowerer emits each arm's instruction tree
   * and leaves the carrier value on the Wasm stack at end-of-arm; the
   * post-block `local.set` binds the if-instr's result to whichever
   * carrier ran.
   */
  emitIfElse(args: {
    cond: IrValueId;
    then: readonly IrInstr[];
    thenValue: IrValueId;
    else: readonly IrInstr[];
    elseValue: IrValueId;
    resultType: IrType;
  }): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, args.resultType);
    this.pushInstr({
      kind: "if",
      cond: args.cond,
      then: args.then,
      thenValue: args.thenValue,
      else: args.else,
      elseValue: args.elseValue,
      result,
      resultType: args.resultType,
    });
    return result;
  }

  // --- string ops (#1169a) ------------------------------------------------

  emitStringConst(value: string): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "string" };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("string", resultType);
    this.pushInstr({ kind: "string.const", value, result, resultType, alloc });
    return result;
  }

  emitStringConcat(
    lhs: IrValueId,
    rhs: IrValueId,
    encodingEvidence?: IrStringEncoding,
    concatMode: IrStringConcatMode = "immutable",
  ): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "string" };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("string", resultType);
    this.pushInstr({ kind: "string.concat", lhs, rhs, result, resultType, alloc, encodingEvidence, concatMode });
    return result;
  }

  emitStringEq(lhs: IrValueId, rhs: IrValueId, negate: boolean): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: { kind: "i32" } };
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "string.eq", lhs, rhs, negate, result, resultType });
    return result;
  }

  emitStringLen(value: IrValueId, inputEncoding?: IrStringEncoding): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: { kind: "f64" } };
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "string.len", value, result, resultType, inputEncoding });
    return result;
  }

  emitStringCharAt(
    value: IrValueId,
    index: IrValueId,
    inputEncoding: IrStringEncoding,
    encodingEvidence: IrStringEncoding,
  ): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "string" };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("string", resultType);
    this.pushInstr({
      kind: "string.char_at",
      value,
      index,
      inputEncoding,
      encodingEvidence,
      result,
      resultType,
      alloc,
    });
    return result;
  }

  emitStringCharCodeAt(value: IrValueId, index: IrValueId, inputEncoding: IrStringEncoding): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: { kind: "f64" } };
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "string.char_code_at", value, index, inputEncoding, result, resultType });
    return result;
  }

  // --- dynamic value ops (#2949 S5.0) -------------------------------------
  //
  // Builder-level emit vocabulary for the `IrType.dynamic` boxed-any carrier:
  // `box` erases a concrete value into the carrier, `unbox` reads a proven
  // partition's payload back out, and `tag.test` classifies the carrier's
  // runtime JS tag. These are the plumbing the S5.1–S5.P dynamic-use-in-body
  // producers consume; the node-level LOWERING already landed in slices 2/3
  // (`lower.ts` box/unbox/tag.test cases → `resolveDynamicLowering` →
  // `IrDynamicLowering`, backed by `$AnyValue` / `__any_box_*` on WasmGC and
  // the `__box_number` / classifier import family on host).
  //
  // S5.0 is byte-inert by construction: these methods only APPEND verifier-
  // clean nodes, and no producer calls them yet (from-ast/select unchanged),
  // so no compiled function's Wasm changes (prove-emit-identity IDENTICAL).

  /**
   * Emit `box{value → toType}` — erase a concrete value into a boxed-any
   * carrier (`toType.kind === "dynamic"`) or a scalar tagged union
   * (`toType.kind === "union"`). Result type is `toType`.
   *
   * The operand must NOT itself be dynamic — a re-box is provably redundant
   * (verifier R1); this is asserted here so a producer bug surfaces at
   * construction time rather than as a malformed double-boxed carrier that
   * only fails later in verify/lower.
   *
   * A `dynamic` `toType` may carry a `tag` refinement (`irDynamic(JS_TAG_IDS.X)`);
   * lowering maps it onto the canonical boxing helper's representation hint
   * (e.g. a Boolean-refined i32 boxes as tag-4, not an unbranded number),
   * so producers that statically know the partition SHOULD refine the box
   * target — see slice-3 note 4 in the #2949 issue file.
   */
  emitBox(value: IrValueId, toType: IrType): IrValueId {
    if (this.typeOf(value).kind === "dynamic") {
      throw new Error(
        `IrFunctionBuilder: emitBox operand ${value} is already dynamic — re-boxing a dynamic value is invalid (#2949 R1) (func ${this.id.name})`,
      );
    }
    const result = this.allocator.fresh();
    this.valueTypes.set(result, toType);
    const alloc = this.allocId("box", toType);
    this.pushInstr({ kind: "box", value, toType, result, resultType: toType, alloc });
    return result;
  }

  /**
   * Emit `unbox{value, tagId}` — read the proven partition's payload off a
   * boxed-any carrier. The caller MUST have proved the tag already (via an
   * earlier `emitTagTest`, or a static refinement); lowering emits a payload
   * read without a runtime re-check.
   *
   * `tagId` must be payload-bearing: a SINGLETON partition has no payload
   * (`carrierKindOf === null`, verifier R2 — ECMAScript's Null/Undefined) and
   * its identity is observed via `emitTagTest` alone, so unboxing one is
   * rejected here.
   *
   * Result type is the partition's payload ValType per the DOMAIN's
   * `carrierKindOf`: `i32`, `f64`, or a ref-shaped carrier. The exact ref
   * ValType is a resolver/consumer decision at lowering (host: the externref
   * carrier is the value; WasmGC: String rides `externval`, Object/Function
   * ride `refval` — see slice-3 hazard (b)); the plumbing declares the
   * ref-shaped result as `externref` and the S5.4 member-read producer refines
   * it where a native ref is needed.
   *
   * #3954 phase 3 (W5) — takes a neutral `TagId` and asks `this.tagDomain`,
   * rather than taking `JsTag` and computing the ValType from the JS domain
   * reached as a global. A JS producer passes `JS_TAG_IDS.X`.
   */
  emitUnbox(value: IrValueId, tagId: TagId): IrValueId {
    const domain = this.tagDomain;
    const payload = domain.carrierKindOf(tagId);
    if (payload === null) {
      throw new Error(
        `IrFunctionBuilder: emitUnbox with payload-less partition ${domain.nameOf(tagId)} is invalid — use emitTagTest (#2949 R2) (func ${this.id.name})`,
      );
    }
    const payloadVal: ValType =
      payload === "i32" ? { kind: "i32" } : payload === "f64" ? { kind: "f64" } : { kind: "externref" };
    const resultType = irVal(payloadVal);
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "unbox", value, tagId, result, resultType });
    return result;
  }

  /**
   * Emit `tag.test{value, tagId}` — does the carrier's runtime tag match the
   * partition? Result is `i32` (1 if it matches, else 0).
   *
   * `tagId` may be ANY partition, including a payload-less singleton (testing
   * for them is the point — verifier R3). Under the JS domain the V2
   * numeric-class invariant applies: the two number partitions are ONE class,
   * so `tag.test` against either `NumberI32` or `NumberF64` lowers to the same
   * numeric-class test in both backends (slice-3 note 3 in the #2949 issue).
   */
  emitTagTest(value: IrValueId, tagId: TagId): IrValueId {
    const resultType = irVal({ kind: "i32" });
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "tag.test", value, tagId, result, resultType });
    return result;
  }

  /**
   * Emit `dyn.truthy{value}` — `ToBoolean(value)` (§7.1.2) on a boxed-any
   * carrier. Result is `i32` (1 = truthy, 0 = falsy), usable directly as an
   * `if` / loop / ternary `condValue` (#2949 S5.1).
   *
   * The operand MUST be `dynamic` — this is the general JS-truthiness op, not
   * a Boolean-partition read. Feeding a concrete scalar here is a producer
   * bug (a concrete value already lowers ToBoolean inline via the existing
   * `coerceLoopCondToBool` arms), so it is rejected at construction time
   * rather than silently mis-lowering the carrier. Lowering routes through
   * `IrDynamicLowering.emitToBoolean` → `coercion-engine.emitToBoolean`
   * (`__any_unbox_bool` gc / `__is_truthy` host) — one ToBoolean engine (D4).
   */
  emitDynTruthy(value: IrValueId): IrValueId {
    if (this.typeOf(value).kind !== "dynamic") {
      throw new Error(
        `IrFunctionBuilder: emitDynTruthy operand ${value} is not dynamic — general truthiness applies only to the boxed-any carrier (#2949 S5.1) (func ${this.id.name})`,
      );
    }
    const resultType = irVal({ kind: "i32" });
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "dyn.truthy", value, result, resultType });
    return result;
  }

  /**
   * Emit `dyn.to_number{value}` — `ToNumber(value)` (§7.1.4) on a boxed-any
   * carrier. Result is `f64`, feeding the existing `f64.lt`/`gt`/`le`/`ge`
   * numeric-abstract relational compare path (#2949 S5.3).
   *
   * The operand MUST be `dynamic` — this is the carrier ToNumber, not a
   * concrete-scalar conversion (a concrete numeric operand converts to f64
   * inline). Feeding a concrete value here is a producer bug, rejected at
   * construction time rather than mis-lowering the carrier. Lowering routes
   * through `IrDynamicLowering.emitToNumber` — `__any_to_f64` (gc, the SAME
   * boxed-any→f64 helper legacy's `__any_lt` family uses) / `__unbox_number`
   * (host, `Number(v)`) — one ToNumber engine (D4). SCOPE: numeric-abstract
   * only; string×string lexicographic relational is DEFERRED (see the
   * `IrInstrDynToNumber` node doc).
   */
  emitDynToNumber(value: IrValueId): IrValueId {
    if (this.typeOf(value).kind !== "dynamic") {
      throw new Error(
        `IrFunctionBuilder: emitDynToNumber operand ${value} is not dynamic — carrier ToNumber applies only to the boxed-any carrier (#2949 S5.3) (func ${this.id.name})`,
      );
    }
    const resultType = irVal({ kind: "f64" });
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "dyn.to_number", value, result, resultType });
    return result;
  }

  /**
   * Emit `dyn.eq{lhs, rhs, loose, negate}` — strict/loose equality between two
   * boxed-any carriers, result `i32` (0/1) (#2949 S5.2).
   *
   * BOTH operands MUST be `dynamic`. The producer boxes any concrete operand
   * into the carrier first (`emitBox(v, irDynamic(...))`), leaving the dyn side
   * as-is, so both operands are carriers by the time they reach here — exactly
   * the `(ref null $AnyValue, ref null $AnyValue)` shape the canonical
   * `__any_strict_eq` / `__any_eq` helpers take. A concrete operand slipping
   * through is a producer bug (a concrete `===` has an inline scalar compare),
   * rejected at construction rather than mis-lowered through the carrier.
   *
   * @param opts.loose  `true` = `==`/`!=` (`__any_eq`); `false` = `===`/`!==`
   *                    (`__any_strict_eq`).
   * @param opts.negate `true` = `!==`/`!=` — append `i32.eqz` at lowering.
   */
  emitDynEq(lhs: IrValueId, rhs: IrValueId, opts: { loose: boolean; negate: boolean }): IrValueId {
    for (const [label, v] of [
      ["lhs", lhs],
      ["rhs", rhs],
    ] as const) {
      if (this.typeOf(v).kind !== "dynamic") {
        throw new Error(
          `IrFunctionBuilder: emitDynEq ${label} operand ${v} is not dynamic — carrier equality applies only to boxed-any operands; box concrete operands first (#2949 S5.2) (func ${this.id.name})`,
        );
      }
    }
    const resultType = irVal({ kind: "i32" });
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "dyn.eq", lhs, rhs, loose: opts.loose, negate: opts.negate, result, resultType });
    return result;
  }

  /**
   * Emit `dyn.member_get{recv, key}` — a dynamic member read `recv[key]` /
   * `recv.name` on a boxed-any receiver, result `dynamic` (#3053 U1 / #2949
   * S5.4).
   *
   * BOTH operands MUST be `dynamic` carriers. The receiver is already the
   * carrier (an `any`-typed value); the key is a boxed property name (string)
   * or boxed index — the producer boxes them first, so this node always sees
   * the `(carrier, carrier) -> carrier` shape the unified reader primitive
   * `__dyn_member_get(recv, key)` (#3053 U0) takes and returns. A concrete
   * operand slipping through is a producer bug (the receiver would need a box,
   * the key its own `ToPropertyKey`), rejected here at construction rather than
   * mis-lowered through the carrier ABI.
   *
   * Lowering routes through `IrDynamicLowering.emitMemberGet` — a bare
   * `[call __dyn_member_get]` that flips `ctx.usesDynMemberGet`. The result
   * carrier is identity-preserving + tag-honest (the helper closes the
   * externref↔carrier round-trip in its OWN frame, U0), so the read composes:
   * `recv.a.z` is two chained `dyn.member_get`s with no `__any_to_extern`
   * tag-6 breaker in between.
   */
  emitDynMemberGet(recv: IrValueId, key: IrValueId): IrValueId {
    for (const [label, v] of [
      ["recv", recv],
      ["key", key],
    ] as const) {
      if (this.typeOf(v).kind !== "dynamic") {
        throw new Error(
          `IrFunctionBuilder: emitDynMemberGet ${label} operand ${v} is not dynamic — the dynamic member read applies only to boxed-any carriers; box the receiver/key first (#3053 U1 / #2949 S5.4) (func ${this.id.name})`,
        );
      }
    }
    const resultType = irDynamic();
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "dyn.member_get", recv, key, result, resultType });
    return result;
  }

  /**
   * Emit the void, strict statement-position write dual of
   * {@link emitDynMemberGet}. Receiver, key, and value must already use the
   * canonical dynamic carrier; conversion is explicit at the AST producer.
   */
  emitDynMemberSet(recv: IrValueId, key: IrValueId, value: IrValueId): void {
    for (const [label, v] of [
      ["recv", recv],
      ["key", key],
      ["value", value],
    ] as const) {
      if (this.typeOf(v).kind !== "dynamic") {
        throw new Error(
          `IrFunctionBuilder: emitDynMemberSet ${label} operand ${v} is not dynamic — the dynamic member write accepts only boxed-any carriers (#3795) (func ${this.id.name})`,
        );
      }
    }
    this.pushInstr({ kind: "dyn.member_set", recv, key, value, result: null, resultType: null });
  }

  // --- object ops (#1169b) ------------------------------------------------

  /**
   * Emit `object.new` to materialize an object literal. The caller is
   * responsible for canonicalizing `shape.fields` (sorted ascending by
   * name) and for ensuring `values[i]` matches `shape.fields[i].type`.
   * The arity check is enforced here so a stray slice-2 selector miss
   * surfaces immediately instead of as a malformed Wasm struct.new.
   */
  emitObjectNew(shape: IrObjectShape, values: readonly IrValueId[]): IrValueId {
    if (values.length !== shape.fields.length) {
      throw new Error(
        `IrFunctionBuilder: object.new value count ${values.length} != shape field count ${shape.fields.length} (func ${this.id.name})`,
      );
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "object", shape };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("object", resultType);
    this.pushInstr({
      kind: "object.new",
      shape,
      values: [...values],
      result,
      resultType,
      alloc,
    });
    return result;
  }

  /**
   * Emit `object.get` to read a named field. Caller passes the field's
   * declared IrType so the SSA def's static type matches the shape's
   * field type without a second lookup at lowering time.
   */
  emitObjectGet(value: IrValueId, name: string, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({
      kind: "object.get",
      value,
      name,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Emit `object.set` to write a named field. Void result.
   */
  emitObjectSet(value: IrValueId, name: string, newValue: IrValueId): void {
    this.pushInstr({
      kind: "object.set",
      value,
      name,
      newValue,
      result: null,
      resultType: null,
    });
  }

  // --- closure / ref-cell ops (#1169c) -----------------------------------

  /**
   * Materialize a closure value. Caller is responsible for ensuring
   * `captureFieldTypes[i]` matches the IR type of the SSA value at
   * `captures[i]`. The arity check below catches mistakes early.
   */
  emitClosureNew(
    liftedFunc: IrFuncRef,
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    captures: readonly IrValueId[],
    options: Pick<NonNullable<IrFunction["closureSubtype"]>, "hostOneShot" | "domCallbackAuthority"> = {},
  ): IrValueId {
    if (captureFieldTypes.length !== captures.length) {
      throw new Error(
        `IrFunctionBuilder: closure.new captureFieldTypes count ${captureFieldTypes.length} != captures count ${captures.length} (func ${this.id.name})`,
      );
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "closure", signature };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("closure", resultType);
    this.pushInstr({
      kind: "closure.new",
      liftedFunc,
      signature,
      captureFieldTypes: [...captureFieldTypes],
      captures: [...captures],
      ...(options.hostOneShot ? { hostOneShot: true } : {}),
      ...(options.domCallbackAuthority ? { domCallbackAuthority: options.domCallbackAuthority } : {}),
      result,
      resultType,
      alloc,
    });
    return result;
  }

  /**
   * Read a capture field from the implicit `__self` closure struct.
   * Caller passes the field's IrType so the SSA def's static type is
   * stable without a second resolver lookup at lowering time.
   */
  emitClosureCap(self: IrValueId, index: number, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({
      kind: "closure.cap",
      self,
      index,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Invoke a closure value. Caller passes `resultType` (= signature.returnType)
   * for the SSA def, or null for a void call in statement position.
   */
  emitClosureCall(callee: IrValueId, args: readonly IrValueId[], resultType: IrType | null): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    this.pushInstr({
      kind: "closure.call",
      callee,
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  /**
   * Wrap a primitive value in a fresh ref cell. The SSA def's type is
   * `{ kind: "boxed", inner }`. #1926 — the `boxed` IrType carries an IrType
   * `inner`, so the ValType arg is wrapped with `irVal` here; the resolver
   * unwraps it back to the ValType at lowering time.
   */
  emitRefCellNew(value: IrValueId, inner: ValType): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "boxed", inner: irVal(inner) };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("refcell", resultType);
    this.pushInstr({
      kind: "refcell.new",
      value,
      result,
      resultType,
      alloc,
    });
    return result;
  }

  /**
   * Read the inner value out of a ref cell. The SSA def's type is the cell's
   * `inner` IrType. #1926 — `inner` is now the `boxed` IrType's `inner`
   * field (an IrType), passed straight through as the result type. Callers
   * pass the same `inner` they used for the matching `boxed` cell (for V1
   * primitive cells this is `irVal(scalar)`, so the result type is
   * `{ kind: "val", val: scalar }` exactly as before).
   */
  emitRefCellGet(cell: IrValueId, inner: IrType): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = inner;
    this.valueTypes.set(result, resultType);
    this.pushInstr({
      kind: "refcell.get",
      cell,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Write a new value through the ref cell. Void result.
   */
  emitRefCellSet(cell: IrValueId, value: IrValueId): void {
    this.pushInstr({
      kind: "refcell.set",
      cell,
      value,
      result: null,
      resultType: null,
    });
  }

  /**
   * Phase 1 escape hatch — emit raw backend ops with a stated stack delta.
   * Verifier requires stackDelta to match the effective push count.
   */
  emitRawWasm(ops: readonly Instr[], stackDelta: number): void {
    this.pushInstr({ kind: "raw.wasm", ops: [...ops], stackDelta, result: null, resultType: null });
  }

  // --- class ops (#1169d) -------------------------------------------------

  /**
   * Emit `class.new` through the class-owned AST-free `<className>_new`
   * wrapper. Caller is responsible for ensuring
   * `args[i]` matches `shape.constructorParams[i]`. The arity check below
   * catches mistakes early.
   */
  emitClassNew(shape: IrClassShape, args: readonly IrValueId[]): IrValueId {
    if (args.length !== shape.constructorParams.length) {
      throw new Error(
        `IrFunctionBuilder: class.new arg count ${args.length} != constructor arity ${shape.constructorParams.length} (func ${this.id.name}, class ${shape.className})`,
      );
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "class", shape };
    this.valueTypes.set(result, resultType);
    // The ctor body allocates internally (black-box per #1586 non-goals); the
    // site is the constructing call, kind "object".
    const alloc = this.allocId("object", resultType);
    this.pushInstr({
      kind: "class.new",
      shape,
      ...(shape.constructorTarget ? { target: shape.constructorTarget } : {}),
      args: [...args],
      result,
      resultType,
      alloc,
    });
    return result;
  }

  /**
   * Emit `class.get` to read a named field on a class instance. Caller
   * passes the field's IrType (looked up against the receiver's shape) so
   * the SSA def's static type matches without a second resolver lookup.
   */
  emitClassGet(value: IrValueId, fieldName: string, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({
      kind: "class.get",
      value,
      fieldName,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Emit `class.set` to write a named field on a class instance. Void
   * result. The receiver's shape must contain `fieldName`; arity / type
   * checks happen at the AST→IR layer.
   */
  emitClassSet(value: IrValueId, fieldName: string, newValue: IrValueId): void {
    this.pushInstr({
      kind: "class.set",
      value,
      fieldName,
      newValue,
      result: null,
      resultType: null,
    });
  }

  /** Invoke an instance member while keeping semantic kind separate from its
   * compatibility spelling. A void method/setter returns `null`.
   */
  emitClassCall(
    receiver: IrValueId,
    methodName: string,
    memberKind: Exclude<IrClassMemberKind, "static">,
    args: readonly IrValueId[],
    resultType: IrType | null,
    target?: IrFuncRef,
  ): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    this.pushInstr({
      kind: "class.call",
      receiver,
      memberKind,
      methodName,
      ...(target ? { target } : {}),
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  /**
   * #3000-E: emit `class.super_init` for a derived ctor's `super(args)`. Runs
   * the PARENT's `<parent>_init` on the already-allocated `self`. Statement-only
   * (no SSA result) — the parent init's `(ref $struct)` return is dropped by the
   * lowering. `self` is the subclass instance (a WasmGC subtype of the parent).
   */
  emitClassSuperInit(parentShape: IrClassShape, self: IrValueId, args: readonly IrValueId[]): void {
    this.pushInstr({
      kind: "class.super_init",
      parentShape,
      ...(parentShape.constructorInitTarget ? { target: parentShape.constructorInitTarget } : {}),
      self,
      args: [...args],
      result: null,
      resultType: null,
    });
  }

  /**
   * #3000-E: emit `class.super_call` for `super.method(args)`. Static-dispatches
   * to the PARENT's `<parent>_<method>` slot with the subclass receiver.
   * `resultType` is the parent method descriptor's `returnType` (`null` for void);
   * returns `null` for void methods (callers in expression position reject null).
   */
  emitClassSuperCall(
    parentShape: IrClassShape,
    receiver: IrValueId,
    methodName: string,
    args: readonly IrValueId[],
    resultType: IrType | null,
    target?: IrFuncRef,
  ): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    this.pushInstr({
      kind: "class.super_call",
      parentShape,
      receiver,
      methodName,
      ...(target ? { target } : {}),
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  /**
   * (#3144) Emit `class.instanceof` — `value instanceof <targetShape.className>`.
   * `value` must be an `IrType.class` SSA def (non-null class carrier).
   * Result type: i32 (JS boolean; 0/1).
   */
  emitClassInstanceOf(value: IrValueId, targetShape: IrClassShape): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "val", val: { kind: "i32" } };
    this.valueTypes.set(result, resultType);
    this.pushInstr({
      kind: "class.instanceof",
      value,
      targetShape,
      result,
      resultType,
    });
    return result;
  }

  /**
   * (#3144) Emit `class.static_call` for `C.m(args)` on a local user class.
   * No receiver (legacy statics take no `self` param). `resultType` is the
   * static descriptor's `returnType` (`null` for void → returns `null`).
   */
  emitClassStaticCall(
    shape: IrClassShape,
    methodName: string,
    args: readonly IrValueId[],
    resultType: IrType | null,
    target?: IrFuncRef,
  ): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    this.pushInstr({
      kind: "class.static_call",
      shape,
      methodName,
      ...(target ? { target } : {}),
      args: [...args],
      result,
      resultType,
    });
    return result;
  }

  // --- extern class ops (#1169i — slice 10) -------------------------------

  /**
   * Slice 10 (#1169i) — emit `extern.new` for `new ExternClass(args)`.
   * Result type is `{ kind: "extern", className }` — opaque externref
   * carrying the class identity statically.
   */
  emitExternNew(className: string, args: readonly IrValueId[], importPrefix = className): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "extern", className };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("extern", resultType);
    this.pushInstr({
      kind: "extern.new",
      className,
      importPrefix,
      args: [...args],
      result,
      resultType,
      alloc,
    });
    return result;
  }

  /**
   * Slice 10 (#1169i) — emit `extern.call` for `<recv>.<method>(args)` on
   * an extern-class receiver. `resultType` is the method's registered
   * result IrType (or `null` for void). Returns `null` for void methods.
   */
  emitExternCall(
    className: string,
    method: string,
    receiver: IrValueId,
    args: readonly IrValueId[],
    resultType: IrType | null,
  ): IrValueId | null {
    let result: IrValueId | null = null;
    if (resultType !== null) {
      result = this.allocator.fresh();
      this.valueTypes.set(result, resultType);
    }
    // #1588 Phase 2: string-returning extern call (e.g. TextDecoder.decode) is
    // a string allocation site — inert id for the encoding analysis.
    const alloc = resultType?.kind === "string" ? this.allocId("string", resultType) : undefined;
    this.pushInstr({
      kind: "extern.call",
      className,
      method,
      receiver,
      args: [...args],
      result,
      resultType,
      alloc,
    });
    return result;
  }

  /**
   * Slice 10 (#1169i) — emit `extern.prop` for a property read on an
   * extern-class receiver.
   */
  emitExternProp(className: string, property: string, receiver: IrValueId, resultType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({
      kind: "extern.prop",
      className,
      property,
      receiver,
      result,
      resultType,
    });
    return result;
  }

  /**
   * Slice 10 (#1169i) — emit `extern.propSet` for a property write on an
   * extern-class receiver. Void result.
   */
  emitExternPropSet(className: string, property: string, receiver: IrValueId, value: IrValueId): void {
    this.pushInstr({
      kind: "extern.propSet",
      className,
      property,
      receiver,
      value,
      result: null,
      resultType: null,
    });
  }

  /**
   * Slice 10 (#1169i) — emit `extern.regex` for a `/pattern/flags`
   * RegExp literal. Result is `{ kind: "extern", className: "RegExp" }`
   * (opaque externref handle to the RegExp instance).
   */
  emitRegExpLiteral(pattern: string, flags: string): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "extern", className: "RegExp" };
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("extern", resultType);
    this.pushInstr({
      kind: "extern.regex",
      pattern,
      flags,
      result,
      resultType,
      alloc,
    });
    return result;
  }

  // --- finalize -----------------------------------------------------------

  typeOf(value: IrValueId): IrType {
    const t = this.valueTypes.get(value);
    if (t === undefined) {
      throw new Error(`IrFunctionBuilder: unknown value ${value} in func ${this.id.name}`);
    }
    return t;
  }

  finish(closureSubtype?: NonNullable<IrFunction["closureSubtype"]>): IrFunction {
    if (this.current !== null) {
      throw new Error(`IrFunctionBuilder: finish() while block ${this.current.id} still open (func ${this.id.name})`);
    }
    if (this.reserved.size > 0) {
      const ids = [...this.reserved].map((b) => b as number).join(",");
      throw new Error(`IrFunctionBuilder: reserved block(s) [${ids}] never opened (func ${this.id.name})`);
    }
    if (this.finished.length === 0) {
      throw new Error(`IrFunctionBuilder: function ${this.id.name} has no blocks`);
    }
    // Blocks may have been pushed out-of-order (a forward-referenced block is
    // opened after blocks allocated during its predecessor's lowering). The
    // verifier and the lowerer both expect `blocks[i].id === i`.
    const sorted = [...this.finished].sort((a, b) => (a.id as number) - (b.id as number));
    return {
      ...this.id,
      params: this.params,
      resultTypes: [...this.resultTypes],
      blocks: sorted,
      exported: this.exported,
      valueCount: this.allocator.count,
      ...(closureSubtype ? { closureSubtype } : {}),
      ...(this.slotDefs.length > 0 ? { slots: [...this.slotDefs] } : {}),
      ...(this.funcKind !== "regular" ? { funcKind: this.funcKind } : {}),
      ...(this.generatorBufferSlot !== undefined ? { generatorBufferSlot: this.generatorBufferSlot } : {}),
    };
  }

  // --- generator / async (slice 7a — #1169f) ------------------------------

  /**
   * Slice 7a (#1169f): set the function kind. Must be called before any
   * `gen.push` / `gen.epilogue` is emitted. Idempotent — subsequent calls
   * with the same value are no-ops; calls with a different value throw.
   */
  setFuncKind(kind: "regular" | "generator" | "async"): void {
    if (kind !== "regular" && this.funcKind !== "regular" && this.funcKind !== kind) {
      throw new Error(`IrFunctionBuilder: setFuncKind conflict in ${this.id.name} (was ${this.funcKind}, now ${kind})`);
    }
    this.funcKind = kind;
  }

  /**
   * Slice 7a (#1169f): record the slot index of the `__gen_buffer`
   * Wasm-local. Called from the generator-prologue emitter in from-ast
   * after `declareSlot("__gen_buffer", { kind: "externref" })` allocates
   * the slot. The lowerer reads this when expanding `gen.push` /
   * `gen.epilogue`.
   */
  setGeneratorBufferSlot(slotIndex: number): void {
    if (this.funcKind !== "generator") {
      throw new Error(`IrFunctionBuilder: setGeneratorBufferSlot requires funcKind=generator (${this.id.name})`);
    }
    this.generatorBufferSlot = slotIndex;
  }

  /**
   * (#1373b C-1) The IrType recorded for an SSA value, or `undefined` for an
   * unknown id. Used by from-ast's `await` lowering to decide passthrough
   * (non-externref operand — already the raw value under the sync model) vs
   * emitting an `await` instr (externref operand — per-lane unwrap/identity
   * decided in lower.ts).
   */
  valueType(value: IrValueId): IrType | undefined {
    return this.valueTypes.get(value);
  }

  /**
   * (#1373b C-1) Emit an `await` instr over an externref-shaped operand.
   * Result is externref (the settled value under the sync-pass-through model:
   * native-carrier lanes unwrap one `$Promise` level, JS-host lanes pass the
   * operand through — see lower.ts `case "await"`). Only valid inside
   * `funcKind === "async"` functions.
   */
  emitAwait(operand: IrValueId, resultType: IrType = { kind: "val", val: { kind: "externref" } }): IrValueId {
    if (this.funcKind !== "async") {
      throw new Error(`IrFunctionBuilder: emitAwait requires funcKind=async (${this.id.name})`);
    }
    const result = this.allocator.fresh();
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "await", operand, result, resultType });
    return result;
  }

  /** Emit a `gen.push` instr — push a yielded value onto the buffer. */
  emitGenPush(value: IrValueId): void {
    if (this.funcKind !== "generator") {
      throw new Error(`IrFunctionBuilder: emitGenPush requires funcKind=generator (${this.id.name})`);
    }
    this.pushInstr({ kind: "gen.push", value, result: null, resultType: null });
  }

  /**
   * Emit a `gen.epilogue` instr — produce the Generator-like object via
   * `__create_generator(buffer, pendingThrow)`. Returns the SSA value of
   * the resulting externref (the Generator object), suitable for use in a
   * `return [result]` terminator.
   */
  emitGenEpilogue(): IrValueId {
    if (this.funcKind !== "generator") {
      throw new Error(`IrFunctionBuilder: emitGenEpilogue requires funcKind=generator (${this.id.name})`);
    }
    if (this.generatorBufferSlot === undefined) {
      throw new Error(`IrFunctionBuilder: emitGenEpilogue requires setGeneratorBufferSlot first (${this.id.name})`);
    }
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "externref" });
    this.valueTypes.set(result, resultType);
    // `__create_generator(buffer)` allocates the Generator object (black-box).
    const alloc = this.allocId("generator", resultType);
    this.pushInstr({ kind: "gen.epilogue", result, resultType, alloc });
    return result;
  }

  /**
   * Slice 7b (#1169f): emit a `gen.yieldStar` instr — drain the inner
   * iterable into the outer generator's buffer via
   * `__gen_yield_star(buf, inner)`. The caller MUST coerce `inner` to
   * externref upstream (e.g. via `emitCoerceToExternref`) — the host
   * import expects an externref in arg position 1.
   */
  emitGenYieldStar(inner: IrValueId): void {
    if (this.funcKind !== "generator") {
      throw new Error(`IrFunctionBuilder: emitGenYieldStar requires funcKind=generator (${this.id.name})`);
    }
    this.pushInstr({ kind: "gen.yieldStar", inner, result: null, resultType: null });
  }

  /**
   * #2951: emit a `gen.setReturn` instr — stash a generator's `return
   * <value>` on the buffer via `__gen_set_return(buf, value)`. The lowerer
   * BOXES `value` to externref (f64 → __box_number; i32 → convert+box;
   * ref/ref_null → extern.convert_any; externref → pass through). The caller
   * passes `value` in its NATIVE dispatch shape (f64 / i32 stay native;
   * reference-shaped values coerced to externref upstream), exactly like
   * `emitGenPush`. Guarded on `funcKind === "generator"` +
   * `generatorBufferSlot` set (mirrors the `emitGenPush` guards).
   */
  emitGenSetReturn(value: IrValueId): void {
    if (this.funcKind !== "generator") {
      throw new Error(`IrFunctionBuilder: emitGenSetReturn requires funcKind=generator (${this.id.name})`);
    }
    if (this.generatorBufferSlot === undefined) {
      throw new Error(`IrFunctionBuilder: emitGenSetReturn requires setGeneratorBufferSlot first (${this.id.name})`);
    }
    this.pushInstr({ kind: "gen.setReturn", value, result: null, resultType: null });
  }

  private requireBlock(): OpenBlock {
    if (this.current === null) {
      throw new Error(`IrFunctionBuilder: no open block (func ${this.id.name})`);
    }
    return this.current;
  }

  /**
   * Slice 6 (#1169e): single push site for IR instrs. Routes to either the
   * current open block's instr list or — if a body buffer is active — into
   * that buffer instead. The for-of-body builder uses this redirection so
   * its lowered statements end up in `IrInstrForOfVec.body` rather than in
   * the surrounding block's instr list.
   */
  private pushInstr(instr: IrInstr): void {
    if (this.bodyBuffer !== null) {
      this.bodyBuffer.push(instr);
      return;
    }
    this.requireBlock().instrs.push(instr);
  }

  // --- slot allocation (slice 6 — #1169e) ---------------------------------

  /**
   * Allocate a Wasm-local slot for cross-iteration mutable state. Returns
   * the slot's stable index, usable with `slot.read` / `slot.write`.
   * `type` must be a primitive ValType (no struct refs in slice 6).
   */
  declareSlot(name: string, type: ValType): number {
    const index = this.slotDefs.length;
    this.slotDefs.push({ index, name, type });
    return index;
  }

  /** Read a slot by its index. Returns the SSA value of the load. */
  emitSlotRead(slotIndex: number): IrValueId {
    const slot = this.slotDefs[slotIndex];
    if (!slot) {
      throw new Error(`IrFunctionBuilder: slot.read with unknown index ${slotIndex} (func ${this.id.name})`);
    }
    const result = this.allocator.fresh();
    const resultType = irVal(slot.type);
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "slot.read", slotIndex, result, resultType });
    return result;
  }

  /**
   * Slice 6 part 4 refactor (#1185): read a slot but tag the SSA def
   * with a caller-supplied IrType instead of `irVal(slot.type)`.
   * The Wasm-level value produced is identical — `slot.read` lowers
   * to a single `local.get` either way — so this is purely a
   * type-system rewrite. The caller is responsible for ensuring
   * `asType` is interconvertible with `irVal(slot.type)` at the
   * Wasm level (e.g. `IrType.string` and `(ref $AnyString)` are
   * interconvertible in native-strings mode).
   *
   * Used by the slot-binding `asType` widening in `lowerExpr`'s
   * identifier handler — see the `slot` arm of `ScopeBinding`.
   */
  emitSlotReadAs(slotIndex: number, asType: IrType): IrValueId {
    const slot = this.slotDefs[slotIndex];
    if (!slot) {
      throw new Error(`IrFunctionBuilder: slot.read with unknown index ${slotIndex} (func ${this.id.name})`);
    }
    const result = this.allocator.fresh();
    this.valueTypes.set(result, asType);
    this.pushInstr({ kind: "slot.read", slotIndex, result, resultType: asType });
    return result;
  }

  /** Write a value to a slot by its index. */
  emitSlotWrite(slotIndex: number, value: IrValueId): void {
    const slot = this.slotDefs[slotIndex];
    if (!slot) {
      throw new Error(`IrFunctionBuilder: slot.write with unknown index ${slotIndex} (func ${this.id.name})`);
    }
    this.pushInstr({ kind: "slot.write", slotIndex, value, result: null, resultType: null });
  }

  // --- vec ops (slice 6 — #1169e) -----------------------------------------

  /** Read `vec.length` (returned as f64 to match JS Number semantics). */
  emitVecLen(vec: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "f64" });
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "vec.len", vec, result, resultType });
    return result;
  }

  /** Read a proven vector length without the JavaScript-number promotion. */
  emitVecLenI32(vec: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "i32" });
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "vec.len", vec, integer: true, result, resultType });
    return result;
  }

  /**
   * Index into a vec's data array. `indexI32` MUST be an i32-typed SSA value
   * (not f64). `elemType` is the element's IrType, and the result carries it.
   */
  emitVecGet(vec: IrValueId, indexI32: IrValueId, elemType: IrType): IrValueId {
    const result = this.allocator.fresh();
    this.valueTypes.set(result, elemType);
    this.pushInstr({ kind: "vec.get", vec, index: indexI32, result, resultType: elemType });
    return result;
  }

  /** Store one value into a planned dense-vector element. */
  emitVecSet(vec: IrValueId, indexI32: IrValueId, newValue: IrValueId): void {
    this.pushInstr({
      kind: "vec.set",
      vec,
      index: indexI32,
      newValue,
      result: null,
      resultType: null,
    });
  }

  /** Update the logical i32 length of an already-allocated vector. */
  emitVecSetLength(vec: IrValueId, lengthI32: IrValueId): void {
    this.pushInstr({
      kind: "vec.set_length",
      vec,
      length: lengthI32,
      result: null,
      resultType: null,
    });
  }

  /** Construct a fixed vec whose result uses the resolver's `vecRefType`, so
   * downstream `vec.get`/`.length`/`for-of` reads retain the same identity. */
  emitVecNewFixed(
    elements: readonly IrValueId[],
    elementType: IrType,
    vecRefType: IrType,
    capacity = elements.length,
  ): IrValueId {
    const result = this.allocator.fresh();
    const resultType = vecRefType;
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("array", resultType);
    this.pushInstr({
      kind: "vec.new_fixed",
      elements: [...elements],
      elementType,
      capacity,
      result,
      resultType,
      alloc,
    });
    return result;
  }

  // --- for-of-vec (slice 6 — #1169e) --------------------------------------

  /**
   * Run a callback that emits the loop body's IR instrs into a side buffer.
   * The callback typically calls `lowerStmt` on each TS body statement;
   * those calls go through `lowerExpr` etc. and produce IR via the normal
   * builder methods, which route into the side buffer instead of the
   * current block.
   *
   * Returns the captured body instrs.
   */
  collectBodyInstrs(emit: () => void): IrInstr[] {
    // (#1392) Nesting support — required for nested optional chains
    // (`a?.b?.c` lowers to nested `IrInstrIf`s, each with its own arm
    // buffer). Save & restore the previous buffer so emissions inside
    // the inner `emit()` route to its own buffer; instructions emitted
    // AFTER the inner returns continue routing to the outer buffer.
    const previous = this.bodyBuffer;
    const buffer: IrInstr[] = [];
    this.bodyBuffer = buffer;
    try {
      emit();
    } finally {
      this.bodyBuffer = previous;
    }
    return buffer;
  }

  emitForOfVec(args: {
    vec: IrValueId;
    elementType: IrType;
    counterSlot: number;
    lengthSlot: number;
    vecSlot: number;
    dataSlot: number;
    elementSlot: number;
    body: readonly IrInstr[];
    /** #2952 slice 2 — loop identity for `br.label` targeting. */
    loopLabel?: IrLabelId;
  }): void {
    this.pushInstr({
      kind: "forof.vec",
      vec: args.vec,
      elementType: args.elementType,
      counterSlot: args.counterSlot,
      lengthSlot: args.lengthSlot,
      vecSlot: args.vecSlot,
      dataSlot: args.dataSlot,
      elementSlot: args.elementSlot,
      body: args.body,
      ...(args.loopLabel !== undefined ? { loopLabel: args.loopLabel } : {}),
      result: null,
      resultType: null,
    });
  }

  // --- coercion + iterator protocol (slice 6 part 3 — #1182) -----------

  /**
   * Coerce a reference-typed IR value to externref. Caller is responsible
   * for ensuring `value` has a reference IrType — numeric ValTypes
   * (i32/f64) cannot be coerced and produce an invalid Wasm body.
   */
  emitCoerceToExternref(value: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "externref" });
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "coerce.to_externref", value, result, resultType });
    return result;
  }

  /**
   * Pack an internal closure into the canonical externref callable ABI.
   * This is intentionally the only closure→callable conversion: signatures
   * must match exactly, so the boundary does not introduce callback
   * covariance or broaden selection.
   */
  emitCallablePack(value: IrValueId, signature: IrClosureSignature): IrValueId {
    const valueType = this.typeOf(value);
    if (valueType.kind !== "closure" || !closureSignatureEquals(valueType.signature, signature)) {
      throw new Error(`IrFunctionBuilder: callable pack requires an exact closure signature (func ${this.id.name})`);
    }
    const result = this.allocator.fresh();
    const resultType: IrType = { kind: "callable", signature };
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "coerce.to_externref", value, result, resultType });
    return result;
  }

  /**
   * Construct a host iterator handle from an externref iterable.
   * `async: false` calls `__iterator`; `async: true` calls
   * `__async_iterator` (reserved for #1169f, slice 7).
   */
  emitIterNew(iterable: IrValueId, async: boolean): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "externref" });
    this.valueTypes.set(result, resultType);
    const alloc = this.allocId("iterator", resultType);
    this.pushInstr({ kind: "iter.new", iterable, async, result, resultType, alloc });
    return result;
  }

  /**
   * Advance the iterator (`iter.next()`). Result is the iterator-result
   * object as externref. Side-effecting — DCE must not eliminate.
   */
  emitIterNext(iter: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "externref" });
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "iter.next", iter, result, resultType });
    return result;
  }

  /** Read `.done` off an iterator-result object. Returns i32 (bool). */
  emitIterDone(resultObj: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "i32" });
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "iter.done", resultObj, result, resultType });
    return result;
  }

  /** Read `.value` off an iterator-result object. Returns externref. */
  emitIterValue(resultObj: IrValueId): IrValueId {
    const result = this.allocator.fresh();
    const resultType: IrType = irVal({ kind: "externref" });
    this.valueTypes.set(result, resultType);
    this.pushInstr({ kind: "iter.value", resultObj, result, resultType });
    return result;
  }

  /** Call `iter.return()`. Void result. */
  emitIterReturn(iter: IrValueId): void {
    this.pushInstr({ kind: "iter.return", iter, result: null, resultType: null });
  }

  emitForOfIter(args: {
    iterable: IrValueId;
    iterSlot: number;
    resultSlot: number;
    elementSlot: number;
    body: readonly IrInstr[];
    /** #2952 slice 2 — loop identity for `br.label` targeting. */
    loopLabel?: IrLabelId;
  }): void {
    this.pushInstr({
      kind: "forof.iter",
      iterable: args.iterable,
      iterSlot: args.iterSlot,
      resultSlot: args.resultSlot,
      elementSlot: args.elementSlot,
      body: args.body,
      ...(args.loopLabel !== undefined ? { loopLabel: args.loopLabel } : {}),
      result: null,
      resultType: null,
    });
  }

  // --- string for-of (slice 6 part 4 — #1183) -----------------------------

  /**
   * Emit a `forof.string` declarative instr — the native-strings counter
   * loop over a string. Caller pre-allocates all four slots and passes
   * the body buffer collected via `collectBodyInstrs`. The lowerer is
   * responsible for emitting the `__str_charAt` calls + counter
   * arithmetic; this builder method just records the structured node.
   */
  emitForOfString(args: {
    str: IrValueId;
    counterSlot: number;
    lengthSlot: number;
    strSlot: number;
    elementSlot: number;
    body: readonly IrInstr[];
    /** #2952 slice 2 — loop identity for `br.label` targeting. */
    loopLabel?: IrLabelId;
  }): void {
    this.pushInstr({
      kind: "forof.string",
      str: args.str,
      counterSlot: args.counterSlot,
      lengthSlot: args.lengthSlot,
      strSlot: args.strSlot,
      elementSlot: args.elementSlot,
      body: args.body,
      ...(args.loopLabel !== undefined ? { loopLabel: args.loopLabel } : {}),
      result: null,
      resultType: null,
    });
  }

  // --- exception handling (slice 9 — #1169h) ------------------------------

  /**
   * Slice 9 (#1169h): emit a `throw` instruction. The `value` MUST be an
   * SSA value of `(externref)` ValType — callers coerce upstream via
   * `emitCoerceToExternref` for ref / object / class / closure values,
   * and via the legacy box helper for f64 / i32 (boxed by the host).
   *
   * The instruction produces no SSA value; control doesn't fall through.
   * The current block must still be terminated by the caller (typically
   * with `unreachable` for top-level throws, or implicitly by the surrounding
   * try-body buffer mechanism).
   */
  emitThrow(value: IrValueId): void {
    this.pushInstr({ kind: "throw", value, result: null, resultType: null });
  }

  /**
   * (#2856) Emit an early `return [value]` from inside a nested body buffer
   * (loop bodies / if.stmt arms). Lowers to the Wasm `return` op. `value`
   * is null for a bare `return;` in a void function; otherwise it must
   * already be coerced to the function's declared result type. See
   * `IrInstrEarlyReturn` for the soundness scope (no try/finally, no
   * iterator-protocol for-of, no generators — selector/from-ast enforced).
   */
  emitEarlyReturn(value: IrValueId | null): void {
    this.pushInstr({ kind: "early.return", value, result: null, resultType: null });
  }

  /**
   * Slice 9 (#1169h): emit a `try` instruction with a body, optional catch
   * handler, and optional finally body. Mirrors the for-of declarative
   * shape — the caller pre-collects each buffer via `collectBodyInstrs`.
   * Result is void.
   */
  emitTry(args: {
    body: readonly IrInstr[];
    catchClause?: { payloadSlot: number; body: readonly IrInstr[] };
    finallyBody?: readonly IrInstr[];
  }): void {
    this.pushInstr({
      kind: "try",
      body: args.body,
      ...(args.catchClause ? { catchClause: args.catchClause } : {}),
      ...(args.finallyBody ? { finallyBody: args.finallyBody } : {}),
      result: null,
      resultType: null,
    });
  }

  // --- generic structured loops (slice 12 — #1280) ------------------------

  /**
   * Slice 12 (#1280): emit a `while (cond) body` declarative loop. The
   * caller pre-collects the cond + body buffers via `collectBodyInstrs`
   * and threads through the SSA value emitted by the cond's last
   * instruction. The lowerer emits the canonical
   * `block { loop { <cond>; i32.eqz; br_if 1; <body>; br 0 } }`
   * Wasm pattern.
   */
  emitWhileLoop(args: {
    cond: readonly IrInstr[];
    condValue: IrValueId;
    body: readonly IrInstr[];
    /** #2952 slice 1 — set for `do { body } while (cond)` (post-test loop). */
    postCond?: boolean;
    /** #2952 slice 2 — loop identity for `br.label` targeting. */
    loopLabel?: IrLabelId;
  }): void {
    this.pushInstr({
      kind: "while.loop",
      cond: args.cond,
      condValue: args.condValue,
      body: args.body,
      ...(args.postCond ? { postCond: true } : {}),
      ...(args.loopLabel !== undefined ? { loopLabel: args.loopLabel } : {}),
      result: null,
      resultType: null,
    });
  }

  /**
   * Slice 12 (#1280): emit a `for (init; cond; update) body` declarative
   * loop. `init` is emitted as separate IR instructions BEFORE this
   * instr (a `let i = 0` is just a `lowerVarDecl`, no special encoding
   * needed). The instr carries cond, body, update.
   */
  emitForLoop(args: {
    cond: readonly IrInstr[];
    condValue: IrValueId;
    body: readonly IrInstr[];
    update: readonly IrInstr[];
    /** #2952 slice 2 — loop identity for `br.label` targeting. */
    loopLabel?: IrLabelId;
  }): void {
    this.pushInstr({
      kind: "for.loop",
      cond: args.cond,
      condValue: args.condValue,
      body: args.body,
      update: args.update,
      ...(args.loopLabel !== undefined ? { loopLabel: args.loopLabel } : {}),
      result: null,
      resultType: null,
    });
  }

  // --- multi-exit control flow (#2952 slice 2) -----------------------------

  /**
   * #2952 slice 2 — allocate a fresh per-function loop label. The from-ast
   * layer calls this once per lowered loop; unlabeled `break` / `continue`
   * emit `br.label` against the innermost loop's label.
   */
  freshLoopLabel(): IrLabelId {
    return asLabelId(this.nextLabelId++);
  }

  /**
   * #2952 slice 2 — emit a `br.label` (unlabeled `break` / `continue`
   * targeting the loop identified by `label`). Buffer-terminating; the
   * caller must not emit further instructions into the same buffer.
   */
  emitBrLabel(label: IrLabelId, mode: "break" | "continue"): void {
    this.pushInstr({ kind: "br.label", label, mode, result: null, resultType: null });
  }

  /**
   * #2952 slice 2 — emit a statement-level `if (cond) then [else]` inside a
   * nested buffer. Both arms are pre-collected via `collectBodyInstrs`;
   * `else` may be an empty array (plain if). Result is void.
   */
  emitIfStmt(args: { cond: IrValueId; then: readonly IrInstr[]; else: readonly IrInstr[] }): void {
    this.pushInstr({
      kind: "if.stmt",
      cond: args.cond,
      then: args.then,
      else: args.else,
      result: null,
      resultType: null,
    });
  }

  /**
   * #2952 slice 4 — emit a break-only labeled frame (`lbl: { ... }` over a
   * non-loop statement). Body pre-collected via `collectBodyInstrs`;
   * `br.label{label, "break"}` inside it exits the frame.
   */
  emitLabeledBlock(args: { label: IrLabelId; body: readonly IrInstr[] }): void {
    this.pushInstr({
      kind: "labeled.block",
      label: args.label,
      body: args.body,
      result: null,
      resultType: null,
    });
  }

  /**
   * #2952 slice 4 — emit a `switch` over literal tests. `tests[k]` is the
   * clause-k literal (null = default); `bodies[k]` its statement buffer
   * (falls through into k+1 unless it breaks). `breakLabel` is the exit
   * frame `break` targets (allocate via `freshLoopLabel`).
   */
  emitSwitch(args: {
    disc: IrValueId;
    discSlot: number;
    tests: readonly (number | null)[];
    bodies: readonly (readonly IrInstr[])[];
    breakLabel: IrLabelId;
  }): void {
    this.pushInstr({
      kind: "switch",
      disc: args.disc,
      discSlot: args.discSlot,
      tests: args.tests,
      bodies: args.bodies,
      breakLabel: args.breakLabel,
      result: null,
      resultType: null,
    });
  }
}

// Convenience: value-id brand with no underlying type map — useful for tests
// that want to pass raw integers around.
export function v(n: number): IrValueId {
  return asValueId(n);
}
