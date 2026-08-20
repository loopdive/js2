// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4504 — Standalone inherited [[Set]] must make ONE nearest-descriptor decision
// before any carrier creates an own property. This is deliberately a SCRIPT-goal
// suite for the strictness-sensitive cases: an exported unit test would be a
// module and silently exercise only __extern_set_strict.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CompilerPool, type TestResult } from "../scripts/compiler-pool.js";
import {
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import { resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";
import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

let pool: CompilerPool;
let previousEvalEngine: string | undefined;

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262", "test");
const TEST262_HARNESS = join(import.meta.dirname ?? ".", "..", "test262", "harness", "assert.js");
const HAS_TEST262 = existsSync(TEST262_HARNESS);

interface Test262Row {
  readonly id: string;
  readonly path: string;
  readonly shape: string;
  /** Normal scripts execute primary (sloppy) + strict rerun; noStrict executes only primary. */
  readonly variants: number;
}

// Authoritative #4504 acceptance denominator: EXACTLY these nine rows, not the
// historical eleven-row diagnostic cohort. Each path is an upstream untouched
// script record, assembled through assembleOriginalHarness below.
const TARGET_ROWS: readonly Test262Row[] = [
  {
    id: "15.2.3.6-4-410",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-410.js",
    shape: "JSON + Object.prototype companion non-writable data",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-415",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-415.js",
    shape: "three-level Object.create chain + nearest non-writable data",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-579",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-579.js",
    shape: "Array companion setter",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-581",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-581.js",
    shape: "Number companion getter-only accessor",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-584",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-584.js",
    shape: "Date companion setter",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-586",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-586.js",
    shape: "JSON + Object.prototype companion getter-only accessor",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-594",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-594.js",
    shape: "bound Function companion setter",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-596",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-596.js",
    shape: "bound Function companion getter-only accessor",
    variants: 2,
  },
  {
    id: "8.14.4-8-b_1",
    path: "language/expressions/assignment/8.14.4-8-b_1.js",
    shape: "fnctor prototype chain + non-writable data (noStrict)",
    variants: 1,
  },
];

// These two rows were intentionally diagnosed alongside the nine target rows,
// but are NOT descriptor-walk acceptance criteria:
//
// - 4-408 needs Date own-expando/own-view visibility after a legal writable
//   data shadow;
// - 4-589 reaches the setter, then loses a Date through the getter result ABI.
//
// They are exercised as live diagnostics below, but their expected-red state
// must never turn #4504's suite red (nor must an eventual independent fix turn
// this suite red by making one pass).
const EXCLUDED_DIAGNOSTICS: readonly Test262Row[] = [
  {
    id: "15.2.3.6-4-408",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-408.js",
    shape: "excluded Date writable-data own-view follow-up",
    variants: 2,
  },
  {
    id: "15.2.3.6-4-589",
    path: "built-ins/Object/defineProperty/15.2.3.6-4-589.js",
    shape: "excluded Date accessor getter-result carrier follow-up",
    variants: 2,
  },
];

/**
 * Keep this changed-root test self-contained. Two bound-Function rows import
 * the runtime-eval namespace even though their descriptor assertion does not
 * execute dynamic code; the cheap refusal provider is sufficient and is the
 * same cache artifact built by standalone Test262 CI.
 */
async function ensureRefusalProviderCached(): Promise<void> {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, computeCompilerBundleHash());
  const dir = defaultRuntimeEvalProviderCacheDir();
  if (readCachedRuntimeEvalProvider(dir, key, runtimeEvalRefusalCachePath)) return;
  const result = await compile(source, RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS);
  expect(result.success, "#4504 refusal provider must compile").toBe(true);
  writeCachedRuntimeEvalProvider(dir, key, result.binary!, runtimeEvalRefusalCachePath);
  resetTest262RuntimeEvalProviderForTest();
}

beforeAll(async () => {
  previousEvalEngine = process.env.JS2WASM_EVAL_ENGINE;
  process.env.JS2WASM_EVAL_ENGINE = "interpreter";
  await ensureRefusalProviderCached();
  pool = new CompilerPool(1, "unified");
  await pool.ready();
}, 600_000);

afterAll(() => {
  pool?.shutdown();
  if (previousEvalEngine === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EVAL_ENGINE");
  else process.env.JS2WASM_EVAL_ENGINE = previousEvalEngine;
  resetTest262RuntimeEvalProviderForTest();
});

/**
 * Assemble and execute a literal Test262-shaped SCRIPT record. Both admissible
 * flag forms suppress the automatic opposite-strictness rerun:
 *
 * - noStrict proves the sloppy __extern_set result is a silent false/no-op;
 * - onlyStrict proves __extern_set_strict turns that same false into a
 *   catchable TypeError.
 */
async function runScriptGoal(
  label: string,
  flags: readonly ("noStrict" | "onlyStrict")[],
  body: string,
): Promise<readonly TestResult[]> {
  const source = `/*---
description: ${label}
flags: [${flags.join(", ")}]
---*/
${body}`;
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);

  expect(meta.flags).toEqual([...flags]);
  expect(assembly.primary.strict).toBe(flags.includes("onlyStrict"));
  if (flags.includes("noStrict") || flags.includes("onlyStrict")) {
    expect(assembly.strictRerun).toBeUndefined();
  } else {
    expect(assembly.strictRerun, `${label} must retain Test262's strict rerun`).toBeDefined();
  }

  const variants = [assembly.primary, ...(assembly.strictRerun ? [assembly.strictRerun] : [])];
  const results: TestResult[] = [];
  for (const variant of variants) {
    const result = await pool.runTest(
      variant.source,
      {
        originalHarness: true,
        asyncTest: assembly.async,
        // This is a script record, not a synthetic module wrapper.
        inferModuleStrictArguments: false,
        target: "standalone",
        label: `${label} [${variant.strict ? "strict" : "sloppy"}]`,
      },
      30_000,
    );
    expect(result.status, `${label}: ${result.error ?? "no worker detail"}`).toBe("pass");
    results.push(result);
  }
  return results;
}

/**
 * The faithful standalone Test262 route: untouched upstream source, original
 * harness assembly, SCRIPT goal (primary sloppy then optional strict rerun),
 * and the same unified worker substrate used by the Test262 runner.
 */
async function runOriginalStandaloneRow(row: Test262Row): Promise<readonly TestResult[]> {
  const source = readFileSync(join(TEST262_ROOT, row.path), "utf8");
  const meta = parseMeta(source);
  const assembly = assembleOriginalHarness(source, meta);
  const variants = [assembly.primary, ...(assembly.strictRerun ? [assembly.strictRerun] : [])];

  // Every row here is a script goal. Do not accidentally turn it into a module
  // test: that would make all member assignments strict and hide the sloppy
  // half of the contract.
  expect(meta.flags ?? []).not.toContain("module");
  expect(assembly.primary.strict).toBe(false);
  expect(variants).toHaveLength(row.variants);

  const results: TestResult[] = [];
  for (const variant of variants) {
    const result = await pool.runTest(
      variant.source,
      {
        originalHarness: true,
        asyncTest: assembly.async,
        inferModuleStrictArguments: false,
        target: "standalone",
        label: `#4504 ${row.id} [${variant.strict ? "strict" : "sloppy"}]`,
      },
      30_000,
    );
    results.push(result);
  }
  return results;
}

/** Compile a standalone regression whose runtime contract must not need host imports. */
async function compileStandaloneNoImports<T>(fileName: string, source: string): Promise<T> {
  const result = await compile(source, { fileName, target: "standalone" });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\\n")).toBe(true);

  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), `${fileName} must stay host-import-free`).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as T;
}

describe("#4504 — inherited [[Set]] nearest-descriptor decision", () => {
  it("keeps the pre-existing resurrection helper in descriptor-free standalone output", async () => {
    const result = await compile(
      `
class Box { value = "before"; }
export function rewrite(key: string): number {
  const box: any = new Box();
  delete box.value;
  box[key] = "after";
  return box.value === "after" ? 1 : 0;
}
`,
      {
        fileName: "issue-4504-flag-clear.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        emitWat: true,
      },
    );

    expect(result.success, result.errors.map((error) => String(error.message ?? error)).join("; ")).toBe(true);
    expect(result.wat?.match(/\(func \$__instance_field_resurrect\b/g) ?? []).toHaveLength(1);
    expect(result.wat).not.toContain("(func $__extern_set_decide");
  });

  it("stops at the nearest inherited writable/non-writable data descriptor across multiple levels", async () => {
    await runScriptGoal(
      "4504/nearest-data-descriptor/sloppy-script",
      ["noStrict"],
      `
var far = {};
var farSetterCalls = 0;
Object.defineProperty(far, "slot", {
  get: function() { return "far"; },
  set: function(value) { farSetterCalls = farSetterCalls + 1; },
  configurable: true
});

var nearerWritable = Object.create(far);
Object.defineProperty(nearerWritable, "slot", {
  value: "near",
  writable: true,
  configurable: true
});
var writableReceiver = Object.create(nearerWritable);
var writableRhs = { marker: "writable" };
var writableResult = writableReceiver.slot = writableRhs;
assert.sameValue(writableResult, writableRhs, "assignment result remains the RHS");
assert.sameValue(writableReceiver.hasOwnProperty("slot"), true, "nearest writable data allows an own write");
assert.sameValue(writableReceiver.slot, writableRhs);
assert.sameValue(farSetterCalls, 0, "must not look past writable data to the farther setter");

var nearerReadonly = Object.create(far);
Object.defineProperty(nearerReadonly, "slot", {
  value: "blocked",
  writable: false,
  configurable: true
});
var readonlyReceiver = Object.create(nearerReadonly);
var readonlyRhs = { marker: "readonly" };
var readonlyResult = readonlyReceiver.slot = readonlyRhs;
assert.sameValue(readonlyResult, readonlyRhs, "a refused sloppy assignment still evaluates to its RHS");
assert.sameValue(readonlyReceiver.hasOwnProperty("slot"), false, "nearest non-writable data refuses an own write");
assert.sameValue(readonlyReceiver.slot, "blocked");
assert.sameValue(farSetterCalls, 0, "must not look past non-writable data to the farther setter");
`,
    );
  });

  it("calls an inherited setter once with the original receiver and preserves the assignment RHS", async () => {
    await runScriptGoal(
      "4504/inherited-setter/original-receiver/sloppy-script",
      ["noStrict"],
      `
var proto = {};
var setterCalls = 0;
var seenReceiver = null;
var seenValue = null;
Object.defineProperty(proto, "slot", {
  get: function() { return seenValue; },
  set: function(value) {
    setterCalls = setterCalls + 1;
    seenReceiver = this;
    seenValue = value;
  },
  configurable: true
});
var receiver = Object.create(Object.create(proto));
var rhs = { marker: "rhs identity" };
var result = receiver.slot = rhs;

assert.sameValue(setterCalls, 1, "setter runs exactly once");
assert.sameValue(seenReceiver, receiver, "setter this is the original receiver, not a proto cursor");
assert.sameValue(seenValue, rhs, "setter receives the unmodified RHS");
assert.sameValue(result, rhs, "assignment result remains the original RHS");
assert.sameValue(receiver.hasOwnProperty("slot"), false, "setter handling never creates a shadow own property");
assert.sameValue(receiver.slot, rhs, "the inherited getter still controls the read");
`,
    );
  });

  it("checks a brand companion before Object.prototype and still retains Array receiver identity", async () => {
    await runScriptGoal(
      "4504/brand-before-object/array-carrier/sloppy-script",
      ["noStrict"],
      `
var objectCalls = 0;
var arrayCalls = 0;
var arrayReceiver = null;
var arrayValue = null;
Object.defineProperty(Object.prototype, "brandFirst", {
  set: function(value) { objectCalls = objectCalls + 1; },
  configurable: true
});
Object.defineProperty(Array.prototype, "brandFirst", {
  set: function(value) {
    arrayCalls = arrayCalls + 1;
    arrayReceiver = this;
    arrayValue = value;
  },
  configurable: true
});

var receiver = [];
var rhs = { marker: "array rhs" };
var result = receiver.brandFirst = rhs;
assert.sameValue(arrayCalls, 1, "Array companion setter wins");
assert.sameValue(objectCalls, 0, "Object companion is not consulted after an Array hit");
assert.sameValue(arrayReceiver, receiver, "carrier setter this remains the Array receiver");
assert.sameValue(arrayValue, rhs);
assert.sameValue(result, rhs, "assignment result remains the RHS");
assert.sameValue(receiver.hasOwnProperty("brandFirst"), false, "carrier setter does not fabricate an own property");
`,
    );
  });

  it("uses a silent no-op for a sloppy inherited getter-only assignment", async () => {
    await runScriptGoal(
      "4504/getter-only/sloppy-refusal",
      ["noStrict"],
      `
var proto = {};
var getterCalls = 0;
Object.defineProperty(proto, "slot", {
  get: function() {
    getterCalls = getterCalls + 1;
    return "inherited data";
  },
  configurable: true
});
var receiver = Object.create(proto);
var rhs = { marker: "sloppy rhs" };
var result = null;
var threw = false;
try {
  result = receiver.slot = rhs;
} catch (error) {
  threw = true;
}

assert.sameValue(threw, false, "sloppy getter-only assignment is a silent refusal");
assert.sameValue(result, rhs, "the assignment expression still evaluates to RHS");
assert.sameValue(receiver.hasOwnProperty("slot"), false, "getter-only refusal creates no own property");
assert.sameValue(receiver.slot, "inherited data");
assert.sameValue(getterCalls, 1);
`,
    );
  });

  it("keeps own Array getter-only and non-writable indexes silent in sloppy code while Reflect refuses", async () => {
    await runScriptGoal(
      "4504/array-own-getter-only/sloppy-refusal",
      ["noStrict"],
      `
var receiver = [1, 2, 3];
Object.defineProperty(receiver, "0", {
  value: 10,
  writable: false,
  configurable: true
});
Object.defineProperty(receiver, "1", {
  get: function() { return 100; },
  configurable: true
});
var threw = false;
var result = null;
var dataResult = null;
try {
  result = receiver[1] = 5;
  dataResult = receiver[0] = 11;
} catch (error) {
  threw = true;
}

assert.sameValue(threw, false, "sloppy own descriptor refusals are silent");
assert.sameValue(result, 5, "the assignment expression still evaluates to RHS");
assert.sameValue(dataResult, 11, "the non-writable assignment also evaluates to RHS");
assert.sameValue(receiver[1], 100, "the getter remains authoritative");
assert.sameValue(receiver[0], 10, "the non-writable value remains authoritative");
assert.sameValue(Reflect.set(receiver, "1", 6), false, "Reflect exposes the same refusal");
assert.sameValue(Reflect.set(receiver, "0", 12), false, "Reflect exposes the data refusal too");
assert.sameValue(receiver[1], 100, "neither write replaces the descriptor");
assert.sameValue(receiver[0], 10);
`,
    );
  });

  it("turns that same inherited getter-only refusal into a catchable strict TypeError", async () => {
    await runScriptGoal(
      "4504/getter-only/strict-refusal",
      ["onlyStrict"],
      `
var proto = {};
Object.defineProperty(proto, "slot", {
  get: function() { return "inherited data"; },
  configurable: true
});
var receiver = Object.create(proto);
var caught = null;
try {
  receiver.slot = { marker: "strict rhs" };
} catch (error) {
  caught = error;
}

assert(caught instanceof TypeError, "strict refusal must be a catchable TypeError");
assert.sameValue(receiver.hasOwnProperty("slot"), false);
assert.sameValue(receiver.slot, "inherited data");
`,
    );
  });

  it("refuses an inherited writable data property after Object.freeze makes it non-writable", async () => {
    // A normal Test262 script runs once sloppy and once strict. The direct
    // assignment therefore either leaves `caught` null (sloppy) or stores a
    // TypeError (strict); Reflect.set is uniformly the underlying false.
    // Use an open null-prototype object so this stays a descriptor-walk gate,
    // independent of closed-carrier integrity-bag follow-up behavior.
    await runScriptGoal(
      "4504/frozen-prototype/inherited-data-refusal",
      [],
      `
var proto = Object.create(null);
Object.defineProperty(proto, "frozenSlot", {
  value: 1,
  writable: true,
  configurable: true
});
Object.freeze(proto);

var receiver = Object.create(proto);
var rhs = { marker: "frozen RHS" };
var result = null;
var caught = null;
try {
  result = receiver.frozenSlot = rhs;
} catch (error) {
  caught = error;
}

assert.sameValue(Object.getOwnPropertyDescriptor(proto, "frozenSlot").writable, false);
assert.sameValue(Reflect.set(receiver, "frozenSlot", rhs), false, "the shared [[Set]] decision refuses");
assert.sameValue(Object.prototype.hasOwnProperty.call(receiver, "frozenSlot"), false);
assert.sameValue(receiver.frozenSlot, 1);
if (caught === null) {
  assert.sameValue(result, rhs, "sloppy refusal preserves assignment RHS");
} else {
  assert(caught instanceof TypeError, "strict refusal is catchable");
}
`,
    );
  });

  it("recognizes an Object.freeze alias before deciding an inherited data write", async () => {
    await runScriptGoal(
      "4504/frozen-prototype/aliased-freeze-inherited-data-refusal",
      [],
      `
var proto = Object.create(null);
Object.defineProperty(proto, "aliasedFrozenSlot", {
  value: 1,
  writable: true,
  configurable: true
});
const freezeFn = Object.freeze;
freezeFn(proto);

var receiver = Object.create(proto);
var rhs = { marker: "aliased frozen RHS" };
var result = null;
var caught = null;
try {
  result = receiver.aliasedFrozenSlot = rhs;
} catch (error) {
  caught = error;
}

assert.sameValue(Object.getOwnPropertyDescriptor(proto, "aliasedFrozenSlot").writable, false);
assert.sameValue(Reflect.set(receiver, "aliasedFrozenSlot", rhs), false, "aliased freeze must feed the same [[Set]] refusal");
assert.sameValue(Object.prototype.hasOwnProperty.call(receiver, "aliasedFrozenSlot"), false);
assert.sameValue(receiver.aliasedFrozenSlot, 1);
if (caught === null) {
  assert.sameValue(result, rhs, "sloppy refusal preserves assignment RHS");
} else {
  assert(caught instanceof TypeError, "strict refusal is catchable");
}
`,
    );
  });

  // Direct legacy __defineGetter__/__defineSetter__ calls remain a separate
  // standalone-provider capability gap. Ordinary descriptor accessors above
  // are the #4504 gate; do not turn this suite into a masked Annex-B test.

  it("returns Reflect.set true only for a handled/allowed write and false for both refusal kinds", async () => {
    await runScriptGoal(
      "4504/reflect-set/shared-decision/sloppy-script",
      ["noStrict"],
      `
var setterCalls = 0;
var setterReceiver = null;
var setterValue = null;
var setterProto = {};
Object.defineProperty(setterProto, "setter", {
  set: function(value) {
    setterCalls = setterCalls + 1;
    setterReceiver = this;
    setterValue = value;
  },
  configurable: true
});
var setterReceiverObject = Object.create(setterProto);
var setterRhs = { marker: "setter rhs" };
assert.sameValue(Reflect.set(setterReceiverObject, "setter", setterRhs), true);
assert.sameValue(setterCalls, 1);
assert.sameValue(setterReceiver, setterReceiverObject);
assert.sameValue(setterValue, setterRhs);
assert.sameValue(setterReceiverObject.hasOwnProperty("setter"), false);

var writableProto = {};
Object.defineProperty(writableProto, "data", { value: 1, writable: true, configurable: true });
var writableReceiver = Object.create(writableProto);
assert.sameValue(Reflect.set(writableReceiver, "data", 2), true);
assert.sameValue(writableReceiver.hasOwnProperty("data"), true);
assert.sameValue(writableReceiver.data, 2);

var getterProto = {};
Object.defineProperty(getterProto, "getter", { get: function() { return 3; }, configurable: true });
var getterReceiver = Object.create(getterProto);
assert.sameValue(Reflect.set(getterReceiver, "getter", 4), false);
assert.sameValue(getterReceiver.hasOwnProperty("getter"), false);
assert.sameValue(getterReceiver.getter, 3);

var readonlyProto = {};
Object.defineProperty(readonlyProto, "readonly", { value: 5, writable: false, configurable: true });
var readonlyReceiver = Object.create(readonlyProto);
assert.sameValue(Reflect.set(readonlyReceiver, "readonly", 6), false);
assert.sameValue(readonlyReceiver.hasOwnProperty("readonly"), false);
assert.sameValue(readonlyReceiver.readonly, 5);
`,
    );
  });

  it("propagates an inherited setter exception exactly once rather than converting it to a refusal", async () => {
    await runScriptGoal(
      "4504/setter-exception/once/sloppy-script",
      ["noStrict"],
      `
var proto = {};
var calls = 0;
var sentinel = { marker: "setter exception" };
Object.defineProperty(proto, "slot", {
  set: function(value) {
    calls = calls + 1;
    throw sentinel;
  },
  configurable: true
});
var receiver = Object.create(proto);
var caught = null;
try {
  receiver.slot = { marker: "rhs" };
} catch (error) {
  caught = error;
}

assert.sameValue(caught, sentinel, "the setter's abrupt completion propagates");
assert.sameValue(calls, 1, "a preflight must not replay the setter");
assert.sameValue(receiver.hasOwnProperty("slot"), false);
`,
    );
  });

  it("keeps an outer handled result intact when its setter makes a nested refused set", async () => {
    // This normal script intentionally gets BOTH Test262 variants. The inner
    // Reflect.set returns false (getter-only), so a private mutable result slot
    // overwritten by the nested call would incorrectly make the outer handled
    // setter look refused: sloppy would diverge from strict, and Reflect.set
    // would return false. The outer setter has nevertheless completed normally.
    await runScriptGoal(
      "4504/nested-setter-reentrancy/outer-result-survives",
      [],
      `
var proto = {};
var outerCalls = 0;
var nestedResult = true;
Object.defineProperty(proto, "inner", {
  get: function() { return "inner getter"; },
  configurable: true
});
Object.defineProperty(proto, "outer", {
  set: function(value) {
    outerCalls = outerCalls + 1;
    nestedResult = Reflect.set(this, "inner", value);
  },
  configurable: true
});

var receiver = Object.create(proto);
var rhs = { marker: "outer rhs" };
var assignmentResult = receiver.outer = rhs;
assert.sameValue(assignmentResult, rhs, "outer assignment still returns its RHS");
assert.sameValue(outerCalls, 1);
assert.sameValue(nestedResult, false, "nested getter-only set really was refused");
assert.sameValue(receiver.hasOwnProperty("outer"), false);
assert.sameValue(receiver.hasOwnProperty("inner"), false);
assert.sameValue(Reflect.set(receiver, "outer", 23), true, "outer setter is handled despite nested refusal");
assert.sameValue(outerCalls, 2);
assert.sameValue(nestedResult, false);
`,
    );
  });

  // #4098 (standalone instance fields not own properties of the instance)
  // owns the known stale typed direct-read after deletion. This #4504 score
  // intentionally gates the [[Set]] decision only: delete, no throw, one
  // inherited setter call, no own resurrection, and side-bag preservation.
  it("keeps declared physical fields ahead of inherited descriptors even after a side bag exists", async () => {
    const result = await compile(
      `
        class ClosedStruct {
          value: number = 1;
        }

        class ObjectPrototypeStruct {
          value: number = 1;
        }

        let inheritedSetterCalls: number = 0;
        let objectPrototypeSetterCalls: number = 0;

        export function reflectDeclaredField(): number {
          const receiver: any = new ClosedStruct();
          receiver["sideBag"] = 1;
          const setResult = Reflect.set(receiver, "value", 9);
          let score = 0;
          if (setResult === true) score = score | 1;
          if (receiver.value === 9) score = score | 2;
          if (receiver.sideBag === 1) score = score | 4;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 8;
          return score;
        }

        export function strictDeclaredField(): number {
          "use strict";
          const receiver: any = new ClosedStruct();
          receiver["sideBag"] = 1;
          let threw = 0;
          try {
            receiver["value"] = 10;
          } catch (error) {
            threw = 1;
          }
          let score = 0;
          if (threw === 0) score = score | 1;
          if (receiver.value === 10) score = score | 2;
          if (receiver.sideBag === 1) score = score | 4;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 8;
          return score;
        }

        export function physicalFieldBeatsInheritedSetter(): number {
          inheritedSetterCalls = 0;
          const receiver: any = new ClosedStruct();
          receiver["sideBag"] = 1; // allocate the carrier's side bag first
          Object.defineProperty(ClosedStruct.prototype, "value", {
            get: function(): number { return 99; },
            set: function(next: any): void { inheritedSetterCalls = inheritedSetterCalls + 1; },
            configurable: true
          });
          let threw = 0;
          try {
            receiver["value"] = 17; // module code: strict physical-field write
          } catch (error) {
            threw = 1;
          }
          const reflectResult = Reflect.set(receiver, "value", 18);
          let score = 0;
          if (threw === 0) score = score | 1;
          if (reflectResult === true) score = score | 2;
          if (inheritedSetterCalls === 0) score = score | 4;
          if (receiver.value === 18) score = score | 8;
          if (receiver.sideBag === 1) score = score | 16;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 32;
          return score;
        }

        export function physicalFieldBeatsInheritedNonWritableData(): number {
          const receiver: any = new ClosedStruct();
          receiver["sideBag"] = 1; // allocate the carrier's side bag first
          Object.defineProperty(ClosedStruct.prototype, "value", {
            value: 99,
            writable: false,
            configurable: true
          });
          let threw = 0;
          try {
            receiver["value"] = 23;
          } catch (error) {
            threw = 1;
          }
          const reflectResult = Reflect.set(receiver, "value", 24);
          let score = 0;
          if (threw === 0) score = score | 1;
          if (reflectResult === true) score = score | 2;
          if (receiver.value === 24) score = score | 4;
          if (receiver.sideBag === 1) score = score | 8;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 16;
          return score;
        }

        export function physicalFieldBeatsObjectPrototypeSetter(): number {
          objectPrototypeSetterCalls = 0;
          const receiver: any = new ObjectPrototypeStruct();
          receiver["sideBag"] = 1; // force the hidden side bag to exist
          Object.defineProperty(Object.prototype, "value", {
            get: function(): number { return 99; },
            set: function(next: any): void { objectPrototypeSetterCalls = objectPrototypeSetterCalls + 1; },
            configurable: true
          });
          let threw = 0;
          try {
            receiver["value"] = 27;
          } catch (error) {
            threw = 1;
          }
          const reflectResult = Reflect.set(receiver, "value", 28);
          let score = 0;
          if (threw === 0) score = score | 1;
          if (reflectResult === true) score = score | 2;
          if (objectPrototypeSetterCalls === 0) score = score | 4;
          if (receiver.value === 28) score = score | 8;
          if (receiver.sideBag === 1) score = score | 16;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 32;
          return score;
        }

        export function physicalFieldBeatsObjectPrototypeNonWritableData(): number {
          const receiver: any = new ObjectPrototypeStruct();
          receiver["sideBag"] = 1; // force the hidden side bag to exist
          Object.defineProperty(Object.prototype, "value", {
            value: 99,
            writable: false,
            configurable: true
          });
          let threw = 0;
          try {
            receiver["value"] = 29;
          } catch (error) {
            threw = 1;
          }
          const reflectResult = Reflect.set(receiver, "value", 30);
          let score = 0;
          if (threw === 0) score = score | 1;
          if (reflectResult === true) score = score | 2;
          if (receiver.value === 30) score = score | 4;
          if (receiver.sideBag === 1) score = score | 8;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 16;
          return score;
        }

        export function deletedPhysicalFieldDelegatesToObjectPrototypeSetter(): number {
          objectPrototypeSetterCalls = 0;
          const receiver: any = new ObjectPrototypeStruct();
          receiver["sideBag"] = 1; // keep the historical bag/tombstone path live
          Object.defineProperty(Object.prototype, "value", {
            set: function(next: any): void { objectPrototypeSetterCalls = objectPrototypeSetterCalls + 1; },
            configurable: true
          });
          const deleted = delete receiver.value;
          let threw = 0;
          try {
            receiver["value"] = 31;
          } catch (error) {
            threw = 1;
          }
          let score = 0;
          if (deleted === true) score = score | 1;
          if (threw === 0) score = score | 2;
          if (objectPrototypeSetterCalls === 1) score = score | 4;
          if (!Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 8;
          if (receiver.sideBag === 1) score = score | 32;
          return score;
        }

        export function resurrectsDeletedPhysicalFieldWithoutInheritedDescriptor(): number {
          // The preceding controls intentionally install Object.prototype.value.
          // Clear it first: a deleted physical field can resurrect only when
          // normal inherited-descriptor lookup finds no setter/data barrier.
          delete Object.prototype.value;
          const receiver: any = new ObjectPrototypeStruct();
          receiver["sideBag"] = 1;
          const deleted = delete receiver.value;
          let threw = 0;
          try {
            receiver["value"] = 31;
          } catch (error) {
            threw = 1;
          }
          let score = 0;
          if (deleted === true) score = score | 1;
          if (threw === 0) score = score | 2;
          if (receiver.value === 31) score = score | 4;
          if (receiver.sideBag === 1) score = score | 8;
          if (Object.prototype.hasOwnProperty.call(receiver, "value")) score = score | 16;
          return score;
        }
      `,
      {
        fileName: "issue-4504-closed-struct-own-precedence.ts",
        target: "standalone",
      },
    );
    expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\\n")).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as {
      reflectDeclaredField(): number;
      strictDeclaredField(): number;
      physicalFieldBeatsInheritedSetter(): number;
      physicalFieldBeatsInheritedNonWritableData(): number;
      physicalFieldBeatsObjectPrototypeSetter(): number;
      physicalFieldBeatsObjectPrototypeNonWritableData(): number;
      deletedPhysicalFieldDelegatesToObjectPrototypeSetter(): number;
      resurrectsDeletedPhysicalFieldWithoutInheritedDescriptor(): number;
    };
    expect(exports.reflectDeclaredField()).toBe(15);
    expect(exports.strictDeclaredField()).toBe(15);
    expect(exports.physicalFieldBeatsInheritedSetter()).toBe(63);
    expect(exports.physicalFieldBeatsInheritedNonWritableData()).toBe(31);
    expect(exports.physicalFieldBeatsObjectPrototypeSetter()).toBe(63);
    expect(exports.physicalFieldBeatsObjectPrototypeNonWritableData()).toBe(31);
    expect(exports.deletedPhysicalFieldDelegatesToObjectPrototypeSetter()).toBe(47);
    expect(exports.resurrectsDeletedPhysicalFieldWithoutInheritedDescriptor()).toBe(31);
  });

  it("recognizes a stored Object.defineProperty alias before inherited [[Set]]", async () => {
    const exports = await compileStandaloneNoImports<{ run(): number }>(
      "issue-4504-stored-define-property-alias.ts",
      `
const dp = Object.defineProperty;

export function run(): number {
  const proto: any = {};
  dp(proto, "x", { value: 1 });
  const receiver: any = Object.create(proto);
  const reflected = Reflect.set(receiver, "x", 2);
  let score = 0;
  if (reflected === false) score = score | 1;
  if (!Object.prototype.hasOwnProperty.call(receiver, "x")) score = score | 2;
  if (receiver.x === 1) score = score | 4;
  return score;
}
`,
    );
    expect(exports.run()).toBe(7);
  });

  it("keeps descriptor-dirty Vec numeric and length writes on their physical success paths", async () => {
    const exports = await compileStandaloneNoImports<{
      numericIndex(): number;
      lengthWrite(): number;
    }>(
      "issue-4504-descriptor-dirty-vec-results.ts",
      `
export function numericIndex(): number {
  const marker: any = {};
  Object.defineProperty(marker, "x", { value: 1 });
  const array: any = [1, 2];
  const reflected = Reflect.set(array, "0", 9);
  return (reflected === true ? 1 : 0) | (array[0] === 9 ? 2 : 0);
}

export function lengthWrite(): number {
  const marker: any = {};
  Object.defineProperty(marker, "x", { value: 1 });
  const array: any = [1, 2];
  const reflected = Reflect.set(array, "length", 1);
  return (reflected === true ? 1 : 0) | (array.length === 1 ? 2 : 0);
}
`,
    );
    expect(exports.numericIndex()).toBe(3);
    expect(exports.lengthWrite()).toBe(3);
  });

  it("treats a sparse Vec hole as absent while retaining dense own-index writes", async () => {
    const exports = await compileStandaloneNoImports<{
      sparseHole(): number;
      denseIndex(): number;
    }>(
      "issue-4504-vec-hole-presence.ts",
      `
var calls = 0;
Object.defineProperty(Array.prototype, "1", {
  set: function(value: any): void { calls = calls + 1; },
  configurable: true
});
var sparse: any = [0, , 2];
var dense: any = [0, 1, 2];

export function sparseHole(): number {
  calls = 0;
  var reflected = Reflect.set(sparse, "1", 7);
  return (reflected === true ? 1 : 0) |
    (calls === 1 ? 2 : 0) |
    (!Object.prototype.hasOwnProperty.call(sparse, "1") ? 4 : 0);
}

export function denseIndex(): number {
  calls = 0;
  var reflected = Reflect.set(dense, "1", 7);
  return (reflected === true ? 1 : 0) |
    (calls === 0 ? 2 : 0) |
    (dense[1] === 7 ? 4 : 0) |
    (Object.prototype.hasOwnProperty.call(dense, "1") ? 8 : 0);
}
`,
    );
    expect(exports.sparseHole()).toBe(7);
    expect(exports.denseIndex()).toBe(15);
  });

  it("forwards Proxy trap success and refusal through Reflect and strict assignment", async () => {
    const exports = await compileStandaloneNoImports<{
      acceptedTrap(): number;
      refusedTrap(): number;
    }>(
      "issue-4504-proxy-set-result-channel.ts",
      `
let acceptedCalls: number = 0;
let refusedCalls: number = 0;
const accepted: any = new Proxy({}, {
  set: function(target: any, key: any, value: any, receiver: any): boolean {
    acceptedCalls = acceptedCalls + 1;
    return true;
  }
});
const refused: any = new Proxy({}, {
  set: function(target: any, key: any, value: any, receiver: any): boolean {
    refusedCalls = refusedCalls + 1;
    return false;
  }
});
Object.defineProperty({}, "dirty", { value: 1 });

export function acceptedTrap(): number {
  acceptedCalls = 0;
  const reflected = Reflect.set(accepted, "x", 7);
  return (reflected === true ? 1 : 0) | (acceptedCalls === 1 ? 2 : 0);
}

export function refusedTrap(): number {
  refusedCalls = 0;
  const reflected = Reflect.set(refused, "x", 7);
  let threw = 0;
  try {
    refused["x"] = 8;
  } catch (error) {
    threw = 1;
  }
  return (reflected === false ? 1 : 0) |
    (threw === 1 ? 2 : 0) |
    (refusedCalls === 2 ? 4 : 0) |
    (!Object.prototype.hasOwnProperty.call(refused, "x") ? 8 : 0);
}
`,
    );
    expect(exports.acceptedTrap()).toBe(3);
    expect(exports.refusedTrap()).toBe(15);
  });

  it("does not leak a refused Reflect result into a later strict typed-array write", async () => {
    const exports = await compileStandaloneNoImports<{ run(): number }>(
      "issue-4504-stale-refusal-result-typed-array.ts",
      `
const TA: any = Uint8Array;
const buffer: ArrayBuffer = new ArrayBuffer(4);
const view: any = new TA(buffer);
const blocked: any = {};
Object.defineProperty(blocked, "x", {
  get: function(): number { return 1; },
  configurable: true
});

function strictWrite(receiver: any): number {
  "use strict";
  try {
    receiver["0"] = 9;
    return 0;
  } catch (error) {
    return 1;
  }
}

export function run(): number {
  const refused = Reflect.set(blocked, "x", 2);
  const threw = strictWrite(view);
  return (refused === false ? 1 : 0) |
    (threw === 0 ? 2 : 0) |
    (view[0] === 9 ? 4 : 0);
}
`,
    );
    expect(exports.run()).toBe(7);
  });

  // Direct typed-array OOB Reflect=true is an established pre-#4504 behavior.
  // The gate here is the trap-absent Proxy forwarding its target's UNADMITTED
  // result and keeping both strict assignment paths lenient.
  it("forwards trap-absent typed-array OOB state without turning it into a refusal throw", async () => {
    const exports = await compileStandaloneNoImports<{ run(): number }>(
      "issue-4504-proxy-typed-array-oob-forwarding.ts",
      `
Object.defineProperty({}, "dirty", { value: 1 });
const TA: any = Uint8Array;
const direct: any = new TA(new ArrayBuffer(2));
const proxied: any = new Proxy(new TA(new ArrayBuffer(2)), {});

function strictWrite(receiver: any): number {
  "use strict";
  try {
    receiver["9"] = 9;
    return 0;
  } catch (error) {
    return 1;
  }
}

export function run(): number {
  const directReflect = Reflect.set(direct, "9", 8);
  const directThrow = strictWrite(direct);
  const proxyReflect = Reflect.set(proxied, "9", 8);
  const proxyThrow = strictWrite(proxied);
  return (directReflect === false ? 1 : 0) |
    (directThrow === 0 ? 2 : 0) |
    (proxyReflect === false ? 4 : 0) |
    (proxyThrow === 0 ? 8 : 0);
}
`,
    );
    expect(exports.run()).toBe(14);
  });

  for (const carrier of [
    { label: "Array", prototype: "Array.prototype", receiver: "[]" },
    { label: "Function", prototype: "Function.prototype", receiver: "function(): void {}" },
  ] as const) {
    it(`${carrier.label} getter-only descriptors share Reflect refusal with strict assignment`, async () => {
      const exports = await compileStandaloneNoImports<{ run(): number }>(
        `issue-4504-${carrier.label.toLowerCase()}-named-getter-only-result.ts`,
        `
Object.defineProperty(${carrier.prototype}, "blocked", {
  get: function(): number { return 1; },
  configurable: true
});
const receiver: any = ${carrier.receiver};

export function run(): number {
  let threw = 0;
  try {
    receiver["blocked"] = 7;
  } catch (error) {
    threw = 1;
  }
  const reflected = Reflect.set(receiver, "blocked", 8);
  return (threw === 1 ? 1 : 0) |
    (reflected === false ? 2 : 0) |
    (!Object.prototype.hasOwnProperty.call(receiver, "blocked") ? 4 : 0);
}
`,
      );
      expect(exports.run()).toBe(7);
    });
  }

  it("keeps a fnctor absent flow-slot refusal sloppy while its strict twin throws", async () => {
    await runScriptGoal(
      "4504/fnctor-flow-slot/sloppy-and-inner-strict-refusal",
      ["noStrict"],
      `
function FlowCtor() {}
Object.defineProperty(FlowCtor.prototype, "blocked", {
  value: 1,
  writable: false,
  configurable: true
});

var sloppy = new FlowCtor();
var sloppyThrew = 0;
try {
  sloppy.blocked = 2;
} catch (error) {
  sloppyThrew = 1;
}

var strict = new FlowCtor();
var strictThrew = 0;
(function() {
  "use strict";
  try {
    strict.blocked = 3;
  } catch (error) {
    strictThrew = error instanceof TypeError ? 1 : 2;
  }
})();

var score = 0;
if (sloppyThrew === 0) score = score | 1;
if (strictThrew === 1) score = score | 2;
if (!Object.prototype.hasOwnProperty.call(sloppy, "blocked")) score = score | 4;
if (!Object.prototype.hasOwnProperty.call(strict, "blocked")) score = score | 8;
if (sloppy.blocked === 1 && strict.blocked === 1) score = score | 16;
assert.sameValue(score, 31);
`,
    );
  });

  it("reads present fnctor flow slots directly while absent slots preserve normal prototype lookup", async () => {
    const exports = await compileStandaloneNoImports<{ run(): number }>(
      "issue-4504-fnctor-flow-slot-read-presence.ts",
      `
function FlowCtor() {}

export function run() {
  var present = new FlowCtor();
  present.flowSlot = "present";
  var freshBefore = new FlowCtor();
  var before = freshBefore.flowSlot;
  Object.defineProperty(FlowCtor.prototype, "flowSlot", {
    value: "inherited",
    writable: false,
    configurable: true
  });
  var freshAfter = new FlowCtor();
  var after = freshAfter.flowSlot;
  return (present.flowSlot === "present" ? 1 : 0) |
    (before === undefined ? 2 : 0) |
    (after === "inherited" ? 4 : 0);
}
`,
    );
    expect(exports.run()).toBe(7);
  });

  it("keeps an experimental-IR dynamic writer on the symbolic runtime path", async () => {
    // #3795's opt-in is required because a public any-parameter function is
    // otherwise intentionally outside normal IR selection. It changes ONLY
    // selection for this known dynamic-member-set shape; the assertions below
    // still require an emitted IR body plus the real standalone runtime result.
    const previousForce = process.env.JS2WASM_FORCE_DYN_MEMBER_SET;
    process.env.JS2WASM_FORCE_DYN_MEMBER_SET = "1";
    let result: Awaited<ReturnType<typeof compile>>;
    try {
      result = await compile(
        `
        let calls: number = 0;
        let seenReceiver: any = null;
        let seenValue: any = null;

        // This is deliberately the sole IR-selected unit. Its receiver and
        // key are dynamic carriers; the canonical literal value is boxed by
        // the producer before dyn.member_set reaches the shared runtime.
        function writer(receiver: any, key: any): void {
          receiver[key] = "true";
        }

        // Keep setup, allocation, and observation in one legacy function so
        // the public Wasm ABI is number-only. That makes this a runtime-path
        // test rather than an externref round-trip test.
        export function run(): number {
          Object.defineProperty(Array.prototype, "irSet", {
            get: function(): any { return seenValue; },
            set: function(value: any): void {
              calls = calls + 1;
              seenReceiver = this;
              seenValue = value;
            },
            configurable: true
          });
          const receiver: any = [];
          // Keep the caller on its legacy setup/scoring path without making a
          // static call-graph edge that would demote the dynamic IR leaf. The
          // callable still resolves to writer entirely inside this module.
          const invoke: any = writer;
          invoke(receiver, "irSet");
          let score = 0;
          if (calls === 1) score = score | 1;
          if (seenReceiver === receiver) score = score | 2;
          if (seenValue === "true") score = score | 4;
          if (!Object.prototype.hasOwnProperty.call(receiver, "irSet")) score = score | 8;
          if (receiver["irSet"] === "true") score = score | 16;
          return score;
        }
      `,
        {
          fileName: "issue-4504-ir-symbolic-writer.ts",
          target: "standalone",
          experimentalIR: true,
          trackIrOutcomes: true,
          skipSemanticDiagnostics: true,
        },
      );
    } finally {
      if (previousForce === undefined) Reflect.deleteProperty(process.env, "JS2WASM_FORCE_DYN_MEMBER_SET");
      else process.env.JS2WASM_FORCE_DYN_MEMBER_SET = previousForce;
    }
    expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\\n")).toBe(true);
    // The setup/scoring helpers intentionally stay on the legacy path. The
    // dynamic writer is the sole unit claimed by IR, so this pins actual IR
    // ownership without coupling the test to hybrid export ABI bookkeeping.
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toEqual(["writer"]);
    expect(
      result.irOutcomes?.find((outcome) => outcome.unitKind === "function" && outcome.displayName === "writer"),
    ).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as {
      run(): number;
    };
    expect(exports.run()).toBe(31);
  });
});

describe.skipIf(!HAS_TEST262)("#4504 — exact standalone Test262 acceptance rows", () => {
  it("keeps the nine-row acceptance denominator separate from the two excluded diagnostics", () => {
    expect(TARGET_ROWS).toHaveLength(9);
    expect(new Set(TARGET_ROWS.map((row) => row.id)).size).toBe(9);
    expect(TARGET_ROWS.map((row) => row.id)).toEqual([
      "15.2.3.6-4-410",
      "15.2.3.6-4-415",
      "15.2.3.6-4-579",
      "15.2.3.6-4-581",
      "15.2.3.6-4-584",
      "15.2.3.6-4-586",
      "15.2.3.6-4-594",
      "15.2.3.6-4-596",
      "8.14.4-8-b_1",
    ]);
    expect(EXCLUDED_DIAGNOSTICS.map((row) => row.id)).toEqual(["15.2.3.6-4-408", "15.2.3.6-4-589"]);
    expect(new Set([...TARGET_ROWS, ...EXCLUDED_DIAGNOSTICS].map((row) => row.id)).size).toBe(11);
  });

  for (const row of TARGET_ROWS) {
    it(`${row.id} — ${row.shape} passes every authentic standalone script variant`, async () => {
      const results = await runOriginalStandaloneRow(row);
      for (const result of results) {
        expect(result.status, `${row.id}: ${result.error ?? "no worker detail"}`).toBe("pass");
      }
    }, 90_000);
  }

  for (const row of EXCLUDED_DIAGNOSTICS) {
    it(`${row.id} — ${row.shape} remains a non-gating expected-red diagnostic`, async () => {
      const results = await runOriginalStandaloneRow(row);
      // Execute the exact same harness variants so a broken test path cannot
      // masquerade as a diagnostic. Outcome is deliberately not asserted:
      // these are separate defects today, and either can legitimately become
      // green under its own follow-up without reopening #4504.
      expect(results).toHaveLength(row.variants);
      expect(results.every((result) => result.status !== "skip")).toBe(true);
    }, 90_000);
  }
});
