// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  buildAccessorCallBody,
  type AccessorCallBindings,
  type AccessorDispatchBinding,
} from "../src/runtime/wasmgc/values/accessor-call-bodies.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fixtureText = readFileSync(
  new URL("./fixtures/issue-3518-native-accessor-call-donor.json", import.meta.url),
  "utf8",
);
const fixtureHash = "35489aa27b7348bdf3f7a7354b897e2fc01ecfa955dbe7f1d80aa3b87f96134b";
function authenticate(text: string) {
  if (sha(text) !== fixtureHash) throw new Error("accessor donor fixture digest mismatch");
  const fixture = JSON.parse(text) as {
    base: string;
    path: string;
    fileSha256: string;
    functionSha256: string;
    function: string;
  };
  if (
    fixture.base !== "750fb7e7365692b315179dc909b57fa1407d4527" ||
    fixture.path !== "src/codegen/accessor-driver.ts" ||
    fixture.functionSha256 !== "37addf888c8c67c09e3a6ce1f448f9ddad67b066501f0701a22ba2e389bcd7b2" ||
    sha(fixture.function) !== fixture.functionSha256
  )
    throw new Error("accessor donor provenance mismatch");
  return fixture;
}
const donor = authenticate(fixtureText);
const adapter = readFileSync(new URL("../src/codegen/accessor-driver.ts", import.meta.url), "utf8");
function functionSpan(source: string) {
  const sf = ts.createSourceFile("accessor-driver.ts", source, ts.ScriptTarget.Latest, true);
  const matches = sf.statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "buildAccessorCall",
  );
  expect(matches).toHaveLength(1);
  return { start: matches[0]!.getStart(sf), end: matches[0]!.end };
}
const span = functionSpan(adapter);
const currentFunction = adapter.slice(span.start, span.end);

type TraceContext = { funcMap: { get(name: string): number | undefined } };
type LegacyBuilder = (
  ctx: TraceContext,
  actual: 0 | 1,
  receiver: number,
  callable: number,
  args: readonly number[],
) => ReturnType<typeof buildAccessorCallBody>;
interface TraceOptions {
  actual: 0 | 1;
  arity?: boolean;
  singleton?: boolean;
  missing?: "all" | "actual" | "wide";
  mutation?: boolean;
}
function runTrace(source: string, options: TraceOptions) {
  const trace: unknown[][] = [];
  // Stable-regime-sized handles deliberately differ from compact physical slots.
  const functions = new Map<string, number>([["__closure_arity", 0x40000040]]);
  for (let arity = 0; arity <= 8; arity++) functions.set(`__call_fn_method_${arity}`, 0x40000080 + arity);
  if (options.arity === false) functions.delete("__closure_arity");
  for (let arity = 0; arity <= 8; arity++) {
    if (
      options.missing === "all" ||
      (options.missing === "actual" && arity === options.actual) ||
      (options.missing === "wide" && arity === 8)
    )
      functions.delete(`__call_fn_method_${arity}`);
  }
  const ctx: TraceContext = {
    funcMap: {
      get(name) {
        const value = functions.get(name);
        trace.push(["get", name, value]);
        return value;
      },
    },
  };
  let undefinedCalls = 0;
  const shared: Instr = { op: "global.get", index: 70 };
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const build = new Function(
    "ensureArgcGlobal",
    "undefinedExternInstrs",
    "buildAccessorCallBody",
    `${js}\nreturn buildAccessorCall;`,
  )(
    (actual: TraceContext) => {
      expect(actual).toBe(ctx);
      trace.push(["ensureArgc", 7]);
      return 7;
    },
    (actual: TraceContext) => {
      expect(actual).toBe(ctx);
      trace.push(["undefined", ++undefinedCalls]);
      if (options.mutation) {
        shared.index = 70 + undefinedCalls;
        if (undefinedCalls === 1) {
          // A reservation can change later lookup results, never prior captures.
          for (const [key, value] of functions) functions.set(key, value + 100);
        }
      }
      return options.singleton === false ? undefined : [shared, { op: "extern.convert_any" }];
    },
    buildAccessorCallBody,
  ) as LegacyBuilder;
  const argumentLocals = Object.freeze(options.actual === 0 ? [] : [2]);
  const result = build(ctx, options.actual, 0, 1, argumentLocals);
  expect(argumentLocals).toEqual(options.actual === 0 ? [] : [2]);
  return { result, trace, undefinedCalls };
}

function bindings(actual: 0 | 1, missingArity = false): AccessorCallBindings {
  const dispatches = new Map<number, AccessorDispatchBinding>();
  for (let arity = actual; arity <= 8; arity++) {
    const undefinedArguments = new Map<number, readonly Instr[] | undefined>();
    for (let arg = actual; arg < arity; arg++) undefinedArguments.set(arg, [{ op: "global.get", index: 1 }]);
    dispatches.set(arity, { kind: "resolved", target: arity + 1, undefinedArguments });
  }
  return {
    closureArity: missingArity ? undefined : 0,
    argcGlobal: 0,
    dispatches,
    withoutArity: dispatches.get(actual),
  };
}
function flatten(body: readonly Instr[]): Instr[] {
  return body.flatMap((instr) => [
    instr,
    ...(instr.op === "if"
      ? [...flatten(instr.then), ...flatten(instr.else ?? [])]
      : instr.op === "block" || instr.op === "loop"
        ? flatten(instr.body)
        : []),
  ]);
}
interface Observation {
  arity: number;
  receiver: unknown;
  callable: unknown;
  args: unknown[];
  argc: number;
}
function execute(actual: 0 | 1, declared: number, deps = bindings(actual), mutate?: (body: Instr[]) => void) {
  // Real Wasm and observable imported dispatch functions, not native resource issuers.
  const module = createEmptyModule();
  const extern = { kind: "externref" } as const;
  module.types.push({ kind: "func", params: [extern], results: [{ kind: "i32" }] });
  module.imports.push({ module: "control", name: "arity", desc: { kind: "func", typeIdx: 0 } });
  const argc = new WebAssembly.Global({ value: "i32", mutable: true }, -1);
  const undefinedValue = new WebAssembly.Global({ value: "externref", mutable: false }, undefined);
  const receiver = { receiver: true },
    callable = { callable: true },
    value = { value: true },
    result = { result: true };
  const observations: Observation[] = [];
  let arityCalls = 0;
  const control: WebAssembly.ModuleImports = {
    argc,
    undefinedValue,
    arity: (target: unknown) => {
      expect(target).toBe(callable);
      arityCalls++;
      return declared;
    },
  };
  for (let arity = 0; arity <= 8; arity++) {
    module.types.push({ kind: "func", params: Array.from({ length: arity + 2 }, () => extern), results: [extern] });
    module.imports.push({ module: "control", name: `method${arity}`, desc: { kind: "func", typeIdx: arity + 1 } });
    control[`method${arity}`] = (recv: unknown, target: unknown, ...args: unknown[]) => {
      observations.push({ arity, receiver: recv, callable: target, args, argc: argc.value as number });
      return result;
    };
  }
  module.imports.push(
    { module: "control", name: "argc", desc: { kind: "global", type: { kind: "i32" }, mutable: true } },
    { module: "control", name: "undefinedValue", desc: { kind: "global", type: extern, mutable: false } },
  );
  const built = buildAccessorCallBody(actual, 0, 1, actual === 0 ? [] : [2], deps);
  mutate?.(built.body);
  const body = actual === 0 ? built.body : [...built.body, { op: "drop" } as const];
  module.types.push({
    kind: "func",
    params: Array.from({ length: actual + 2 }, () => extern),
    results: actual === 0 ? [extern] : [],
  });
  module.functions.push({ name: "driver", typeIdx: 10, locals: built.locals, body, exported: true });
  module.exports.push({ name: "driver", desc: { kind: "func", index: 10 } });
  const binary = emitBinary(module);
  const compiled = new WebAssembly.Module(binary as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toHaveLength(12);
  const instance = new WebAssembly.Instance(compiled, { control });
  const driver = instance.exports.driver as (...args: unknown[]) => unknown;
  const returned = driver(...(actual === 0 ? [receiver, callable] : [receiver, callable, value]));
  return {
    observations,
    receiver,
    callable,
    value,
    result,
    returned,
    arityCalls,
    locals: built.locals,
    argc: argc.value,
  };
}
function expectExecution(actual: 0 | 1, declared: number, observed: ReturnType<typeof execute>) {
  const selected = declared > actual && declared <= 8 ? declared : actual;
  expect(observed.observations).toHaveLength(1);
  const call = observed.observations[0]!;
  expect(call.arity).toBe(selected);
  expect(call.receiver).toBe(observed.receiver);
  expect(call.callable).toBe(observed.callable);
  expect(call.argc).toBe(actual);
  expect(call.args).toHaveLength(selected);
  if (actual === 1) expect(call.args[0]).toBe(observed.value);
  for (const arg of call.args.slice(actual)) expect(arg).toBeUndefined();
  expect(observed.returned).toBe(actual === 0 ? observed.result : undefined);
  expect(observed.arityCalls).toBe(1);
  expect(observed.locals).toEqual([{ name: "__declared_arity", type: { kind: "i32" } }]);
}

describe("C1 accessor call body extraction", () => {
  it("authenticates the fixed committed donor and retains all unrelated driver declarations and bodies", () => {
    expect(authenticate(fixtureText)).toEqual(donor);
    const restored = adapter.slice(0, span.start) + donor.function + adapter.slice(span.end);
    const sf = ts.createSourceFile("restored.ts", restored, ts.ScriptTarget.Latest, true);
    const imports = sf.statements.filter(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "../runtime/wasmgc/values/accessor-call-bodies.js",
    );
    expect(imports).toHaveLength(1);
    const added = imports[0]!,
      clause = added.importClause!;
    expect(clause.isTypeOnly).toBe(false);
    expect(clause.name).toBeUndefined();
    expect(added.attributes).toBeUndefined();
    expect(
      clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.map((binding) => [
          binding.name.text,
          binding.propertyName?.text,
          binding.isTypeOnly,
        ]),
    ).toEqual([
      ["buildAccessorCallBody", undefined, false],
      ["AccessorDispatchBinding", undefined, true],
    ]);
    expect(restored[added.end]).toBe("\n");
    expect(sha(restored.slice(0, added.getStart(sf)) + restored.slice(added.end + 1))).toBe(donor.fileSha256);
    expect(() => authenticate(fixtureText.replace("closureArityIdx", "changedArityIdx"))).toThrow("digest mismatch");
  });

  it("keeps the runtime leaf free of frontend, codegen and allocation dependencies", () => {
    const source = readFileSync(
      new URL("../src/runtime/wasmgc/values/accessor-call-bodies.ts", import.meta.url),
      "utf8",
    );
    const sf = ts.createSourceFile("bodies.ts", source, ts.ScriptTarget.Latest, true);
    const imports = sf.statements.filter(ts.isImportDeclaration);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.importClause?.isTypeOnly).toBe(true);
    expect((imports[0]!.moduleSpecifier as ts.StringLiteral).text).toBe("../../../wasm/model/instructions.js");
  });

  it.each([
    ["getter", { actual: 0 }],
    ["setter", { actual: 1 }],
    ["getter inactive singleton", { actual: 0, singleton: false }],
    ["setter inactive singleton", { actual: 1, singleton: false }],
    ["getter missing arity", { actual: 0, arity: false }],
    ["setter missing arity", { actual: 1, arity: false }],
    ["getter absent dispatchers", { actual: 0, missing: "all" }],
    ["setter absent dispatchers", { actual: 1, missing: "all" }],
    ["getter missing actual dispatcher", { actual: 0, missing: "actual" }],
    ["setter missing wide dispatcher", { actual: 1, missing: "wide" }],
    ["getter reservation mutations", { actual: 0, mutation: true }],
    ["setter reservation mutations", { actual: 1, mutation: true }],
    ["getter missing arity with mutations", { actual: 0, arity: false, mutation: true }],
    ["setter missing arity with mutations", { actual: 1, arity: false, mutation: true }],
  ] satisfies [string, TraceOptions][])(
    "preserves %s acquisition order, captured handles and instructions",
    (_name, options) => {
      const original = runTrace(donor.function, options),
        current = runTrace(currentFunction, options);
      expect(current).toEqual(original);
      expect(current.trace[0]?.slice(0, 2)).toEqual(["get", "__closure_arity"]);
      expect(current.trace[1]).toEqual(["ensureArgc", 7]);
      const actualReads = current.trace.filter(
        (event) => event[0] === "get" && event[1] === `__call_fn_method_${options.actual}`,
      );
      expect(actualReads).toHaveLength(options.arity === false ? 2 : 1);
      if (options.missing === "all") expect(current.undefinedCalls).toBe(0);
      else expect(current.undefinedCalls).toBeGreaterThan(0);
    },
  );

  it("detects deferred shallow snapshots after a later undefined reservation mutates prior instructions", () => {
    const options = { actual: 0, arity: true, mutation: true } as const;
    const original = runTrace(donor.function, options);
    expect(runTrace(currentFunction, options)).toEqual(original);
    const expression = "undefinedExternInstrs(ctx)?.map((instr) => ({ ...instr }))";
    expect(currentFunction.split(expression)).toHaveLength(2);
    expect(runTrace(currentFunction.replace(expression, "undefinedExternInstrs(ctx)"), options)).not.toEqual(original);
  });

  it("pins the full mutation trace and preserves both early captures and the later fallback lookup", () => {
    for (const arity of [true, false]) {
      const observed = runTrace(currentFunction, { actual: 0, arity, mutation: true });
      const expected: unknown[][] = [
        ["get", "__closure_arity", arity ? 0x40000040 : undefined],
        ["ensureArgc", 7],
        ["get", "__call_fn_method_0", 0x40000080],
      ];
      let ordinal = 0;
      for (let declared = 8; declared > 0; declared--) {
        expected.push(["get", `__call_fn_method_${declared}`, 0x40000080 + declared + (declared === 8 ? 0 : 100)]);
        for (let arg = 0; arg < declared; arg++) expected.push(["undefined", ++ordinal]);
      }
      if (!arity) expected.push(["get", "__call_fn_method_0", 0x40000080 + 100]);
      expect(ordinal).toBe(36);
      expect(observed.trace).toEqual(expected);
      const instructions = flatten(observed.result.body);
      const calls = instructions.filter((instr) => instr.op === "call").map((instr) => instr.funcIdx);
      if (arity) {
        expect(calls).toEqual([
          0x40000040,
          ...Array.from({ length: 7 }, (_, index) => 0x40000081 + index + 100),
          0x40000088,
          0x40000080,
        ]);
        const snapshots = instructions.filter((instr) => instr.op === "global.get").map((instr) => instr.index);
        expect(snapshots.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 36 }, (_, index) => 71 + index));
      } else expect(calls).toEqual([0x40000080 + 100]);
    }
  });

  it("creates fresh top-level instructions while preserving the donor's shallow nested identity", () => {
    const deps = bindings(0),
      nested: Instr[] = [{ op: "ref.null.extern" }];
    const input: Instr = { op: "block", blockType: { kind: "val", type: { kind: "externref" } }, body: nested };
    const dispatch = deps.dispatches.get(1)!;
    if (dispatch.kind !== "resolved") throw new Error("missing positive dispatcher");
    (dispatch.undefinedArguments as Map<number, readonly Instr[]>).set(0, [input]);
    const first = flatten(buildAccessorCallBody(0, 0, 1, [], deps).body).find((instr) => instr.op === "block")!;
    const second = flatten(buildAccessorCallBody(0, 0, 1, [], deps).body).find((instr) => instr.op === "block")!;
    expect(first).not.toBe(input);
    expect(first).not.toBe(second);
    expect(first.op === "block" && first.body).toBe(nested);
    expect(second.op === "block" && second.body).toBe(nested);
  });

  for (const actual of [0, 1] as const) {
    it.each([-1, 0, 1, 2, 8, 9])(`executes actual arity ${actual} with declared arity %i`, (declared) => {
      expectExecution(actual, declared, execute(actual, declared));
    });
    it(`retains the absent-arity fallback for actual arity ${actual} without changing argc or declaring locals`, () => {
      const observed = execute(actual, 8, bindings(actual, true));
      expect(observed.observations).toHaveLength(1);
      expect(observed.observations[0]).toMatchObject({ arity: actual, argc: -1 });
      expect(observed.observations[0]!.receiver).toBe(observed.receiver);
      expect(observed.observations[0]!.callable).toBe(observed.callable);
      expect(observed.observations[0]!.args).toEqual(actual === 0 ? [] : [observed.value]);
      expect(observed.returned).toBe(actual === 0 ? observed.result : undefined);
      expect(observed.arityCalls).toBe(0);
      expect(observed.locals).toEqual([]);
    });
    it(`retains the explicitly missing dispatcher result for actual arity ${actual}`, () => {
      const deps = bindings(actual);
      (deps.dispatches as Map<number, AccessorDispatchBinding>).set(2, { kind: "legacy-missing" });
      const observed = execute(actual, 2, deps);
      expect(observed.observations).toEqual([]);
      expect(observed.returned).toBe(actual === 0 ? null : undefined);
      expect(observed.argc).toBe(actual);
    });
  }

  it.each(["argc", "receiver", "max arity", "undefined"] as const)(
    "rejects a live %s mutant after the positive execution",
    (kind) => {
      expectExecution(0, 2, execute(0, 2));
      const changed = execute(0, 2, bindings(0), (body) => {
        if (kind === "argc") {
          expect(body[0]!.op).toBe("i32.const");
          body[0] = { op: "i32.const", value: 8 };
        }
        for (const instr of flatten(body)) {
          if (kind === "receiver" && instr.op === "local.get" && instr.index === 0) instr.index = 1;
          if (kind === "max arity" && instr.op === "i32.const" && instr.value === 2) instr.value = 12;
          if (kind === "undefined" && instr.op === "global.get" && instr.index === 1)
            Object.assign(instr, { op: "ref.null.extern" });
        }
      });
      expect(() => expectExecution(0, 2, changed)).toThrow();
    },
  );

  it("refuses accidentally omitted prepared bindings instead of treating them as legacy absence", () => {
    const deps = bindings(0);
    expectExecution(0, 2, execute(0, 2, deps));
    (deps.dispatches as Map<number, AccessorDispatchBinding>).delete(2);
    expect(() => buildAccessorCallBody(0, 0, 1, [], deps)).toThrow("missing prepared dispatch binding");
  });
});
