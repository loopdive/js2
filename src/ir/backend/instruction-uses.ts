// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
export function collectIrUses(instr: IrInstr): readonly IrValueId[] {
  switch (instr.kind) {
    case "const":
      return [];
    case "call":
      return instr.args;
    case "intrinsic":
      return instr.args;
    case "global.get":
      return [];
    case "global.set":
      return [instr.value];
    case "binary":
      return [instr.lhs, instr.rhs];
    case "unary":
      return [instr.rand];
    case "select":
      return [instr.condition, instr.whenTrue, instr.whenFalse];
    case "if":
      // (#1392) Surface only the cond at top level. Arm-buffer uses of
      // OUTER SSA values are surfaced separately via collectForOfBodyUses
      // so the cross-block / multi-use counters properly materialise
      // them in Wasm locals before the if-instr emits.
      return [instr.cond];
    case "raw.wasm":
      return [];
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
      return [instr.value];
    case "dyn.eq":
      return [instr.lhs, instr.rhs];
    case "dyn.member_get":
      return [instr.recv, instr.key];
    case "dyn.member_set":
      return [instr.recv, instr.key, instr.value];
    case "string.const":
      return [];
    case "string.concat":
    case "string.eq":
      return [instr.lhs, instr.rhs];
    case "string.repeat":
      return [instr.value, instr.count];
    case "string.len":
      return [instr.value];
    case "string.char_at":
    case "string.char_code_at":
      return [instr.value, instr.index];
    case "fnctor.new":
      return [
        ...instr.captureArgs,
        ...instr.args,
        ...(instr.constructorIdentity === null ? [] : [instr.constructorIdentity]),
      ];
    case "fnctor.get":
      return [instr.value];
    case "object.new":
      return instr.values;
    case "object.get":
      return [instr.value];
    case "object.set":
      return [instr.value, instr.newValue];
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new":
      return instr.captures;
    case "closure.cap":
      return [instr.self];
    case "closure.call":
      // INTENTIONAL DOUBLE COUNT for `callee`: the Wasm emission pattern
      // pushes the closure value twice (once as the implicit __self
      // argument, once as the source of the funcref struct.get). The
      // use-counter must see TWO uses so the closure value gets a Wasm
      // local — otherwise we'd re-emit the (potentially side-effecting)
      // closure subtree. The verifier's collectUses counts it ONCE
      // because that's a pure SSA def→use relationship.
      return [instr.callee, ...instr.args, instr.callee];
    case "refcell.new":
      return [instr.value];
    case "refcell.get":
      return [instr.cell];
    case "refcell.set":
      return [instr.cell, instr.value];
    // Slice 4 (#1169d): class ops.
    case "class.new":
      return instr.args;
    case "class.get":
      return [instr.value];
    case "class.set":
      return [instr.value, instr.newValue];
    case "class.call":
      return [instr.receiver, ...instr.args];
    case "class.super_init":
      return [...instr.args, instr.self];
    case "class.super_call":
      return [instr.receiver, ...instr.args];
    case "class.instanceof":
      return [instr.value];
    case "class.static_call":
      return instr.args;
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return [];
    case "slot.write":
      return [instr.value];
    case "vec.len":
      return [instr.vec];
    case "vec.get":
      return [instr.vec, instr.index];
    case "vec.set":
      return [instr.vec, instr.index, instr.newValue];
    case "vec.set_length":
      return [instr.vec, instr.length];
    case "vec.new_fixed":
      return instr.elements; // #1804
    case "forof.vec":
      // Body uses are collected separately and merged in by
      // `lowerIrFunctionToWasm`.
      return [instr.vec];
    // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
    case "coerce.to_externref":
      return [instr.value];
    case "iter.new":
      return [instr.iterable];
    case "iter.next":
      return [instr.iter];
    case "iter.done":
      return [instr.resultObj];
    case "iter.value":
      return [instr.resultObj];
    case "iter.return":
      return [instr.iter];
    case "forof.iter":
      // Same rationale as forof.vec — body uses surfaced separately.
      return [instr.iterable];
    // Slice 7a (#1169f): generator ops.
    case "gen.push":
      return [instr.value];
    case "gen.epilogue":
      // No SSA operand uses — buffer + pendingThrow are read from Wasm
      // locals (slot indices stored on the IrFunction).
      return [];
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar":
      return [instr.inner];
    // #2951 — generator `return <value>` stash.
    case "gen.setReturn":
      return [instr.value];
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string":
      return [instr.str];
    // Slice 9 (#1169h) — exception handling.
    case "throw":
      return [instr.value];
    case "try":
      // Body / catch / finally buffer uses are surfaced separately via
      // `collectForOfBodyUses` (recurses into try buffers).
      return [];
    // Slice 10 (#1169i) — extern class ops.
    case "extern.new":
      return instr.args;
    case "extern.call":
      return [instr.receiver, ...instr.args];
    case "extern.prop":
      return [instr.receiver];
    case "extern.propSet":
      return [instr.receiver, instr.value];
    case "extern.regex":
      return [];
    // Slice 12 (#1280) — generic structured loops. Body / cond / update
    // buffer uses are surfaced separately via `collectForOfBodyUses`.
    case "while.loop":
    case "for.loop":
      return [];
    // #2952 slice 2 — br.label has no SSA operands; if.stmt surfaces only
    // its cond (arm-buffer uses via `collectForOfBodyUses`, like `if`).
    case "br.label":
      return [];
    case "if.stmt":
      return [instr.cond];
    // #2952 slice 4 — labeled.block has no operands; switch surfaces its
    // disc (clause-buffer uses via `collectForOfBodyUses`).
    case "labeled.block":
      return [];
    case "switch":
      return [instr.disc];
    // (#1373 Phase B) Async / await IR nodes — type-only in this slice.
    // The lowering Phase C (#1373b) will inflate these into CPS-form
    // microtask-queue calls; until then they're never emitted by
    // from-ast and never reach the lowerer.
    case "await":
      return [instr.operand];
    case "async.return":
      return [instr.value];
    case "async.throw":
      return [instr.reason];
    // (#2856) Early return — the optional return value is a direct use.
    case "early.return":
      return instr.value !== null ? [instr.value] : [];
    // (#4070) Exhaustiveness gate. Under-reporting an instruction's uses would
    // corrupt the lowerer's use accounting (which decides what gets a Wasm
    // local), so the runtime arm throws rather than returning `[]`.
    default: {
      const _exhaustive: never = instr;
      void _exhaustive;
      // invariant (producer-promise): see emitInstrTree's twin above.
      throw new Error(
        `ir/lower: collectIrUses has no case for IR instruction kind ${(instr as { readonly kind: string }).kind}`,
      );
    }
  }
}
