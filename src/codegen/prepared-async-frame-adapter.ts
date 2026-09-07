// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { assertPreparedIrAsyncRuntimeCurrent, type CurrentPreparedIrAsyncRuntime } from "../ir/async-plan.js";
import { irCallableBindingKey } from "../ir/callable-bindings.js";
import { irTypeEquals, type IrFunction, type IrInstr } from "../ir/nodes.js";
import type { Instr, ValType } from "../ir/types.js";
import { emitPreparedFrame } from "./prepared-async-frame-engine.js";
import type {
  PreparedFrameOperation,
  PreparedFrameOutput,
  PreparedFramePlan,
  PreparedFrameTerminator,
  PreparedIrAsyncFrameResources,
} from "./prepared-async-frame-types.js";

const ext: ValType = { kind: "externref" };
function sameType(a: ValType, b: ValType): boolean {
  return (
    a.kind === b.kind &&
    (!(a.kind === "ref" || a.kind === "ref_null") ||
      ((b.kind === "ref" || b.kind === "ref_null") && a.typeIdx === b.typeIdx))
  );
}

/** Lower only C-accepted IR; no allocation, provider discovery or publication. */
export function emitPreparedIrAsyncFrame(
  fn: IrFunction,
  currentRuntime: CurrentPreparedIrAsyncRuntime,
  resources: PreparedIrAsyncFrameResources,
): PreparedFrameOutput {
  const fail = (why: string): never => {
    throw new Error(`prepared async adapter: ${why}`);
  };
  const assertOwner = (): void => {
    if (fn.asyncRuntime !== currentRuntime || resources.owner !== fn.unitId)
      fail("foreign owner or runtime attachment");
    assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, currentRuntime);
    resources.assertCurrent();
  };
  assertOwner();
  const semantic = currentRuntime.plan;
  if (
    fn.funcKind !== "async" ||
    semantic.entry !== 0 ||
    semantic.handlers.length ||
    currentRuntime.states.length !== semantic.states.length
  )
    fail("unsupported state graph");
  if ((currentRuntime.kind === "host-wasmgc") !== (resources.runtime.kind === "host")) fail("runtime carrier mismatch");

  const layouts = resources.values.map((v) => ({ ...v, type: { ...v.type } as ValType }));
  const values = new Map(layouts.map((v) => [v.id, v]));
  const logical = new Map(semantic.values.map((v) => [Number(v.value), v.type]));
  const calls = new Map(
    [...resources.callTargets].map(([key, handle]) => {
      const signature = resources.callSignatures.get(key);
      if (!signature) return fail("missing accepted call signature");
      return [
        key,
        {
          handle,
          params: signature.params.map((type) => ({ ...type }) as ValType),
          results: signature.results.map((type) => ({ ...type }) as ValType),
        },
      ] as const;
    }),
  );
  if (resources.callSignatures.size !== calls.size) fail("call signature mapping is not a bijection");
  if (values.size !== layouts.length || values.size !== logical.size || layouts.some((v) => !logical.has(v.id)))
    fail("value mapping is not a bijection");
  for (const [index, param] of semantic.params.entries()) {
    if (values.get(Number(param.value))?.param !== index) fail("parameter mapping mismatch");
  }
  const spills = new Set(semantic.spills.map((v) => Number(v.value)));
  for (const value of layouts) {
    if (value.param !== undefined && semantic.params[value.param]?.value !== value.id)
      fail("foreign parameter mapping");
    if ((value.spill !== undefined) !== (spills.has(value.id) && value.param === undefined))
      fail("spill mapping mismatch");
  }
  const typeOf = (id: number): ValType => values.get(id)?.type ?? fail(`missing value ${id}`);
  const conversion = (from: ValType, to: ValType): PreparedFrameOperation => {
    if (sameType(from, to)) return () => {};
    if (!resources.conversions.some((c) => sameType(c.from, from) && sameType(c.to, to)))
      fail("unplanned value conversion");
    return (e) => e.convert(from, to);
  };
  const get = (id: number, to?: ValType): PreparedFrameOperation => {
    const from = typeOf(id);
    const convert = to ? conversion(from, to) : () => {};
    return (e) => {
      e.body.push({ op: "local.get", index: e.local(id) });
      convert(e);
    };
  };
  const result = (instr: IrInstr): number => {
    if (
      instr.result === null ||
      instr.resultType === null ||
      !logical.has(Number(instr.result)) ||
      !irTypeEquals(logical.get(Number(instr.result))!, instr.resultType)
    )
      fail("untyped or foreign instruction result");
    return Number(instr.result);
  };
  const instruction = (instr: IrInstr): PreparedFrameOperation => {
    if (instr.kind === "const") {
      const id = result(instr);
      if (instr.value.kind === "undefined") {
        if (resources.undefinedSource.kind !== "helper") fail("missing canonical undefined");
        const convert = conversion(ext, typeOf(id));
        return (e) => {
          e.undefinedValue();
          convert(e);
          e.body.push({ op: "local.set", index: e.local(id) });
        };
      }
      let op: Instr;
      let type: ValType;
      switch (instr.value.kind) {
        case "f64":
          op = { op: "f64.const", value: instr.value.value };
          type = { kind: "f64" };
          break;
        case "f32":
          op = { op: "f32.const", value: instr.value.value };
          type = { kind: "f32" };
          break;
        case "i64":
          op = { op: "i64.const", value: instr.value.value };
          type = { kind: "i64" };
          break;
        case "i32":
          op = { op: "i32.const", value: instr.value.value };
          type = { kind: "i32" };
          break;
        case "bool":
          op = { op: "i32.const", value: instr.value.value ? 1 : 0 };
          type = { kind: "i32" };
          break;
        case "null":
          op = { op: "ref.null.extern" };
          type = ext;
          break;
        default:
          return fail("unsupported constant");
      }
      const convert = conversion(type, typeOf(id));
      return (e) => {
        e.body.push(op);
        convert(e);
        e.body.push({ op: "local.set", index: e.local(id) });
      };
    }
    if (instr.kind !== "call") return fail(`unsupported instruction ${instr.kind}`);
    const target = calls.get(irCallableBindingKey(instr.target.binding));
    if (!target || !resources.operations.includes(target.handle)) return fail("missing accepted call binding");
    if (target.params.length !== instr.args.length || target.results.length > 1)
      return fail("unsupported call signature");
    const args = instr.args.map((id, index) => get(Number(id), target.params[index]!));
    const id = instr.result === null ? undefined : result(instr);
    if (id !== undefined && target.results.length !== 1) return fail("missing call result");
    const convert = id === undefined ? undefined : conversion(target.results[0]!, typeOf(id));
    return (e) => {
      for (const arg of args) arg(e);
      e.body.push(e.call(target.handle));
      if (id !== undefined) {
        convert!(e);
        e.body.push({ op: "local.set", index: e.local(id) });
      } else if (target.results.length === 1) e.body.push({ op: "drop" });
    };
  };

  const restores = new Map<number, Set<number>>();
  for (const state of semantic.states) {
    const term = state.terminator;
    if (term.kind !== "suspend") continue;
    const next = semantic.states[Number(term.resume.state)];
    if (
      term.rejected.kind !== "reject" ||
      next?.resume?.value !== term.resume.value ||
      next.resume.source !== "fulfilled"
    )
      fail("unsupported suspend edge");
    const restore = restores.get(Number(term.resume.state)) ?? new Set<number>();
    for (const id of term.live) {
      typeOf(Number(id));
      restore.add(Number(id));
    }
    restores.set(Number(term.resume.state), restore);
  }
  const directTarget = (id: number): number => {
    if (!semantic.states[id] || semantic.states[id]!.resume) fail("invalid direct successor");
    return id;
  };
  const states: PreparedFramePlan["states"] = semantic.states.map((state, index) => {
    const projected = currentRuntime.states[index]!;
    if (state.id !== index || projected.id !== state.id) fail("state identity mismatch");
    const body = projected.body.map(instruction);
    for (const update of state.updates ?? []) {
      if (values.get(Number(update.target))?.param !== undefined) fail("updated parameter needs a mutable carrier");
      const read = get(Number(update.value), typeOf(Number(update.target)));
      body.push((e) => {
        read(e);
        e.body.push({ op: "local.set", index: e.local(Number(update.target)) });
      });
    }
    let resume: PreparedFrameOperation | undefined;
    if (state.resume) {
      if (state.resume.source !== "fulfilled" || !restores.has(index)) fail("unbound resume state");
      const id = Number(state.resume.value);
      const convert = conversion(ext, typeOf(id));
      resume = (e) => {
        e.resumeValue();
        convert(e);
        e.body.push({ op: "local.set", index: e.local(id) });
      };
    }
    const term = state.terminator;
    let terminator: PreparedFrameTerminator;
    switch (term.kind) {
      case "suspend":
        terminator = {
          kind: "suspend",
          next: Number(term.resume.state),
          live: term.live.map(Number),
          awaited: get(Number(term.awaited), ext),
        };
        break;
      case "resolve": {
        if (term.value === undefined && resources.undefinedSource.kind !== "helper")
          fail("missing canonical undefined");
        terminator = {
          kind: "resolve",
          value: term.value === undefined ? (e) => e.undefinedValue() : get(Number(term.value), ext),
        };
        break;
      }
      case "goto":
        terminator = { kind: "goto", target: directTarget(Number(term.target)) };
        break;
      case "branch": {
        if (typeOf(Number(term.condition)).kind !== "i32") fail("branch condition is not i32");
        terminator = {
          kind: "branch",
          condition: get(Number(term.condition)),
          whenTrue: directTarget(Number(term.ifTrue)),
          whenFalse: directTarget(Number(term.ifFalse)),
        };
        break;
      }
      default:
        return fail(`unsupported terminator ${term.kind}`);
    }
    return {
      id: index,
      restore: [...(restores.get(index) ?? [])],
      ...(resume ? { resume } : {}),
      body(e) {
        for (const op of body) op(e);
      },
      terminator,
    };
  });
  const assertCurrent = (): void => {
    assertOwner();
    if (
      resources.values.length !== layouts.length ||
      resources.values.some((v, i) => {
        const old = layouts[i]!;
        return v.id !== old.id || v.param !== old.param || v.spill !== old.spill || !sameType(v.type, old.type);
      }) ||
      resources.callTargets.size !== calls.size ||
      resources.callSignatures.size !== calls.size ||
      [...calls].some(([key, call]) => {
        const now = resources.callSignatures.get(key);
        return (
          !now ||
          resources.callTargets.get(key) !== call.handle ||
          now.params.length !== call.params.length ||
          now.results.length !== call.results.length ||
          now.params.some((t, i) => !sameType(t, call.params[i]!)) ||
          now.results.some((t, i) => !sameType(t, call.results[i]!))
        );
      })
    )
      fail("bound IR mapping changed during emission");
  };
  return emitPreparedFrame(
    { owner: fn.unitId, handlers: [], values: layouts, states },
    { ...resources, assertCurrent },
  );
}
