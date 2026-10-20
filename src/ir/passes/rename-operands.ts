// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrInstr, IrValueId } from "../nodes.js";

function renameJsClassOperands(
  inst: Extract<IrInstr, { kind: `js.class.${string}` }>,
  rename: ReadonlyMap<IrValueId, IrValueId>,
): IrInstr {
  const mapped = (v: IrValueId): IrValueId => mapId(rename, v);
  const list = (values: readonly IrValueId[]): readonly IrValueId[] => {
    const next = values.map(mapped);
    return next.some((v, i) => v !== values[i]) ? next : values;
  };
  const storage = (value: import("../core/js-class-contracts.js").IrJsClassBindingStorage) =>
    value.kind === "cell" && mapped(value.cell) !== value.cell ? { ...value, cell: mapped(value.cell) } : value;
  const key = (value: import("../core/js-class-contracts.js").IrJsClassPropertyKey) =>
    value.kind === "computed" && mapped(value.value) !== value.value ? { ...value, value: mapped(value.value) } : value;
  let result: IrInstr;
  switch (inst.kind) {
    case "js.class.define":
      result = { ...inst, captures: list(inst.captures) };
      break;
    case "js.class.binding.new":
      return inst;
    case "js.class.binding.read":
      result = { ...inst, storage: storage(inst.storage) };
      break;
    case "js.class.binding.init":
    case "js.class.binding.write":
      result = {
        ...inst,
        storage: storage(inst.storage),
        value: mapped(inst.value),
      };
      break;
    case "js.class.construct":
      result = {
        ...inst,
        constructor: mapped(inst.constructor),
        newTarget: mapped(inst.newTarget),
        args: list(inst.args),
      };
      break;
    case "js.class.property.get":
      result = { ...inst, receiver: mapped(inst.receiver), key: key(inst.key) };
      break;
    case "js.class.property.define":
    case "js.class.property.set":
      result = {
        ...inst,
        receiver: mapped(inst.receiver),
        key: key(inst.key),
        value: mapped(inst.value),
      };
      break;
    case "js.class.frame.get":
      result = { ...inst, frame: mapped(inst.frame) };
      break;
    case "js.class.frame.new":
      result = {
        ...inst,
        environment: mapped(inst.environment),
        thisValue: mapped(inst.thisValue),
        homeObject: mapped(inst.homeObject),
        newTarget: mapped(inst.newTarget),
      };
      break;
    case "js.class.invoke":
      result = {
        ...inst,
        callable: mapped(inst.callable),
        receiver: mapped(inst.receiver),
        args: list(inst.args),
      };
      break;
    case "js.class.constructor.complete":
      result = {
        ...inst,
        self: mapped(inst.self),
        completion:
          inst.completion.kind === "return" && mapped(inst.completion.value) !== inst.completion.value
            ? { ...inst.completion, value: mapped(inst.completion.value) }
            : inst.completion,
      };
      break;
    case "js.class.identity":
      result = { ...inst, left: mapped(inst.left), right: mapped(inst.right) };
      break;
    case "js.class.instanceof":
      result = {
        ...inst,
        value: mapped(inst.value),
        constructor: mapped(inst.constructor),
      };
      break;
    default: {
      const never: never = inst;
      return never;
    }
  }
  return Object.keys(result).some((field) => Reflect.get(result, field) !== Reflect.get(inst, field)) ? result : inst;
}

function mapId(rename: ReadonlyMap<IrValueId, IrValueId>, v: IrValueId): IrValueId {
  return rename.get(v) ?? v;
}

/**
 * Rewrite operand IDs in an instruction. Does NOT touch `result` — reserved
 * for caller-scope renames (where we only redirect uses, not definitions).
 */
export function renameInstrOperands(inst: IrInstr, rename: ReadonlyMap<IrValueId, IrValueId>): IrInstr {
  if (rename.size === 0) return inst;
  switch (inst.kind) {
    case "js.class.define":
    case "js.class.binding.new":
    case "js.class.binding.init":
    case "js.class.binding.read":
    case "js.class.binding.write":
    case "js.class.construct":
    case "js.class.property.get":
    case "js.class.property.define":
    case "js.class.property.set":
    case "js.class.frame.get":
    case "js.class.invoke":
    case "js.class.constructor.complete":
    case "js.class.identity":
    case "js.class.instanceof":
    case "js.class.frame.new":
      return renameJsClassOperands(inst, rename);
    case "const":
    case "global.get":
    case "raw.wasm":
      return inst;
    case "call":
    case "intrinsic": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "global.set": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "binary": {
      const l = mapId(rename, inst.lhs);
      const r = mapId(rename, inst.rhs);
      if (l === inst.lhs && r === inst.rhs) return inst;
      return { ...inst, lhs: l, rhs: r };
    }
    case "unary": {
      const r = mapId(rename, inst.rand);
      if (r === inst.rand) return inst;
      return { ...inst, rand: r };
    }
    case "select": {
      const c = mapId(rename, inst.condition);
      const t = mapId(rename, inst.whenTrue);
      const f = mapId(rename, inst.whenFalse);
      if (c === inst.condition && t === inst.whenTrue && f === inst.whenFalse) return inst;
      return { ...inst, condition: c, whenTrue: t, whenFalse: f };
    }
    case "if": {
      // (#1392) Renames in the cond + carrier values; arm-buffer instrs
      // are walked recursively (each gets its own renameInstrOperands
      // call). Conservative — if any sub-instr changed, rebuild the if;
      // otherwise return unchanged.
      const c = mapId(rename, inst.cond);
      const t = mapId(rename, inst.thenValue);
      const e = mapId(rename, inst.elseValue);
      const newThen: IrInstr[] = [];
      const newElse: IrInstr[] = [];
      let armChanged = false;
      for (const sub of inst.then) {
        const r = renameInstrOperands(sub, rename);
        if (r !== sub) armChanged = true;
        newThen.push(r);
      }
      for (const sub of inst.else) {
        const r = renameInstrOperands(sub, rename);
        if (r !== sub) armChanged = true;
        newElse.push(r);
      }
      if (c === inst.cond && t === inst.thenValue && e === inst.elseValue && !armChanged) return inst;
      return {
        ...inst,
        cond: c,
        thenValue: t,
        elseValue: e,
        then: newThen,
        else: newElse,
      };
    }
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "string.const":
      return inst;
    case "dyn.eq":
    case "string.concat":
    case "string.eq": {
      const l = mapId(rename, inst.lhs);
      const r = mapId(rename, inst.rhs);
      if (l === inst.lhs && r === inst.rhs) return inst;
      return { ...inst, lhs: l, rhs: r };
    }
    case "string.repeat": {
      const value = mapId(rename, inst.value);
      const count = mapId(rename, inst.count);
      if (value === inst.value && count === inst.count) return inst;
      return { ...inst, value, count };
    }
    case "dyn.member_get": {
      const recv = mapId(rename, inst.recv);
      const key = mapId(rename, inst.key);
      if (recv === inst.recv && key === inst.key) return inst;
      return { ...inst, recv, key };
    }
    case "dyn.member_set": {
      const recv = mapId(rename, inst.recv);
      const key = mapId(rename, inst.key);
      const value = mapId(rename, inst.value);
      if (recv === inst.recv && key === inst.key && value === inst.value) return inst;
      return { ...inst, recv, key, value };
    }
    case "string.len": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "string.char_at":
    case "string.char_code_at": {
      const value = mapId(rename, inst.value);
      const index = mapId(rename, inst.index);
      if (value === inst.value && index === inst.index) return inst;
      return { ...inst, value, index };
    }
    case "fnctor.new": {
      let changed = false;
      const captureArgs = inst.captureArgs.map((value) => {
        const next = mapId(rename, value);
        changed ||= next !== value;
        return next;
      });
      const args = inst.args.map((value) => {
        const next = mapId(rename, value);
        changed ||= next !== value;
        return next;
      });
      const constructorIdentity = inst.constructorIdentity === null ? null : mapId(rename, inst.constructorIdentity);
      changed ||= constructorIdentity !== inst.constructorIdentity;
      if (!changed) return inst;
      return { ...inst, captureArgs, args, constructorIdentity };
    }
    case "fnctor.get": {
      const value = mapId(rename, inst.value);
      if (value === inst.value) return inst;
      return { ...inst, value };
    }
    case "object.new": {
      let changed = false;
      const newValues: IrValueId[] = [];
      for (const a of inst.values) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newValues.push(n);
      }
      if (!changed) return inst;
      return { ...inst, values: newValues };
    }
    case "object.get": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "object.set": {
      const v = mapId(rename, inst.value);
      const nv = mapId(rename, inst.newValue);
      if (v === inst.value && nv === inst.newValue) return inst;
      return { ...inst, value: v, newValue: nv };
    }
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new": {
      let changed = false;
      const newCaps: IrValueId[] = [];
      for (const c of inst.captures) {
        const n = mapId(rename, c);
        if (n !== c) changed = true;
        newCaps.push(n);
      }
      if (!changed) return inst;
      return { ...inst, captures: newCaps };
    }
    case "closure.cap": {
      const s = mapId(rename, inst.self);
      if (s === inst.self) return inst;
      return { ...inst, self: s };
    }
    case "closure.call": {
      const c = mapId(rename, inst.callee);
      let changed = c !== inst.callee;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, callee: c, args: newArgs };
    }
    case "refcell.new": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "refcell.get": {
      const c = mapId(rename, inst.cell);
      if (c === inst.cell) return inst;
      return { ...inst, cell: c };
    }
    case "refcell.set": {
      const c = mapId(rename, inst.cell);
      const v = mapId(rename, inst.value);
      if (c === inst.cell && v === inst.value) return inst;
      return { ...inst, cell: c, value: v };
    }
    // Slice 4 (#1169d): class ops.
    case "class.new": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "class.get": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "class.set": {
      const v = mapId(rename, inst.value);
      const nv = mapId(rename, inst.newValue);
      if (v === inst.value && nv === inst.newValue) return inst;
      return { ...inst, value: v, newValue: nv };
    }
    case "class.call": {
      const r = mapId(rename, inst.receiver);
      let changed = r !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: r, args: newArgs };
    }
    case "class.super_init": {
      const s = mapId(rename, inst.self);
      let changed = s !== inst.self;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, self: s, args: newArgs };
    }
    case "class.super_call": {
      const r = mapId(rename, inst.receiver);
      let changed = r !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: r, args: newArgs };
    }
    // (#3144): class.instanceof / class.static_call operand renames.
    case "class.instanceof": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "class.static_call": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return inst;
    case "slot.write": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "vec.len": {
      const v = mapId(rename, inst.vec);
      if (v === inst.vec) return inst;
      return { ...inst, vec: v };
    }
    case "vec.get": {
      const v = mapId(rename, inst.vec);
      const idx = mapId(rename, inst.index);
      if (v === inst.vec && idx === inst.index) return inst;
      return { ...inst, vec: v, index: idx };
    }
    case "vec.set": {
      const v = mapId(rename, inst.vec);
      const idx = mapId(rename, inst.index);
      const newValue = mapId(rename, inst.newValue);
      if (v === inst.vec && idx === inst.index && newValue === inst.newValue) return inst;
      return { ...inst, vec: v, index: idx, newValue };
    }
    case "vec.set_length": {
      const vec = mapId(rename, inst.vec);
      const length = mapId(rename, inst.length);
      if (vec === inst.vec && length === inst.length) return inst;
      return { ...inst, vec, length };
    }
    case "vec.new_fixed": {
      // #1804 — rewrite each element operand (mirrors object.new).
      let changed = false;
      const newElements: IrValueId[] = [];
      for (const e of inst.elements) {
        const n = mapId(rename, e);
        if (n !== e) changed = true;
        newElements.push(n);
      }
      if (!changed) return inst;
      return { ...inst, elements: newElements };
    }
    case "forof.vec": {
      const v = mapId(rename, inst.vec);
      // Body instrs must also have their operands rewritten.
      let bodyChanged = v !== inst.vec;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, vec: v, body: newBody };
    }
    // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
    case "coerce.to_externref": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "iter.new": {
      const v = mapId(rename, inst.iterable);
      if (v === inst.iterable) return inst;
      return { ...inst, iterable: v };
    }
    case "iter.next": {
      const v = mapId(rename, inst.iter);
      if (v === inst.iter) return inst;
      return { ...inst, iter: v };
    }
    case "iter.done":
    case "iter.value": {
      const v = mapId(rename, inst.resultObj);
      if (v === inst.resultObj) return inst;
      return { ...inst, resultObj: v };
    }
    case "iter.return": {
      const v = mapId(rename, inst.iter);
      if (v === inst.iter) return inst;
      return { ...inst, iter: v };
    }
    case "forof.iter": {
      const v = mapId(rename, inst.iterable);
      let bodyChanged = v !== inst.iterable;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, iterable: v, body: newBody };
    }
    // Slice 7a (#1169f): generator ops.
    case "gen.push": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "gen.epilogue":
      // No operands to rewrite.
      return inst;
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar": {
      const v = mapId(rename, inst.inner);
      if (v === inst.inner) return inst;
      return { ...inst, inner: v };
    }
    // #2951 — generator `return <value>` stash.
    case "gen.setReturn": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string": {
      const v = mapId(rename, inst.str);
      let bodyChanged = v !== inst.str;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, str: v, body: newBody };
    }
    // Slice 9 (#1169h) — exception handling.
    case "throw": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "try": {
      let changed = false;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newBody.push(renamed);
      }
      let newCatch = inst.catchClause;
      if (inst.catchClause) {
        const newCatchBody: IrInstr[] = [];
        let catchBodyChanged = false;
        for (const sub of inst.catchClause.body) {
          const renamed = renameInstrOperands(sub, rename);
          if (renamed !== sub) catchBodyChanged = true;
          newCatchBody.push(renamed);
        }
        if (catchBodyChanged) {
          changed = true;
          newCatch = {
            payloadSlot: inst.catchClause.payloadSlot,
            body: newCatchBody,
          };
        }
      }
      let newFinally = inst.finallyBody;
      if (inst.finallyBody) {
        const newFinBody: IrInstr[] = [];
        let finBodyChanged = false;
        for (const sub of inst.finallyBody) {
          const renamed = renameInstrOperands(sub, rename);
          if (renamed !== sub) finBodyChanged = true;
          newFinBody.push(renamed);
        }
        if (finBodyChanged) {
          changed = true;
          newFinally = newFinBody;
        }
      }
      if (!changed) return inst;
      return {
        ...inst,
        body: newBody,
        ...(newCatch ? { catchClause: newCatch } : {}),
        ...(newFinally ? { finallyBody: newFinally } : {}),
      };
    }
    // Slice 10 (#1169i): extern class ops.
    case "extern.new": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "extern.call": {
      const recv = mapId(rename, inst.receiver);
      let changed = recv !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: recv, args: newArgs };
    }
    case "extern.prop": {
      const recv = mapId(rename, inst.receiver);
      if (recv === inst.receiver) return inst;
      return { ...inst, receiver: recv };
    }
    case "extern.propSet": {
      const recv = mapId(rename, inst.receiver);
      const v = mapId(rename, inst.value);
      if (recv === inst.receiver && v === inst.value) return inst;
      return { ...inst, receiver: recv, value: v };
    }
    case "extern.regex":
      return inst;
    // Slice 12 (#1280): while.loop / for.loop. The cond/body/update
    // buffers carry their own SSA values and are renamed via the
    // recursive walker in inline-small's body-buffer pass (mirrors
    // the forof.* handling above). Renaming the condValue keeps the
    // instr-level reference consistent.
    case "while.loop": {
      const cv = mapId(rename, inst.condValue);
      if (cv === inst.condValue) return inst;
      return { ...inst, condValue: cv };
    }
    // #2952 slice 2 — br.label carries no SSA operands (label is a control
    // identity, untouched by value renames).
    case "br.label":
      return inst;
    // #2952 slice 2 — if.stmt: rename the cond + recurse into both arm
    // buffers (same pattern as `try` above), so a caller-scope rename
    // reaches arm-interior uses of the redirected value.
    case "if.stmt": {
      const cv = mapId(rename, inst.cond);
      let changed = cv !== inst.cond;
      const newThen: IrInstr[] = [];
      for (const sub of inst.then) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newThen.push(renamed);
      }
      const newElse: IrInstr[] = [];
      for (const sub of inst.else) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newElse.push(renamed);
      }
      if (!changed) return inst;
      return { ...inst, cond: cv, then: newThen, else: newElse };
    }
    // #2952 slice 4 — labeled block / switch: honest deep rename of the
    // clause buffers (+ disc), mirroring the if.stmt pattern. (canInline
    // skips functions containing these, so this is defensive parity.)
    case "labeled.block": {
      let changed = false;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newBody.push(renamed);
      }
      if (!changed) return inst;
      return { ...inst, body: newBody };
    }
    case "switch": {
      const dv = mapId(rename, inst.disc);
      let changed = dv !== inst.disc;
      const newBodies: IrInstr[][] = [];
      for (const body of inst.bodies) {
        const newBody: IrInstr[] = [];
        for (const sub of body) {
          const renamed = renameInstrOperands(sub, rename);
          if (renamed !== sub) changed = true;
          newBody.push(renamed);
        }
        newBodies.push(newBody);
      }
      if (!changed) return inst;
      return { ...inst, disc: dv, bodies: newBodies };
    }
    case "for.loop": {
      const cv = mapId(rename, inst.condValue);
      if (cv === inst.condValue) return inst;
      return { ...inst, condValue: cv };
    }
    // (#1373 Phase B) Async / await IR nodes — rename single operand.
    // Phase C may need richer renaming (continuation-closure capture
    // sets); for now the simple operand rename is sufficient.
    case "await": {
      const op = mapId(rename, inst.operand);
      if (op === inst.operand) return inst;
      return { ...inst, operand: op };
    }
    case "async.return": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "async.throw": {
      const r = mapId(rename, inst.reason);
      if (r === inst.reason) return inst;
      return { ...inst, reason: r };
    }
    // (#2856) Early return — rename the optional value. NB inlining a
    // function CONTAINING an early.return is unsound (the return would
    // exit the CALLER); the inline pass's eligibility check excludes the
    // kind in `canInline`.
    case "early.return": {
      if (inst.value === null) return inst;
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    // (#4070) Exhaustiveness gate. The runtime arm throws rather than
    // returning `inst` unchanged: skipping the rename for an unknown kind
    // would splice callee-scope SSA ids into the caller, which is a silent
    // miscompile rather than a missed optimisation.
    default: {
      const _exhaustive: never = inst;
      void _exhaustive;
      // invariant (producer-promise): union/switch agreement, per #4035/#4502.
      throw new Error(
        `ir/inline-small: renameInstrOperands has no case for IR instruction kind ${(inst as { readonly kind: string }).kind}`,
      );
    }
  }
}
