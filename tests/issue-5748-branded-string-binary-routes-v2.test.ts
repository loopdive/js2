// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import binaryen from "binaryen";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

// V1 and its numeric-alias ABI failure stay frozen. This is ONLY the branded
// control: no claim that `type i64 = number` is supported by this backend.
const raw = 1152921504606846976n;
const names = ["probe", "ctorLength", "ctorUnit", "callLength", "callUnit"] as const;
const source = `
export function probe(x: bigint) { return new String(x).valueOf() === String(x) ? 1 : 0; }
export function ctorLength(x: bigint) { return new String(x).valueOf().length; }
export function ctorUnit(x: bigint, index: number) { return new String(x).valueOf().charCodeAt(index); }
export function callLength(x: bigint) { return String(x).length; }
export function callUnit(x: bigint, index: number) { return String(x).charCodeAt(index); }
`;

function inspectBinary(binary: Uint8Array, receipt: Record<string, unknown>) {
  // Same installed API compatibility seam as the original host-delegation
  // control. Decode emitted bytes; never interpret debug-WAT export handles
  // as physical function indexes and never subtract a guessed handle base.
  const readWithFeatures = binaryen.readBinary as (
    bytes: Uint8Array,
    features: number,
  ) => ReturnType<typeof binaryen.readBinary>;
  const decoded = readWithFeatures(binary, binaryen.Features.All);
  try {
    const partialRoots: unknown[] = [];
    receipt.binaryRootInspection = partialRoots;
    const functions = new Map<
      string,
      { name: string; params: number[]; results: number[]; body: string; calls: string[] }
    >();
    for (let index = 0; index < decoded.getNumFunctions(); index++) {
      const info = binaryen.getFunctionInfo(decoded.getFunctionByIndex(index));
      const body = info.body ? binaryen.emitText(info.body) : "";
      // Decoder-produced expression text has symbolic function names. Quoted
      // names/indirect calls remain visible in body, not invented direct edges.
      const calls = [...body.matchAll(/\((?:return_call|call)\s+\$([^\s()"]+)/g)].map((match) => match[1]!);
      functions.set(info.name, {
        name: info.name,
        params: binaryen.expandType(info.params),
        results: binaryen.expandType(info.results),
        body,
        calls,
      });
    }
    return names.map((exportName) => {
      const exportRef = decoded.getExport(exportName);
      expect(exportRef, `binary export ${exportName}`).toBeTruthy();
      const exported = binaryen.getExportInfo(exportRef);
      expect(exported.kind).toBe(binaryen.ExternalFunction);
      const root = functions.get(exported.value);
      partialRoots.push({ exportName, exported, root });
      expect(root, `physical binary definition ${exported.value}`).toBeDefined();
      const expectedParams = exportName.endsWith("Unit") ? [binaryen.i64, binaryen.f64] : [binaryen.i64];
      expect(root!.params, `${exportName} physical ABI`).toEqual(expectedParams);
      expect(root!.results).toEqual([binaryen.f64]);
      expect(root!.calls.length, `${exportName} has visible calls`).toBeGreaterThan(0);
      expect(root!.body).not.toMatch(/\((?:return_call|call)\s+\$"/);
      const visited = new Set<string>();
      const queue: string[][] = [[root!.name]];
      const formatterPaths: { path: string[]; formatterBody: string }[] = [];
      while (queue.length > 0) {
        const path = queue.shift()!;
        const name = path[path.length - 1]!;
        if (visited.has(name)) continue;
        visited.add(name);
        const fn = functions.get(name);
        expect(fn, `resolved binary direct callee ${name}`).toBeDefined();
        if (/^(?:number_toString|bigint_toString|bigint_carrier_toString_radix)$/.test(name)) {
          formatterPaths.push({ path, formatterBody: fn!.body });
          continue;
        }
        for (const callee of fn!.calls) queue.push([...path, callee]);
      }
      expect(formatterPaths.length, `${exportName} has a binary-decoded formatter path`).toBeGreaterThan(0);
      return { exportName, exported, root, formatterPaths, visitedFunctions: visited.size };
    });
  } finally {
    decoded.dispose();
  }
}

for (const arm of ["constructor", "direct"] as const) {
  it(`observes branded String ${arm} with binary-authenticated roots`, async () => {
    const native = runInNewContext(
      `(() => { const x = 1152921504606846976n; return {
        constructor: new String(x).valueOf(), direct: String(x),
        probe: new String(x).valueOf() === String(x) ? 1 : 0
      }; })()`,
      {},
      { timeout: 5000 },
    ) as { constructor: string; direct: string; probe: number };
    const receipt: Record<string, unknown> = {
      arm,
      source,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      rawI64: raw.toString(),
      native,
      numericI64Coverage: "unmeasured: v1 alias emitted f64; not repeated here",
    };
    try {
      const result = await compile(source, {
        fileName: "5748-branded-string-binary-routes-v2.ts",
        target: "standalone",
        nativeStrings: true,
        hostBridge: "off",
        optimize: false,
        emitWat: true,
        skipSemanticDiagnostics: true,
      });
      receipt.success = result.success;
      receipt.errors = result.errors;
      receipt.debugWatExports = result.wat.split("\n").filter((line) => /^\s+\(export /.test(line));
      // V2.1: owned ArrayBuffer satisfies BufferSource without an assertion.
      // Hash, decode and instantiate the SAME byte-verified copy.
      const binary: Uint8Array<ArrayBuffer> = new Uint8Array(result.binary);
      receipt.binaryCopyVerified =
        binary.length === result.binary.length && binary.every((byte, index) => byte === result.binary[index]);
      expect(receipt.binaryCopyVerified).toBe(true);
      receipt.binarySha256 = createHash("sha256").update(binary).digest("hex");
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(binary);
      receipt.imports = WebAssembly.Module.imports(module);
      expect(receipt.imports).toEqual([]);
      // ABI is checked BEFORE passing raw i64 bits through the host boundary.
      receipt.routes = inspectBinary(binary, receipt);
      const instance = new WebAssembly.Instance(module, {});
      const invoke = (name: string, ...args: (number | bigint)[]) => {
        expect(instance.exports[name], name).toBeTypeOf("function");
        return (instance.exports[name] as (...args: (number | bigint)[]) => number)(...args);
      };
      const read = (prefix: "ctor" | "call") => {
        const length = invoke(`${prefix}Length`, raw);
        expect(Number.isInteger(length) && length >= 0 && length <= 128).toBe(true);
        const units = Array.from({ length }, (_, index) => invoke(`${prefix}Unit`, raw, index));
        expect(units.every((unit) => Number.isInteger(unit) && unit >= 0 && unit <= 65535)).toBe(true);
        return { length, units, text: String.fromCharCode(...units) };
      };
      const actual = { constructor: read("ctor"), direct: read("call"), probe: invoke("probe", raw) };
      receipt.actual = actual;
      expect(native).toEqual({ constructor: "1152921504606846976", direct: "1152921504606846976", probe: 1 });
      // Each arm is counted separately; both outputs/probe remain in every
      // receipt. A good direct arm never excuses a wrong constructor string.
      expect(actual[arm].text).toBe(native[arm]);
      expect(actual.probe).toBe(actual.constructor.text === actual.direct.text ? 1 : 0);
    } catch (error) {
      receipt.failure = String(error);
      throw error;
    } finally {
      console.log(JSON.stringify(receipt));
    }
  }, 120_000);
}
