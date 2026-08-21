// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";
import {
  STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT,
  STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT,
  STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT,
  STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC,
  STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE,
  STANDALONE_TIMER_CALLBACK_MARKER_EXPORT,
  STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE,
} from "../src/timer-capability-contract.js";

const EXACT_DELAY = `
export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}
`;

const NEAR_MISS_DELAY = `
export function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => setTimeout(() => resolve(value), ms));
}
`;

const START_TIME_REACTION = `
let observed = 0;
${EXACT_DELAY}
delay(1, 73).then((value: number) => { observed = value; });
export function readObserved(): number { return observed; }
`;

function timerCollisionSource(): string {
  const collisionNames = [
    STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT,
    STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE,
    STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT,
    STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE,
    STANDALONE_TIMER_CALLBACK_MARKER_EXPORT,
    STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE,
    STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT,
    STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE,
  ];
  const exportNameLiteral = (name: string): string => JSON.stringify(name).replace("\\u0000", "\0");
  return `
function collision(): number { return 99; }
${collisionNames.map((name) => `export { collision as ${exportNameLiteral(name)} };`).join("\n")}
${EXACT_DELAY}
`;
}

interface ScheduledTimer {
  readonly callback: () => void;
  readonly delay: number;
  readonly sequence: number;
}

interface ConcurrentTrace {
  readonly scheduledDelays: readonly number[];
  readonly beforeStates: readonly [number, number];
  readonly afterFastStates: readonly [number, number];
  readonly afterFastValues: readonly [unknown, unknown];
  readonly afterFastRepeatStates: readonly [number, number];
  readonly afterFastRepeatValues: readonly [unknown, unknown];
  readonly afterSlowStates: readonly [number, number];
  readonly afterSlowValues: readonly [unknown, unknown];
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

function terminalOutcome(result: CompileResult, displayName: string): IrObservedOutcome {
  const matches = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === displayName,
  );
  expect(matches, `terminal outcome count for function:${displayName}`).toHaveLength(1);
  return matches[0]!;
}

function actualImportNames(result: CompileResult): readonly string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
    (entry) => `${entry.module}.${entry.name}`,
  );
}

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watFunction(result: CompileResult, name: string): WatFunction {
  const matches = parseWatFunctions(result.wat).filter((candidate) => candidate.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

function watCallTargets(result: CompileResult, body: string): readonly string[] {
  const imports = [...result.wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...result.wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_call|call) (\d+)/g)].map((match) => names[Number(match[1])] ?? "<missing>");
}

async function compileDelay(
  source: string,
  experimentalIR: boolean,
  fileName = "issue-4573-standalone-native-promise-delay.ts",
  hostBridge?: "always" | "off",
): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: "standalone",
    ...(hostBridge ? { hostBridge } : {}),
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    emitWat: true,
  });
}

function importsWithCapturedSetTimeout(result: CompileResult, capturedSetTimeout: typeof setTimeout) {
  return buildCompiledImports(result, { setTimeout: capturedSetTimeout });
}

async function runConcurrent(result: CompileResult): Promise<ConcurrentTrace> {
  const scheduled: ScheduledTimer[] = [];
  let sequence = 0;
  const capturedSetTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    scheduled.push({
      callback: () => callback(...args),
      delay: Number(delay ?? 0),
      sequence: sequence++,
    });
    return sequence as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const imports = importsWithCapturedSetTimeout(result, capturedSetTimeout);

  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as unknown as Record<string, Function>;
  imports.setInstance?.(instance);
  const delay = exports.delay as (ms: number, value: number) => unknown;
  const readState = exports.__promise_boundary_state as (promise: unknown) => number;
  const readValue = exports.__promise_boundary_value as (promise: unknown) => unknown;
  const drain = exports.__drain_microtasks as (() => void) | undefined;
  expect(delay).toBeTypeOf("function");
  expect(readState).toBeTypeOf("function");
  expect(readValue).toBeTypeOf("function");
  expect(drain).toBeTypeOf("function");

  const slow = delay(25, 111);
  const fast = delay(1, 222);
  const beforeStates = [readState(fast), readState(slow)] as const;
  const inDeadlineOrder = [...scheduled].sort((a, b) => a.delay - b.delay || a.sequence - b.sequence);
  expect(inDeadlineOrder).toHaveLength(2);
  inDeadlineOrder[0]!.callback();
  const afterFastStates = [readState(fast), readState(slow)] as const;
  const afterFastValues = [readValue(fast), readValue(slow)] as const;
  inDeadlineOrder[0]!.callback();
  const afterFastRepeatStates = [readState(fast), readState(slow)] as const;
  const afterFastRepeatValues = [readValue(fast), readValue(slow)] as const;
  inDeadlineOrder[1]!.callback();
  const afterSlowStates = [readState(fast), readState(slow)] as const;
  const afterSlowValues = [readValue(fast), readValue(slow)] as const;

  return {
    scheduledDelays: scheduled.map((timer) => timer.delay),
    beforeStates,
    afterFastStates,
    afterFastValues,
    afterFastRepeatStates,
    afterFastRepeatValues,
    afterSlowStates,
    afterSlowValues,
  };
}

async function runRejectedRegistration(result: CompileResult): Promise<{ state: number; reason: unknown }> {
  const throwingSetTimeout = (() => {
    throw new Error("injected timer registration failure");
  }) as typeof setTimeout;
  const imports = importsWithCapturedSetTimeout(result, throwingSetTimeout);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as unknown as Record<string, Function>;
  imports.setInstance?.(instance);
  const delay = exports.delay as (ms: number, value: number) => unknown;
  const readState = exports.__promise_boundary_state as (promise: unknown) => number;
  const readValue = exports.__promise_boundary_value as (promise: unknown) => unknown;
  expect(delay).toBeTypeOf("function");
  expect(readState).toBeTypeOf("function");
  expect(readValue).toBeTypeOf("function");
  let promise: unknown;
  expect(() => {
    promise = delay(1, 7);
  }).not.toThrow();
  return { state: readState(promise), reason: readValue(promise) };
}

describe("#4573 standalone native Promise-delay compile-once ownership", () => {
  it("IR-emits the exact owner through one native provider and retires its direct body", async () => {
    const [ir, direct] = await Promise.all([compileDelay(EXACT_DELAY, true), compileDelay(EXACT_DELAY, false)]);
    expectSuccess(ir);
    expectSuccess(direct);

    expect(terminalOutcome(ir, "delay")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(ir.irCompiledFuncs ?? []).toContain("delay");
    expect(actualImportNames(ir)).toEqual(["env.__timer_set_timeout"]);
    expect(ir.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual(["env.__timer_set_timeout"]);
    expect(ir.capabilityProviderDiagnostics).toEqual([]);
    expect(ir.capabilityRequirements).toEqual([
      expect.objectContaining({
        id: "timers",
        abiNamespace: "js2wasm:capability/timers",
        abiVersion: 1,
        selectedProviders: ["embedder"],
        compatibleProviders: ["js-host", "embedder"],
        imports: [
          expect.objectContaining({
            module: "env",
            name: "__timer_set_timeout",
            kind: "func",
            params: ["externref", "externref"],
            results: ["externref"],
          }),
        ],
      }),
    ]);
    expect(ir.explanation).toMatchObject({ status: "declared-host-capability" });
    expect(ir.errors.map(({ message }) => message)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Host import leak")]),
    );
    expect(() => buildCompiledImports(ir)).toThrow("requires deps.setTimeout");
    for (const retiredImport of ["env.Promise_new", "env.__call_1_f64", "env.__box_number", "env.__make_callback"])
      expect(actualImportNames(ir)).not.toContain(retiredImport);

    const exportNames = WebAssembly.Module.exports(new WebAssembly.Module(ir.binary)).map(({ name }) => name);
    expect(exportNames).toContain(STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT);
    expect(exportNames).toContain(STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT);
    expect(exportNames).toContain(STANDALONE_TIMER_CALLBACK_MARKER_EXPORT);
    expect(exportNames).toContain(STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT);
    expect(exportNames).not.toContain("__call_fn_0");
    expect(exportNames).not.toContain("__\0js2_closure_host_bridge");

    const delayBody = watFunction(ir, "delay").body;
    expect(watCallTargets(ir, delayBody)).toContain("__ir_promise_delay_native");
    expect(ir.wat).toContain("(func $__ir_promise_delay_native");
    expect(ir.wat).toContain("$Promise");
    expect(delayBody).not.toContain("call_ref");
    expect(ir.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
  });

  it("settles concurrent fast and slow native promises exactly once with direct-backend parity", async () => {
    const [ir, direct] = await Promise.all([
      compileDelay(EXACT_DELAY, true, "issue-4573-concurrent-ir.ts"),
      compileDelay(EXACT_DELAY, false, "issue-4573-concurrent-direct.ts", "always"),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(terminalOutcome(ir, "delay")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(actualImportNames(ir)).toEqual(["env.__timer_set_timeout"]);

    const irTrace = await runConcurrent(ir);
    const directTrace = await runConcurrent(direct);
    expect(irTrace).toEqual({
      scheduledDelays: [25, 1],
      beforeStates: [0, 0],
      afterFastStates: [1, 0],
      afterFastValues: [222, null],
      afterFastRepeatStates: [1, 0],
      afterFastRepeatValues: [222, null],
      afterSlowStates: [1, 1],
      afterSlowValues: [222, 111],
    });
    expect(irTrace).toEqual(directTrace);
  });

  it("fires a start-time timer through the authenticated bridge and drains reactions automatically", async () => {
    const result = await compileDelay(START_TIME_REACTION, true, "issue-4573-start-time-reaction.ts");
    expectSuccess(result);
    expect(terminalOutcome(result, "delay")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(
      (result.irOutcomes ?? []).filter(
        ({ stage, detail }) => stage === "resolve" && detail?.includes("late-preparation-unsupported"),
      ),
    ).toEqual([]);

    const scheduled: Array<() => void> = [];
    const setTimeoutProvider = ((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const imports = importsWithCapturedSetTimeout(result, setTimeoutProvider);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect(scheduled).toHaveLength(1);

    const exports = instance.exports as unknown as Record<string, any>;
    const marker = exports[STANDALONE_TIMER_CALLBACK_MARKER_EXPORT] as WebAssembly.Table;
    const bindings = exports[STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT] as WebAssembly.Table;
    const manifest = exports[STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT] as WebAssembly.Global;
    const dispatch = exports[STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT];
    expect(marker).toBeInstanceOf(WebAssembly.Table);
    expect(marker.length).toBe(0);
    expect(bindings).toBeInstanceOf(WebAssembly.Table);
    expect(bindings.length).toBe(1);
    expect(manifest).toBeInstanceOf(WebAssembly.Global);
    expect(manifest.value).toBe(STANDALONE_TIMER_CALLBACK_MANIFEST_MAGIC);
    expect(bindings.get(0)).toBe(dispatch);

    imports.setInstance?.(instance);
    expect((exports.readObserved as () => number)()).toBe(0);
    scheduled[0]!();
    // No explicit __drain_microtasks call: the external timer boundary owns it.
    expect((exports.readObserved as () => number)()).toBe(73);
  });

  it("preserves colliding user exports while authenticating the terminal timer aliases", async () => {
    const result = await compileDelay(timerCollisionSource(), true, "issue-4573-timer-export-collisions.ts");
    expectSuccess(result);
    const scheduled: Array<() => void> = [];
    const setTimeoutProvider = ((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const imports = importsWithCapturedSetTimeout(result, setTimeoutProvider);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const exports = instance.exports as unknown as Record<string, any>;

    for (const name of [
      STANDALONE_TIMER_CALLBACK_DISPATCH_EXPORT,
      STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT,
      STANDALONE_TIMER_CALLBACK_MARKER_EXPORT,
      STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT,
    ]) {
      expect((exports[name] as () => number)()).toBe(99);
    }
    for (const base of [
      STANDALONE_TIMER_CALLBACK_DISPATCH_PHYSICAL_BASE,
      STANDALONE_TIMER_CALLBACK_MANIFEST_PHYSICAL_BASE,
      STANDALONE_TIMER_CALLBACK_MARKER_PHYSICAL_BASE,
      STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE,
    ]) {
      expect((exports[base] as () => number)()).toBe(99);
      expect(exports[`${base}$`]).toBeDefined();
    }

    const promise = (exports.delay as (ms: number, value: number) => unknown)(1, 41);
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    expect((exports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(1);
    expect((exports.__promise_boundary_value as (value: unknown) => unknown)(promise)).toBe(41);
  });

  it("fails closed when the authenticated timer binding table is tampered with", async () => {
    const result = await compileDelay(EXACT_DELAY, true, "issue-4573-timer-binding-tamper.ts");
    expectSuccess(result);
    const scheduled: Array<() => void> = [];
    const setTimeoutProvider = ((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const imports = importsWithCapturedSetTimeout(result, setTimeoutProvider);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as unknown as Record<string, any>;
    const bindings = exports[STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT] as WebAssembly.Table;
    bindings.set(0, null);
    imports.setInstance?.(instance);

    const promise = (exports.delay as (ms: number, value: number) => unknown)(1, 17);
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]!()).toThrow("timer callback dispatcher");
    expect((exports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(0);
  });

  it("fails closed on a proxied timer binding table without surfacing its branded getter", async () => {
    const result = await compileDelay(EXACT_DELAY, true, "issue-4573-timer-binding-proxy.ts");
    expectSuccess(result);
    const scheduled: Array<() => void> = [];
    const imports = importsWithCapturedSetTimeout(result, ((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as unknown as Record<string, any>;

    const descriptors = Object.getOwnPropertyDescriptors(exports);
    const bindingDescriptor = descriptors[STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE];
    expect(bindingDescriptor).toBeDefined();
    descriptors[STANDALONE_TIMER_CALLBACK_BINDINGS_PHYSICAL_BASE] = {
      ...bindingDescriptor!,
      value: new Proxy(exports[STANDALONE_TIMER_CALLBACK_BINDINGS_EXPORT] as WebAssembly.Table, {}),
    };
    const proxiedExports = Object.create(null) as Record<string, Function>;
    Object.defineProperties(proxiedExports, descriptors);

    expect(() => imports.setExports?.(proxiedExports)).not.toThrow();
    const promise = (exports.delay as (ms: number, value: number) => unknown)(1, 23);
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]!()).toThrow("timer callback dispatcher");
    expect((exports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(0);

    imports.setInstance?.(instance);
    expect(() => scheduled[0]!()).not.toThrow();
    expect((exports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(1);
    expect((exports.__promise_boundary_value as (value: unknown) => unknown)(promise)).toBe(23);
  });

  it("rejects raw and donor setExports records until branded setInstance establishes authority", async () => {
    const result = await compileDelay(EXACT_DELAY, true, "issue-4573-timer-donor-record.ts");
    expectSuccess(result);

    const donorImports = importsWithCapturedSetTimeout(result, ((callback: () => void) => {
      void callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const { instance: donor } = await WebAssembly.instantiate(result.binary, donorImports);
    donorImports.setInstance?.(donor);

    const scheduled: Array<() => void> = [];
    const victimImports = importsWithCapturedSetTimeout(result, ((callback: () => void) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const { instance: victim } = await WebAssembly.instantiate(result.binary, victimImports);
    const victimExports = victim.exports as unknown as Record<string, any>;
    const promise = (victimExports.delay as (ms: number, value: number) => unknown)(1, 29);
    expect(scheduled).toHaveLength(1);

    victimImports.setExports?.(donor.exports as unknown as Record<string, Function>);
    expect(() => scheduled[0]!()).toThrow("timer callback dispatcher");
    expect((victimExports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(0);

    victimImports.setExports?.(victim.exports as unknown as Record<string, Function>);
    expect(() => scheduled[0]!()).toThrow("timer callback dispatcher");
    expect((victimExports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(0);

    victimImports.setInstance?.(victim);
    expect(() => scheduled[0]!()).not.toThrow();
    expect((victimExports.__promise_boundary_state as (value: unknown) => number)(promise)).toBe(1);
    expect((victimExports.__promise_boundary_value as (value: unknown) => unknown)(promise)).toBe(29);
  });

  it("turns a synchronous timer-capability throw into native sentinel rejection", async () => {
    const ir = await compileDelay(EXACT_DELAY, true, "issue-4573-timer-registration-throw.ts");
    expectSuccess(ir);
    expect(terminalOutcome(ir, "delay")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(actualImportNames(ir)).toEqual(["env.__timer_set_timeout"]);
    // Foreign JS exception identity is intentionally outside the one-import
    // standalone timer ABI. The IR path improves the direct backend's
    // synchronous leak by rejecting, using null as the documented boundary
    // sentinel until the capability contract grows a typed error channel.
    await expect(runRejectedRegistration(ir)).resolves.toEqual({ state: 2, reason: null });
  });

  it("fails closed on native-provider collisions and injected late registration", async () => {
    const collision = await compileDelay(
      `
        export function __ir_promise_delay_native(a: number, b: number): number { return a + b; }
        ${EXACT_DELAY}
      `,
      true,
      "issue-4573-native-provider-collision.ts",
    );
    expectSuccess(collision);
    expect(terminalOutcome(collision, "delay")).toMatchObject({
      kind: "unsupported",
      code: "late-preparation-unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const priorInjection = process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW = "1";
    try {
      const injected = await compileDelay(EXACT_DELAY, true, "issue-4573-native-registration-injection.ts");
      expect(injected.success).toBe(false);
      expect(terminalOutcome(injected, "delay")).toMatchObject({
        kind: "invariant",
        code: "unexpected-internal-throw",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      expect(injected.errors.map(({ message }) => message).join("\n")).toContain(
        "injected Promise late-registration failure",
      );
    } finally {
      if (priorInjection === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW");
      } else {
        process.env.JS2WASM_TEST_INJECT_IR_PROMISE_REGISTRATION_THROW = priorInjection;
      }
    }
  });

  it("bypasses the retired direct emitter while the near-miss poison remains live", async () => {
    const previousPoison = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "delay";
      const exact = await compileDelay(EXACT_DELAY, true, "issue-4573-exact-poison.ts");
      expectSuccess(exact);
      expect(terminalOutcome(exact, "delay")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });

      const nearMiss = await compileDelay(NEAR_MISS_DELAY, true, "issue-4573-near-miss-poison.ts");
      expect(nearMiss.success).toBe(false);
      expect(nearMiss.errors.map((error) => error.message).join("\n")).toContain(
        "injected direct function-body poison: delay",
      );
    } finally {
      if (previousPoison === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousPoison;
      }
    }
  });

  it("keeps a concise-executor near miss on typed direct ownership", async () => {
    const result = await compileDelay(NEAR_MISS_DELAY, true, "issue-4573-near-miss.ts");
    expectSuccess(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("delay");
    expect(result.irFirstSkipped ?? []).not.toContain("delay");
    expect(terminalOutcome(result, "delay")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(terminalOutcome(result, "delay")).not.toHaveProperty("preparedComponentId");
  });

  it("emits no timer bridge metadata when the capability is unused", async () => {
    const result = await compileDelay(
      `export function answer(): number { return 42; }`,
      true,
      "issue-4573-no-timer.ts",
    );
    expectSuccess(result);
    const exportNames = WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).map(({ name }) => name);
    expect(exportNames.some((name) => name.includes("js2_timer_callback") || /^\$t[0mtu]/.test(name))).toBe(false);
    expect(result.capabilityRequirements).toEqual([]);

    const unregistered = await compileDelay(
      `
        declare function __unregistered_embedder_call(value: number): number;
        export function probe(value: number): number { return __unregistered_embedder_call(value); }
      `,
      true,
      "issue-4573-unregistered-env-import.ts",
    );
    expectSuccess(unregistered);
    expect(
      unregistered.errors.some(
        ({ severity, message }) => severity === "warning" && message.includes("Host import leak"),
      ),
    ).toBe(true);
  });
});
