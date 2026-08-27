// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1719 checkpoint 1 — standalone CPR results cross the canonical iterator
 * normalizer exactly once before any existing consumer calls
 * `__iterator_next`.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { directArrayProtoIteratorAssignment } from "../src/codegen/array-proto-iterator-override-ast.js";
import { compile, type CompileResult } from "../src/index.js";
import { tsRuntime } from "../src/ts-api.js";

const STANDALONE_RUNNER = `
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const module = new WebAssembly.Module(Buffer.concat(chunks));
  const imports = WebAssembly.Module.imports(module)
    .map(({ module, name }) => module + "." + name)
    .sort();
  const instance = await WebAssembly.instantiate(module, {});
  const values = {};
  for (const name of process.env.JS2WASM_1719_EXPORTS.split(",")) {
    values[name] = instance.exports[name]();
  }
  process.stdout.write(JSON.stringify({ imports, values }));
`;

const EXPECTED_VALUES = {
  assignment: 708,
  declaration: 708,
  forOfHead: 9,
  parameter: 708,
  spread: 708,
} as const;
const CONSUMER_EXPORTS = Object.keys(EXPECTED_VALUES) as (keyof typeof EXPECTED_VALUES)[];

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

interface WatInstruction {
  readonly op: "call" | "local.get" | "local.set" | "local.tee";
  readonly operand: string;
  readonly target?: string;
}

function compileFailure(result: CompileResult): string {
  return result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n");
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

function watCallTargets(wat: string, body: string): readonly string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])] ?? "<missing>";
    return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
  });
}

function watInstructions(wat: string, body: string): readonly WatInstruction[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b((?:return_)?call|local\.(?:get|set|tee)) ([^\s()]+)/g)].map((match) => {
    const op = match[1]!.endsWith("call") ? "call" : (match[1] as WatInstruction["op"]);
    const operand = match[2]!;
    const target = op === "call" ? (names[Number(operand)] ?? "<missing>").replace(/_import$/, "") : undefined;
    return { op, operand, target };
  });
}

function expectNormalizedCprPath(result: CompileResult, functionName: string): void {
  const functions = parseWatFunctions(result.wat).filter(({ name }) => name === functionName);
  expect(functions, `unique WAT function $${functionName}`).toHaveLength(1);
  const calls = watCallTargets(result.wat, functions[0]!.body);
  const drive = calls.indexOf("__drive_proto_iterator");
  expect(drive, `${functionName}: CPR driver call in ${JSON.stringify(calls)}`).toBeGreaterThanOrEqual(0);
  expect(calls[drive + 1], `${functionName}: raw result normalized immediately`).toBe("__iterator");
  expect(calls.indexOf("__iterator_next", drive + 2), `${functionName}: normalized result consumed`).toBeGreaterThan(
    drive + 1,
  );
  expect(calls.filter((name) => name === "__drive_proto_iterator")).toHaveLength(1);

  const instructions = watInstructions(result.wat, functions[0]!.body);
  const iteratorCalls = instructions
    .map((instruction, index) => ({ index, instruction }))
    .filter(({ instruction }) => instruction.op === "call" && instruction.target === "__iterator");
  expect(iteratorCalls, `${functionName}: exactly one canonical normalization`).toHaveLength(1);
  const iteratorCallIndex = iteratorCalls[0]!.index;
  const iteratorStore = instructions[iteratorCallIndex + 1];
  expect(["local.set", "local.tee"], `${functionName}: normalized result stored immediately`).toContain(
    iteratorStore?.op,
  );
  const iteratorLocal = iteratorStore!.operand;
  expect(
    instructions.filter(
      (instruction) =>
        (instruction.op === "local.set" || instruction.op === "local.tee") && instruction.operand === iteratorLocal,
    ),
    `${functionName}: one authoritative normalized iterator local`,
  ).toHaveLength(1);
  const nextCallIndices = instructions.flatMap((instruction, index) =>
    instruction.op === "call" && instruction.target === "__iterator_next" ? [index] : [],
  );
  expect(nextCallIndices.length, `${functionName}: direct iterator consumers`).toBeGreaterThan(0);
  const firstNextCallIndex = nextCallIndices[0]!;
  if (iteratorStore!.op === "local.tee") {
    const watLines = functions[0]!.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const iteratorCallLine = watLines.indexOf(`call ${iteratorCalls[0]!.instruction.operand}`);
    const firstNextOperand = instructions[firstNextCallIndex]!.operand;
    const firstNextLine = watLines.indexOf(`call ${firstNextOperand}`, iteratorCallLine + 1);
    expect(
      watLines.slice(iteratorCallLine + 1, firstNextLine + 1),
      `${functionName}: tee value consumed only by the established null guard before first __iterator_next`,
    ).toEqual([
      `local.tee ${iteratorLocal}`,
      "ref.is_null",
      "i32.eqz",
      "(if",
      "(then",
      `local.get ${iteratorLocal}`,
      `call ${firstNextOperand}`,
    ]);
  }
  for (const nextCallIndex of nextCallIndices) {
    expect(nextCallIndex, `${functionName}: iterator consumer after normalization`).toBeGreaterThan(iteratorCallIndex);
    expect(
      instructions[nextCallIndex - 1],
      `${functionName}: exact normalized local feeds every __iterator_next`,
    ).toMatchObject({
      op: "local.get",
      operand: iteratorLocal,
    });
  }
}

function sourceFor(overrideTarget: "symbol" | "values"): string {
  const target = overrideTarget === "symbol" ? "Array.prototype[Symbol.iterator]" : "Array.prototype.values";
  return `
    ${target} = function* () { yield 7; yield 8; yield 9; };

    export function declaration(): number {
      const [a, b] = [1, 2];
      return a * 100 + b;
    }

    function take([a, b]: number[]): number { return a * 100 + b; }
    export function parameter(): number { return take([1, 2]); }

    export function forOfHead(): number {
      let result = 0;
      for (var [a, b, c] of [[1, 2, 3]]) result = c;
      return result;
    }

    export function assignment(): number {
      let a = 0;
      let b = 0;
      [a, b] = [1, 2];
      return a * 100 + b;
    }

    export function spread(): number {
      const result = [...[1, 2]];
      return result[0] * 100 + result[1];
    }
  `;
}

async function compileStandalone(source: string, disableInlining = false): Promise<CompileResult> {
  const previousInline = process.env.JS2WASM_IR_INLINE;
  if (disableInlining) process.env.JS2WASM_IR_INLINE = "0";
  let result: CompileResult;
  try {
    result = await compile(source, {
      emitWat: true,
      experimentalIR: false,
      fileName: "issue-1719-standalone-cpr-normalizer.ts",
      hostBridge: "off",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
  } finally {
    if (disableInlining) {
      if (previousInline === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previousInline;
    }
  }
  expect(result.success, compileFailure(result)).toBe(true);
  expect(result.imports, "standalone compiler import descriptors").toEqual([]);
  expect(result.hostImportSummary?.total ?? 0, "standalone host-import inventory").toBe(0);
  return result;
}

function runStandalone(result: CompileResult): {
  readonly imports: readonly string[];
  readonly values: Readonly<Record<string, number>>;
} {
  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--input-type=module", "--eval", STANDALONE_RUNNER],
    {
      input: result.binary,
      encoding: "utf8",
      env: { ...process.env, JS2WASM_1719_EXPORTS: CONSUMER_EXPORTS.join(",") },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  expect(child.error, child.error?.message).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr || child.error?.message).toBe(0);
  return JSON.parse(child.stdout) as {
    readonly imports: readonly string[];
    readonly values: Readonly<Record<string, number>>;
  };
}

describe("#1719 shared direct CPR assignment predicate", () => {
  function direct(source: string) {
    const file = tsRuntime.createSourceFile("t.ts", source, tsRuntime.ScriptTarget.Latest, true);
    return directArrayProtoIteratorAssignment(file.statements[0]!);
  }

  it("recognizes only the exact direct Symbol.iterator and values assignments", () => {
    expect(direct(`Array.prototype[Symbol.iterator] = function* () {};`)?.key).toBe("@@iterator");
    expect(direct(`Array.prototype.values = function* () {};`)?.key).toBe("values");
    expect(direct(`Array.prototype["values"] = function* () {};`)?.key).toBe("values");
  });

  it("rejects wrapped, foreign, nested-expression, and non-assignment shapes", () => {
    expect(direct(`(Array.prototype as any)[Symbol.iterator] = function* () {};`)).toBeUndefined();
    expect(direct(`String.prototype[Symbol.iterator] = function* () {};`)).toBeUndefined();
    expect(direct(`consume(Array.prototype.values = function* () {});`)).toBeUndefined();
    expect(direct(`Array.prototype.values;`)).toBeUndefined();
  });
});

describe.each(["symbol", "values"] as const)("#1719 standalone CPR normalizer — %s", (overrideTarget) => {
  it("drives all five consumers through drive -> __iterator -> __iterator_next", async () => {
    // #4157's shipped inliner folds the three-instruction driver into
    // `__call_fn_method_0`. Pin it off only for this shape assertion so the
    // producer/normalizer/consumer edge remains directly observable.
    const result = await compileStandalone(sourceFor(overrideTarget), true);
    const probe = runStandalone(result);
    expect(probe.imports).toEqual([]);
    for (const name of CONSUMER_EXPORTS) expect(probe.values[name], name).toBe(EXPECTED_VALUES[name]);

    for (const functionName of ["declaration", "take", "forOfHead", "assignment", "spread"]) {
      expectNormalizedCprPath(result, functionName);
    }
  });
});

it("keeps the shipped default inliner runtime-correct and host-free", async () => {
  const previousInline = process.env.JS2WASM_IR_INLINE;
  Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
  let result: CompileResult;
  try {
    result = await compileStandalone(sourceFor("symbol"));
  } finally {
    if (previousInline !== undefined) process.env.JS2WASM_IR_INLINE = previousInline;
  }
  const probe = runStandalone(result);
  expect(probe.imports).toEqual([]);
  for (const name of CONSUMER_EXPORTS) expect(probe.values[name], name).toBe(EXPECTED_VALUES[name]);
});

it("keeps an override-free standalone module free of all CPR machinery", async () => {
  const result = await compileStandalone(`
    export function run(): number {
      const [a, b] = [1, 2];
      const spread = [...[3, 4]];
      return a + b + spread[0] + spread[1];
    }
  `);
  expect(result.wat).not.toContain("$__drive_proto_iterator");
  expect(result.wat).not.toContain("$__array_proto_iterator_override");
});
