// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildTargetTaggedTry } from "../src/wasm/physical/exception-control.js";
import {
  buildPromiseResolveValueBody as buildResolutionBody,
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseThenableJob,
  buildPromiseSettleClosureValue,
  buildPromiseSettleClosureBody,
} from "../src/runtime/wasmgc/promise/resolution-bodies.js";
import {
  buildPromisePeelValue,
  buildPromiseThenableClassifier,
  type PromiseThenableInventory,
} from "../src/runtime/wasmgc/promise/thenable-bodies.js";

// Authentication is self-contained: shallow CI needs no historical Git objects.
// This pins the verbatim donor receipt, not a regenerated expected result.
const BASE = "2b9cb408c18446361fcf9837045067d1fd97c642";
const DONOR_SHA256 = "da7c7a907726732488dec5e80a8a06c8bb0ed88c644fea32e0da15abef70a646";
const root = new URL("../", import.meta.url);
const asyncPath = "src/codegen/async-scheduler.ts";
const closedPath = "src/codegen/closed-method-dispatch.ts";
const current = (path: string) => readFileSync(new URL(path, root), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const donorText = current("tests/fixtures/issue-3518-promise-resolution-donors.json");
interface DonorReceipt {
  schemaVersion: number;
  base: string;
  sources: {
    path: string;
    sourceSha256: string;
    declarations: { name: string; start: number; end: number; sha256: string; text: string }[];
  }[];
}
function authenticateDonors(text: string): Map<string, string> {
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
const donors = authenticateDonors(donorText);
const oldAsync = donors.get(asyncPath)!;
const oldClosed = donors.get(closedPath)!;
const newAsync = current(asyncPath);
const newClosed = current(closedPath);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function declaration(source: string, name: string): string {
  const file = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true);
  const found = file.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(found.length, "positive donor declaration count: " + name).toBe(1);
  return found[0]!.getText(file).replace(/^export /, "");
}

function evaluate(source: string, names: string[], bindings: Record<string, unknown>) {
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
function originalSettleBody(capTypeIdx: number, capPromiseFieldIdx: number, settleFuncIdx: number) {
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

function mutatedSettleBuilder(before: string, after: string) {
  const name = "buildPromiseSettleClosureBody";
  const source = declaration(current("src/runtime/wasmgc/promise/resolution-bodies.ts"), name);
  expect(source.split(before)).toHaveLength(2); // exactly one live mutation site
  return evaluate(source.replace(before, after), [name], {})[name] as typeof buildPromiseSettleClosureBody;
}

function resolutionFixture(source: string, native: boolean, ownThen: boolean, callable: "predicate" | "root" | "none") {
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
        thenableJobFuncIdx: 21,
        peelValueFuncIdx: 22,
        newTypeErrorFuncIdx: 23,
        selfResolutionMsg: "self",
      }
    : null;
  const fn = evaluate(source, ["buildPromiseResolveValueBody"], {
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

function classifierFixture(source: string, variant: "full" | "empty" | "no-any" | "unreserved") {
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
  evaluate(source, ["fillPromiseThenableHelpers"], bindings).fillPromiseThenableHelpers(ctx);
  return plain({ funcs: [...funcs], calls });
}

function jobFixture(source: string, native: boolean, apply: boolean) {
  const funcs: unknown[] = [];
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
    addFuncType: () => {
      calls.push("type");
      return next++;
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
  const fns = evaluate(source, ["buildPromiseSettleClosureInstrs", "ensurePromiseThenableSubstrate"], bindings);
  const result = fns.ensurePromiseThenableSubstrate(ctx, state);
  const repeated = fns.ensurePromiseThenableSubstrate(ctx, state);
  expect(repeated).toBe(result);
  return plain({ funcs, calls, result, registrations: [...ctx.funcMap] });
}

describe("Promise resolution exact-base body preservation", () => {
  it("authenticates the self-contained receipt before rejecting altered donor text", () => {
    expect([...authenticateDonors(donorText).keys()]).toEqual([asyncPath, closedPath]);
    expect(() => authenticateDonors(donorText.replace('"schemaVersion": 1', '"schemaVersion": 2'))).toThrow(
      "digest mismatch",
    );
    expect(() => authenticateDonors(donorText + " ")).toThrow("digest mismatch");
  });
  for (const native of [false, true])
    for (const ownThen of [false, true])
      for (const callable of ["predicate", "root", "none"] as const)
        it("resolution resources " + JSON.stringify({ native, ownThen, callable }), () => {
          expect(resolutionFixture(newAsync, native, ownThen, callable)).toEqual(
            resolutionFixture(oldAsync, native, ownThen, callable),
          );
        });
  it("preserves all seven resolution locals", () => {
    const old = evaluate(oldAsync, ["buildPromiseResolveValueLocals"], {});
    const result = buildPromiseResolveValueLocals(1);
    expect(result).toHaveLength(7);
    expect(plain(result)).toEqual(plain(old.buildPromiseResolveValueLocals(1)));
  });
  for (const variant of ["full", "empty", "no-any", "unreserved"] as const)
    it("classifier finalization " + variant, () => {
      expect(classifierFixture(newClosed, variant)).toEqual(classifierFixture(oldClosed, variant));
    });
  for (const native of [false, true])
    for (const apply of [false, true])
      it("job reservations, cache, bodies and locals " + JSON.stringify({ native, apply }), () => {
        expect(jobFixture(newAsync, native, apply)).toEqual(jobFixture(oldAsync, native, apply));
      });
  it("rejects missing or unfinished classification inventory", () => {
    expect(() => buildPromiseThenableClassifier({} as PromiseThenableInventory)).toThrow("not finalized");
    expect(() => buildPromisePeelValue(undefined as never)).toThrow("missing");
    expect(() => buildNativePromiseResolveValueBody({ thenable: null } as never)).toThrow("complete");
    expect(() =>
      buildNativePromiseResolveValueBody({
        thenable: {},
        selfResolutionStringInstrs: [{ op: "global.get", index: 1 }],
      } as never),
    ).toThrow("invalid thenable binding");
  });
  it("observes changed finalized inventories and rejects an accessor without its driver", () => {
    const inventory: PromiseThenableInventory = {
      finalized: true,
      peelFuncIdx: 1,
      methodTypeIdxs: [2],
      accessors: [{ typeIdx: 3, getGlobal: 4 }],
      callAccessorGetIdx: 5,
      fields: [{ typeIdx: 3, fieldIdx: 6 }],
      closureWrapperTypeIdxs: [7],
      openObject: null,
    };
    const original = plain(buildPromiseThenableClassifier(inventory));
    expect(plain(buildPromiseThenableClassifier({ ...inventory, closureWrapperTypeIdxs: [8] }))).not.toEqual(original);
    expect(
      plain(buildPromiseThenableClassifier({ ...inventory, accessors: [{ typeIdx: 3, getGlobal: 9 }] })),
    ).not.toEqual(original);
    expect(() => buildPromiseThenableClassifier({ ...inventory, callAccessorGetIdx: undefined })).toThrow(
      "getter binding",
    );
    expect(() => buildPromiseThenableClassifier({ ...inventory, fields: undefined } as never)).toThrow("not finalized");
    expect(() => buildPromiseThenableClassifier({ ...inventory, finalized: false } as never)).toThrow("not finalized");
  });
  it("settle closure metadata and bodies have independent instructions", () => {
    const resources = { capTypeIdx: 4, capMetaTypeIdx: 5, capPromiseFieldIdx: 5 };
    const first = buildPromiseSettleClosureValue(resources, 6, [{ op: "local.get", index: 2 }]);
    const second = buildPromiseSettleClosureValue(resources, 6, [{ op: "local.get", index: 2 }]);
    expect(plain(first)).toEqual(plain(second));
    expect(first[0]).not.toBe(second[0]);
    const old = evaluate(oldAsync, ["buildPromiseSettleClosureInstrs"], {
      closureBagInitInstr: () => ({ op: "ref.null.extern" }),
    });
    expect(plain(first)).toEqual(
      plain(old.buildPromiseSettleClosureInstrs(resources, 6, [{ op: "local.get", index: 2 }])),
    );
  });
  for (const capTypeIdx of [4, 37])
    for (const capPromiseFieldIdx of [1, 5, 17])
      for (const resolveFuncIdx of [6, 101])
        for (const rejectFuncIdx of [7, 203])
          it(
            "complete settle bodies and live operand controls " +
              JSON.stringify({ capTypeIdx, capPromiseFieldIdx, resolveFuncIdx, rejectFuncIdx }),
            () => {
              const resources = { capTypeIdx, capPromiseFieldIdx, capMetaTypeIdx: 91 };
              const wrongField = mutatedSettleBuilder(
                "fieldIdx: capPromiseFieldIdx",
                "fieldIdx: capPromiseFieldIdx + 1",
              );
              const wrongTarget = mutatedSettleBuilder("funcIdx: settleFuncIdx", "funcIdx: settleFuncIdx + 1");
              for (const target of [resolveFuncIdx, rejectFuncIdx]) {
                const expected = originalSettleBody(capTypeIdx, capPromiseFieldIdx, target);
                expect(expected).toHaveLength(6); // positive denominator before negative controls
                const verify = (builder: typeof buildPromiseSettleClosureBody) =>
                  expect(plain(builder(resources, target))).toEqual(expected);
                verify(buildPromiseSettleClosureBody);
                expect(() => verify(wrongField)).toThrow();
                expect(() => verify(wrongTarget)).toThrow();
              }
            },
          );
});
