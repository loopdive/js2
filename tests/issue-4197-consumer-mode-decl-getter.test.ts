// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4197) In runtime-eval CONSUMER mode a function DECLARATION used as a
 * descriptor `get`/`set` was a broken callable.
 *
 * Consumer mode is what a standalone module enters once dynamic eval /
 * `Function` construction is reachable: every top-level function declaration
 * becomes a live binding whose module global holds the closure wrapped in the
 * `$RuntimeEvalAotCallable` carrier. Reading the name as a VALUE therefore
 * yields the carrier — and `__call_fn_method_<arity>`, which sits behind
 * `__call_accessor_get` / `__call_accessor_set`, had no arm for it. It fell
 * through to `ref.null.extern`, so every accessor read answered `undefined`
 * (null on a reference receiver, 0 after a numeric unbox on a plain object)
 * and every accessor write was dropped.
 *
 * This is the mechanism behind the test262 `propertyHelper.js` accessor
 * cluster: that harness opens with primordial captures, its deprecated-helper
 * tests spell their getters as `function getFunc() {…}` + `{ get: getFunc }`,
 * and the whole file compiles in consumer mode.
 *
 * The controls in the same module are the discriminating half — a function
 * EXPRESSION getter and a plain data define both already worked — so a failure
 * here is specifically about the declaration's carrier-wrapped value, not about
 * the descriptor store or the read path.
 *
 * Wiring: the trigger is an unreached `new Function(dynamicArg)`, which is what
 * flips the module (`callUsesRuntimeEvalBoundary` → `hasUnknownDynamicSource`);
 * the module is instantiated against the compiler's own REFUSAL provider, the
 * same self-contained pattern `issue-2928-refusal-provider.test.ts` uses. No
 * built provider cache and no test262 checkout are required — nothing here ever
 * calls eval, it only needs the namespace to link.
 */
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalRefusalProviderSource,
  instantiateRuntimeEvalNamespace,
  // @ts-ignore — plain .mjs helper
} from "../scripts/runtime-eval-provider.mjs";
import { compile } from "../src/index.js";

/**
 * The one construct that puts the module in consumer mode. It is never
 * executed: the scan that promotes top-level declarations to live bindings is
 * over the AST, not over reachable code.
 */
const CONSUMER_MODE_TRIGGER = `
var dynamicBody: any = "return 1";
function neverCalled(): any { return new Function(dynamicBody); }
`;

let refusalModule: WebAssembly.Module | undefined;
async function refusalNamespace(): Promise<WebAssembly.Instance["exports"]> {
  if (refusalModule === undefined) {
    const built: any = await compile(buildRuntimeEvalRefusalProviderSource(), {
      ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
      fileName: "runtime-eval-refusal.ts",
    });
    expect(built.success, built.errors?.map((e: any) => e.message).join("\n")).toBe(true);
    refusalModule = new WebAssembly.Module(built.binary);
  }
  return instantiateRuntimeEvalNamespace(refusalModule);
}

async function runConsumerMode(body: string, fileName: string): Promise<number> {
  const result: any = await compile(CONSUMER_MODE_TRIGGER + body, {
    fileName,
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors?.map((e: any) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(result.binary);
  // The trigger has to have actually fired — otherwise every assertion below
  // is a tautology against the ordinary (already working) closure lane.
  expect(WebAssembly.Module.imports(mod).map((i) => i.module)).toContain(RUNTIME_EVAL_IMPORT_MODULE);
  const instance = new WebAssembly.Instance(mod, {
    ...(result.importObject ?? {}),
    [RUNTIME_EVAL_IMPORT_MODULE]: await refusalNamespace(),
  });
  return (instance.exports as { test(): number }).test();
}

describe("#4197 consumer-mode function-declaration accessors", { timeout: 600_000 }, () => {
  it("invokes a function-declaration getter on array and plain-object receivers", async () => {
    const code = await runConsumerMode(
      `
function getFunc(): any { return 12; }
var getExpr: any = function (): any { return 99; };

export function test(): number {
  // Control: the declaration is callable directly (this always worked).
  if (getFunc() !== 12) return 10;

  // Control: a function EXPRESSION getter is never carrier-wrapped.
  var oExpr: any = {};
  Object.defineProperty(oExpr, "p", { get: getExpr, configurable: true });
  if (oExpr.p !== 99) return 11;

  // Control: a plain data define round-trips.
  var oData: any = {};
  Object.defineProperty(oData, "d", { value: 77, configurable: true });
  if (oData.d !== 77) return 12;

  // The defect: declaration getter on a plain object (read 0 before the fix).
  var oDecl: any = {};
  Object.defineProperty(oDecl, "p", { get: getFunc, configurable: true });
  if (oDecl.p !== 12) return 13;

  // The defect: declaration getter on an array receiver (read null before).
  var arr: any = [10, 20, 30];
  Object.defineProperty(arr, "1", { get: getFunc, configurable: true });
  if (arr[1] !== 12) return 14;

  // The descriptor must still expose the getter itself — propertyHelper
  // compares descriptor fields, so unwrapping at store time is not a fix.
  var desc: any = Object.getOwnPropertyDescriptor(oDecl, "p");
  if (!desc) return 15;
  if (typeof desc.get !== "function") return 16;
  return 1;
}
`,
      "issue-4197-consumer-mode-decl-getter.ts",
    );
    expect(code).toBe(1);
  });

  it("invokes a function-declaration setter", async () => {
    const code = await runConsumerMode(
      `
var seen: any = 0;
function setFunc(v: any): void { seen = v; }
function readSeen(): any { return seen; }

export function test(): number {
  var o: any = {};
  Object.defineProperty(o, "p", { set: setFunc, get: readSeen, configurable: true });
  o.p = 42;
  // The setter's argument must survive the carrier hop — an argc of 0 here
  // would silently drop it and leave the old value in place.
  if (readSeen() !== 42) return 20;
  if (o.p !== 42) return 21;
  return 1;
}
`,
      "issue-4197-consumer-mode-decl-setter.ts",
    );
    expect(code).toBe(1);
  });

  it("invokes the declaration getter once per read, per receiver", async () => {
    // NOT a `this`-binding test on purpose: `this` inside a function
    // DECLARATION used as a getter resolves to the wrong receiver in BOTH
    // modes — measured on origin/main, non-consumer included — so that is a
    // pre-existing gap outside #4197's mechanism, tracked as #4198.
    const code = await runConsumerMode(
      `
var calls: any = 0;
function counting(): any { calls = calls + 1; return calls; }

export function test(): number {
  var a: any = {};
  var b: any = {};
  Object.defineProperty(a, "p", { get: counting, configurable: true });
  Object.defineProperty(b, "p", { get: counting, configurable: true });
  if (a.p !== 1) return 30;
  if (b.p !== 2) return 31;
  if (a.p !== 3) return 32;
  return 1;
}
`,
      "issue-4197-consumer-mode-decl-getter-per-receiver.ts",
    );
    expect(code).toBe(1);
  });

  it("leaves a non-consumer module's declaration getter working", async () => {
    // Same program WITHOUT the trigger: no carrier is minted at all, so this
    // arm proves the fix did not disturb the ordinary lane.
    const result: any = await compile(
      `
function getFunc(): any { return 12; }

export function test(): number {
  var o: any = {};
  Object.defineProperty(o, "p", { get: getFunc, configurable: true });
  if (o.p !== 12) return 40;
  var arr: any = [10, 20, 30];
  Object.defineProperty(arr, "1", { get: getFunc, configurable: true });
  return arr[1] === 12 ? 1 : 41;
}
`,
      {
        fileName: "issue-4197-non-consumer-decl-getter.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors?.map((e: any) => e.message).join("\n")).toBe(true);
    const mod = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(mod).map((i) => i.module)).not.toContain(RUNTIME_EVAL_IMPORT_MODULE);
    const instance = new WebAssembly.Instance(mod, result.importObject ?? {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});
