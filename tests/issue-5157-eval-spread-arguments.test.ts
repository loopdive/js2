// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5157 — eval needs ArgumentListEvaluation, not one AST argument per source
 * node. These are standalone runtime checks because the result has to cross
 * the linked eval provider after the native caller has expanded its spreads.
 */
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const OPTIONS = {
  allowJs: true,
  fileName: "issue-5157-eval-spread-arguments.ts",
  skipSemanticDiagnostics: true,
  target: "standalone",
} as const;

// The upstream eval-spread rows are Script records with top-level `var`s, not
// exported test functions. Keep the dedicated controls in that shape so their
// counters populate the same global-binding sync set as the conformance rows.
const SCRIPT_OPTIONS = {
  allowJs: true,
  deferTopLevelInit: true,
  fileName: "issue-5157-eval-spread-arguments-script.js",
  inferModuleStrictArguments: false,
  scriptGoal: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
} as const;

async function run(body: string, prefix = ""): Promise<number> {
  const result = await compile(`${prefix}\nexport function test(): number {\n${body}\n}`, OPTIONS);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "compiled module failed validation").toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    {
      target: "standalone",
      providerLabel: "issue-5157",
    },
  );
  return (instance.exports as { test(): number }).test();
}

/**
 * Compile and execute a literal Script record after the runtime-eval provider
 * is attached. The required deferred initializer makes a completed call a
 * non-vacuous top-level assertion, just like the maintained Test262 path.
 */
async function runRuntimeEvalScript(body: string): Promise<void> {
  const result = await compile(body, SCRIPT_OPTIONS);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "compiled Script failed validation").toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    {
      target: "standalone",
      providerLabel: "issue-5157-script",
    },
  );
  const moduleInit = (instance.exports as { __module_init?: () => void }).__module_init;
  expect(typeof moduleInit, "deferred Script initializer must be exported").toBe("function");
  moduleInit!();
}

/**
 * Evaluate the same focused control in a fresh Node realm. The global-Script
 * spelling is compiler-specific; its oracle adapter performs indirect eval in
 * that realm and deliberately forwards the full variadic argument list.
 * Isolating every control also keeps an Array iterator override out of Vitest's
 * own realm.
 */
function oracle(body: string, globalScript = false): number {
  const sandbox = Object.create(null) as Record<string, unknown>;
  const context = createContext(sandbox);
  if (globalScript) {
    runInContext(
      "globalThis.__js2wasm_global_script_eval = function (...args) { return (0, eval)(...args); };",
      context,
    );
  }
  return runInContext(`(() => {${body}\n})()`, context) as number;
}

const DIRECT_SNAPSHOT_BODY = `
  let x = 0;
  const args = ["x = 1"];
  eval(...args, (args[0] = "x = 2"));
  return x;
`;

const DIRECT_BOUND_LEXICAL_BODY = `
  let lexical = 0;
  const source = ['lexical = 7'];
  eval(...source);
  return lexical;
`;

const DIRECT_LITERAL_LEXICAL_BODY = `
  let lexical = 0;
  eval(...['lexical = 7']);
  return lexical;
`;

const DIRECT_BOUND_NONSTRING_BODY = `
  const marker = { marker: 1 };
  const source = [marker];
  const identity = eval(...source, "unreachable = 1");
  return identity === marker ? 1 : 0;
`;

const DIRECT_LITERAL_NONSTRING_BODY = `
  const marker = { marker: 1 };
  const identity = eval(...[marker], "unreachable = 1");
  return identity === marker ? 1 : 0;
`;

const DIRECT_EMPTY_BODY = `
  let nextCount = 0;
  const empty = {
    [Symbol.iterator]() {
      return { next() { nextCount += 1; return { done: true }; } };
    },
  };
  return eval(...empty) === undefined && nextCount === 1 ? 1 : 0;
`;

// This is the original eval-spread.js mechanism expressed as Script assertions
// rather than harness calls. In particular, nextCount stays a top-level `var`
// captured by a dynamically assigned iterator callback.
const SCRIPT_GLOBAL_COUNTER_BODY = `
  var elements = ["x = 1;", "x = 2;"];
  var nextCount = 0;
  var iter = {};
  iter[Symbol.iterator] = function () {
    return {
      next: function () {
        var i = nextCount++;
        if (i < elements.length) return { done: false, value: elements[i] };
        return { done: true, value: undefined };
      },
    };
  };
  var x = "global";
  (function () {
    var x = "local";
    eval(...iter);
    if (x !== 1) throw "local direct eval";
  })();
  if (x !== "global") throw "global direct eval";
  if (nextCount !== 3) throw "spread iterator count";
`;

// No spread here: ordinary trailing arguments also complete before PerformEval
// and can mutate a Script-global that the provider must snapshot afterward.
// Keep this nonempty tuple element form executable: its current opaque failure
// is a diagnostic, not evidence that the alternate source shape below is safe.
const SCRIPT_ORDINARY_TRAILING_ARRAY_BODY = `
  var nextCount = 0;
  var observed = -1;
  var source = ["observed = nextCount;"][0];
  eval(source, (nextCount = 7));
  if (nextCount !== 7 || observed !== 7) throw "ordinary trailing array argument";
`;

// This alternate leaves the source dynamically produced without routing it
// through the known nonempty-tuple representation gap.
const SCRIPT_ORDINARY_TRAILING_BODY = `
  var nextCount = 0;
  var observed = -1;
  function sourceOf(value) {
    return value;
  }
  var source = sourceOf("observed = nextCount;");
  eval(source, (nextCount = 7));
  if (nextCount !== 7 || observed !== 7) throw "ordinary trailing argument";
`;

// Top-level direct eval is intentionally routed through the global Script
// provider. Keep a separate function-scoped control for the direct-runtime
// provider path, with the same trailing-argument write and dynamic source.
const SCRIPT_FUNCTION_SCOPED_ORDINARY_TRAILING_BODY = `
  var nextCount = 0;
  var observed = -1;
  (function () {
    function sourceOf(value) {
      return value;
    }
    var source = sourceOf("observed = nextCount;");
    eval(source, (nextCount = 7));
  })();
  if (nextCount !== 7 || observed !== 7) throw "function-scoped ordinary trailing argument";
`;

// The expanded source runs a nested direct eval inside the provider. Its read
// must observe the iterator increment, and the nested write must survive the
// outer provider return/pull sequence.
const SCRIPT_NESTED_BODY = `
  var nextCount = 0;
  var source = ["eval('nextCount = nextCount + 10;');"][0];
  var iter = {};
  iter[Symbol.iterator] = function () {
    var emitted = false;
    return {
      next: function () {
        if (!emitted) {
          emitted = true;
          nextCount += 1;
          return { done: false, value: source };
        }
        return { done: true, value: undefined };
      },
    };
  };
  eval(...iter);
  if (nextCount !== 11) throw "nested direct eval";
`;

// ArgumentListEvaluation propagates a spread abrupt completion and must not
// evaluate the following ordinary argument or enter PerformEval.
const SCRIPT_ABRUPT_BODY = `
  var sentinel = {};
  var caught = false;
  var afterAbrupt = 0;
  var abrupt = {};
  abrupt[Symbol.iterator] = function () {
    throw sentinel;
  };
  try {
    eval(...abrupt, (afterAbrupt = 1));
  } catch (error) {
    caught = error === sentinel;
  }
  if (!caught || afterAbrupt !== 0) throw "spread abrupt completion";
`;

const GLOBAL_BODY = `
  let score = 0;

  const indirectArgs = ["41"];
  const indirect = (0, eval)(...indirectArgs, (indirectArgs[0] = "42"));
  if (indirect === 41) score += 1;

  const scriptArgs = ["7"];
  const script = __js2wasm_global_script_eval(...scriptArgs, (scriptArgs[0] = "8"));
  if (script === 7) score += 2;

  return score;
`;

const GLOBAL_PREFIX = "declare function __js2wasm_global_script_eval(...args: any[]): any;";

/**
 * Persistent reproduction of the original mixed VM/Wasm discrepancy. It is
 * intentionally executable: raw Node currently returns 7 and Wasm 23, while
 * the spec-correct adapted realm oracle below returns 15. The separate
 * controls identify the eval-owned and generic portions.
 */
const ORIGINAL_GROUPED_PROTOCOL_PROBE_BODY = `
  let score = 0;

  let valueReads = 0;
  const doneWithoutValue = {
    [Symbol.iterator]() {
      return {
        next() {
          return {
            done: true,
            get value() {
              valueReads += 1;
              throw new Error("done value read");
            },
          };
        },
      };
    },
  };
  if (eval(...doneWithoutValue) === undefined && valueReads === 0) score += 1;

  const sentinel = { sentinel: true };
  let caughtSentinel = false;
  let afterAbrupt = 0;
  const abrupt = {
    [Symbol.iterator]() {
      throw sentinel;
    },
  };
  try {
    eval(...abrupt, (afterAbrupt = 1));
  } catch (error) {
    caughtSentinel = error === sentinel;
  }
  if (caughtSentinel && afterAbrupt === 0) score += 2;

  let caughtNonIterable = false;
  let afterNonIterable = 0;
  const nonIterable = {};
  try {
    eval(...nonIterable, (afterNonIterable = 1));
  } catch (error) {
    caughtNonIterable = error instanceof TypeError;
  }
  if (caughtNonIterable && afterNonIterable === 0) score += 4;

  const array = [0];
  Array.prototype[Symbol.iterator] = function () {
    let step = 0;
    return {
      next() {
        if (step++ === 0) return { done: false, value: "overridden = 1" };
        return { done: true };
      },
    };
  };
  let overridden = 0;
  eval(...array);
  if (overridden === 1) score += 8;

  const nonIntrinsic = { eval(value) { return value; } };
  if (nonIntrinsic.eval(...["ordinary call"]) === "ordinary call") score += 16;

  return score;
`;

const STRICT_ARRAY_OVERRIDE_BODY = `
  const array = [0];
  Array.prototype[Symbol.iterator] = function () {
    let step = 0;
    return {
      next() {
        if (step++ === 0) return { done: false, value: "overridden = 1" };
        return { done: true };
      },
    };
  };
  let overridden = 0;
  eval(...array);
  return overridden;
`;

/**
 * Node does not implement direct eval with a spread as ArgumentListEvaluation.
 * Expand the list explicitly, then make an ordinary direct eval in the same
 * lexical scope, to give the Array-override case a realm-isolated oracle.
 */
const STRICT_ARRAY_OVERRIDE_ORACLE_BODY = `
  const array = [0];
  Array.prototype[Symbol.iterator] = function () {
    let step = 0;
    return {
      next() {
        if (step++ === 0) return { done: false, value: "overridden = 1" };
        return { done: true };
      },
    };
  };
  let overridden = 0;
  const expanded = [...array];
  eval(expanded[0]);
  return overridden;
`;

/**
 * The raw Node spelling above does not perform direct-eval
 * ArgumentListEvaluation. This preserves its observed 7 as a diagnostic while
 * adapting only that direct-eval call to the required expanded first value.
 * The later ordinary method call deliberately retains its real spread, so it
 * observes the overridden iterator and does not score the final 16-point bit.
 */
const ORIGINAL_GROUPED_PROTOCOL_ADAPTED_ORACLE_BODY = `
  let score = 0;

  let valueReads = 0;
  const doneWithoutValue = {
    [Symbol.iterator]() {
      return {
        next() {
          return {
            done: true,
            get value() {
              valueReads += 1;
              throw new Error("done value read");
            },
          };
        },
      };
    },
  };
  if (eval(...doneWithoutValue) === undefined && valueReads === 0) score += 1;

  const sentinel = { sentinel: true };
  let caughtSentinel = false;
  let afterAbrupt = 0;
  const abrupt = {
    [Symbol.iterator]() {
      throw sentinel;
    },
  };
  try {
    eval(...abrupt, (afterAbrupt = 1));
  } catch (error) {
    caughtSentinel = error === sentinel;
  }
  if (caughtSentinel && afterAbrupt === 0) score += 2;

  let caughtNonIterable = false;
  let afterNonIterable = 0;
  const nonIterable = {};
  try {
    eval(...nonIterable, (afterNonIterable = 1));
  } catch (error) {
    caughtNonIterable = error instanceof TypeError;
  }
  if (caughtNonIterable && afterNonIterable === 0) score += 4;

  const array = [0];
  Array.prototype[Symbol.iterator] = function () {
    let step = 0;
    return {
      next() {
        if (step++ === 0) return { done: false, value: "overridden = 1" };
        return { done: true };
      },
    };
  };
  let overridden = 0;
  const expandedOverrideArgs = [...array];
  eval(expandedOverrideArgs[0]);
  if (overridden === 1) score += 8;

  const nonIntrinsic = { eval(value) { return value; } };
  if (nonIntrinsic.eval(...["ordinary call"]) === "ordinary call") score += 16;

  return score;
`;

describe("#5157 — eval spread ArgumentListEvaluation", () => {
  // V8 currently treats a direct-eval call with a spread differently from
  // ArgumentListEvaluation, so direct controls use the specified outcomes.
  // The maintained QuickJS/Test262 runner remains the engine-level oracle.
  it("snapshots direct values before later arguments mutate their source", async () => {
    expect(await run(DIRECT_SNAPSHOT_BODY)).toBe(1);
  }, 180_000);

  it("keeps direct eval lexical for a bound spread source", async () => {
    expect(await run(DIRECT_BOUND_LEXICAL_BODY)).toBe(7);
  }, 180_000);

  it("returns a bound non-string first expanded value unchanged", async () => {
    expect(await run(DIRECT_BOUND_NONSTRING_BODY)).toBe(1);
  }, 180_000);

  it("keeps direct eval lexical for an inline literal spread", async () => {
    expect(await run(DIRECT_LITERAL_LEXICAL_BODY)).toBe(7);
  }, 180_000);

  it("returns an inline literal non-string first expanded value unchanged", async () => {
    expect(await run(DIRECT_LITERAL_NONSTRING_BODY)).toBe(1);
  }, 180_000);

  it("drains an empty direct-eval spread exactly once", async () => {
    expect(await run(DIRECT_EMPTY_BODY)).toBe(1);
  }, 180_000);

  it("keeps Test262-style Script globals live through direct spread expansion", async () => {
    await runRuntimeEvalScript(SCRIPT_GLOBAL_COUNTER_BODY);
  }, 180_000);

  it("retains the nonempty-tuple ordinary-source diagnostic", async () => {
    await runRuntimeEvalScript(SCRIPT_ORDINARY_TRAILING_ARRAY_BODY);
  }, 180_000);

  it("publishes Script-global writes from ordinary trailing arguments before direct eval", async () => {
    await runRuntimeEvalScript(SCRIPT_ORDINARY_TRAILING_BODY);
  }, 180_000);

  it("publishes ordinary trailing writes before function-scoped direct eval", async () => {
    await runRuntimeEvalScript(SCRIPT_FUNCTION_SCOPED_ORDINARY_TRAILING_BODY);
  }, 180_000);

  it("keeps nested direct eval synchronized after a Script-global iterator write", async () => {
    await runRuntimeEvalScript(SCRIPT_NESTED_BODY);
  }, 180_000);

  it("preserves abrupt spread ordering in a Script-global direct eval", async () => {
    await runRuntimeEvalScript(SCRIPT_ABRUPT_BODY);
  }, 180_000);

  it("uses the expanded first value on indirect eval and global Script routes", async () => {
    const actual = await run(GLOBAL_BODY, GLOBAL_PREFIX);
    expect(actual).toBe(oracle(GLOBAL_BODY, true));
    expect(actual).toBe(3);
  }, 180_000);

  it("honors Array.prototype iterator override before direct eval", async () => {
    const actual = await run(STRICT_ARRAY_OVERRIDE_BODY);
    expect(actual).toBe(oracle(STRICT_ARRAY_OVERRIDE_ORACLE_BODY));
    expect(actual).toBe(1);
  }, 180_000);

  it("preserves the original grouped strict-protocol discrepancy for diagnosis", async () => {
    const actual = await run(ORIGINAL_GROUPED_PROTOCOL_PROBE_BODY);
    const expected = oracle(ORIGINAL_GROUPED_PROTOCOL_ADAPTED_ORACLE_BODY);
    expect(expected).toBe(15);
    expect(actual).toBe(expected);
  }, 180_000);
});
