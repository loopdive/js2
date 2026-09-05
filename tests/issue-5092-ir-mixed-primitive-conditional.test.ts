// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5092 — bounded IR ownership for heterogeneous number/string/boolean
// conditional-expression arms. The accepted route must stay lazy, preserve
// each arm's JavaScript tag, and fail closed after claim.

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { compile, compileMulti, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import { forEachInstrDeep, irDynamic, type IrFunction, type IrInstrBox, type IrInstrIf } from "../src/ir/nodes.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const IR_FIRST = "JS2WASM_IR_FIRST";
const ROUTE = "JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL";
const TAMPER = "JS2WASM_TEST_TAMPER_IR_MIXED_PRIMITIVE_CONDITIONAL";
const identities = createTestIrFunctionIdentityFactory("issue-5092-ir-mixed-primitive-conditional");

const ELIGIBLE_NAMES = ["numberString", "booleanString", "numberBoolean"] as const;
const ELIGIBLE_SOURCE = `
  export function numberString(c: boolean): number {
    const value = c ? 7 : "s";
    return "" + value === (c ? "7" : "s") ? 1 : 0;
  }
  export function booleanString(c: boolean): number {
    const value = c ? true : "s";
    return "" + value === (c ? "true" : "s") ? 1 : 0;
  }
  export function numberBoolean(c: boolean): number {
    const value = c ? 7 : true;
    return +value === (c ? 7 : 1) ? 1 : 0;
  }
`;

const CONSUMER_NAMES = ["asString", "asNumber", "typeName"] as const;
const CONSUMER_SOURCE = `
  export function asString(c: boolean): number {
    return String(c ? 7 : "s") === (c ? "7" : "s") ? 1 : 0;
  }
  export function asNumber(c: boolean): number {
    return Number(c ? 7 : true);
  }
  export function typeName(c: boolean): number {
    return typeof (c ? 7 : "s") === (c ? "number" : "string") ? 1 : 0;
  }
`;

// (2026-08-28 review repair, HOLD 1) `typeof` over the mixed carrier must read
// the arms' REAL primitive kinds. An `as` assertion is not runtime evidence, so
// each forged spelling below has to answer exactly what Node answers.
const TYPEOF_CODE = `return t === "number" ? 1 : t === "string" ? 2 : t === "boolean" ? 3 : 0;`;
const FORGED_TYPEOF_SOURCE = `
  export function forgedInline(c: boolean): number {
    const t = typeof ((c ? 7 : "s") as number | boolean);
    ${TYPEOF_CODE}
  }
  export function forgedOnLocal(c: boolean): number {
    const v = c ? 7 : "s";
    const t = typeof (v as number | boolean);
    ${TYPEOF_CODE}
  }
  export function forgedThroughLocal(c: boolean): number {
    const v = c ? true : "s";
    const w = v as number | string;
    const t = typeof w;
    ${TYPEOF_CODE}
  }
  export function honestTypeof(c: boolean): number {
    const t = typeof (c ? 7 : "s");
    ${TYPEOF_CODE}
  }
`;
/** `1` number · `2` string · `3` boolean — the answer Node gives for each arm. */
const FORGED_TYPEOF_EXPECTED: ReadonlyArray<readonly [string, number, number]> = [
  ["forgedInline", 1, 2],
  ["forgedOnLocal", 1, 2],
  ["forgedThroughLocal", 3, 2],
  ["honestTypeof", 1, 2],
];

const LOST_PROOF_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    "conditional",
    `export function choose(c: boolean): string { const v = c ? 7 : "s"; return "" + v; }`,
    "choose",
    "mixed conditional",
  ],
  [
    "String wrapper",
    `export function asString(c: boolean): number { return String(c ? 7 : "s") === (c ? "7" : "s") ? 1 : 0; }`,
    "asString",
    "String wrapper",
  ],
  [
    "Number wrapper",
    `export function asNumber(c: boolean): number { return Number(c ? 7 : true); }`,
    "asNumber",
    "Number wrapper",
  ],
];

function expectSuccess(result: CompileResult, label: string): void {
  expect(
    result.success,
    `${label} failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
  ).toBe(true);
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing IR outcome for ${name}`);
  return observed;
}

async function compileTracked(source: string, fileName: string): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: "standalone",
    hostBridge: "always",
    experimentalIR: true,
    trackIrOutcomes: true,
  } as never);
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function nestedInstructions(fn: IrFunction): { ifs: IrInstrIf[]; boxes: IrInstrBox[]; selects: number } {
  const ifs: IrInstrIf[] = [];
  const boxes: IrInstrBox[] = [];
  let selects = 0;
  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "if") ifs.push(instr);
        if (instr.kind === "box") boxes.push(instr);
        if (instr.kind === "select") selects++;
      });
    }
  }
  return { ifs, boxes, selects };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#5092 mixed primitive conditional IR ownership", () => {
  it("owns a non-vacuous exact denominator and preserves runtime tags", async () => {
    expect(ELIGIBLE_NAMES.length).toBeGreaterThan(0);
    const result = await compileTracked(ELIGIBLE_SOURCE, "issue-5092-eligible.ts");
    expectSuccess(result, "mixed primitive denominator");
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of ELIGIBLE_NAMES) {
      expect(outcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }

    const exports = await instantiate(result);
    for (const name of ELIGIBLE_NAMES) {
      const probe = exports[name] as (condition: number) => number;
      expect(probe(1), `${name}(true)`).toBe(1);
      expect(probe(0), `${name}(false)`).toBe(1);
    }
  });

  it("emits one lazy if with honest per-arm box tags and no eager select", () => {
    const analysis = analyzeSource(`
      export function choose(c: boolean): number | string { return c ? 7 : "s"; }
    `);
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration);
    if (!declaration) throw new Error("missing choose declaration");
    const fn = lowerFunctionAstToIr(declaration, {
      ownerUnitId: identities.next("choose").unitId,
      exported: true,
      checker: analysis.checker,
      returnTypeOverride: irDynamic(),
      resolver: { resolveDynamic: () => ({ kind: "externref" }) },
    }).main;
    const instructions = nestedInstructions(fn);

    expect(instructions.ifs).toHaveLength(1);
    expect(instructions.selects).toBe(0);
    expect(instructions.ifs[0]!.resultType).toEqual(irDynamic());
    expect(instructions.ifs[0]!.then.filter((instr) => instr.kind === "box")).toEqual([
      expect.objectContaining({ toType: irDynamic(JS_TAG_IDS.NumberF64) }),
    ]);
    expect(instructions.ifs[0]!.else.filter((instr) => instr.kind === "box")).toEqual([
      expect.objectContaining({ toType: irDynamic(JS_TAG_IDS.String) }),
    ]);
    expect(instructions.boxes).toHaveLength(2);
  });

  it("preserves String, Number, and typeof consumers on both arms", async () => {
    const result = await compileTracked(CONSUMER_SOURCE, "issue-5092-consumers.ts");
    expectSuccess(result, "mixed primitive consumers");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of CONSUMER_NAMES) {
      expect(outcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });
    }

    const exports = await instantiate(result);
    expect((exports.asString as (condition: number) => number)(1)).toBe(1);
    expect((exports.asString as (condition: number) => number)(0)).toBe(1);
    expect((exports.asNumber as (condition: number) => number)(1)).toBe(7);
    expect((exports.asNumber as (condition: number) => number)(0)).toBe(1);
    expect((exports.typeName as (condition: number) => number)(1)).toBe(1);
    expect((exports.typeName as (condition: number) => number)(0)).toBe(1);
  });

  it("bypasses poisoned direct bodies and restores them with both kill switches", async () => {
    vi.stubEnv(DIRECT_POISON, ELIGIBLE_NAMES.join(","));
    const prepared = await compileTracked(ELIGIBLE_SOURCE, "issue-5092-poisoned.ts");
    expectSuccess(prepared, "IR route with poisoned direct bodies");
    expect(prepared.irPostClaimErrors ?? []).toEqual([]);

    vi.stubEnv(ROUTE, "0");
    const routeControl = await compileTracked(ELIGIBLE_SOURCE, "issue-5092-route-off.ts");
    expect(routeControl.success).toBe(false);
    expect(routeControl.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison",
    );

    vi.unstubAllEnvs();
    vi.stubEnv(DIRECT_POISON, ELIGIBLE_NAMES.join(","));
    vi.stubEnv(IR_FIRST, "0");
    const globalControl = await compileTracked(ELIGIBLE_SOURCE, "issue-5092-ir-first-off.ts");
    expect(globalControl.success).toBe(false);
    expect(globalControl.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison",
    );
  });

  it.each([
    [
      "nullable",
      `export function pick(c: boolean, n: number | null): string { const v = c ? n : "s"; return "" + v; }`,
    ],
    ["bigint", `export function pick(c: boolean, n: bigint): string { const v = c ? n : "s"; return "" + v; }`],
    ["any", `export function pick(c: boolean, n: any): string { const v = c ? n : "s"; return "" + v; }`],
    ["unknown", `export function pick(c: boolean, n: unknown): string { const v = c ? n : "s"; return "" + v; }`],
    [
      "generic",
      `export function pick<T extends number>(c: boolean, n: T): string { const v = c ? n : "s"; return "" + v; }`,
    ],
    [
      "object",
      `export function pick(c: boolean, n: { value: number }): string { const v = c ? n : "s"; return "" + v; }`,
    ],
    [
      "property",
      `export function pick(c: boolean, n: { value: number }): string { const v = c ? n.value : "s"; return "" + v; }`,
    ],
    [
      "call",
      `function side(): number { return 1; } export function pick(c: boolean): string { const v = c ? side() : "s"; return "" + v; }`,
    ],
    [
      "assignment",
      `export function pick(c: boolean, n: number): string { const v = c ? (n = 1) : "s"; return "" + v; }`,
    ],
    [
      "nested closure",
      `export function pick(c: boolean): string { const nested = () => c ? 1 : "s"; return "" + nested(); }`,
    ],
  ])("keeps the %s form pre-claim", async (_label, source) => {
    const result = await compileTracked(source, `issue-5092-${String(_label)}.ts`);
    expectSuccess(result, `unsupported ${String(_label)}`);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(result, "pick")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("excludes module-init, class-member, and multi-source units", async () => {
    const moduleResult = await compileTracked(
      `const value = true ? 1 : "s"; export function read(): string { return "" + value; }`,
      "issue-5092-module-init.ts",
    );
    expectSuccess(moduleResult, "module-init exclusion");
    expect(moduleResult.irPostClaimErrors ?? []).toEqual([]);
    expect(moduleResult.irOutcomes?.find((candidate) => candidate.unitKind === "module-init")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const classResult = await compileTracked(
      `export class Box { pick(c: boolean): string { const v = c ? 1 : "s"; return "" + v; } }`,
      "issue-5092-class.ts",
    );
    expectSuccess(classResult, "class exclusion");
    expect(classResult.irPostClaimErrors ?? []).toEqual([]);
    expect(
      classResult.irOutcomes?.find(
        (candidate) => candidate.unitKind === "class-member" && candidate.displayName.endsWith("_pick"),
      ),
    ).toMatchObject({ kind: "unsupported", legacyBodyEmitted: true, irBodyEmitted: false });

    const multiResult = await compileMulti(
      {
        "main.ts": `import { flag } from "./flag"; export function pick(): string { const v = flag ? 1 : "s"; return "" + v; }`,
        "flag.ts": `export const flag: boolean = true;`,
      },
      "main.ts",
      { experimentalIR: true, trackIrOutcomes: true },
    );
    expectSuccess(multiResult, "multi-source exclusion");
    expect(multiResult.irPostClaimErrors ?? []).toEqual([]);
    expect(outcome(multiResult, "pick")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("answers typeof from the arms' real kinds, not a forged assertion", async () => {
    const result = await compileTracked(FORGED_TYPEOF_SOURCE, "issue-5092-forged-typeof.ts");
    expectSuccess(result, "forged-assertion typeof");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const [name] of FORGED_TYPEOF_EXPECTED) {
      expect(outcome(result, name)).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    }

    const exports = await instantiate(result);
    for (const [name, whenTrue, whenFalse] of FORGED_TYPEOF_EXPECTED) {
      const probe = exports[name] as (condition: number) => number;
      expect(probe(1), `${name}(true)`).toBe(whenTrue);
      expect(probe(0), `${name}(false)`).toBe(whenFalse);
    }
  });

  it.each(LOST_PROOF_CASES)(
    "fails closed when the %s consumer loses its prepared proof",
    async (label, source, name, site) => {
      vi.stubEnv(TAMPER, "proof");
      const result = await compileTracked(source, `issue-5092-lost-proof-${label.replace(/\s+/g, "-")}.ts`);
      expect(result.success).toBe(false);
      expect(result.binary.length).toBe(0);
      expect(result.errors.map((error) => error.message).join("\n")).toContain(
        `#5092 ${site} lost its prepared mixed-conditional proof`,
      );
      expect(outcome(result, name)).toMatchObject({ kind: "invariant", stage: "build" });
    },
  );

  it.each(["tag", "result"])("fails closed on injected %s drift after claim", async (tamper) => {
    vi.stubEnv(TAMPER, tamper);
    const result = await compileTracked(
      `export function choose(c: boolean): string { const v = c ? 7 : "s"; return "" + v; }`,
      `issue-5092-tamper-${tamper}.ts`,
    );
    expect(result.success).toBe(false);
    expect(result.binary.length).toBe(0);
    expect(result.errors.map((error) => error.message).join("\n")).toMatch(/#5092|mixed conditional/i);
    expect(outcome(result, "choose")).toMatchObject({ kind: "invariant", stage: "build" });
  });
});
