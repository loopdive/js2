// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareIrProgramSources,
  captureTypedIrProgramInput,
  type IrProgramSourceInput,
  type IrProgramSourcePreparation,
} from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { ownTypedIrProgramInput } from "../src/ir/program/input.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import * as familyProducer from "../src/ir/program-native-async-source.js";
import * as lowerer from "../src/ir/from-ast.js";
import * as runtimeCallables from "../src/ir/program-runtime-abi.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { sourceInput, typedOptions } from "./helpers/typed-program-fixtures.js";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { captureNativeFamilyRuntimeSupport } from "./helpers/native-family-runtime-support.js";

const ORIGINAL = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
const RUNTIME = ORIGINAL.replace("async function fetchUser", "export async function fetchUser")
  .replace("async function fetchAllSequential", "export async function fetchAllSequential")
  .replace("async function fetchAllParallel", "export async function fetchAllParallel");
const VARIANTS = [
  ["original", ORIGINAL],
  ["export-only", RUNTIME],
] as const;
const names = ["delay", "fetchUser", "fetchAllSequential", "fetchAllParallel", "main"];
const f64 = { kind: "val", val: { kind: "f64" } };
const numericVector = { kind: "vec", elementType: f64, nullable: true };
const nativePolicy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const nativeOptions = { ...typedOptions, policy: nativePolicy, runtimePolicies: [nativePolicy] };

function callCensus(input: Parameters<typeof runtimeCallables.prepareIrProgramRuntimeCallables>[0]) {
  return input.ir.functions.map((fn) => {
    const references: Array<{ kind: string; ref: unknown; resolution: string; declaration: unknown }> = [];
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const root of buffer)
        forEachInstrDeep(root, (node) => {
          const ref = node.kind === "call" ? node.target : node.kind === "closure.new" ? node.liftedFunc : undefined;
          if (!ref) return;
          const declaration = irRuntimeCallableDeclaration(ref);
          const binding = ref.binding;
          const resolution = declaration
            ? "canonical-runtime"
            : binding.kind === "unit" && input.ir.functions.some((owner) => owner.unitId === binding.unitId)
              ? "program-unit"
              : "unresolved";
          references.push({ kind: node.kind, ref, resolution, declaration: declaration ?? null });
        });
    return { unitId: fn.unitId, name: fn.name, references };
  });
}

// Preserve the established typed-program-source-free.mjs preparation exclusions.
const ESTABLISHED_SOURCE_FREE_FORBIDDEN = [
  /\/src\/(checker|frontend|codegen|codegen-linear)\//,
  /\/src\/(ts-api|compiler|index)\.[cm]?[jt]s$/,
  /\/src\/ir\/(from-ast|async-from-ast|async-prepare|identity|program-source|program-preparation|program-middleend)\.[cm]?[jt]s$/,
  /\/src\/ir\/passes\/gvn\.[cm]?[jt]s$/,
  /\/node_modules\/(typescript|typescript7)\//,
];
const SOURCE_FREE_FORBIDDEN = [
  ...ESTABLISHED_SOURCE_FREE_FORBIDDEN,
  /\/src\/compiler\//,
  /\/src\/ir\/(program-logical-types|program-native-async-source)\.[cm]?[jt]s$/,
];
const SOURCE_FREE_GUARD = `data:text/javascript,${encodeURIComponent(`
  import {appendFileSync} from "node:fs";
  import {fileURLToPath} from "node:url";
  let data; export function initialize(value){data=value;}
  function rejectForbidden(url,parent,phase){
    const normalized=url.startsWith("file:")?fileURLToPath(url):url;
    if(data.patterns.some(pattern=>new RegExp(pattern).test(normalized))){
      appendFileSync(data.file,JSON.stringify({url,parent:parent??null,phase,denied:true})+"\\n");
      throw new Error("forbidden typed-preparation load: "+url);
    }
  }
  export async function resolve(specifier,context,next){
    if(specifier.startsWith("file:")||((specifier.startsWith("./")||specifier.startsWith("../"))&&context.parentURL?.startsWith("file:")))
      rejectForbidden(new URL(specifier,context.parentURL).href,context.parentURL,"requested");
    const result=await next(specifier,context);
    rejectForbidden(result.url,context.parentURL,"resolved");
    appendFileSync(data.file,JSON.stringify({url:result.url,parent:context.parentURL??null,denied:false})+"\\n");
    return result;
  }
`)}`;
function sourceFreeGuardRegistration(censusFile: string): string {
  return `register(${JSON.stringify(SOURCE_FREE_GUARD)}, {parentURL:import.meta.url,data:${JSON.stringify({
    file: censusFile,
    patterns: SOURCE_FREE_FORBIDDEN.map((pattern) => pattern.source),
  })}});`;
}

afterEach(() => vi.restoreAllMocks());
function request(text = ORIGINAL, reverse = false): IrProgramSourceInput {
  return {
    ...sourceInput({ "./entry.ts": text }, reverse),
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  };
}
function requireSource(value: ReturnType<typeof prepareIrProgramSources>): IrProgramSourcePreparation {
  expect(value.kind, JSON.stringify(value)).toBe("prepared");
  if (value.kind !== "prepared") throw new Error(value.detail);
  return value;
}
function instructions(source: IrProgramSourcePreparation): IrInstr[] {
  const result: IrInstr[] = [];
  for (const fn of source.ir.functions)
    for (const block of fn.blocks)
      for (const instruction of block.instrs) forEachInstrDeep(instruction, (node) => result.push(node));
  return result;
}
function invalid(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect(caught).toMatchObject({ code: "invalid-prepared-data" });
}
function noFrontendOrPhysicalData(root: unknown, seen = new Set<object>()): void {
  if (root === null || typeof root !== "object" || seen.has(root)) return;
  seen.add(root);
  if (root instanceof Map) {
    for (const [key, value] of root) {
      noFrontendOrPhysicalData(key, seen);
      noFrontendOrPhysicalData(value, seen);
    }
    return;
  }
  if (root instanceof Set) {
    for (const value of root) noFrontendOrPhysicalData(value, seen);
    return;
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(root))) {
    expect([
      "logicalVectorTypes",
      "checker",
      "declaration",
      "sourceFiles",
      "typeIdx",
      "funcIdx",
      "dataArrayTypeIdx",
      "vecStructTypeIdx",
    ]).not.toContain(key);
    expect("value" in descriptor).toBe(true);
    expect(typeof descriptor.value).not.toBe("function");
    noFrontendOrPhysicalData(descriptor.value, seen);
  }
}

describe("complete native family logical source preparation", () => {
  it("pins the unchanged original source and the exact export-only runtime transformation", () => {
    expect(createHash("sha256").update(ORIGINAL).digest("hex")).toBe(
      "6bc4fc96cc65881c9919a39b840afaf1001dfd3d0e05ef0cc141441a051f7915",
    );
    const oldSuite = readFileSync(
      new URL("./issue-4574-standalone-native-async-family.test.ts", import.meta.url),
      "utf8",
    );
    expect(oldSuite).toContain(
      'const RUNTIME_SOURCE = PLAYGROUND_SOURCE.replace("async function fetchUser", "export async function fetchUser")',
    );
    expect(RUNTIME.replaceAll("export async function fetch", "async function fetch")).toBe(ORIGINAL);
  });

  it.each(VARIANTS)("prepares every original owner, await and main operation in %s", (_label, text) => {
    const input = request(text);
    const inventory = buildIrUnitInventory(input.sourceFiles, {
      checker: input.checker,
      entrySource: input.entrySource,
    });
    const source = requireSource(prepareIrProgramSources(input));
    expect(source.inventory).toEqual(inventory);
    expect(source.inventory.allUnits).toHaveLength(7);
    expect(source.inventory.terminalUnits.map((unit) => unit.displayName)).toEqual(names);
    expect(source.inventory.allUnits.filter((unit) => !unit.terminal).map((unit) => unit.kind)).toEqual([
      "arrow-function",
      "arrow-function",
    ]);
    expect(source.ir.functions).toHaveLength(5);
    expect(source.derivedUnits).toEqual([]);
    const byName = new Map(source.ir.functions.map((fn) => [fn.name, fn]));
    expect(byName.get("delay")!.resultTypes).toEqual([{ kind: "extern", className: "Promise" }]);
    for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel"])
      expect(byName.get(name)!.resultTypes).toEqual([f64]);
    for (const name of ["fetchAllSequential", "fetchAllParallel"])
      expect(byName.get(name)!.params.map((param) => param.type)).toEqual([numericVector]);
    expect(byName.get("main")!.resultTypes).toEqual([]);
    const ir = instructions(source);
    expect(ir.filter((node) => node.kind === "await")).toHaveLength(5);
    expect(ir.filter((node) => node.kind === "vec.new_fixed")).toHaveLength(2);
    expect(ir.some((node) => node.kind === "closure.new")).toBe(false);
    const symbols = ir.flatMap((node) =>
      node.kind === "call" && (node.target.binding.kind === "runtime" || node.target.binding.kind === "intrinsic")
        ? [node.target.binding.symbol]
        : [],
    );
    for (const [symbol, count] of [
      ["__ir_promise_delay_native", 1],
      ["__ir_async_promise_all_native", 1],
      ["__ir_vec_elem_set_externref", 1],
      ["async.clock.snapshot", 4],
      ["async.number.to-string", 4],
      ["async.console.log-string", 4],
      ["async.string.concat$arity5", 2],
    ] as const)
      expect(
        symbols.filter((value) => value === symbol),
        symbol,
      ).toHaveLength(count);
    const packet = captureTypedIrProgramInput(source);
    expect(packet.allocations.entries.length).toBeGreaterThan(0);
    expect(ownTypedIrProgramInput(packet).input).toEqual(packet);
    noFrontendOrPhysicalData(packet);
  });

  it.each(["omitted", "disabled"] as const)(
    "does not infer the %s family request from native delay or target",
    (mode) => {
      const input = request();
      Reflect.deleteProperty(input, "asyncFamilyProjection");
      if (mode === "disabled") Reflect.set(input, "asyncFamilyProjection", "disabled");
      const producer = vi.spyOn(familyProducer, "prepareNativeAsyncSourceFamilies");
      const result = prepareIrProgramSources(input);
      expect(result).toMatchObject({ kind: "unsupported", code: "type-resolution-unsupported", stage: "build" });
      expect(producer).not.toHaveBeenCalled();
    },
  );

  it.each([null, true, 0, "native", "host"])("rejects invalid request %s before any lowering", (value) => {
    const input = request();
    Reflect.set(input, "asyncFamilyProjection", value);
    const lower = vi.spyOn(lowerer, "lowerFunctionAstToIr");
    invalid(() => prepareIrProgramSources(input));
    expect(lower).not.toHaveBeenCalled();
  });
  it.each([undefined, "disabled"] as const)("requires explicit native delay when its value is %s", (value) => {
    const input = { ...request(), promiseDelayProjection: value };
    invalid(() => prepareIrProgramSources(input));
  });
  it.each([
    { backend: "wasmgc", target: "host" },
    { backend: "linear", target: "standalone" },
  ] as const)("rejects conflicting source policy %j", (policy) => {
    const input = request();
    Reflect.set(input, "policy", policy);
    invalid(() => prepareIrProgramSources(input));
  });
  it("preserves duplicate/source-policy checks and rejects an additional host projection", () => {
    const input = request();
    invalid(() => prepareWholeIrProgram({ ...input, runtimePolicies: [input.policy, input.policy] }));
    invalid(() => prepareWholeIrProgram({ ...input, runtimePolicies: [{ backend: "wasmgc", target: "host" }] }));
    invalid(() =>
      prepareWholeIrProgram({ ...input, runtimePolicies: [input.policy, { backend: "wasmgc", target: "host" }] }),
    );
  });

  for (const [variant, text] of VARIANTS)
    for (const gvnMode of ["off", "on"] as const)
      for (const replay of [false, true])
        it(`${variant} GVN=${gvnMode} decoded=${replay}: rejects omitted native string policy`, () => {
          const source = requireSource(prepareIrProgramSources(request(text)));
          const original = captureNativeFamilyRuntimeSupport(source, nativePolicy);
          const encoded = encodeTypedPacket(original);
          const decoded = decodeTypedPacket(encoded);
          expect(encodeTypedPacket(decoded)).toBe(encoded);
          expect(decoded.inventory).toEqual(original.inventory);
          expect(decoded.allocations).toEqual(original.allocations);
          const result = prepareTypedIrProgram(replay ? decoded : original, {
            ...typedOptions,
            controls: { ...typedOptions.controls, gvnMode },
          });
          // Retain the actual outcome of this deliberately incomplete policy.
          mkdirSync(resolve(".tmp"), { recursive: true });
          const directory = mkdtempSync(resolve(".tmp/native-family-preparation-"));
          writeFileSync(
            resolve(directory, "receipt.json"),
            JSON.stringify(
              {
                variant,
                gvnMode,
                replay,
                root: resolve("."),
                originalEncoded: encoded,
                replayEncoded: encodeTypedPacket(decoded),
                result,
              },
              null,
              2,
            ),
          );
          // Canonical callable admission does not silently supply a native storage policy.
          expect(result).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", stage: "build" });
          if (result.kind === "prepared")
            throw new Error("native runtime preparation accepted an omitted string policy");
          expect(result.detail).toBe("async.native.delay requires explicit native string storage");
          const owner = source.inventory.terminalUnits.find((unit) => unit.id === result.unitId)!;
          expect(owner).toBeDefined();
          expect(result.location).toEqual({
            sourceId: owner.sourceId,
            line: owner.line,
            column: owner.column,
            declarationStart: owner.declarationStart,
            declarationEnd: owner.declarationEnd,
          });
        });

  for (const [variant, text] of VARIANTS)
    for (const gvnMode of ["off", "on"] as const)
      for (const replay of [false, true])
        it(`${variant} GVN=${gvnMode} decoded=${replay}: prepares the entire native family`, () => {
          const source = requireSource(prepareIrProgramSources(request(text)));
          const original = captureNativeFamilyRuntimeSupport(source, nativePolicy);
          const encoded = encodeTypedPacket(original);
          const scans: ReturnType<typeof callCensus>[] = [];
          const collect = runtimeCallables.prepareIrProgramRuntimeCallables;
          vi.spyOn(runtimeCallables, "prepareIrProgramRuntimeCallables").mockImplementation((input) => {
            scans.push(callCensus(input));
            return collect(input);
          });
          let result: ReturnType<typeof prepareTypedIrProgram> | undefined;
          let failure: unknown;
          try {
            result = prepareTypedIrProgram(replay ? decodeTypedPacket(encoded) : original, {
              ...nativeOptions,
              controls: { ...nativeOptions.controls, gvnMode },
            });
          } catch (error) {
            failure = error;
          }
          mkdirSync(resolve(".tmp"), { recursive: true });
          const directory = mkdtempSync(resolve(".tmp/native-family-native-policy-"));
          writeFileSync(
            resolve(directory, "receipt.json"),
            JSON.stringify(
              {
                variant,
                gvnMode,
                replay,
                root: resolve("."),
                originalEncoded: encoded,
                stages: scans.map((owners, index) => ({
                  stage: ["source", "post-async", "post-optimization"][index] ?? `validation-${index - 2}`,
                  owners,
                })),
                result,
                failure: failure instanceof Error ? { name: failure.name, message: failure.message } : failure,
              },
              null,
              2,
            ),
          );
          expect(failure, directory).toBeUndefined();
          expect(result?.kind, directory).toBe("prepared");
          if (result?.kind !== "prepared") throw new Error("complete native family preparation failed");
          expect(encodeTypedPacket(original)).toBe(encoded);
          // The producer scans three stages; final validation independently recollects them.
          expect(scans.length).toBeGreaterThanOrEqual(4);
          expect(scans[0]).toHaveLength(5);
          expect(scans[1]).toHaveLength(16);
          expect(scans[2]).toHaveLength(16);
          expect(
            scans.slice(0, 3).map((owners) => owners.reduce((sum, owner) => sum + owner.references.length, 0)),
          ).toEqual([22, 33, 33]);
          expect(scans[2]!.map((owner) => owner.unitId)).toEqual(result.program.ir.functions.map((fn) => fn.unitId));
          for (const owners of scans)
            for (const owner of owners)
              expect(
                owner.references.filter((ref) => ref.resolution === "unresolved"),
                owner.name,
              ).toEqual([]);
          expect(result.program.inventory).toEqual(original.inventory);
          expect(result.program.inventory.allUnits).toHaveLength(7);
          expect(result.program.inventory.terminalUnits.map((unit) => unit.displayName)).toEqual(names);
        });

  it.each([
    { label: "missing native policy", options: typedOptions, expectedKind: "unsupported" },
    { label: "explicit native policy", options: nativeOptions, expectedKind: "prepared" },
  ])("replays the complete source-free packet with $label in a fresh process", ({ options, expectedKind }) => {
    const source = requireSource(prepareIrProgramSources(request()));
    const packet = captureNativeFamilyRuntimeSupport(source, nativePolicy);
    mkdirSync(resolve(".tmp"), { recursive: true });
    const directory = mkdtempSync(resolve(".tmp/native-family-source-free-"));
    const packetFile = resolve(directory, "packet.json");
    const censusFile = resolve(directory, "loads.jsonl");
    const reportFile = resolve(directory, "report.json");
    writeFileSync(packetFile, encodeTypedPacket({ packet, options }));
    const script = `
      import {register} from "node:module";
      import {readFileSync,writeFileSync} from "node:fs";
      ${sourceFreeGuardRegistration(censusFile)}
      const {encodeTypedPacket,decodeTypedPacket}=await import(${JSON.stringify(new URL("./helpers/typed-program-transport.mjs", import.meta.url).href)});
      const encoded=readFileSync(${JSON.stringify(packetFile)},"utf8");
      const value=decodeTypedPacket(encoded);
      const {prepareTypedIrProgram}=await import(${JSON.stringify(new URL("../src/ir/program-prepare-ir.ts", import.meta.url).href)});
      const result=prepareTypedIrProgram(value.packet,value.options);
      const report={root:process.cwd(),node:process.version,encoded,reencoded:encodeTypedPacket(value),
        units:value.packet.inventory.allUnits,bodies:value.packet.ir.functions.length,allocations:value.packet.allocations,result};
      writeFileSync(${JSON.stringify(reportFile)},JSON.stringify(report,null,2));
      if(report.reencoded!==encoded||report.bodies!==5||report.units.length!==7||result.kind!==${JSON.stringify(expectedKind)})process.exitCode=1;
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: resolve("."),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
    });
    writeFileSync(
      resolve(directory, "terminal.json"),
      JSON.stringify(
        {
          status: child.status,
          signal: child.signal,
          error: child.error?.message ?? null,
          stdout: child.stdout,
          stderr: child.stderr,
        },
        null,
        2,
      ),
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(readFileSync(reportFile, "utf8"));
    expect(report.units).toHaveLength(7);
    const replayedPacket = decodeTypedPacket(report.reencoded).packet;
    expect(replayedPacket.inventory).toEqual(packet.inventory);
    expect(replayedPacket.allocations).toEqual(packet.allocations);
    expect(report.result.kind).toBe(expectedKind);
    if (expectedKind === "unsupported") {
      expect(report.result).toMatchObject({ code: "body-shape-rejected", stage: "build" });
      expect(report.result.detail).toBe("async.native.delay requires explicit native string storage");
      expect(report.result.location).toBeDefined();
    } else {
      expect(report.result.program.inventory).toEqual(JSON.parse(JSON.stringify(packet.inventory)));
      expect(report.result.program.ir.functions.length).toBeGreaterThan(5);
    }
    const loaded = readFileSync(censusFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(loaded.length).toBeGreaterThan(10);
    expect(loaded.every((row) => row.denied === false)).toBe(true);
    expect(loaded.some((row) => row.url.includes("/src/ir/program-prepare-ir.ts"))).toBe(true);
  });

  it("retains every established preparation exclusion before adding the two source producers", () => {
    const established = readFileSync(new URL("./helpers/typed-program-source-free.mjs", import.meta.url), "utf8");
    const start = established.indexOf("const forbidden = [");
    const end = established.indexOf("\n];", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(established.slice(start, end + 3)).toBe(
      `const forbidden = [\n${ESTABLISHED_SOURCE_FREE_FORBIDDEN.map((pattern) => `  ${pattern},`).join("\n")}\n];`,
    );
  });

  it.each([
    "../src/ts-api.ts",
    "../src/compiler.ts",
    "../src/compiler/ir-program-driver.ts",
    "../src/ir/async-prepare.ts",
    "../src/ir/program-middleend.ts",
    "../src/ir/passes/gvn.ts",
    "../node_modules/typescript/lib/typescript.js",
    "../src/ir/program-logical-types.ts",
    "../src/ir/program-native-async-source.ts",
    "../src/ir/program-logical-types.ts?admission-guard",
    "../src/ir/program-native-async-source.ts#admission-guard",
  ])("denies the actual forbidden import %s with exact URL/error/census attribution", (path) => {
    const url = new URL(path, import.meta.url).href;
    // Plain Node preserves suffixes before the exact guard rejects the requested URL.
    // No TS loader, source evaluation, or probe-authored throw substitutes for rejection.
    mkdirSync(resolve(".tmp"), { recursive: true });
    const directory = mkdtempSync(resolve(".tmp/native-family-source-free-denial-"));
    const censusFile = resolve(directory, "loads.jsonl");
    const script = `import {register} from "node:module"; ${sourceFreeGuardRegistration(censusFile)} await import(${JSON.stringify(url)});`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: resolve("."),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
    });
    writeFileSync(
      resolve(directory, "terminal.json"),
      JSON.stringify(
        {
          url,
          status: child.status,
          signal: child.signal,
          error: child.error?.message ?? null,
          stdout: child.stdout,
          stderr: child.stderr,
        },
        null,
        2,
      ),
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr).toBe(1);
    expect(child.stderr).toContain(`Error: forbidden typed-preparation load: ${url}\n`);
    const rows = readFileSync(censusFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.denied)).toEqual([
      { url, parent: expect.any(String), phase: "requested", denied: true },
    ]);
    expect(rows.some((row) => row.url === url && row.denied === false)).toBe(false);
  });
});
