// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { buildStandardTryTable } from "../ir/try-table.js";
import { defaultSpillInstr } from "./frame-core.js";
import { buildNativeAwaitClassification } from "./prepared-native-async-await.js";
import type {
  PreparedFrameEmission,
  PreparedFrameFunction,
  PreparedFrameOutput,
  PreparedFramePlan,
  PreparedFrameResources,
} from "./prepared-async-frame-types.js";

const empty = { kind: "empty" } as const;
const ext = { kind: "externref" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const constant = (value: number): Instr => ({ op: "i32.const", value });

function physicalIndex<T extends object>(target: T, resolved: { index: number; target: T }): number {
  if (resolved.target !== target || !Number.isInteger(resolved.index) || resolved.index < 0) {
    throw new Error("prepared frame has an unbound or foreign allocator handle");
  }
  return resolved.index;
}

function resources(r: PreparedFrameResources) {
  const functionIndex = (h: PreparedFrameFunction): number => physicalIndex(h.target, r.allocator.function(h));
  const frame = physicalIndex(r.frame.target, r.allocator.type(r.frame));
  const tag = physicalIndex(r.exceptionTag.target, r.allocator.tag(r.exceptionTag));
  const rt = r.runtime;
  const funcs = [r.entry, r.resume, r.fulfillStep, r.rejectStep, rt.fulfill, rt.reject, ...r.operations];
  if (rt.kind === "host") funcs.push(rt.create, rt.resolve, rt.react, rt.wrap, rt.caught);
  else funcs.push(rt.enqueue, ...(rt.markHandled.kind === "function" ? [rt.markHandled.target] : []));
  const indices = new Map(funcs.map((fn) => [fn, functionIndex(fn)] as const));
  return {
    frame,
    tag,
    functionIndex(h: PreparedFrameFunction) {
      const index = functionIndex(h);
      if (indices.get(h) !== index) throw new Error("prepared frame allocator changed during emission");
      return index;
    },
    functions: funcs.map((fn) => [fn.target, indices.get(fn)!] as const),
    promise: rt.kind === "native" ? physicalIndex(rt.promise.target, r.allocator.type(rt.promise)) : -1,
    reaction: rt.kind === "native" ? physicalIndex(rt.reaction.target, r.allocator.type(rt.reaction)) : -1,
  };
}

function sameType(a: ValType, b: ValType): boolean {
  return a.kind === b.kind && (!("typeIdx" in a) || ("typeIdx" in b && a.typeIdx === b.typeIdx));
}

/** No allocations or published function bodies on either side of this check. */
export function preflightPreparedFrame(plan: PreparedFramePlan, r: PreparedFrameResources): void {
  r.assertCurrent();
  if (plan.owner !== r.owner) throw new Error("prepared frame has a foreign owner projection");
  if (plan.handlers.length) throw new Error("prepared frame handlers require separate validated materialization");
  if (!plan.states.length || plan.states.some((s, i) => s.id !== i))
    throw new Error("prepared frame state IDs are not dense and unique");
  const ids = new Set(plan.values.map((v) => v.id));
  if (ids.size !== plan.values.length) throw new Error("prepared frame has duplicate values");
  const { promise } = resources(r);
  const carrier = r.frame.target.fields[r.resultField]?.type;
  if (
    r.runtime.kind === "host" ? carrier?.kind !== "externref" : carrier?.kind !== "ref" || carrier.typeIdx !== promise
  ) {
    throw new Error("prepared frame has the wrong Promise result carrier");
  }
  if (new Set([r.entry.target, r.resume.target, r.fulfillStep.target, r.rejectStep.target]).size !== 4) {
    throw new Error("prepared frame machinery aliases another allocated function");
  }
  if (r.runtime.kind === "host") {
    const { fulfillCallback: yes, rejectCallback: no } = r.runtime;
    if (
      yes.target.target !== r.fulfillStep.target ||
      no.target.target !== r.rejectStep.target ||
      yes.id === no.id ||
      !Number.isInteger(yes.id) ||
      !Number.isInteger(no.id) ||
      yes.id < 0 ||
      no.id < 0
    ) {
      throw new Error("prepared frame callback publication does not match reserved steps");
    }
  }
  const fields = r.frame.target.fields;
  const params = plan.values
    .filter((v) => v.param !== undefined)
    .map((v) => v.param!)
    .sort((a, b) => a - b);
  if (params.some((param, index) => param !== index))
    throw new Error("prepared frame parameter positions are not dense and unique");
  if (!Number.isInteger(r.resultField) || r.resultField < 5 + params.length || r.resultField !== fields.length - 1) {
    throw new Error("prepared frame result field is outside the sealed layout");
  }
  const fixedTypes = ["i32", "externref", "i32", "externref", "externref"];
  if (fixedTypes.some((kind, index) => fields[index]?.type.kind !== kind || !fields[index]?.mutable)) {
    throw new Error("prepared frame fixed fields do not match the sealed layout");
  }
  const occupied = new Set<number>([0, 1, 2, 3, 4, r.resultField]);
  for (const value of plan.values) {
    if (value.param === undefined && value.spill === undefined) continue;
    const field = value.param === undefined ? value.spill! : 5 + value.param;
    if (
      !Number.isInteger(field) ||
      occupied.has(field) ||
      !fields[field] ||
      !sameType(fields[field]!.type, value.type) ||
      (value.param !== undefined && value.spill !== undefined) ||
      (value.param === undefined && (field < 5 + params.length || field >= r.resultField || !fields[field]!.mutable))
    ) {
      throw new Error("prepared frame has an invalid parameter/spill field layout");
    }
    occupied.add(field);
  }
  for (const conversion of r.conversions) {
    if (conversion.operation.kind === "helper" && !r.operations.includes(conversion.operation.target)) {
      throw new Error("prepared frame conversion has no accepted helper");
    }
  }
  if (r.undefinedSource.kind === "helper" && !r.operations.includes(r.undefinedSource.target)) {
    throw new Error("prepared frame undefined source has no accepted helper");
  }
  const target = (id: number): void => {
    if (!Number.isInteger(id) || !plan.states[id]) throw new Error("prepared frame has a missing successor");
  };
  for (const state of plan.states) {
    const term = state.terminator;
    if (term.kind === "suspend") target(term.next);
    if (term.kind === "goto") target(term.target);
    if (term.kind === "branch") {
      target(term.whenTrue);
      target(term.whenFalse);
    }
    for (const id of [...state.restore, ...(term.kind === "suspend" ? term.live : [])]) {
      const value = plan.values.find((v) => v.id === id);
      if (!value || (value.param === undefined && value.spill === undefined))
        throw new Error(`prepared frame missing spill ${id}`);
    }
  }
  if (occupied.size !== fields.length) throw new Error("prepared frame layout contains an unplanned field");
  r.assertCurrent();
}

/**
 * Emit the accepted entry/resume algorithm into detached outputs. The caller
 * publishes all four bodies only after this returns; resource loss is fatal.
 * Runtime helpers and recursive types must already have allocator owners.
 */
export function emitPreparedFrame(plan: PreparedFramePlan, r: PreparedFrameResources): PreparedFrameOutput {
  preflightPreparedFrame(plan, r);
  const bound = resources(r);
  const frameType: ValType = { kind: "ref", typeIdx: bound.frame };
  const promiseType: ValType = r.runtime.kind === "host" ? ext : { kind: "ref", typeIdx: bound.promise };
  const call = (h: PreparedFrameFunction): Instr => ({ op: "call", funcIdx: bound.functionIndex(h) });
  const field = (index: number): Instr => ({ op: "struct.get", typeIdx: bound.frame, fieldIdx: index });
  const store = (index: number): Instr => ({ op: "struct.set", typeIdx: bound.frame, fieldIdx: index });
  const stateTo = (id: number): Instr[] => [get(0), constant(id), store(0)];
  const locals: LocalDef[] = [];
  const alloc = (name: string, type: ValType): number => {
    locals.push({ name, type });
    return locals.length;
  };
  const values = new Map(plan.values.map((v) => [v.id, alloc(`value_${v.id}`, v.type)]));
  const result = alloc("result", promiseType);
  const awaited = alloc("awaited", ext);
  const pending = alloc("pending", promiseType);
  const suspended = alloc("suspended", { kind: "i32" });
  const reason = alloc("reason", ext);
  const local = (id: number): number => {
    const index = values.get(id);
    if (index === undefined) throw new Error(`prepared frame lost value ${id}`);
    return index;
  };
  const operationCall = (h: PreparedFrameFunction): Instr => {
    if (!r.operations.includes(h)) throw new Error("prepared frame operation uses an unaccepted callable");
    return call(h);
  };
  const operation = (body: Instr[]): PreparedFrameEmission => ({
    body,
    local,
    call: operationCall,
    convert(from, to) {
      const conversion = r.conversions.find((c) => sameType(c.from, from) && sameType(c.to, to));
      if (!conversion) throw new Error("prepared frame has no accepted value conversion");
      const op = conversion.operation;
      if (op.kind === "helper") body.push(operationCall(op.target));
      else if (op.kind === "numeric") body.push({ op: op.op });
    },
    undefinedValue() {
      if (r.undefinedSource.kind !== "helper") throw new Error("prepared frame has no accepted canonical undefined");
      body.push(operationCall(r.undefinedSource.target));
    },
  });
  const hydrate = (id: number): Instr[] => {
    const value = plan.values.find((v) => v.id === id)!;
    return [get(0), field(value.param === undefined ? value.spill! : 5 + value.param), set(local(id))];
  };
  const spill = (ids: readonly number[]): Instr[] =>
    ids.flatMap((id) => {
      const value = plan.values.find((v) => v.id === id)!;
      return value.param === undefined ? [get(0), get(local(id)), store(value.spill!)] : [];
    });
  const reject: Instr[] = [get(result), get(reason), call(r.runtime.reject), { op: "drop" }, { op: "return" }];
  const arms = plan.states.map((state) => {
    const body: Instr[] = state.restore.flatMap(hydrate);
    if (state.resume) {
      body.push(
        get(0),
        field(2),
        constant(2),
        { op: "i32.eq" },
        {
          op: "if",
          blockType: empty,
          then: [get(0), field(4), set(reason), ...reject],
        },
      );
      state.resume(operation(body));
    }
    state.body(operation(body));
    const term = state.terminator;
    if (term.kind === "resolve") {
      body.push(get(result));
      term.value(operation(body));
      body.push(call(r.runtime.fulfill), { op: "drop" }, { op: "return" });
    } else if (term.kind === "goto") body.push(...stateTo(term.target), { op: "br", depth: 1 });
    else if (term.kind === "branch") {
      term.condition(operation(body));
      body.push(
        { op: "if", blockType: empty, then: stateTo(term.whenTrue), else: stateTo(term.whenFalse) },
        { op: "br", depth: 1 },
      );
    } else {
      term.awaited(operation(body));
      body.push(set(awaited));
      if (r.runtime.kind === "host") {
        const rt = r.runtime;
        body.push(
          get(awaited),
          call(rt.resolve),
          set(pending),
          ...stateTo(term.next),
          ...spill(term.live),
          get(pending),
        );
        for (const id of [rt.fulfillCallback.id, rt.rejectCallback.id]) {
          body.push(constant(id), get(0), { op: "extern.convert_any" }, call(rt.wrap));
        }
        body.push(call(rt.react), { op: "drop" }, { op: "return" });
      } else {
        const rt = r.runtime;
        body.push(
          ...buildNativeAwaitClassification({
            alwaysAsync: true,
            awaitedLocal: awaited,
            promiseLocal: pending,
            frameLocal: 0,
            suspendedLocal: suspended,
            promiseTypeIdx: bound.promise,
            stateTypeIdx: bound.frame,
            sentField: 1,
            errorField: 4,
            enqueueFuncIdx: bound.functionIndex(rt.enqueue),
            fulfillStepFuncIdx: bound.functionIndex(r.fulfillStep),
            rejectStepFuncIdx: bound.functionIndex(r.rejectStep),
            markRejectionHandledFuncIdx:
              rt.markHandled.kind === "function" ? bound.functionIndex(rt.markHandled.target) : -1,
            setThrowMode: [get(0), constant(2), store(2)],
          }),
          ...stateTo(term.next),
          ...spill(term.live),
          get(suspended),
          constant(1),
          { op: "i32.eq" },
          {
            op: "if",
            blockType: empty,
            then: [
              get(pending),
              { op: "ref.func", funcIdx: bound.functionIndex(r.fulfillStep) },
              get(0),
              { op: "extern.convert_any" },
              { op: "ref.func", funcIdx: bound.functionIndex(r.rejectStep) },
              get(0),
              { op: "extern.convert_any" },
              get(pending),
              { op: "struct.get", typeIdx: bound.promise, fieldIdx: 2 },
              { op: "struct.new", typeIdx: bound.reaction },
              { op: "extern.convert_any" },
              { op: "struct.set", typeIdx: bound.promise, fieldIdx: 2 },
            ],
          },
          { op: "return" },
        );
      }
    }
    return [
      get(0),
      field(0),
      constant(state.id),
      { op: "i32.eq" },
      { op: "if", blockType: empty, then: body },
    ] satisfies Instr[];
  });
  const dispatch: Instr[] = [{ op: "loop", blockType: empty, body: [...arms.flat(), { op: "unreachable" }] }];
  const resumeBody: Instr[] = [
    ...plan.values.filter((v) => v.param !== undefined).flatMap((v) => hydrate(v.id)),
    get(0),
    field(r.resultField),
    set(result),
    buildStandardTryTable(empty, dispatch, [
      { kind: "catch", tagIdx: bound.tag, payloadType: ext, body: [set(reason), ...reject] },
      ...(r.runtime.kind === "host"
        ? [{ kind: "catch_all" as const, body: [call(r.runtime.caught), set(reason), ...reject] }]
        : []),
    ]),
  ];
  const step = (rejected: boolean): PreparedFrameOutput["fulfillStep"] => ({
    locals: [{ name: "frame", type: frameType }],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: bound.frame },
      set(2),
      get(2),
      get(1),
      store(1),
      ...(rejected ? [get(2), get(1), store(4), get(2), constant(2), store(2)] : []),
      get(2),
      call(r.resume),
      { op: "ref.null.extern" },
    ],
  });
  const paramCount = plan.values.filter((v) => v.param !== undefined).length;
  const entryBody: Instr[] =
    r.runtime.kind === "host"
      ? [call(r.runtime.create)]
      : [
          constant(0),
          { op: "ref.null.extern" },
          { op: "ref.null.extern" },
          { op: "ref.null.extern" },
          { op: "struct.new", typeIdx: bound.promise },
        ];
  entryBody.push(set(paramCount));
  for (let i = 0; i < r.frame.target.fields.length; i++) {
    const param = plan.values.find((v) => v.param !== undefined && 5 + v.param === i);
    entryBody.push(
      i === r.resultField
        ? get(paramCount)
        : param
          ? get(param.param!)
          : defaultSpillInstr(r.frame.target.fields[i]!.type),
    );
  }
  entryBody.push(
    { op: "struct.new", typeIdx: bound.frame },
    set(paramCount + 1),
    get(paramCount + 1),
    call(r.resume),
    get(paramCount),
  );
  if (r.runtime.kind === "native") entryBody.push({ op: "extern.convert_any" });
  entryBody.push({ op: "return" });
  const output: PreparedFrameOutput = {
    entry: {
      locals: [
        { name: "promise", type: promiseType },
        { name: "frame", type: frameType },
      ],
      body: entryBody,
    },
    resume: { locals, body: resumeBody },
    fulfillStep: step(false),
    rejectStep: step(true),
  };
  // Include both step builders in the detached-emission interval. No resolver
  // or operation is called after the final authority check.
  preflightPreparedFrame(plan, r);
  const after = resources(r);
  if (
    after.frame !== bound.frame ||
    after.tag !== bound.tag ||
    after.promise !== bound.promise ||
    after.reaction !== bound.reaction ||
    after.functions.length !== bound.functions.length ||
    after.functions.some(
      ([target, index], i) => bound.functions[i]?.[0] !== target || bound.functions[i]?.[1] !== index,
    )
  )
    throw new Error("prepared frame allocator changed during emission");
  r.assertCurrent();
  return output;
}
