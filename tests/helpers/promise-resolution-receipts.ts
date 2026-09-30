// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect } from "vitest";
import { createBuiltinFunctionMetadataType } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import { buildTargetTaggedTry } from "../../src/wasm/physical/exception-control.js";
import { promiseRejectionDispatcher } from "../../src/codegen/promise-rejection-dispatch.js";
import {
  buildPromiseResolveValueBody as buildResolutionBody,
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseThenableJob,
  buildPromiseSettleClosureValue,
  buildPromiseSettleClosureBody,
} from "../../src/runtime/wasmgc/promise/resolution-bodies.js";
import {
  buildPromisePeelValue,
  buildPromiseThenableClassifier,
  buildPromiseThenableLookup,
  type PromiseThenableInventory,
} from "../../src/runtime/wasmgc/promise/thenable-bodies.js";

// Authentication is self-contained: shallow CI needs no historical Git objects.
// This pins the verbatim donor receipt, not a regenerated expected result.
export const BASE = "2b9cb408c18446361fcf9837045067d1fd97c642";
export const DONOR_SHA256 = "da7c7a907726732488dec5e80a8a06c8bb0ed88c644fea32e0da15abef70a646";
export const root = new URL("../../", import.meta.url);
export const asyncPath = "src/codegen/async-scheduler.ts";
export const closedPath = "src/codegen/closed-method-dispatch.ts";
export const current = (path: string) => readFileSync(new URL(path, root), "utf8");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const donorText = current("tests/fixtures/issue-3518-promise-resolution-donors.json");
interface DonorReceipt {
  schemaVersion: number;
  base: string;
  sources: {
    path: string;
    sourceSha256: string;
    declarations: { name: string; start: number; end: number; sha256: string; text: string }[];
  }[];
}
export function authenticateDonors(text: string): Map<string, string> {
  if (sha256(text) !== DONOR_SHA256) throw new Error("Promise donor receipt digest mismatch");
  const receipt = JSON.parse(text) as DonorReceipt;
  if (receipt.schemaVersion !== 1 || receipt.base !== BASE || receipt.sources.length !== 2)
    throw new Error("Promise donor receipt provenance mismatch");
  const expected = new Map([
    [
      asyncPath,
      [
        "buildPromiseResolveValueLocals",
        "buildPromiseResolveValueBody",
        "buildPromiseSettleClosureInstrs",
        "ensurePromiseThenableSubstrate",
        "ensurePromiseExecutorClosures",
      ],
    ],
    [closedPath, ["fillPromiseThenableHelpers"]],
  ]);
  const reconstructed = new Map<string, string>();
  for (const source of receipt.sources) {
    const names = expected.get(source.path);
    if (
      !names ||
      reconstructed.has(source.path) ||
      JSON.stringify(source.declarations.map((entry) => entry.name)) !== JSON.stringify(names)
    )
      throw new Error("Promise donor declaration inventory mismatch");
    for (const entry of source.declarations) {
      if (sha256(entry.text) !== entry.sha256 || entry.end - entry.start !== entry.text.length)
        throw new Error("Promise donor declaration authentication failed");
    }
    reconstructed.set(source.path, source.declarations.map((entry) => entry.text).join("\n"));
  }
  return reconstructed;
}
export const donors = authenticateDonors(donorText);
export const oldAsync = donors.get(asyncPath)!;
export const oldClosed = donors.get(closedPath)!;
export const newAsync = current(asyncPath);
export const newClosed = current(closedPath);
export const newLookupAdapter = current("src/codegen/promise-thenable-lookup.ts");
export const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

export function declaration(source: string, name: string): string {
  const file = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  const found = file.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(found.length, "positive donor declaration count: " + name).toBe(1);
  return found[0]!.getText(file).replace(/^export /, "");
}

export function evaluate(source: string, names: string[], bindings: Record<string, unknown>) {
  const code =
    names.map((name) => declaration(source, name)).join("\n") + "\nglobalThis.result = {" + names.join(",") + "};";
  const context = vm.createContext({ ...bindings, structuredClone });
  vm.runInContext(
    ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context,
  );
  return context.result;
}

// Extract the ORIGINAL nested arrow, not an opcode template or the new builder.
export function originalSettleBody(capTypeIdx: number, capPromiseFieldIdx: number, settleFuncIdx: number) {
  const source = declaration(oldAsync, "ensurePromiseExecutorClosures");
  const file = ts.createSourceFile("executor-donor.ts", source, ts.ScriptTarget.Latest, true);
  const matches: ts.ArrowFunction[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "makeBody" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    )
      matches.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(matches).toHaveLength(1);
  const code = "globalThis.result = (" + matches[0]!.getText(file) + ")(settleFuncIdx);";
  const context = vm.createContext({ capTypeIdx, capPromiseFieldIdx, settleFuncIdx });
  vm.runInContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return plain(context.result);
}

export function mutatedSettleBuilder(before: string, after: string) {
  const name = "buildPromiseSettleClosureBody";
  const source = declaration(current("src/runtime/wasmgc/promise/resolution-bodies.ts"), name);
  expect(source.split(before)).toHaveLength(2); // exactly one live mutation site
  return evaluate(source.replace(before, after), [name], {})[name] as typeof buildPromiseSettleClosureBody;
}

export function resolutionFixture(
  source: string,
  native: boolean,
  ownThen: boolean,
  callable: "predicate" | "root" | "none",
) {
  const calls: string[] = [];
  const ctx = {
    standalone: native,
    wasi: false,
    exnTagIdx: 90,
    indexSpaceFrozen: false,
    funcMap: new Map<string, number>(
      ownThen
        ? [
            ["bagHas", 80],
            ["__extern_get", 81],
          ]
        : [],
    ),
  };
  const state = {
    promiseFulfillFuncIdx: 10,
    promiseRejectFuncIdx: 11,
    enqueueFuncIdx: 12,
    identityFulfillWrapperFuncIdx: 13,
    identityRejectWrapperFuncIdx: 14,
  };
  const thenable = native
    ? {
        hasCallableThenFuncIdx: 20,
        lookupThenFuncIdx: 24,
        thenableJobFuncIdx: 21,
        peelValueFuncIdx: 22,
        newTypeErrorFuncIdx: 23,
        selfResolutionMsg: "self",
      }
    : null;
  const fn = evaluate(source, ["buildPromiseResolveValueBody"], {
    promiseRejectionDispatcher,
    buildResolutionBody,
    buildTargetTaggedTry,
    PROMISE_STATE_FULFILLED: 1,
    PROMISE_STATE_REJECTED: 2,
    CARRIER_BAG_HAS: "bagHas",
    stringConstantExternrefInstrs: (_ctx: unknown, value: string) => {
      calls.push("string:" + value);
      return [{ op: "global.get", index: value === "self" ? 100 : 101 }];
    },
    ensureLateImport: () => {
      calls.push("late:typeof");
      if (callable === "predicate") ctx.funcMap.set("__typeof_function", 82);
    },
    getFuncRefWrapperRootTypeIdx: () => {
      calls.push("root");
      return callable === "root" ? 83 : undefined;
    },
  });
  return plain({ body: fn.buildPromiseResolveValueBody(ctx, state, 1, 2, 3, thenable), calls });
}

export function classifierFixture(source: string, variant: "full" | "empty" | "no-any" | "unreserved") {
  const funcs = new Map<number, { locals: unknown[]; body: unknown[] }>([
    [40, { locals: [], body: [{ op: "i32.const", value: 0 }] }],
    [41, { locals: [], body: [{ op: "local.get", index: 0 }] }],
  ]);
  const full = variant === "full";
  const calls: string[] = [];
  const ctx = {
    promiseThenableReserved: variant !== "unreserved",
    funcMap: new Map([
      ["__promise_has_callable_then", 40],
      ["__promise_peel_value", 41],
      ...(full
        ? ([
            ["__call_accessor_get", 42],
            ["__extern_get", 43],
          ] as [string, number][])
        : []),
    ]),
    anyValueTypeIdx: variant === "no-any" ? -1 : 7,
    structMap: new Map([["Both", 8]]),
    structAccessorClosure: new Map([
      ["Both_then", { getGlobal: 55 }],
      ["Missing_then", { getGlobal: 56 }],
    ]),
    objectRuntimeTypes: full ? { objectTypeIdx: 9 } : undefined,
  };
  const roots = full ? [10, 11] : [];
  const bindings = {
    buildPromisePeelValue,
    buildPromiseThenableClassifier,
    buildPromiseThenableLookup,
    definedFuncAt: (_ctx: unknown, idx: number) => funcs.get(idx),
    collectMethodEntries: () => {
      calls.push("methods");
      return full ? [{ typeIdx: 8 }, { typeIdx: 8 }] : [];
    },
    collectFieldEntries: () => {
      calls.push("fields");
      return full ? [{ typeIdx: 8, fieldIdx: 2 }] : [];
    },
    collectClosureBaseWrapperTypeIdxs: () => roots,
    buildClosureRefTestArms: (_ctx: unknown, index: number, onMatch: unknown[]) =>
      roots.flatMap((typeIdx) => [
        { op: "local.get", index },
        { op: "ref.test", typeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [...onMatch] },
      ]),
    stringConstantExternrefInstrs: () => {
      calls.push("string:then");
      return [{ op: "global.get", index: 60 }];
    },
  };
  // Evaluate the real driver and helper together; historical donors stay standalone.
  const names = ["fillPromiseThenableHelpers"];
  if (source !== oldClosed) names.push("finalizePromiseThenableLookup");
  evaluate(
    source === oldClosed ? source : source + "\n" + newLookupAdapter,
    names,
    bindings,
  ).fillPromiseThenableHelpers(ctx);
  return plain({ funcs: [...funcs], calls });
}

export function jobFixture(
  source: string,
  native: boolean,
  apply: boolean,
  observe?: (types: Map<number, { params: unknown; results: unknown; name: unknown }>, funcs: unknown[]) => void,
  lookupSource = newLookupAdapter,
) {
  const funcs: unknown[] = [];
  const types = new Map<number, { params: unknown; results: unknown; name: unknown }>();
  const calls: string[] = [];
  let next = 100;
  const ctx = {
    standalone: native,
    wasi: false,
    funcMap: new Map([
      ["__new_TypeError", 10],
      ["__objvec_new", 11],
      ["__objvec_push", 12],
    ]),
  };
  const state = { promiseTypeIdx: 1, promiseRejectFuncIdx: 2, microtaskFuncTypeIdx: 3 };
  const caps = { capTypeIdx: 4, capMetaTypeIdx: 5, capPromiseFieldIdx: 5, resolveClFuncIdx: 6, rejectClFuncIdx: 7 };
  const bindings = {
    buildTargetTaggedTry,
    buildPromiseThenableJob,
    buildPromiseSettleClosureValue,
    SELF_RESOLUTION_MSG: "self",
    emitWasiErrorConstructor: () => calls.push("TypeError"),
    addStringConstantGlobal: () => calls.push("self"),
    ensureExnTag: () => {
      calls.push("tag");
      return 15;
    },
    reserveClosedMethodDispatchVararg: () => {
      calls.push("vararg");
      return 16;
    },
    ensurePromiseExecutorClosures: () => {
      calls.push("closures");
      return caps;
    },
    addFuncType: (_ctx: unknown, params: unknown, results: unknown, name: unknown) => {
      calls.push("type");
      const index = next++;
      types.set(index, plain({ params, results, name }));
      return index;
    },
    mintDefinedFunc: () => {
      calls.push("mint");
      return next++;
    },
    pushDefinedFunc: (_ctx: unknown, idx: number, fn: unknown) => {
      calls.push("push");
      funcs.push([idx, fn]);
    },
    getOrRegisterThenCapsType: () => {
      calls.push("caps");
      return 17;
    },
    reserveApplyClosure: () => {
      calls.push("apply");
      return apply ? 18 : undefined;
    },
    closureBagInitInstr: () => ({ op: "ref.null.extern" }),
  };
  const names = ["buildPromiseSettleClosureInstrs", "ensurePromiseThenableSubstrate"];
  if (source !== oldAsync) names.push("reservePromiseThenableValueHelpers");
  const fns = evaluate(source === oldAsync ? source : source + "\n" + lookupSource, names, bindings);
  const result = fns.ensurePromiseThenableSubstrate(ctx, state);
  const repeated = fns.ensurePromiseThenableSubstrate(ctx, state);
  expect(repeated).toBe(result);
  observe?.(types, funcs);
  return plain({ funcs, calls, result, registrations: [...ctx.funcMap] });
}

export function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
}

export function changeLookupSignature(source: string, argument: 1 | 2, replacement: unknown): string {
  const file = ts.createSourceFile("lookup-reservation.ts", source, ts.ScriptTarget.Latest, true);
  const sites: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === "addFuncType" &&
      node.arguments[3] &&
      ts.isStringLiteral(node.arguments[3]) &&
      node.arguments[3].text === "$__promise_lookup_then_type"
    )
      sites.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(sites).toHaveLength(1);
  const target = sites[0]!.arguments[argument]!;
  return source.slice(0, target.getStart(file)) + JSON.stringify(replacement) + source.slice(target.end);
}

export function verifyLookupReservation(source: string): void {
  jobFixture(
    newAsync,
    true,
    true,
    (types, funcs) => {
      const lookups = funcs.filter((entry: any) => entry[1].name === "__promise_lookup_then") as [
        number,
        { typeIdx: number; locals: unknown[]; body: unknown[] },
      ][];
      expect(lookups).toHaveLength(1);
      const [index, fn] = lookups[0]!;
      expect(index).toBe(105);
      expect(types.get(fn.typeIdx)).toEqual({
        params: [{ kind: "externref" }],
        results: [{ kind: "i32" }, { kind: "externref" }],
        name: "$__promise_lookup_then_type",
      });
      expect(plain(fn.locals)).toEqual([]);
      expect(plain(fn.body)).toEqual([{ op: "unreachable" }]);
    },
    source,
  );
}

export function verifyActualLookupFill(source: string): void {
  const lookup = { typeIdx: 104, locals: [] as unknown[], body: [{ op: "unreachable" }] as unknown[] };
  const predicate = { typeIdx: 100, locals: [] as unknown[], body: [{ op: "i32.const", value: 0 }] as unknown[] };
  const funcs = new Map([
    [40, predicate],
    [44, lookup],
  ]);
  const inventory: PromiseThenableInventory = {
    finalized: true,
    peelFuncIdx: 41,
    methodTypeIdxs: [8],
    accessors: [{ typeIdx: 9, getGlobal: 55 }],
    callAccessorGetIdx: 42,
    fields: [{ typeIdx: 10, fieldIdx: 2 }],
    closureWrapperTypeIdxs: [11, 12],
    openObject: { typeIdx: 13, externGetFuncIdx: 43, thenStringInstrs: [{ op: "global.get", index: 60 }] },
  };
  const ctx = {
    promiseThenableReserved: true,
    anyValueTypeIdx: -1,
    funcMap: new Map([
      ["__promise_has_callable_then", 40],
      ["__promise_peel_value", 41],
      ["__promise_lookup_then", 44],
      ["__call_accessor_get", 42],
      ["__extern_get", 43],
    ]),
    structAccessorClosure: new Map([["Getter_then", { getGlobal: 55 }]]),
    structMap: new Map([["Getter", 9]]),
    objectRuntimeTypes: { objectTypeIdx: 13 },
  };
  expect(funcs.get(44)).toBe(lookup);
  expect(lookup.body).toEqual([{ op: "unreachable" }]);
  evaluate(newClosed + "\n" + source, ["fillPromiseThenableHelpers", "finalizePromiseThenableLookup"], {
    buildPromisePeelValue,
    buildPromiseThenableClassifier,
    buildPromiseThenableLookup,
    definedFuncAt: (_ctx: unknown, index: number) => funcs.get(index),
    collectMethodEntries: () => [{ typeIdx: 8 }],
    collectFieldEntries: () => [{ typeIdx: 10, fieldIdx: 2 }],
    collectClosureBaseWrapperTypeIdxs: () => [11, 12],
    stringConstantExternrefInstrs: () => [{ op: "global.get", index: 60 }],
  }).fillPromiseThenableHelpers(ctx);
  expect(funcs.get(44)).toBe(lookup); // the reserved object, not a detached replacement
  expect(lookup.typeIdx).toBe(104);
  expect(plain({ locals: lookup.locals, body: lookup.body })).toEqual(plain(buildPromiseThenableLookup(inventory)));
  expect(plain({ locals: predicate.locals, body: predicate.body })).toEqual(
    plain(buildPromiseThenableClassifier(inventory)),
  );
}

// Hand-authored instruction oracle. Expected instructions never call the builder,
// nor are they reconstructed from its output or its source text.
export function verifyIndependentLookupBody(builder: typeof buildPromiseThenableLookup): void {
  const actual = plain(
    builder({
      finalized: true,
      peelFuncIdx: 41,
      methodTypeIdxs: [8],
      accessors: [{ typeIdx: 9, getGlobal: 55 }],
      callAccessorGetIdx: 42,
      fields: [{ typeIdx: 9, fieldIdx: 2 }],
      closureWrapperTypeIdxs: [11],
      openObject: { typeIdx: 13, externGetFuncIdx: 43, thenStringInstrs: [{ op: "global.get", index: 60 }] },
    }),
  );
  const failure = [{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }, { op: "return" }];
  const callable = [{ op: "i32.const", value: 1 }, { op: "local.get", index: 4 }, { op: "return" }];
  const afterRead = [
    { op: "local.tee", index: 4 }, // preserve externref BEFORE any conversion
    { op: "any.convert_extern" },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "ref.test", typeIdx: 11 },
    { op: "if", blockType: { kind: "empty" }, then: callable },
    ...failure,
  ];
  expect(actual).toEqual({
    locals: [
      { name: "__peeled", type: { kind: "externref" } },
      { name: "__any", type: { kind: "anyref" } },
      { name: "__thenAny", type: { kind: "anyref" } },
      { name: "__capturedThen", type: { kind: "externref" } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: 41 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: failure },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: 8 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "ref.null.extern" }, { op: "return" }],
      },
      // Same type9 has accessor AND field. The guarded accessor precedes field.
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: 9 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: 55 },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "global.get", index: 55 },
              { op: "call", funcIdx: 42 },
              ...afterRead,
            ],
          },
          // No return here: a null getter falls through to the field arm.
        ],
      },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: 9 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: 9 },
          { op: "struct.get", typeIdx: 9, fieldIdx: 2 },
          ...afterRead,
        ],
      },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: 13 },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "global.get", index: 60 },
          { op: "call", funcIdx: 43 },
          ...afterRead,
        ],
      },
      { op: "i32.const", value: 0 },
      { op: "ref.null.extern" },
    ],
  });
  // Explicit denominators, independent of the shape equality assertion.
  const flat: any[] = [];
  function walk(body: any[]): void {
    for (const instruction of body) {
      flat.push(instruction);
      if (instruction.then) walk(instruction.then);
      if (instruction.else) walk(instruction.else);
    }
  }
  walk(actual.body);
  expect(flat.filter((i) => i.op === "call" && i.funcIdx === 42)).toHaveLength(1);
  expect(flat.filter((i) => i.op === "struct.get")).toEqual([{ op: "struct.get", typeIdx: 9, fieldIdx: 2 }]);
  expect(flat.filter((i) => i.op === "call" && i.funcIdx === 43)).toHaveLength(1);
  expect(flat.filter((i) => i.op === "local.tee" && i.index === 4)).toHaveLength(3);
}

// Checked intentional deltas; the authenticated donor itself remains immutable.
export function expectedCaptureDelta(receipt: ReturnType<typeof resolutionFixture>, native: boolean) {
  let calls = 0;
  let captures = 0;
  let handled = 0;
  function visit(value: any): void {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const instr = value[i];
        // Intentional #4376 ABI delta: adoption handles the inner Promise,
        // including already-settled carriers. Keep the authenticated donor
        // immutable and require exactly one independently located insertion.
        if (
          instr?.op === "ref.null.extern" &&
          value[i + 1]?.op === "local.get" &&
          value[i + 1].index === 0 &&
          value[i + 2]?.op === "struct.new" &&
          value[i + 2].typeIdx === 3
        ) {
          value.splice(
            i,
            0,
            { op: "local.get", index: 2 },
            { op: "i32.const", value: 1 },
            { op: "struct.set", typeIdx: 1, fieldIdx: 4 },
          );
          i += 3;
          handled++;
        }
        if (instr?.op === "call" && instr.funcIdx === 20) {
          expect(value[i + 1]).toEqual({ op: "local.set", index: 4 });
          instr.funcIdx = 24;
          value.splice(i + 1, 0, { op: "local.set", index: 8 });
          calls++;
        }
        if (instr?.op === "ref.func" && instr.funcIdx === 21 && value[i + 1]?.op === "ref.null.extern") {
          expect(value[i + 2]).toEqual({ op: "local.get", index: 0 });
          value[i + 1] = { op: "local.get", index: 8 };
          captures++;
        }
        visit(instr);
      }
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  }
  visit(receipt.body);
  expect([calls, captures]).toEqual(native ? [1, 1] : [0, 0]);
  expect(handled).toBe(1);
  return receipt;
}

export function expectedLookupReservation(receipt: ReturnType<typeof jobFixture>, native: boolean) {
  if (!native) return receipt;
  expect(receipt.funcs.map((entry: any) => [entry[0], entry[1].name])).toEqual([
    [101, "__promise_has_callable_then"],
    [103, "__promise_peel_value"],
    [104, "__promise_thenable_job"],
  ]);
  receipt.funcs[2][0] = 106;
  receipt.funcs.splice(2, 0, [
    105,
    {
      name: "__promise_lookup_then",
      typeIdx: 104,
      locals: [],
      body: [{ op: "unreachable" }],
      exported: false,
    },
  ]);
  const caps = receipt.calls.indexOf("caps");
  expect(caps).toBeGreaterThan(0);
  receipt.calls.splice(caps, 0, "type", "mint", "push");
  expect(receipt.result.thenableJobFuncIdx).toBe(104);
  receipt.result.thenableJobFuncIdx = 106;
  receipt.result.lookupThenFuncIdx = 105;
  const last = receipt.registrations.pop();
  expect(last).toEqual(["__promise_thenable_job", 104]);
  receipt.registrations.push(["__promise_lookup_then", 105], ["__promise_thenable_job", 106]);
  return receipt;
}

export const movedResolutionNames = new Set([
  "buildPromiseResolveValueLocals",
  "buildPromiseResolveValueBody",
  "buildPromiseSettleClosureInstrs",
  "ensurePromiseExecutorClosures",
  "ensurePromiseThenableSubstrate",
]);

function executorFixture(source: string, fields: number) {
  const funcs: unknown[] = [];
  const calls: string[] = [];
  let next = 100;
  const ctx = {
    mod: {
      types: [
        {
          fields: Array.from({ length: fields }, (_, index) => ({
            name: "field" + index,
            type: { kind: "externref" },
            mutable: true,
          })),
        },
      ],
    },
    funcMap: new Map([
      ["__promise_resolve_value", 11],
      ["__promise_reject", 12],
    ]),
  };
  const functions = evaluate(source, ["ensurePromiseExecutorClosures"], {
    buildPromiseSettleClosureBody,
    promiseRejectionDispatcher: () => undefined,
    ensurePromiseSettleFunctions: () => calls.push("settle"),
    getOrRegisterPromiseType: () => 1,
    getOrCreateFuncRefWrapperTypes: () => ({ structTypeIdx: 2, liftedFuncTypeIdx: 3, closureInfo: {} }),
    ensureBuiltinFnMetaType: () => 0,
    mintDefinedFunc: () => next++,
    pushDefinedFunc: (_ctx: unknown, index: number, value: unknown) => funcs.push([index, value]),
  });
  const result = functions.ensurePromiseExecutorClosures(ctx);
  expect(functions.ensurePromiseExecutorClosures(ctx)).toBe(result);
  expect(funcs).toHaveLength(2);
  return plain({ result, funcs, types: ctx.mod.types, registrations: [...ctx.funcMap], calls });
}

/** Exact intentional delta to the authenticated donor, not a new donor hash. */
function expectedResolvingPair(receipt: ReturnType<typeof executorFixture>, fields: number) {
  expect(receipt.result.capTypeIdx).toBe(1);
  expect(receipt.types).toHaveLength(2);
  receipt.result.capTypeIdx = 2;
  receipt.result.guardTypeIdx = 1;
  receipt.types.splice(1, 0, {
    kind: "struct",
    name: "$__promise_resolving_pair",
    fields: [{ name: "alreadyResolved", type: { kind: "i32" }, mutable: true }],
  });
  receipt.types[2].fields.push({ name: "cap_guard", type: { kind: "ref", typeIdx: 1 }, mutable: false });
  for (const [, fn] of receipt.funcs) {
    expect(fn.body).toHaveLength(6);
    expect(fn.body[1]).toEqual({ op: "ref.cast", typeIdx: 1 });
    fn.body[1].typeIdx = 2;
    fn.body[2].typeIdx = 2;
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx: 2 },
      { op: "struct.get", typeIdx: 2, fieldIdx: fields + 1 },
      { op: "struct.get", typeIdx: 1, fieldIdx: 0 },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx: 2 },
      { op: "struct.get", typeIdx: 2, fieldIdx: fields + 1 },
      { op: "i32.const", value: 1 },
      { op: "struct.set", typeIdx: 1, fieldIdx: 0 },
    );
  }
  return receipt;
}

/** Authenticate the unchanged source donor AND exercise its moved owner and
 * current compiler adapter. A historical-text substitution alone is not proof.
 */
export function assertMovedResolutionReceipt(
  name: string,
  digest: string,
  source = newAsync,
  closureBuilder = buildPromiseSettleClosureValue,
): void {
  expect(movedResolutionNames.has(name)).toBe(true);
  const original = authenticateDonors(donorText).get(asyncPath)!;
  const parsed = ts.createSourceFile("donor.ts", original, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
  expect(node).toBeDefined();
  expect(sha256(node!.getText(parsed))).toBe(digest);
  if (name === "buildPromiseResolveValueLocals") {
    const file = ts.createSourceFile("adapter.ts", source, ts.ScriptTarget.Latest, true);
    const imports = file.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (n) =>
          ts.isStringLiteral(n.moduleSpecifier) &&
          n.moduleSpecifier.text === "../runtime/wasmgc/promise/resolution-bodies.js",
      );
    expect(imports).toHaveLength(1);
    const bindings = imports[0]!.importClause?.namedBindings;
    expect(bindings && ts.isNamedImports(bindings)).toBe(true);
    const names = (bindings as ts.NamedImports).elements.filter((n) => n.name.text === name);
    expect(names).toHaveLength(1);
    expect(names[0]!.propertyName).toBeUndefined();
    expect(names[0]!.isTypeOnly).toBe(false);
    expect(file.statements.some((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)).toBe(false);
    const old = evaluate(original, [name], {});
    for (const index of [1, 37]) expect(plain(buildPromiseResolveValueLocals(index))).toEqual(plain(old[name](index)));
  } else if (name === "buildPromiseResolveValueBody") {
    for (const native of [false, true])
      for (const own of [false, true])
        for (const callable of ["predicate", "root", "none"] as const) {
          expect(resolutionFixture(source, native, own, callable)).toEqual(
            expectedCaptureDelta(resolutionFixture(original, native, own, callable), native),
          );
        }
  } else if (name === "ensurePromiseThenableSubstrate") {
    for (const native of [false, true])
      for (const apply of [false, true]) {
        expect(jobFixture(source, native, apply)).toEqual(
          expectedLookupReservation(jobFixture(original, native, apply), native),
        );
      }
  } else if (name === "ensurePromiseExecutorClosures") {
    for (const fields of [2, 5, 17])
      expect(executorFixture(source, fields)).toEqual(expectedResolvingPair(executorFixture(original, fields), fields));
  } else {
    const old = evaluate(original, [name], { closureBagInitInstr: () => ({ op: "ref.null.extern" }) });
    const current = evaluate(source, [name], { buildPromiseSettleClosureValue: closureBuilder });
    const metadata = createBuiltinFunctionMetadataType(5, 3);
    expect(metadata.fields.map((field) => field.name)).toEqual(["func", "$arity", "$bag", "bfnstate", "bfnid"]);
    expect(metadata.fields).toHaveLength(5);
    for (const capTypeIdx of [4, 37])
      for (const capPromiseFieldIdx of [1, 5, 17]) {
        const resources = { capTypeIdx, capMetaTypeIdx: 5, capPromiseFieldIdx };
        const instructions = [{ op: "local.get", index: 2 }];
        // The donor ignores the supplied capture slot and always emits five
        // metadata operands. Keep that historical evidence, but explicitly
        // account for the moved owner's new refusal of incompatible layouts.
        const historical = plain(old[name](resources, 6, instructions));
        expect(historical).toEqual(plain(old[name]({ ...resources, capPromiseFieldIdx: 5 }, 6, instructions)));
        if (capPromiseFieldIdx === metadata.fields.length) {
          expect(plain(current[name](resources, 6, instructions))).toEqual(historical);
        } else {
          expect(() => current[name](resources, 6, instructions)).toThrow("metadata/capture layout");
        }
      }
  }
}
