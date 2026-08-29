// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5164 — IR adoption of the comma operator and a bounded dynamic-lane `in`.
//
//   S1  VALUE-position PURE comma (`const c = (a, b)`), inheriting #4459's
//       discard purity line so a MUTATING left operand (`(a = 1, b)`) stays
//       legacy-owned.
//   S2  for-INCREMENTOR comma (`for (…; …; i++, j--)`), where each side re-enters
//       the update-clause rules and the mutating `i++` idiom IS admissible.
//   S3  `<key> in <receiver>` over the non-fast dynamic externref carrier only,
//       probed through the same dual-mode `__extern_has` legacy calls.
//
// Every runtime case asserts THREE-WAY agreement — legacy (`experimentalIR:
// false`), IR, and the JavaScript reference value — plus the emitted-log ORDER,
// so a reordered or dropped operand fails even when the result happens to match.
// Emission is asserted from `trackIrOutcomes` (`kind: "emitted"` +
// `irBodyEmitted`), never from a bare selector claim: a claim that never
// reaches a body is the vacuous-pass hazard this file exists to exclude.

import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RunResult {
  readonly exports: Record<string, (...args: unknown[]) => unknown>;
  readonly logs: readonly number[];
  readonly emitted: ReadonlySet<string>;
  readonly outcomes: readonly IrObservedOutcome[];
  readonly postClaim: readonly { kind: string; func: string; message: string }[];
}

async function compileAndRun(
  source: string,
  experimentalIR: boolean,
  options: Record<string, unknown> = {},
): Promise<RunResult> {
  const logs: number[] = [];
  const result = await compile(source, {
    fileName: "test.ts",
    experimentalIR,
    trackIrOutcomes: true,
    ...options,
  });
  if (!result.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${result.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(result.imports as never, undefined, result.stringPool) as Record<string, never> & {
    env: Record<string, unknown>;
    setExports?: (exports: unknown) => void;
  };
  built.env.console_log_number = (value: unknown) => void logs.push(Number(value));
  const { instance } = await WebAssembly.instantiate(result.binary, built as never);
  built.setExports?.(instance.exports);
  return {
    exports: instance.exports as Record<string, (...args: unknown[]) => unknown>,
    logs,
    emitted: new Set(
      (result.irOutcomes ?? []).filter((outcome) => outcome.kind === "emitted").map((outcome) => outcome.displayName),
    ),
    outcomes: result.irOutcomes ?? [],
    postClaim: result.irPostClaimErrors ?? [],
  };
}

/**
 * Run one exported function on BOTH pipelines and assert legacy ≡ IR ≡ the
 * JavaScript reference, for the returned value AND for the ordered side-effect
 * log. `emits` names the functions whose IR bodies must genuinely have been
 * emitted — the non-vacuity guard.
 */
async function expectThreeWayParity(
  source: string,
  fn: string,
  args: readonly unknown[],
  expected: { value: unknown; logs: readonly number[] },
  emits: readonly string[],
): Promise<void> {
  const legacy = await compileAndRun(source, false);
  const ir = await compileAndRun(source, true);

  expect(legacy.exports[fn]!(...args), `legacy ${fn} value`).toStrictEqual(expected.value);
  expect(legacy.logs, `legacy ${fn} side-effect order`).toStrictEqual([...expected.logs]);

  expect(ir.exports[fn]!(...args), `IR ${fn} value matches legacy + JS`).toStrictEqual(expected.value);
  expect(ir.logs, `IR ${fn} side-effect order matches legacy + JS`).toStrictEqual([...expected.logs]);

  expect(ir.postClaim, `no post-claim demotions for ${fn}`).toStrictEqual([]);
  for (const name of emits) {
    expect(ir.emitted.has(name), `${name} genuinely IR-emitted (claim alone is not evidence)`).toBe(true);
  }
}

/** Bare-selector claim set, with the resolver certificates stubbed explicitly. */
function selectionFor(
  source: string,
  certificates: { dynamicReceiver?: boolean; hostStringCarrier?: boolean } = {},
): ReadonlySet<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return planIrCompilation(sf, {
    experimentalIR: true,
    isDynamicForInReceiver: () => certificates.dynamicReceiver === true,
    forInHeadValueIsHostString: certificates.hostStringCarrier === true,
  }).funcs;
}

/** The terminal outcome code the selector recorded for `fn`. */
function outcomeCode(outcomes: readonly IrObservedOutcome[], fn: string): string | undefined {
  const outcome = outcomes.find((entry) => entry.displayName === fn);
  return (outcome as { code?: string } | undefined)?.code;
}

// ---------------------------------------------------------------------------
// S1 — value-position pure comma
// ---------------------------------------------------------------------------

const VALUE_COMMA = `
  export function commaValue(a: number, b: number): number {
    const c = (a, b);
    return c;
  }
  export function commaNested(a: number, b: number, c: number): number {
    const r = (a, b, c);
    return r + (a, b);
  }
`;

const MUTATING_COMMA = `
  export function commaMutating(b: number): number {
    let a = 0;
    const c = ((a = 1), b);
    return c + a;
  }
`;

const ORDER_COMMA = `
  export function commaOrder(): number {
    console.log(1);
    const r = (console.log(2), 3);
    console.log(4);
    return r;
  }
`;

const TRY_COMMA = `
  export function commaTry(n: number): number {
    let r = 0;
    try {
      r = (console.log(n), n + 1);
    } catch {
      r = -1;
    }
    return r;
  }
`;

describe("#5164 S1 — value-position pure comma", () => {
  it("claims the value and nested forms", () => {
    const claimed = selectionFor(VALUE_COMMA);
    expect(claimed.has("commaValue")).toBe(true);
    expect(claimed.has("commaNested")).toBe(true);
  });

  it("keeps a MUTATING left operand legacy-owned (#4459's purity line held)", () => {
    expect(selectionFor(MUTATING_COMMA).has("commaMutating")).toBe(false);
  });

  it("`(a = 1, b)` rejects pre-claim, with no post-claim demotion", async () => {
    const ir = await compileAndRun(MUTATING_COMMA, true);
    expect(ir.emitted.has("commaMutating")).toBe(false);
    expect(outcomeCode(ir.outcomes, "commaMutating")).toBe("body-shape-rejected");
    expect(ir.postClaim).toStrictEqual([]);
    // …and the legacy lowering still answers correctly.
    expect(ir.exports.commaMutating!(5)).toBe(6);
  });

  it("evaluates `(a, b)` and `(a, b, c)` to the LAST operand", async () => {
    // JS reference: (2, 3) === 3; (2, 3, 4) === 4, plus (2, 3) === 3 ⇒ 7.
    await expectThreeWayParity(VALUE_COMMA, "commaValue", [2, 3], { value: 3, logs: [] }, ["commaValue"]);
    await expectThreeWayParity(VALUE_COMMA, "commaNested", [2, 3, 4], { value: 7, logs: [] }, ["commaNested"]);
  });

  it("evaluates a discarded operand for its side effect, left to right", async () => {
    // JS reference: logs 1, then the comma's left operand logs 2, then 4; r === 3.
    await expectThreeWayParity(ORDER_COMMA, "commaOrder", [], { value: 3, logs: [1, 2, 4] }, ["commaOrder"]);
  });

  it("keeps the comma's order inside a try block", async () => {
    await expectThreeWayParity(TRY_COMMA, "commaTry", [7], { value: 8, logs: [7] }, ["commaTry"]);
  });
});

// ---------------------------------------------------------------------------
// S2 — for-incrementor comma
// ---------------------------------------------------------------------------

const FOR_INCR_COMMA = `
  export function commaForIncr(n: number): number {
    let j = 100;
    for (let i = 0; i < n; i++, j--) {
      console.log(i);
    }
    return j;
  }
  export function commaForTriple(n: number): number {
    let j = 0;
    let k = 0;
    for (let i = 0; i < n; i++, j += 2, k += 3) {
      console.log(j);
    }
    return j + k;
  }
`;

describe("#5164 S2 — for-incrementor comma", () => {
  it("claims `i++, j--` and the three-clause form", () => {
    // Console-free so the bare selector (no host-extern resolvers) isolates the
    // update-clause comma itself; the emission assertions below run the real
    // compile, where `console.log` is available.
    const claimed = selectionFor(`
      export function commaForIncr(n: number): number {
        let j = 100;
        for (let i = 0; i < n; i++, j--) { j = j; }
        return j;
      }
      export function commaForTriple(n: number): number {
        let j = 0;
        let k = 0;
        for (let i = 0; i < n; i++, j += 2, k += 3) { j = j; }
        return j + k;
      }
    `);
    expect(claimed.has("commaForIncr")).toBe(true);
    expect(claimed.has("commaForTriple")).toBe(true);
  });

  it("runs BOTH update clauses once per iteration", async () => {
    // JS reference: 3 iterations logging 0,1,2; j goes 100 → 97.
    await expectThreeWayParity(FOR_INCR_COMMA, "commaForIncr", [3], { value: 97, logs: [0, 1, 2] }, ["commaForIncr"]);
    // JS reference: j = 0,2,4 logged before each update; after 3 iterations
    // j === 6 and k === 9.
    await expectThreeWayParity(FOR_INCR_COMMA, "commaForTriple", [3], { value: 15, logs: [0, 2, 4] }, [
      "commaForTriple",
    ]);
  });

  it("runs zero update clauses when the loop body never executes", async () => {
    await expectThreeWayParity(FOR_INCR_COMMA, "commaForIncr", [0], { value: 100, logs: [] }, ["commaForIncr"]);
  });
});

// ---------------------------------------------------------------------------
// S3 — bounded dynamic-lane `in`
// ---------------------------------------------------------------------------

const DYNAMIC_IN = `
  export function hasX(o: any): boolean { return "x" in o; }
  export function hasKey(o: any, k: any): boolean { return k in o; }
  export function hasIndex(o: any, i: number): boolean { return i in o; }
`;

const TYPED_IN = `
  export function hasOnTypedObject(): boolean {
    const o = { a: 1 };
    return "a" in o;
  }
  export function hasOnPrimitive(n: number): boolean {
    return "x" in (n as unknown as object);
  }
`;

const PROXY_IN = `
  export function proxyHas(): boolean {
    const p = new Proxy({ a: 1 }, { has: () => true });
    return "zzz" in p;
  }
`;

const COMMA_KEY_IN = `
  export function commaKeyIn(o: any): boolean {
    return ((0, "x") in o);
  }
`;

describe("#5164 S3 — bounded dynamic-lane `in` selection", () => {
  it("claims ONLY behind BOTH resolver certificates", () => {
    const both = { dynamicReceiver: true, hostStringCarrier: true };
    expect(selectionFor(DYNAMIC_IN, both).has("hasX")).toBe(true);
    // The dynamic-carrier certificate alone is not enough: a native-strings
    // lane cannot coerce the key to externref, so it must reject PRE-claim.
    expect(selectionFor(DYNAMIC_IN, { dynamicReceiver: true }).has("hasX")).toBe(false);
    // …and the host-string carrier alone says nothing about the receiver.
    expect(selectionFor(DYNAMIC_IN, { hostStringCarrier: true }).has("hasX")).toBe(false);
    expect(selectionFor(DYNAMIC_IN, {}).has("hasX")).toBe(false);
  });

  it("keeps legacy's comma-key static fold out of the accept set", () => {
    expect(selectionFor(COMMA_KEY_IN, { dynamicReceiver: true, hostStringCarrier: true }).has("commaKeyIn")).toBe(
      false,
    );
  });

  it("rejects typed-object and primitive receivers pre-claim", async () => {
    const ir = await compileAndRun(TYPED_IN, true);
    for (const fn of ["hasOnTypedObject", "hasOnPrimitive"]) {
      expect(ir.emitted.has(fn), `${fn} stays legacy-owned`).toBe(false);
      expect(outcomeCode(ir.outcomes, fn), `${fn} pre-claim reason`).toBe("body-shape-rejected");
    }
    // Pre-claim, not claim-then-demote.
    expect(ir.postClaim).toStrictEqual([]);
  });

  it("keeps a Proxy has-trap receiver (#2617) on the legacy path", async () => {
    const ir = await compileAndRun(PROXY_IN, true);
    expect(ir.emitted.has("proxyHas")).toBe(false);
    expect(ir.postClaim).toStrictEqual([]);
    // Legacy still honours the trap.
    expect(ir.exports.proxyHas!()).toBeTruthy();
  });

  it("rejects pre-claim on the native-strings lanes (standalone / wasi)", async () => {
    for (const target of ["standalone", "wasi"] as const) {
      const result = await compile(DYNAMIC_IN, {
        fileName: "test.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });
      expect(result.success, `${target} compiles`).toBe(true);
      const emitted = new Set(
        (result.irOutcomes ?? []).filter((outcome) => outcome.kind === "emitted").map((o) => o.displayName),
      );
      expect(emitted.has("hasX"), `${target} keeps \`in\` legacy-owned`).toBe(false);
      expect(result.irPostClaimErrors ?? [], `${target} has no post-claim demotion`).toStrictEqual([]);
    }
  });

  it("keeps the FAST dynamic carrier on the legacy path", async () => {
    const ir = await compileAndRun(DYNAMIC_IN, true, { fast: true });
    expect(ir.emitted.has("hasX")).toBe(false);
    expect(ir.postClaim).toStrictEqual([]);
  });
});

describe("#5164 S3 — bounded dynamic-lane `in` runtime", () => {
  // [fn, args, JavaScript reference answer]
  const CASES: ReadonlyArray<readonly [string, readonly unknown[], boolean]> = [
    ["hasX", [{ x: 1 }], true],
    ["hasX", [{ y: 1 }], false],
    ["hasX", [{ x: undefined }], true], // present-but-undefined is still present
    ["hasX", [Object.create({ x: 9 })], true], // inherited via the prototype chain
    ["hasKey", [{ a: 1 }, "a"], true],
    ["hasKey", [{ a: 1 }, "b"], false],
    ["hasKey", [[1, 2, 3], "length"], true],
    ["hasIndex", [[1, 2, 3], 1], true], // numeric key on an array receiver
    ["hasIndex", [[1, 2, 3], 7], false],
    ["hasIndex", [{ 0: "a" }, 0], true],
  ];

  it("agrees with legacy AND JavaScript on every probed receiver/key shape", async () => {
    const legacy = await compileAndRun(DYNAMIC_IN, false);
    const ir = await compileAndRun(DYNAMIC_IN, true);
    for (const fn of ["hasX", "hasKey", "hasIndex"]) {
      expect(ir.emitted.has(fn), `${fn} genuinely IR-emitted`).toBe(true);
    }
    expect(ir.postClaim).toStrictEqual([]);

    for (const [fn, args, reference] of CASES) {
      const legacyAnswer = Boolean(legacy.exports[fn]!(...args));
      const irAnswer = Boolean(ir.exports[fn]!(...args));
      expect(legacyAnswer, `legacy ${fn}(${JSON.stringify(args)})`).toBe(reference);
      expect(irAnswer, `IR ${fn}(${JSON.stringify(args)}) matches legacy + JS`).toBe(legacyAnswer);
    }
  });

  it("evaluates the KEY before the receiver (§13.10.1 steps 1-4)", async () => {
    const source = `
      export function order(o: any): boolean {
        return (console.log(1), "x") in (console.log(2), o);
      }
    `;
    // Whichever pipeline owns this shape, the emitted order must be key-first.
    const legacy = await compileAndRun(source, false);
    expect(Boolean(legacy.exports.order!({ x: 1 }))).toBe(true);
    expect(legacy.logs).toStrictEqual([1, 2]);

    const ir = await compileAndRun(source, true);
    expect(Boolean(ir.exports.order!({ x: 1 }))).toBe(true);
    expect(ir.logs, "IR keeps §13.10.1 key-before-receiver order").toStrictEqual([1, 2]);
    expect(ir.postClaim).toStrictEqual([]);
  });
});
