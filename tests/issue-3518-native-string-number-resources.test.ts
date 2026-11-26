// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
  requireNativeStringNumberReservations,
  requireCompletedNativeStringNumber,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import * as scaling from "../src/runtime/wasmgc/values/decimal-scale-bodies.js";
import * as scanner from "../src/runtime/wasmgc/values/string-number-bodies.js";
import {
  scannerCases,
  scannerSemanticDebtCases,
  scannerExponentRepairCases,
  executeScannerResourceFixture,
} from "./fixtures/issue-3518-native-string-number-donor.js";

afterEach(async () => {
  await setImmediate();
});
const root = resolve(import.meta.dirname, "..");
function scratch(prefix: string): string {
  mkdirSync(resolve(root, ".tmp"), { recursive: true });
  return mkdtempSync(resolve(root, ".tmp", prefix));
}
const paths = {
  adapter: "src/codegen/parse-number-native.ts",
  grammar: "src/runtime/wasmgc/values/string-number-grammar.ts",
  scaling: "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
  scanner: "src/runtime/wasmgc/values/string-number-bodies.ts",
  owner: "src/backend/wasmgc/resources/native-string-number.ts",
} as const;
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
describe("decimal power table and scanner resources", () => {
  it("pins all 309 original decimal powers and immutable descriptors", () => {
    expect(scaling.buildDecimalPowerArrayType()).toEqual({
      kind: "array",
      name: "Pow10TableF64",
      element: { kind: "f64" },
      mutable: false,
    });
    const init = scaling.buildDecimalPowerArrayInitializer(43);
    expect(init).toEqual([
      ...Array.from({ length: 309 }, (_, k) => ({ op: "f64.const", value: Number(`1e${k}`) })),
      { op: "array.new_fixed", typeIdx: 43, length: 309 },
    ]);
    expect(
      scanner.buildStringToNumberLocals({
        nativeStrDataTypeIdx: 0,
        anyStrTypeIdx: 1,
        nativeStrTypeIdx: 2,
        consStrTypeIdx: 3,
        hashedStrTypeIdx: 4,
        utf8StrDataTypeIdx: -1,
        utf8StrTypeIdx: -1,
      }),
    ).toHaveLength(19);
  });
});
function prepare() {
  const { packet } = sourcePacket({ "./entry.ts": "export function main(value: number): number { return value; }" });
  const program = requireProgram(prepareTypedIrProgram(packet, typedOptions));
  const encoded = encodePreparedIrProgram(program);
  const decoded = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(decoded)).toBe(encoded);
  return {
    program,
    decoded,
    encoded,
    plan: deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string"),
  };
}
/** Reuse the exact success or failure; a failed fixture must not rebuild for every assertion. */
function cacheFixtureOutcome<T>(operation: () => T): () => T {
  let outcome: { kind: "value"; value: T } | { kind: "error"; error: unknown } | undefined;
  return () => {
    if (outcome === undefined) {
      try {
        outcome = { kind: "value", value: operation() };
      } catch (error) {
        outcome = { kind: "error", error };
      }
    }
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  };
}
describe("shared scanner fixture outcome caching", () => {
  it("returns the same successful object without rebuilding", () => {
    let calls = 0;
    const value = {};
    const get = cacheFixtureOutcome(() => {
      calls++;
      return value;
    });
    expect(get()).toBe(value);
    expect(get()).toBe(value);
    expect(calls).toBe(1);
  });
  it("caches a successful undefined result", () => {
    let calls = 0;
    const get = cacheFixtureOutcome(() => {
      calls++;
    });
    expect(get()).toBeUndefined();
    expect(get()).toBeUndefined();
    expect(calls).toBe(1);
  });
  it("rethrows the identical failure with its original stack and cause on every use", () => {
    let calls = 0;
    const cause = new Error("underlying fixture failure");
    const failure = new Error("scanner fixture failed", { cause });
    const stack = failure.stack;
    const get = cacheFixtureOutcome(() => {
      calls++;
      throw failure;
    });
    const caught: unknown[] = [];
    for (let attempt = 0; attempt < 46; attempt++) {
      try {
        get();
      } catch (error) {
        caught.push(error);
      }
    }
    expect(calls).toBe(1);
    expect(caught).toHaveLength(46);
    for (const error of caught) expect(error).toBe(failure);
    expect(failure.stack).toBe(stack);
    expect(failure.cause).toBe(cause);
  });
  it("does not mistake a thrown undefined for an uninitialized or successful cache", () => {
    let calls = 0;
    const get = cacheFixtureOutcome(() => {
      calls++;
      throw undefined;
    });
    const caught: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        get();
      } catch (error) {
        caught.push(error);
      }
    }
    expect(calls).toBe(1);
    expect(caught).toEqual([undefined, undefined]);
  });
});
const actual = cacheFixtureOutcome(prepare);
const texts = [...scannerCases, ...scannerSemanticDebtCases].map(([, text]) => text);
function reserve(utf8 = false) {
  const mod = createEmptyModule(),
    tx = new PhysicalModuleReservations(mod);
  const stringPack = reserveNativeStringLiteralResources(tx, {
    key: "scanner:strings",
    utf8Storage: utf8,
    literals: [
      { value: "", encoding: "wtf16" },
      ...texts.map((value) => ({ value, encoding: "wtf16" as const })),
      { value: "xx3000000000yy", encoding: "wtf16" },
      ...(utf8 ? [{ value: "\u00a0\u200042", encoding: "utf8-guaranteed" as const }] : []),
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "scanner:flatten", stringPack);
  const pack = reserveNativeStringNumberResources(tx, actual().plan, flatten);
  return { mod, tx, stringPack, flatten, pack, plan: actual().plan };
}
function complete() {
  const s = reserve();
  s.tx.freezeReservations();
  fillNativeStringLiteralResources(s.tx, s.stringPack);
  fillNativeStringFlattenResources(s.tx, s.flatten);
  fillNativeStringNumberResources(s.tx, s.pack);
  return s;
}
function admitted(s: ReturnType<typeof reserve>) {
  return requireCompletedNativeStringNumber(s.tx, s.pack, s.plan, s.stringPack);
}
describe("issued scanner reservation and completion authority", () => {
  it("authenticates the exact producer in reserving phase without physical indices", () => {
    const s = reserve();
    expect(s.tx.state).toBe("reserving");
    expect(requireNativeStringNumberReservations(s.tx, s.pack, s.plan, s.stringPack)).toBe(s.pack);
    expect(s.tx.state).toBe("reserving");
    expect(() => admitted(s)).toThrow("incomplete");
  });
  it("completes the actual canonical dependency chain", () => {
    const s = complete();
    expect(admitted(s)).toBe(s.pack);
    const census = s.tx.seal();
    expect(census.completedGlobals).toBe(s.mod.globals.length);
    expect(census.completedFunctions).toBe(s.mod.functions.length);
    expect(admitted(s)).toBe(s.pack);
  });
  it.each(["equal-issued-plan", "clone-plan", "foreign-strings"] as const)(
    "completion rejects %s after its real positive",
    (mode) => {
      const s = complete();
      expect(admitted(s)).toBe(s.pack);
      const expectedPlan =
        mode === "equal-issued-plan"
          ? deriveNativeValueResourcePlan(actual().program, actual().program.runtime[0]!, "native-string")
          : mode === "clone-plan"
            ? { ...s.plan }
            : s.plan;
      const expectedStrings = mode === "foreign-strings" ? { ...s.stringPack } : s.stringPack;
      expect(() => requireCompletedNativeStringNumber(s.tx, s.pack, expectedPlan, expectedStrings)).toThrow();
    },
  );
  it("rejects a missing completed selected decoder", () => {
    const s = reserve(true);
    s.tx.freezeReservations();
    fillNativeStringLiteralResources(s.tx, s.stringPack);
    fillNativeStringFlattenResources(s.tx, s.flatten);
    fillNativeStringNumberResources(s.tx, s.pack);
    expect(admitted(s)).toBe(s.pack);
    expect(s.flatten.utf8Decoder).not.toBeNull();
    s.mod.functions.splice(s.mod.functions.indexOf(s.flatten.utf8Decoder!.object), 1);
    expect(() => admitted(s)).toThrow();
  });
  it.each(["clone-pack", "foreign-tx", "clone-plan", "equal-issued-plan", "foreign-strings", "clone-flatten"] as const)(
    "rejects %s before scanner allocation",
    (mode) => {
      const s = reserve();
      expect(requireNativeStringNumberReservations(s.tx, s.pack, s.plan, s.stringPack)).toBe(s.pack);
      const counts = [s.mod.types.length, s.mod.functions.length, s.mod.globals.length];
      const otherPlan = deriveNativeValueResourcePlan(actual().program, actual().program.runtime[0]!, "native-string");
      expect(otherPlan).toEqual(s.plan);
      expect(otherPlan).not.toBe(s.plan);
      const attempt = () => {
        if (mode === "clone-flatten") return reserveNativeStringNumberResources(s.tx, s.plan, { ...s.flatten });
        return requireNativeStringNumberReservations(
          mode === "foreign-tx" ? new PhysicalModuleReservations(createEmptyModule()) : s.tx,
          mode === "clone-pack" ? { ...s.pack } : s.pack,
          mode === "clone-plan" ? { ...s.plan } : mode === "equal-issued-plan" ? otherPlan : s.plan,
          mode === "foreign-strings" ? { ...s.stringPack } : s.stringPack,
        );
      };
      expect(attempt).toThrow();
      expect([s.mod.types.length, s.mod.functions.length, s.mod.globals.length]).toEqual(counts);
    },
  );
  it("rejects a cloned plan at reservation before allocating", () => {
    const s = reserve(),
      count = s.mod.functions.length;
    expect(() => reserveNativeStringNumberResources(s.tx, { ...s.plan }, s.flatten)).toThrow("unissued");
    expect(s.mod.functions).toHaveLength(count);
  });
  it.each(["literal", "flatten", "power", "scanner"] as const)("never promotes missing %s fill", (missing) => {
    const s = reserve();
    s.tx.freezeReservations();
    if (missing !== "literal") fillNativeStringLiteralResources(s.tx, s.stringPack);
    if (missing === "power" || missing === "scanner") fillNativeStringFlattenResources(s.tx, s.flatten);
    if (missing === "scanner")
      s.tx.fillGlobal(s.pack.powerGlobal, scaling.buildDecimalPowerArrayInitializer(s.pack.powerArray.typeIndex));
    if (missing === "power")
      s.tx.fillFunction(s.pack.toNumber, {
        locals: scanner.buildStringToNumberLocals(s.stringPack.layout),
        body: [
          ...scanner.buildStringToNumberPrelude(s.stringPack.layout, s.flatten.flatten.handle),
          ...scanner.buildStringToNumberResult({
            arrayTypeIndex: s.pack.powerArray.typeIndex,
            globalIndex: s.tx.physicalIndex(s.pack.powerGlobal),
          }),
        ],
      });
    expect(() => admitted(s)).toThrow();
    if (missing === "literal" || missing === "flatten")
      expect(() => fillNativeStringNumberResources(s.tx, s.pack)).toThrow();
  });
  it.each(["constant", "copied-body"] as const)(
    "refuses a manually filled %s even with correct tokens/name/signature",
    (mode) => {
      const s = reserve();
      s.tx.freezeReservations();
      fillNativeStringLiteralResources(s.tx, s.stringPack);
      fillNativeStringFlattenResources(s.tx, s.flatten);
      s.tx.fillGlobal(s.pack.powerGlobal, scaling.buildDecimalPowerArrayInitializer(s.pack.powerArray.typeIndex));
      s.tx.fillFunction(
        s.pack.toNumber,
        mode === "constant"
          ? { locals: [], body: [{ op: "f64.const", value: 42 }] }
          : {
              locals: scanner.buildStringToNumberLocals(s.stringPack.layout),
              body: [
                ...scanner.buildStringToNumberPrelude(s.stringPack.layout, s.flatten.flatten.handle),
                ...scanner.buildStringToNumberResult({
                  arrayTypeIndex: s.pack.powerArray.typeIndex,
                  globalIndex: s.tx.physicalIndex(s.pack.powerGlobal),
                }),
              ],
            },
      );
      expect(() => admitted(s)).toThrow("incomplete");
    },
  );
  it.each([
    "body",
    "locals",
    "power-entry",
    "power-count",
    "power-mutable",
    "array-mutable",
    "empty-literal",
    "reorder",
  ] as const)("rejects changed completed %s", (mode) => {
    const s = complete();
    expect(admitted(s)).toBe(s.pack);
    if (mode === "body") s.pack.toNumber.object.body = [{ op: "f64.const", value: 42 }];
    if (mode === "locals") s.pack.toNumber.object.locals = [];
    if (mode === "power-entry") s.pack.powerGlobal.object.init[0] = { op: "f64.const", value: 2 };
    if (mode === "power-count") s.pack.powerGlobal.object.init.pop();
    if (mode === "power-mutable") s.pack.powerGlobal.object.mutable = true;
    if (mode === "array-mutable") Object.assign(s.pack.powerArray.object, { mutable: true });
    if (mode === "empty-literal")
      s.flatten.emptyLiteral.object.init = [{ op: "ref.null", typeIdx: s.stringPack.layout.nativeStrTypeIdx }];
    if (mode === "reorder") s.mod.functions.reverse();
    expect(() => admitted(s)).toThrow();
  });
});

const execution = cacheFixtureOutcome(() => executeScannerResourceFixture(actual().program));
describe("actual owned native-string → flatten → scanner → unbox execution", () => {
  it("pins the actual whitespace scalar input without literal backslash escapes", () => {
    const row = scannerCases.find(([name]) => name === "whitespace")!;
    expect([...row[1]].map((char) => char.codePointAt(0))).toEqual([9, 160, 8192, 32, 52, 50, 32, 8232, 65279]);
    expect(row[1]).not.toContain("\\");
    expect(Number(row[1])).toBe(42);
    expect(row[2]).toBe(42);
  });
  it("instantiates the exact retained binary twice with zero imports and complete resources", () => {
    const r = execution();
    expect(r.bytes).toBe(r.instantiatedBytes);
    expect(r.bytes.length).toBeGreaterThan(100);
    expect(r.imports).toEqual([]);
    expect(r.wat).toContain("__str_to_number");
    expect(r.census.completedFunctions).toBe(r.resources.functions.length);
    expect(r.census.completedGlobals).toBe(r.resources.globals.length);
    expect(r.programOwners).toEqual(actual().program.ir.functions.map((f) => f.unitId));
    expect(r.programOwners.length).toBeGreaterThan(0);
    expect(r.resources.functions.map((f) => f.name)).toEqual([
      "__str_copy_tree",
      "__str_utf8_to_flat",
      "__str_flatten",
      "__str_to_number",
      "__box_number",
      "__unbox_number",
      "__typeof_number",
      ...[...scannerCases, ...scannerSemanticDebtCases, ...scannerExponentRepairCases].flatMap(([name]) =>
        ["wtf16", "utf8-guaranteed"].flatMap((encoding) =>
          ["flat", "offset"].map((view) => name + "__" + encoding + "__" + view),
        ),
      ),
      "offset",
      "ropeValue",
      "memo",
      "utf8",
    ]);
    expect(scannerCases).toHaveLength(20);
    expect(scannerSemanticDebtCases).toHaveLength(3);
    expect(scannerExponentRepairCases).toHaveLength(16);
    expect(r.resources.recipeCount).toBe(156);
    expect(r.observations.map((instance) => instance.rows.length)).toEqual([156, 156]);
  });
  it.each([...scannerCases, ...scannerExponentRepairCases, ...scannerSemanticDebtCases.slice(0, 2)])(
    "executes %s from real GC string resources",
    (name, text, expected) => {
      for (const instance of execution().observations) {
        const rows = instance.rows.filter((r) => r.name === name);
        expect(rows).toHaveLength(4);
        expect(rows.map((row) => [row.encoding, row.view, row.offset])).toEqual([
          ["wtf16", "flat", 0],
          ["wtf16", "offset", 2],
          ["utf8-guaranteed", "flat", 0],
          ["utf8-guaranteed", "offset", 2],
        ]);
        for (const row of rows) {
          expect(row.text).toBe(text);
          expect(row.semanticOK).toBe(true);
          expect(row.values).toEqual([row.expected, row.expected]);
          expect(row.expected).toBe(Number.isNaN(expected) ? "NaN" : Object.is(expected, -0) ? "-0" : String(expected));
        }
      }
    },
  );
  it.each(["offset", "ropeValue", "memo", "utf8"])("executes %s twice per instance", (name) => {
    const expected = name === "offset" ? 3e9 : name === "memo" ? 1 : 42;
    for (const instance of execution().observations)
      expect(instance.extras.find((row) => row.name === name)?.values).toEqual([expected, expected]);
    expect(execution().resources.pendingRightChildren).toBe(40);
    expect(execution().resources.utf8Decoder).toBe("__str_utf8_to_flat");
  });
  it("requires repaired exponent semantics while retaining the independent precision debt", () => {
    const r = execution();
    const directory = scratch("native-scanner-semantics-");
    // Persist complete values even when one of the following semantic checks
    // fails. R1's wrong outcomes and original donor remain separate receipts.
    writeFileSync(
      resolve(directory, "receipt.json"),
      JSON.stringify(
        {
          ...r,
          scope: "resource-producer execution; not public compiler preservation",
          semanticOK: r.observations.every((instance) => instance.rows.every((row) => row.semanticOK)),
          requiredSemanticOK: r.observations.every((instance) =>
            instance.rows.filter((row) => row.name !== "precision").every((row) => row.semanticOK),
          ),
          precisionDebtAssessedComplete: false,
          wholeProgramExecutionAssessed: false,
        },
        null,
        2,
      ),
    );
    const rows = r.observations.map((instance) =>
      instance.rows.filter((row) => scannerSemanticDebtCases.some(([name]) => name === row.name)),
    );
    expect(rows.map((a) => a.length)).toEqual([12, 12]);
    expect(rows[0]).toEqual(rows[1]);
    for (const instance of rows)
      for (const row of instance) {
        expect(row.values).toHaveLength(2);
        expect(row.values[0]).toBe(row.values[1]);
        expect(row.semanticOK).toBe(row.values.every((v) => v === row.expected));
        if (row.name !== "precision") {
          expect(row.expected).toBe("NaN");
          expect(row.semanticOK).toBe(true);
          expect(row.values).toEqual(["NaN", "NaN"]);
        }
      }
  });
  it("replays actual canonical prepared bytes into identical emitted bytes/WAT/order/results", () => {
    expect(executeScannerResourceFixture(actual().decoded)).toEqual(execution());
  });
  it("executes unchanged public standalone parseFloat prefix and parseInt grammars", async () => {
    const { compile } = await import("../src/index.js");
    const source = `
      export function floatPrefix(): number { return parseFloat("1e+"); }
      export function intPrefix(): number { return parseInt("1e+", 10); }
      export function intHex(): number { return parseInt("0x1e", 0); }
      export function intNegative(): number { return parseInt(" -7px", 10); }
    `;
    const result = await compile(source, { target: "standalone", emitWat: true, fileName: "scanner-prefix.ts" });
    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(result.wat).toContain("parseFloat");
    expect(result.wat).toContain("parseInt");
    const compiled = new WebAssembly.Module(result.binary as BufferSource);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const observations = [];
    for (let instance = 0; instance < 2; instance++) {
      const exports = new WebAssembly.Instance(compiled, {}).exports as Record<string, () => number>;
      observations.push(
        Object.fromEntries(
          ["floatPrefix", "intPrefix", "intHex", "intNegative"].map((name) => [
            name,
            [exports[name]!(), exports[name]!()],
          ]),
        ),
      );
    }
    const directory = scratch("native-scanner-legacy-prefix-");
    writeFileSync(
      resolve(directory, "receipt.json"),
      JSON.stringify(
        {
          source,
          bytes: Buffer.from(result.binary).toString("base64"),
          instantiatedBytes: Buffer.from(result.binary).toString("base64"),
          wat: result.wat,
          imports: WebAssembly.Module.imports(compiled),
          exports: WebAssembly.Module.exports(compiled),
          observations,
        },
        null,
        2,
      ),
    );
    expect(observations).toEqual(
      Array.from({ length: 2 }, () => ({
        floatPrefix: [1, 1],
        intPrefix: [1, 1],
        intHex: [30, 30],
        intNegative: [-7, -7],
      })),
    );
  }, 120000);
});

const deniedPatterns = [
  /\/src\/(checker|frontend|codegen|codegen-linear|compiler)\//,
  /\/src\/(ts-api|compiler|index)\.[cm]?[jt]s$/,
  /\/src\/ir\/(from-ast|async-from-ast|async-prepare|identity|program-source|program-preparation|program-middleend|program-middleend-ir|program-native-async-source|program-logical-types)\.[cm]?[jt]s$/,
  /\/src\/ir\/passes\/gvn\.[cm]?[jt]s$/,
  /\/node_modules\/(typescript|typescript7)\//,
];
const guardSource = `
import {appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
let data;
export function initialize(value){data=value;}
function check(url,parent,phase){
 const path=url.startsWith("file:")?fileURLToPath(url):url;
 const denied=data.patterns.some(p=>new RegExp(p).test(path));
 appendFileSync(data.census,JSON.stringify({url,parent:parent??null,phase,denied})+"\\n");
 if(denied)throw new Error("native scanner forbidden load: "+url);
}
export async function resolve(specifier,context,next){
 if(specifier.startsWith("file:")||((specifier.startsWith("./")||specifier.startsWith("../"))&&context.parentURL?.startsWith("file:")))
  check(new URL(specifier,context.parentURL).href,context.parentURL,"requested");
 const result=await next(specifier,context);check(result.url,context.parentURL,"resolved");return result;
}
`;
const guardURL = "data:text/javascript," + encodeURIComponent(guardSource);
function launch(
  args: string[],
  cwd = root,
): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      error: string | null = null;
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (cause) => {
      error = String(cause);
    });
    child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr, error }));
  });
}
const canonicalRoots = [
  "src/backend/wasmgc/resources/native-resource-declarations.ts",
  "src/runtime/wasmgc/values/string-number-grammar.ts",
  "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
  "src/runtime/wasmgc/values/string-number-bodies.ts",
  "src/backend/wasmgc/resources/native-string-number.ts",
  "src/backend/wasmgc/resources/native-string-flatten.ts",
  "src/runtime/wasmgc/values/string-flatten-bodies.ts",
  "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
  "src/backend/wasmgc/resources/native-string-literals.ts",
  "src/backend/wasmgc/resources/native-values.ts",
];
// Erased declarations are hashed, but must not be fabricated as runtime loads.
const canonicalSnapshotPaths = [...canonicalRoots, "src/runtime/wasmgc/values/native-resource-declaration-types.ts"];
function childSource(rootPath: string, packet: string, report: string, census: string): string {
  return `
import {register} from "node:module";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
const root=${JSON.stringify(rootPath)}, packet=${JSON.stringify(packet)}, report=${JSON.stringify(report)};
const paths=${JSON.stringify(canonicalSnapshotPaths)};
const sha=text=>createHash("sha256").update(text).digest("hex");
const snapshot=()=>Object.fromEntries(paths.map(p=>[p,sha(readFileSync(resolve(root,p)))]));
const before=snapshot(),encoded=readFileSync(packet,"utf8");
const out={ok:false,root,node:process.version,encodedSha256:sha(encoded),before,after:null,execution:null,error:null};
register(${JSON.stringify(guardURL)},{parentURL:import.meta.url,data:${JSON.stringify({ census, patterns: deniedPatterns.map((p) => p.source) })}});
try{
 const codec=await import(pathToFileURL(resolve(root,"src/ir/program-codec.ts")).href);
 const program=codec.decodePreparedIrProgram(encoded);
 if(codec.encodePreparedIrProgram(program)!==encoded)throw Error("codec bytes differ");
 const fixture=await import(pathToFileURL(resolve(root,"tests/fixtures/issue-3518-native-string-number-donor.ts")).href);
 out.execution=fixture.executeScannerResourceFixture(program);
 out.after=snapshot();
 if(JSON.stringify(out.after)!==JSON.stringify(before))throw Error("source changed");
 out.ok=true;
}catch(error){out.error=String(error?.stack??error);}
writeFileSync(report,JSON.stringify(out,null,2));process.exitCode=out.ok?0:1;
`;
}
describe("fresh-process canonical resource admission", () => {
  it("executes a source-produced codec with frontend/legacy emitters denied", async () => {
    const directory = scratch("native-scanner-admission-");
    const packet = resolve(directory, "program.json"),
      report = resolve(directory, "report.json"),
      census = resolve(directory, "loads.jsonl"),
      entry = resolve(directory, "entry.mjs");
    writeFileSync(packet, actual().encoded);
    writeFileSync(entry, childSource(root, packet, report, census));
    const terminal = await launch(["--import", "tsx", entry]);
    writeFileSync(resolve(directory, "terminal.json"), JSON.stringify(terminal, null, 2));
    expect(terminal.error).toBeNull();
    expect(terminal.signal).toBeNull();
    const receipt = JSON.parse(readFileSync(report, "utf8"));
    expect(terminal.status, receipt.error ?? terminal.stderr).toBe(0);
    expect(receipt.ok, receipt.error).toBe(true);
    expect(receipt.root).toBe(root);
    expect(receipt.node).toBe(process.version);
    expect(receipt.encodedSha256).toBe(sha(actual().encoded));
    const hashes = Object.fromEntries(canonicalSnapshotPaths.map((p) => [p, sha(readFileSync(resolve(root, p)))]));
    expect(receipt.before).toEqual(hashes);
    expect(receipt.after).toEqual(hashes);
    expect(receipt.execution).toEqual(execution());
    const loads = readFileSync(census, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(loads.length).toBeGreaterThan(0);
    expect(loads.filter((row) => row.denied)).toEqual([]);
    for (const p of canonicalRoots)
      expect(loads.some((row) => row.url === pathToFileURL(resolve(root, p)).href && row.phase === "resolved")).toBe(
        true,
      );
  }, 120000);
  it.each(["", "?duplicate=1", "#duplicate"])("proves exact forbidden URL rejection %s", async (suffix) => {
    const directory = scratch("native-scanner-denied-"),
      census = resolve(directory, "loads.jsonl");
    const url = pathToFileURL(resolve(root, paths.adapter)).href + suffix;
    // Plain Node preserves suffixes before this SAME guard's requested-URL
    // check; tsx can strip them. No sentinel failure counts as guard evidence.
    const script = `import {register} from "node:module";register(${JSON.stringify(guardURL)},{parentURL:import.meta.url,data:${JSON.stringify({ census, patterns: deniedPatterns.map((p) => p.source) })}});await import(${JSON.stringify(url)});`;
    const terminal = await launch(["--input-type=module", "--eval", script]);
    writeFileSync(resolve(directory, "terminal.json"), JSON.stringify(terminal, null, 2));
    expect(terminal.error).toBeNull();
    expect(terminal.signal).toBeNull();
    expect(terminal.status).toBe(1);
    expect(terminal.stderr).toContain("native scanner forbidden load: " + url);
    const loads = readFileSync(census, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(loads.filter((row) => row.denied)).toEqual([
      { url, parent: new URL("[eval1]", pathToFileURL(root + "/")).href, phase: "requested", denied: true },
    ]);
    expect(loads.some((row) => row.url === url && row.phase === "resolved")).toBe(false);
  });
});
