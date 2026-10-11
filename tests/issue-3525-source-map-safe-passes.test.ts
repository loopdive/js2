// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { sourceInput, typedOptions } from "./helpers/typed-program-fixtures.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { constantFold } from "../src/ir/passes/constant-fold.js";
import { createGvnCounters, gvnCore } from "../src/ir/passes/gvn-core.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { simplifyCFG } from "../src/ir/passes/simplify-cfg.js";
import { runTaggedUnions } from "../src/ir/passes/tagged-unions.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { assertPreparedSourceMap } from "../src/ir/program/validation.js";
import { PreparedIrProgramInvariantError, preparedIrDataMismatch } from "../src/ir/program.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import type { PreparedIrBackendOptions } from "../src/ir/program.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitWat } from "../src/emit/wat.js";
import { createJavaScriptAdapterManifest } from "../src/adapter-manifest.js";
import { resolveCompileTargetProfile } from "../src/target-profile.js";
import { generateImportsHelper } from "../src/compiler/output.js";

// These origins/catalogs are explicit DATA attachments, not Package B minted provenance.
const NUMERIC = `export function calculate(value:number):number {
 const a=value*2; const b=value*2; const unused=value+99;
 return a+b;
}
export function fixed(value:number):number { const sum=3+4; const neg=-3; return value+sum+neg; }
export function nested(value:number):number { return value>0 ? (2+3) : (4+5); }`;
const PEER = "export function calculate(value:number):number { return value+11; }";
const root = resolve(import.meta.dirname, "..");
const scratch = resolve(root, ".tmp/source-map-safe-passes");
function snapshot(value: unknown): string {
  return inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, sorted: true });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if ("value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
function instructions(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const instr of block.instrs) forEachInstrDeep(instr, (child) => found.push(child));
  return found;
}
function verified(fn: IrFunction): void {
  expect(verifyIrFunction(fn), "real SSA and type verifier, not metadata equality only").toEqual([]);
}
function seed(entry = NUMERIC, peer = PEER) {
  const files = { "./entry.ts": entry, "./peer.ts": peer };
  const original = sourceInput(files);
  const source = prepareIrProgramSources(original);
  if (source.kind !== "prepared") throw new Error(`genuine source refusal ${JSON.stringify(source)}`);
  const input = { source, packet: captureTypedIrProgramInput(source) };
  const mappedIr = structuredClone(input.packet.ir);
  expect(preparedIrDataMismatch(input.packet.ir, mappedIr)).toBeUndefined();
  const catalog = {
    schema: "prepared-ir-source-map-v1" as const,
    sources: input.packet.inventory.sources.map((source) => {
      const file = original.sourceFiles.find((candidate) => candidate.fileName === source.originalFileName);
      if (!file) throw new Error("source inventory lacks actual source file");
      return {
        sourceId: source.id,
        sourceKey: source.sourceKey,
        originalFileName: source.originalFileName,
        mapName: source.sourceKey,
        projection: { originalText: file.text, analyzedText: file.text, stages: [] },
      };
    }),
  };
  for (const fn of mappedIr.functions) {
    const unit = input.packet.inventory.allUnits.find((record) => record.id === fn.unitId);
    const declaration = original.sourceFiles
      .flatMap((file) => file.statements)
      .find((node) => {
        if (!unit || !ts.isFunctionDeclaration(node)) return false;
        return (
          node.getStart() === unit.declarationStart &&
          node.getEnd() === unit.declarationEnd &&
          node.getSourceFile().fileName ===
            catalog.sources.find((source) => source.sourceId === unit.sourceId)?.originalFileName
        );
      });
    if (!unit || !declaration || !ts.isFunctionDeclaration(declaration))
      throw new Error("actual function declaration join absent");
    const binary: ts.Node[] = [],
      unary: ts.Node[] = [],
      strings: ts.Node[] = [];
    const collect = (node: ts.Node): void => {
      ts.forEachChild(node, collect);
      if (ts.isBinaryExpression(node)) binary.push(node);
      if (ts.isPrefixUnaryExpression(node)) unary.push(node);
      if (ts.isStringLiteral(node)) strings.push(node);
    };
    collect(declaration);
    const point = (node: ts.Node) => {
      const start = node.getStart(),
        end = node.getEnd();
      const location = node.getSourceFile().getLineAndCharacterOfPosition(start);
      return {
        line: location.line + 1,
        column: location.character,
        origin: {
          kind: "source" as const,
          point: {
            sourceId: unit.sourceId,
            donorUnitId: unit.id,
            analyzed: { start, end },
            original: { start, end },
            mapping: "exact" as const,
          },
        },
      };
    };
    for (const instr of instructions(fn)) {
      const node =
        instr.kind === "binary" || instr.kind === "string.concat"
          ? binary.shift()
          : instr.kind === "unary"
            ? unary.shift()
            : instr.kind === "string.const"
              ? strings.shift()
              : declaration;
      if (!node) throw new Error("actual source operation population mismatch");
      Reflect.set(instr, "site", point(node));
    }
    for (const block of fn.blocks) Reflect.set(block.terminator, "site", point(declaration));
    verified(fn);
  }
  const mapped = { ...input.packet, ir: mappedIr, sourceMap: catalog };
  assertPreparedSourceMap(mapped);
  return { ...input, original, files, mapped, catalog, mappedIr };
}
function entryFunction(f: ReturnType<typeof seed>, name: string, mapped = true): IrFunction {
  const sourceId = f.packet.inventory.sources.find(
    (source) => source.originalFileName === f.original.entrySource.fileName,
  )!.id;
  const candidates = (mapped ? f.mappedIr : f.packet.ir).functions.filter(
    (fn) =>
      fn.name === name &&
      f.packet.inventory.allUnits.some((unit) => unit.id === fn.unitId && unit.sourceId === sourceId),
  );
  expect(candidates).toHaveLength(1);
  return candidates[0]!;
}
function view(f: ReturnType<typeof seed>, before: IrFunction, after: IrFunction) {
  const ir = { ...f.mappedIr, functions: f.mappedIr.functions.map((fn) => (fn.unitId === before.unitId ? after : fn)) };
  assertPreparedSourceMap({ ...f.mapped, ir });
  verified(after);
  return ir;
}
function erased(fn: IrFunction): IrFunction {
  const copy = structuredClone(fn);
  for (const instr of instructions(copy)) Reflect.deleteProperty(instr, "site");
  for (const block of copy.blocks) Reflect.deleteProperty(block.terminator, "site");
  return copy;
}
function native(files: Record<string, string>, name: string, values: number[]): number[] {
  const source = files["./entry.ts"]!;
  const exports: Record<string, (value: number) => number> = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } })
      .outputText,
    { exports },
  );
  return values.map((value) => exports[name]!(value));
}
async function artifact(
  f: ReturnType<typeof seed>,
  fn: IrFunction,
  backend: "wasmgc" | "linear",
  name: string,
  args: number[],
) {
  const input = {
    ...f.packet,
    ir: {
      ...f.packet.ir,
      functions: f.packet.ir.functions.map((old) => (old.unitId === fn.unitId ? erased(fn) : old)),
    },
  };
  expect(Object.hasOwn(input, "sourceMap")).toBe(false);
  const prepared = prepareTypedIrProgram(input, {
    ...typedOptions,
    policy: { backend, target: "host" },
    runtimePolicies: [{ backend, target: "host" }],
  });
  if (prepared.kind !== "prepared") throw new Error(`real typed producer refusal ${JSON.stringify(prepared)}`);
  expect(Object.hasOwn(prepared.program, "sourceMap")).toBe(false);
  const wire = encodePreparedIrProgram(prepared.program);
  expect(encodePreparedIrProgram(decodePreparedIrProgram(wire))).toBe(wire);
  const accepted = acceptPreparedIrProgram(prepared.program, {
    backend,
    target: "host",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "safe-pass-data",
  } satisfies PreparedIrBackendOptions);
  if (accepted.kind !== "accepted") throw new Error(`real consumer refusal ${JSON.stringify(accepted)}`);
  const emitted = emitAcceptedIrProgram(accepted);
  expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((body) => body.unitId));
  expect(emitted.module.imports).toEqual([]);
  const binary = emitBinary(emitted.module),
    wat = emitWat(emitted.module);
  const { instance } = await WebAssembly.instantiate(new Uint8Array(binary));
  const callable = instance.exports[name];
  if (typeof callable !== "function") throw new Error("real numeric export absent");
  const direct = args.map((value) => callable(value));
  const manifest = createJavaScriptAdapterManifest({
    targetProfile: resolveCompileTargetProfile({ target: backend === "linear" ? "linear" : "gc" }),
    imports: [],
    stringPool: emitted.module.stringPool,
    exportSignatures: emitted.module.exportSignatures,
  });
  const helper = generateImportsHelper(manifest);
  mkdirSync(scratch, { recursive: true });
  const folder = mkdtempSync(resolve(scratch, "helper-"));
  writeFileSync(resolve(folder, "helper.mjs"), helper);
  writeFileSync(resolve(folder, "module.wasm"), binary);
  writeFileSync(resolve(folder, "canonical-program.txt"), wire);
  writeFileSync(resolve(folder, "module.wat"), wat);
  writeFileSync(resolve(folder, "physical-functions.txt"), snapshot(emitted.module.functions));
  writeFileSync(resolve(folder, "source-input.json"), JSON.stringify(f.files, null, 2));

  writeFileSync(
    resolve(folder, "runner.mts"),
    `import {registerHooks} from 'node:module';import {pathToFileURL} from 'node:url';import fs from 'node:fs';registerHooks({resolve(specifier,context,next){return specifier==='js2wasm'?{url:pathToFileURL(${JSON.stringify(resolve(root, "src/index.ts"))}).href,shortCircuit:true}:next(specifier,context);}});const helper=await import('./helper.mjs');const result=await helper.instantiateBytes(fs.readFileSync(new URL('./module.wasm',import.meta.url)));console.log(JSON.stringify(${JSON.stringify(args)}.map(value=>result.exports[${JSON.stringify(name)}](value))));`,
  );
  const child = spawnSync(process.execPath, ["--import", "tsx", resolve(folder, "runner.mts")], {
    cwd: root,
    encoding: "utf8",
  });
  writeFileSync(resolve(folder, "stdout"), child.stdout ?? "");
  writeFileSync(resolve(folder, "stderr"), child.stderr ?? "");
  writeFileSync(
    resolve(folder, "terminal.json"),
    JSON.stringify(
      { pid: child.pid, status: child.status, signal: child.signal, error: child.error?.message },
      null,
      2,
    ),
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe("");
  const helperValues: unknown = JSON.parse(child.stdout.trim());
  expect(helperValues).toEqual(direct);
  console.log(
    "SAFE_PASS_ARTIFACT",
    JSON.stringify({
      backend,
      name,
      args,
      direct,
      helperValues,
      wireBytes: Buffer.byteLength(wire),
      binaryBytes: binary.length,
      helperSha256: createHash("sha256").update(helper).digest("hex"),
      folder,
    }),
  );
  return { wire, binary, wat, helper, direct, physical: emitted.module.functions };
}

describe("five safe-pass source-map DATA preservation on genuine source IR", () => {
  it.each(["fixed", "nested"])(
    "folds real scalar/unary or nested operations in %s retaining replaced primary source points",
    (name) => {
      const f = seed(),
        before = freeze(entryFunction(f, name)),
        old = snapshot(before),
        operations = instructions(before).filter((instr) => instr.kind === "binary" || instr.kind === "unary");
      const after = constantFold(before);
      expect(after).not.toBe(before);
      verified(after);
      view(f, before, after);
      const folded = operations.filter((op) =>
        instructions(after).some((instr) => instr.result === op.result && instr.kind === "const"),
      );
      expect(folded.length).toBeGreaterThan(0);
      for (const op of folded) {
        const replacement = instructions(after).find((instr) => instr.result === op.result)!;
        expect(replacement.site).toBe(op.site);
        if (replacement.kind !== "const" || op.site?.origin?.kind !== "source")
          throw new Error("folded source operation/constant absent");
        const point = op.site.origin.point;
        const source = f.catalog.sources.find((row) => row.sourceId === point.sourceId)!;
        const expression = source.projection.originalText.slice(point.original.start, point.original.end);
        const expected = runInNewContext(`(${expression})`);
        if (!("value" in replacement.value)) throw new Error("folded primitive value absent");
        expect(Object.is(replacement.value.value, expected), `actual native expression ${expression}`).toBe(true);
      }
      expect(snapshot(before)).toBe(old);
      console.log(
        "SAFE_PASS_FOLD",
        JSON.stringify({
          name,
          before: instructions(before).length,
          after: instructions(after).length,
          folded: folded.length,
          sites: folded.map((op) => op.site),
        }),
      );
    },
  );
  it("folds actual source string concatenation and retains the concat operation rather than operand origin", () => {
    const f = seed(
      'export function text():string { return "ab"+"cd"; }',
      'export function text():string { return "peer"; }',
    );
    const before = freeze(entryFunction(f, "text")),
      old = snapshot(before),
      concat = instructions(before).find((instr) => instr.kind === "string.concat");
    expect(concat).toBeDefined();
    const after = constantFold(before);
    view(f, before, after);
    const folded = instructions(after).find((instr) => instr.result === concat!.result);
    expect(folded?.kind).toBe("string.const");
    if (!folded || folded.kind !== "string.const") throw new Error("actual string concatenation did not fold");
    expect(folded.value).toBe("abcd");
    expect(folded.site).toBe(concat!.site);
    expect(snapshot(before)).toBe(old);
  });
  it("merges real dominating duplicates with distinct sites while retaining survivor and actual semantic counters", () => {
    const f = seed(),
      before = freeze(entryFunction(f, "calculate")),
      old = snapshot(before);
    const duplicates = instructions(before).filter((instr) => instr.kind === "binary" && instr.op === "f64.mul");
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]!.site).not.toEqual(duplicates[1]!.site);
    const counters = createGvnCounters(),
      plainCounters = createGvnCounters();
    const after = gvnCore(before, {}, counters),
      plain = gvnCore(entryFunction(f, "calculate", false), {}, plainCounters);
    expect(counters.merged).toBeGreaterThan(0);
    expect(counters).toEqual(plainCounters);
    expect(counters.poisoned).toBe(0);
    view(f, before, after);
    const live = deadCode(after);
    verified(live);
    expect(instructions(live).filter((instr) => instr.kind === "binary" && instr.op === "f64.mul")).toHaveLength(1);
    expect(instructions(live).find((instr) => instr.result === duplicates[0]!.result)?.site).toBe(duplicates[0]!.site);
    expect(snapshot(erased(live))).toBe(snapshot(erased(deadCode(plain))));
    expect(snapshot(before)).toBe(old);
    console.log(
      "SAFE_PASS_GVN",
      JSON.stringify({
        counters,
        before: instructions(before).length,
        after: instructions(live).length,
        survivor: duplicates[0]!.result,
      }),
    );
  });
  it("deletes genuine dead operations while retaining every actual surviving operation and exit origin", () => {
    const f = seed(),
      before = freeze(entryFunction(f, "calculate")),
      old = snapshot(before),
      after = deadCode(before);
    expect(after).not.toBe(before);
    expect(instructions(after).length).toBeLessThan(instructions(before).length);
    view(f, before, after);
    for (const instr of instructions(after)) expect(instructions(before)).toContain(instr);
    expect(after.blocks[0]!.terminator).toBe(before.blocks[0]!.terminator);
    expect(snapshot(before)).toBe(old);
  });
  it("keeps same-spelling source donors distinct and tagged-union validation returns the actual same module", () => {
    const f = seed();
    const same = f.mappedIr.functions.filter((fn) => fn.name === "calculate");
    expect(same).toHaveLength(2);
    expect(same[0]!.unitId).not.toBe(same[1]!.unitId);
    expect(instructions(same[0]!)[0]!.site!.origin).not.toEqual(instructions(same[1]!)[0]!.site!.origin);
    const module = freeze(f.mappedIr),
      old = snapshot(module),
      result = runTaggedUnions(module);
    expect(result.module).toBe(module);
    expect(result.errors).toEqual([]);
    expect(snapshot(module)).toBe(old);
    assertPreparedSourceMap({ ...f.mapped, ir: result.module });
  });
  it.each(["missing", "cross-source", "causal"])(
    "rejects %s mutated DATA provenance with actual healthy/restored witness",
    (mutation) => {
      const f = seed();
      const before = entryFunction(f, "calculate"),
        instr = instructions(before).find((item) => item.kind === "binary")!;
      assertPreparedSourceMap(f.mapped);
      const original = instr.site;
      if (mutation === "missing") Reflect.deleteProperty(instr, "site");
      if (mutation === "cross-source")
        Reflect.set(
          instr,
          "site",
          instructions(f.mappedIr.functions.find((fn) => fn.name === "calculate" && fn.unitId !== before.unitId)!)[0]!
            .site,
        );
      if (mutation === "causal") {
        const changed = structuredClone(original!);
        if (changed.origin?.kind !== "source") throw new Error("healthy primary source point absent");
        Reflect.set(changed.origin.point, "original", { start: 0, end: 1 });
        Reflect.set(instr, "site", changed);
      }
      let error: unknown;
      try {
        assertPreparedSourceMap(f.mapped);
      } catch (caught) {
        error = caught;
      } finally {
        Reflect.set(instr, "site", original);
      }
      assertPreparedSourceMap(f.mapped);
      expect(error).toBeInstanceOf(PreparedIrProgramInvariantError);
      expect(Reflect.get(error as object, "code")).toBe("invalid-prepared-data");
      expect((error as Error).message).toContain("source map:");
    },
  );
  it.each(["wasmgc", "linear"] as const)(
    "%s real numeric native/binary/original-helper before-after and no-map preservation",
    async (backend) => {
      const f = seed();
      const fn = entryFunction(f, "calculate", false),
        mapped = entryFunction(f, "calculate"),
        counters = createGvnCounters(),
        mappedCounters = createGvnCounters();
      const optimized = deadCode(gvnCore(fn, {}, counters)),
        mappedAfter = deadCode(gvnCore(mapped, {}, mappedCounters));
      expect(counters.merged).toBeGreaterThan(0);
      expect(mappedCounters).toEqual(counters);
      const args = [3, -2, 0],
        expected = native(f.files, "calculate", args);
      const before = await artifact(f, fn, backend, "calculate", args),
        after = await artifact(f, optimized, backend, "calculate", args),
        dataAfter = await artifact(f, mappedAfter, backend, "calculate", args);
      expect(before.direct).toEqual(expected);
      expect(after.direct).toEqual(expected);
      expect(dataAfter.direct).toEqual(expected);
      expect(dataAfter.wire).toBe(after.wire);
      expect(dataAfter.binary).toEqual(after.binary);
      expect(dataAfter.wat).toBe(after.wat);
      expect(dataAfter.helper).toBe(after.helper);
      expect(dataAfter.physical).toEqual(after.physical);
      const poison = createGvnCounters(),
        poisoned = gvnCore(fn, { poison: true }, poison);
      expect(poison.poisoned).toBeGreaterThan(0);
      verified(poisoned);
      const wrong = await artifact(f, poisoned, backend, "calculate", args);
      expect(wrong.direct).not.toEqual(expected);
      console.log("SAFE_PASS_POISON", JSON.stringify({ backend, expected, wrong: wrong.direct, counters: poison }));
    },
  );
  it("unchanged pass controls preserve identities and record original no-map own-site presence", () => {
    const f = seed(
      "export function identity(value:number):number { return value; }",
      "export function identity(value:number):number { return value; }",
    );
    const fn = freeze(entryFunction(f, "identity")),
      old = snapshot(fn),
      counts = createGvnCounters();
    expect(constantFold(fn)).toBe(fn);
    expect(gvnCore(fn, {}, counts)).toBe(fn);
    expect(deadCode(fn)).toBe(fn);
    expect(simplifyCFG(fn)).toBe(fn);
    expect(counts.merged).toBe(0);
    expect(snapshot(fn)).toBe(old);
    const plain = seed();
    const original = entryFunction(plain, "fixed", false),
      folded = constantFold(original);
    console.log(
      "ORIGINAL_NO_MAP_SITE_PRESENCE",
      JSON.stringify({
        before: instructions(original).filter((instr) => Object.hasOwn(instr, "site")).length,
        after: instructions(folded).filter((instr) => Object.hasOwn(instr, "site")).length,
        ownUndefined: instructions(folded).filter((instr) => Object.hasOwn(instr, "site") && instr.site === undefined)
          .length,
      }),
    );
  });
});

// Genuine frontend CFG with explicit DATA sites; no handcrafted Prepared packet.
function cfgData() {
  const f = seed(
    "export function control():number { if(1+1>3){return 7;}else{return 9;} }",
    "export function control():number { return 11; }",
  );
  const fn = entryFunction(f, "control");
  expect(fn.blocks).toHaveLength(3);
  expect(fn.blocks[0]!.terminator.kind).toBe("br_if");
  verified(fn);
  console.log(
    "GENUINE_CFG_DATA_SEED",
    JSON.stringify({ source: f.files["./entry.ts"], original: fn, folded: constantFold(fn) }),
  );
  return { f, fn };
}
describe("five safe-pass lower-level CFG DATA floors", () => {
  it("folds an actual constant SSA branch and retains replaced terminator primary origin", () => {
    const { f, fn } = cfgData();
    freeze(fn);
    const before = snapshot(fn),
      after = constantFold(fn);
    expect(fn.blocks[0]!.terminator.kind).toBe("br_if");
    expect(after.blocks[0]!.terminator.kind).toBe("br");
    if (after.blocks[0]!.terminator.kind !== "br" || fn.blocks[0]!.terminator.kind !== "br_if")
      throw new Error("actual branch fold absent");
    expect(after.blocks[0]!.terminator.branch.target).toBe(fn.blocks[0]!.terminator.ifFalse.target);
    expect(native(f.files, "control", [0])).toEqual([9]);
    expect(after.blocks[0]!.terminator.site).toBe(fn.blocks[0]!.terminator.site);
    view(f, fn, after);
    expect(snapshot(fn)).toBe(before);
    const live = deadCode(after);
    expect(live.blocks.length).toBeLessThan(after.blocks.length);
    expect(
      instructions(live)
        .filter((instr) => instr.kind === "const" && instr.value.kind === "f64")
        .map((instr) => (instr.kind === "const" && instr.value.kind === "f64" ? instr.value.value : undefined)),
    ).toEqual([9]);
    verified(live);
    view(f, fn, live);
    for (const block of live.blocks)
      expect(after.blocks.some((old) => old.terminator.site === block.terminator.site)).toBe(true);
    console.log(
      "SAFE_PASS_CFG_BRANCH",
      JSON.stringify({
        before: fn.blocks.length,
        afterFold: after.blocks.length,
        afterDead: live.blocks.length,
        branch: after.blocks[0]!.terminator,
      }),
    );
  });
  it("merges and renumbers verified CFG blocks preserving actual moved instructions and final exit", () => {
    const { f, fn } = cfgData();
    const linked = deadCode(constantFold(fn));
    const left = linked.blocks[1]!;
    expect(linked.blocks).toHaveLength(2);
    expect(fn.blocks[0]!.terminator.kind).toBe("br_if");
    if (fn.blocks[0]!.terminator.kind !== "br_if") throw new Error("genuine branch absent");
    expect(fn.blocks[0]!.terminator.ifFalse.target).toBe(2);
    expect(linked.blocks[0]!.terminator.kind).toBe("br");
    if (linked.blocks[0]!.terminator.kind !== "br") throw new Error("actual folded branch absent");
    expect(linked.blocks[0]!.terminator.branch.target).toBe(1);
    verified(linked);
    view(f, fn, linked);
    freeze(linked);
    const before = snapshot(linked),
      after = simplifyCFG(linked);
    expect(after).not.toBe(linked);
    expect(after.blocks).toHaveLength(1);
    verified(after);
    view(f, fn, after);
    expect(after.blocks[0]!.instrs).toEqual(left.instrs);
    for (const instr of after.blocks[0]!.instrs) expect(left.instrs).toContain(instr);
    expect(after.blocks[0]!.id).toBe(0);
    expect(after.blocks[0]!.terminator).toBe(left.terminator);
    const final = simplifyCFG(after);
    expect(final).toBe(after);
    expect(final.blocks).toHaveLength(1);
    verified(final);
    expect(final.blocks[0]!.terminator).toBe(left.terminator);
    view(f, fn, final);
    expect(snapshot(linked)).toBe(before);
    console.log(
      "SAFE_PASS_CFG_MERGE",
      JSON.stringify({ before: linked.blocks.length, after: after.blocks.length, final: final.blocks.length }),
    );
  });
});
