// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authenticateWellKnownSymbolPolicyEvolution,
  authenticateWellKnownSymbolPolicy,
  beforeWellKnownSymbolPolicy,
  beforeNumberPrerequisitePolicySource,
  beforeWellKnownSymbolPolicySource,
  wellKnownSymbolPolicyReceiptPath,
  authenticateIrRuntimeProgramPolicyEvolution,
  authenticateIrRuntimeProgramPolicy,
  beforeIrRuntimeProgramPolicy,
  irRuntimeProgramPolicyReceiptPath,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { authenticateIrValidationPolicy } from "./helpers/ir-validation-policy-evolution.js";
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const raw = (): string => beforeNumberPrerequisitePolicySource(read("scripts/compiler-boundaries.json"));
const actual = (): Policy => JSON.parse(raw()) as Policy;
const receiptText = (): string => read(wellKnownSymbolPolicyReceiptPath);
const receipt = () => authenticateWellKnownSymbolPolicyEvolution(receiptText());
const contract = "src/runtime/contracts/well-known-symbols.ts";
const owner = "src/backend/wasmgc/resources/native-well-known-symbols.ts";
function accepted(): void {
  expect(authenticateWellKnownSymbolPolicy(actual()).files).toHaveLength(1771);
}
function refused(value: unknown): void {
  expect(() => authenticateWellKnownSymbolPolicy(value)).toThrow();
  expect(() => beforeWellKnownSymbolPolicy(value)).toThrow();
}
function rejected(change: (policy: Policy) => void): void {
  const policy = actual(),
    before = digest(policy);
  authenticateWellKnownSymbolPolicy(policy);
  change(policy);
  expect(digest(policy)).not.toBe(before);
  refused(policy);
  accepted();
}
function frozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) frozen(child);
  }
}
/** Test-local forward delta enumerates its own two rows and layer edits. */
function independentReplay(c1: Policy): Policy {
  const p = clone(c1);
  p.files.push(
    { path: contract, state: "clean", layer: "runtime-contracts" },
    { path: owner, state: "clean", layer: "backend-wasmgc" },
  );
  p.layers[10]!.entries!.push(contract);
  p.layers[10]!.minModules = 10;
  p.layers[11]!.entries!.push(owner);
  p.layers[11]!.minModules = 50;
  p.activationHistory.push(
    { layer: "runtime-contracts", entries: [contract], minModules: 1 },
    { layer: "backend-wasmgc", entries: [owner], minModules: 1 },
  );
  return p;
}
function rawRefused(mutant: string): void {
  expect(mutant).not.toBe(raw());
  expect(sha(mutant)).not.toBe("451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59");
  expect(() => beforeWellKnownSymbolPolicySource(mutant)).toThrow();
  expect(sha(beforeWellKnownSymbolPolicySource(raw()))).toBe(
    "460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57",
  );
}

describe("WKS exact successor of genuine C1 and B", () => {
  it("pins the authenticated WKS predecessor raw/ordered policy, all independent populations and key order", () => {
    const p = actual(),
      text = raw();
    expect(Buffer.byteLength(text)).toBe(565875);
    expect(sha(text)).toBe("451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(text)}\0`)
        .update(text)
        .digest("hex"),
    ).toBe("74dc1b073145713d122e28a0b45f34c0cc41a066");
    expect(digest(p)).toBe("462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7");
    expect([p.files.length, p.activationHistory.length, p.layers.length]).toEqual([1771, 98, 20]);
    for (const [id, required, floor, classified] of [
      ["runtime-contracts", 10, 10, 10],
      ["backend-wasmgc", 50, 50, 55],
      ["ir-program", 43, 43, 44],
      ["ir-runtime", 19, 19, 19],
      ["native-runtime", 98, 97, 103],
      ["ir-analysis", 11, 11, 11],
      ["ir-core", 29, 29, 29],
    ] as const) {
      const rows = p.layers.filter((row) => row.id === id);
      expect(rows).toHaveLength(1);
      expect([rows[0]!.entries!.length, rows[0]!.minModules, p.files.filter((row) => row.layer === id).length]).toEqual(
        [required, floor, classified],
      );
    }
    expect(Object.keys(p)).toEqual([
      "schema",
      "description",
      "sourceRoot",
      "tsconfig",
      "requireGitProvenance",
      "externalAssets",
      "frontendWrapper",
      "moduleExtensions",
      "layers",
      "allowedEdges",
      "externalPackages",
      "activationHistory",
      "nonModules",
      "moves",
      "evidence",
      "files",
    ]);
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    accepted();
  });
  it("freshly checks all nineteen immutable inputs and the entire original helper prefix", () => {
    const r = receipt(),
      c1 = authenticateIrRuntimeProgramPolicyEvolution();
    expect(Buffer.byteLength(receiptText())).toBe(9470);
    expect(sha(receiptText())).toBe("5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61");
    expect(r.before).toEqual(c1.current);
    expect(r.provenance.immutableInputs).toHaveLength(19);
    expect(new Set(r.provenance.immutableInputs.map((pin) => pin.path)).size).toBe(19);
    expect(r.provenance.immutableInputs).toEqual([
      {
        path: irRuntimeProgramPolicyReceiptPath,
        bytes: 6804,
        sha256: "8e2589e90fbc697dceba56e1bbe53447250a94f3bcb03d99317ad4878bc1f58c",
      },
      ...c1.provenance.immutableInputs,
    ]);
    for (const pin of r.provenance.immutableInputs) {
      const text = read(pin.path);
      expect(Buffer.byteLength(text)).toBe(pin.bytes);
      expect(sha(text)).toBe(pin.sha256);
    }
    const helper = Buffer.from(read("tests/helpers/ir-runtime-program-policy-evolution.ts"));
    expect(helper.length).toBeGreaterThan(10742);
    expect(createHash("sha256").update(helper.subarray(0, 10742)).digest("hex")).toBe(
      "2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d",
    );
    frozen(r);
  });
  it("independently replays the exact two-row semantic delta and authenticates C1 through real B", () => {
    const p = actual(),
      original = JSON.stringify(p),
      c1 = beforeWellKnownSymbolPolicy(p);
    expect([c1.files.length, c1.activationHistory.length]).toEqual([1769, 96]);
    expect(digest(c1)).toBe("f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11");
    authenticateIrRuntimeProgramPolicy(c1);
    const b = beforeIrRuntimeProgramPolicy(c1);
    expect([b.files.length, b.activationHistory.length]).toEqual([1765, 94]);
    expect(digest(b)).toBe("e8d0034c26f59e042da49dfcc4af562436b562421b9e231ae78d664ab70c73e3");
    authenticateIrValidationPolicy(b);
    expect(JSON.stringify(independentReplay(c1))).toBe(original);
    expect(JSON.stringify(p)).toBe(original);
    expect(() => authenticateIrRuntimeProgramPolicy(p)).toThrow();
    expect(() => authenticateIrValidationPolicy(p)).toThrow();
    refused(c1);
    accepted();
  });
  it("independently assembles all four fixed raw slices and verifies reciprocal complete-source profiles", () => {
    const text = raw(),
      r = receipt(),
      c1 = beforeWellKnownSymbolPolicySource(text);
    expect(Buffer.byteLength(c1)).toBe(565188);
    expect(sha(c1)).toBe("460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57");
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(c1)}\0`)
        .update(c1)
        .digest("hex"),
    ).toBe("5395e0265ca6fef778141101ea688e456417c558");
    expect(JSON.stringify(JSON.parse(c1))).toBe(JSON.stringify(beforeWellKnownSymbolPolicy(actual())));
    expect(
      r.raw.spans.map((span) => [
        span.role,
        span.beforeOffset,
        span.afterOffset,
        span.before.length,
        span.after.length,
      ]),
    ).toEqual([
      ["runtime-contracts-layer-tail", 9384, 9384, 78, 134],
      ["backend-wasmgc-layer-tail", 12760, 12816, 92, 161],
      ["activation-history-tail", 64874, 64999, 140, 425],
      ["files-tail", 565065, 565475, 123, 400],
    ]);
    let end = 0,
      reconstructed = "";
    for (const span of r.raw.spans) {
      expect(c1.indexOf(span.before)).toBe(span.beforeOffset);
      expect(c1.lastIndexOf(span.before)).toBe(span.beforeOffset);
      expect(text.indexOf(span.after)).toBe(span.afterOffset);
      expect(text.lastIndexOf(span.after)).toBe(span.afterOffset);
      reconstructed += c1.slice(end, span.beforeOffset) + span.after;
      end = span.beforeOffset + span.before.length;
    }
    reconstructed += c1.slice(end);
    expect(reconstructed).toBe(text);
    expect(() => beforeWellKnownSymbolPolicySource(c1)).toThrow();
  });
  it("returns fresh frozen detached current and mutable exact C1 copies across repeated calls", () => {
    const p = actual(),
      original = JSON.stringify(p);
    const a = authenticateWellKnownSymbolPolicy(p),
      a2 = authenticateWellKnownSymbolPolicy(p);
    frozen(a);
    expect(a).not.toBe(p);
    expect(a2).not.toBe(a);
    expect(a.files[0]).not.toBe(p.files[0]);
    const c1 = beforeWellKnownSymbolPolicy(p),
      c2 = beforeWellKnownSymbolPolicy(p);
    expect(c1).not.toBe(c2);
    expect(c1.files).not.toBe(c2.files);
    expect(c1.files[0]).not.toBe(c2.files[0]);
    expect(Object.isFrozen(c1)).toBe(false);
    expect(Object.isFrozen(c1.layers[10]!.entries)).toBe(false);
    c1.files[0]!.state = "unmigrated";
    expect(c1.files[0]!.state).toBe("unmigrated");
    expect(() => authenticateIrRuntimeProgramPolicy(c1)).toThrow();
    authenticateIrRuntimeProgramPolicy(c2);
    expect(JSON.stringify(p)).toBe(original);
    accepted();
  });

  for (const index of [1769, 1770]) {
    for (const operation of [
      "delete",
      "duplicate",
      "replace",
      "reorder",
      "unknown",
      "state",
      "layer",
      "key-order",
    ] as const)
      it(`rejects new file ${index} ${operation}`, () =>
        rejected((p) => {
          const row = p.files[index]!;
          if (operation === "delete") p.files.splice(index, 1);
          if (operation === "duplicate") p.files.splice(index, 0, { ...row });
          if (operation === "replace") row.path = "src/runtime/contracts/unknown.ts";
          if (operation === "unknown")
            p.files.push({ path: "src/runtime/contracts/unknown.ts", state: "clean", layer: "runtime-contracts" });
          if (operation === "reorder") [p.files[1769], p.files[1770]] = [p.files[1770]!, p.files[1769]!];
          if (operation === "state") row.state = "unmigrated";
          if (operation === "layer") row.layer = "ir-core";
          if (operation === "key-order") p.files[index] = { layer: row.layer!, path: row.path!, state: row.state! };
        }));
  }
  for (const index of [10, 11]) {
    for (const operation of [
      "entry-delete",
      "entry-replace",
      "entry-duplicate",
      "entry-reorder",
      "same-count",
      "unknown-entry",
      "index",
      "id",
      "root",
      "status",
      "required",
      "floor",
      "key-order",
    ] as const)
      it(`rejects changed layer ${index} ${operation}`, () =>
        rejected((p) => {
          const layer = p.layers[index]!,
            entries = layer.entries!;
          if (operation === "entry-delete") entries.pop();
          if (operation === "entry-replace") entries[entries.length - 1] = "src/runtime/contracts/unknown.ts";
          if (operation === "entry-duplicate") entries.push(entries[entries.length - 1]!);
          if (operation === "entry-reorder") entries.reverse();
          if (operation === "same-count")
            [entries[0], entries[entries.length - 1]] = [entries[entries.length - 1]!, entries[0]!];
          if (operation === "unknown-entry") entries.push("src/runtime/contracts/unknown.ts");
          if (operation === "index") [p.layers[10], p.layers[11]] = [p.layers[11]!, p.layers[10]!];
          if (operation === "id") layer.id = "ir-core";
          if (operation === "root") layer.roots[0] = "src/runtime/foreign";
          if (operation === "status") layer.status = "inactive";
          if (operation === "required") layer.required = false;
          if (operation === "floor") layer.minModules!++;
          if (operation === "key-order")
            p.layers[index] = {
              status: layer.status,
              id: layer.id,
              required: layer.required,
              roots: layer.roots,
              entries: layer.entries,
              minModules: layer.minModules,
            };
        }));
  }
  for (const index of [96, 97]) {
    for (const operation of [
      "delete",
      "duplicate",
      "replace",
      "reorder",
      "entry-delete",
      "entry-duplicate",
      "layer",
      "floor",
      "key-order",
    ] as const)
      it(`rejects new activation ${index} ${operation}`, () =>
        rejected((p) => {
          const row = p.activationHistory[index]!;
          if (operation === "delete") p.activationHistory.splice(index, 1);
          if (operation === "duplicate") p.activationHistory.splice(index, 0, clone(row));
          if (operation === "replace") row.entries[0] = "src/runtime/contracts/unknown.ts";
          if (operation === "reorder")
            [p.activationHistory[96], p.activationHistory[97]] = [p.activationHistory[97]!, p.activationHistory[96]!];
          if (operation === "entry-delete") row.entries.length = 0;
          if (operation === "entry-duplicate") row.entries.push(row.entries[0]!);
          if (operation === "layer") row.layer = "ir-core";
          if (operation === "floor") row.minModules = 2;
          if (operation === "key-order")
            p.activationHistory[index] = { entries: row.entries, layer: row.layer, minModules: row.minModules };
        }));
  }
  for (const part of [
    "file-prefix",
    "history-prefix",
    "layer-prefix",
    "edge",
    "unrelated",
    "top-key-order",
    "same-count-file",
  ] as const)
    it(`rejects changed ${part}`, () =>
      rejected((p) => {
        if (part === "file-prefix") p.files[0]!.state = "unmigrated";
        if (part === "history-prefix") p.activationHistory[0]!.minModules++;
        if (part === "layer-prefix") p.layers[0]!.id = "changed";
        if (part === "edge") p.allowedEdges["ir-core"]!.push("unknown");
        if (part === "unrelated") p.description = "changed description";
        if (part === "top-key-order") {
          const schema = p.schema;
          Reflect.deleteProperty(p, "schema");
          p.schema = schema;
        }
        if (part === "same-count-file") [p.files[0], p.files[1]] = [p.files[1]!, p.files[0]!];
      }));

  for (const location of ["top", "layer", "file", "history", "array-element"] as const)
    it(`rejects ${location} accessors with zero getter calls before serialization, then restores and retries`, () => {
      const p = actual();
      authenticateWellKnownSymbolPolicy(p);
      const target =
        location === "top"
          ? p
          : location === "layer"
            ? p.layers[10]!
            : location === "file"
              ? p.files[1769]!
              : location === "history"
                ? p.activationHistory[96]!
                : p.files;
      const key =
        location === "top"
          ? "description"
          : location === "layer"
            ? "entries"
            : location === "file"
              ? "path"
              : location === "history"
                ? "entries"
                : "1769";
      const original = Object.getOwnPropertyDescriptor(target, key)!;
      expect(Object.hasOwn(original, "value")).toBe(true);
      let reads = 0;
      try {
        Object.defineProperty(target, key, {
          enumerable: true,
          configurable: true,
          get() {
            reads++;
            return original.value;
          },
        });
        expect(Object.hasOwn(Object.getOwnPropertyDescriptor(target, key)!, "value")).toBe(false);
        refused(p);
        expect(reads).toBe(0);
      } finally {
        Object.defineProperty(target, key, original);
      }
      expect(Object.getOwnPropertyDescriptor(target, key)).toEqual(original);
      authenticateWellKnownSymbolPolicy(p);
      accepted();
    });
  for (const shape of [
    "hidden",
    "symbol",
    "foreign-prototype",
    "sparse",
    "inherited",
    "extra-array",
    "cycle",
    "function",
    "toJSON",
    "undefined",
    "bigint",
    "nan",
    "infinity",
    "negative-zero",
  ] as const)
    it(`rejects ${shape} descriptors or non-JSON data after a warm success without invoking callbacks`, () => {
      const p = actual();
      authenticateWellKnownSymbolPolicy(p);
      const originalDigest = digest(p);
      let calls = 0;
      if (shape === "hidden") Object.defineProperty(p.files[1769]!, "path", { enumerable: false });
      if (shape === "symbol") Object.defineProperty(p, Symbol("extra"), { value: 1, enumerable: true });
      if (shape === "foreign-prototype") Object.setPrototypeOf(p.files[1769]!, { foreign: true });
      if (shape === "sparse") Reflect.deleteProperty(p.files, "1769");
      if (shape === "inherited") {
        const row = p.files[1769]!;
        Reflect.deleteProperty(p.files, "1769");
        Object.setPrototypeOf(p.files, Object.assign(Object.create(Array.prototype), { 1769: row }));
      }
      if (shape === "extra-array") Object.defineProperty(p.files, "extra", { value: 1, enumerable: true });
      if (shape === "cycle") p.cycle = p;
      if (shape === "function")
        p.extra = () => {
          calls++;
          return 1;
        };
      if (shape === "toJSON")
        p.toJSON = () => {
          calls++;
          return actual();
        };
      if (shape === "undefined") p.extra = undefined;
      if (shape === "bigint") p.extra = 1n;
      if (shape === "nan") p.extra = NaN;
      if (shape === "infinity") p.extra = Infinity;
      if (shape === "negative-zero") p.extra = -0;
      // Inspect the mutation through reflection rather than serializing its untrusted values.
      if (shape === "hidden") expect(Object.getOwnPropertyDescriptor(p.files[1769]!, "path")!.enumerable).toBe(false);
      else if (shape === "symbol") expect(Reflect.ownKeys(p).some((key) => typeof key === "symbol")).toBe(true);
      else if (shape === "foreign-prototype") expect(Object.getPrototypeOf(p.files[1769]!)).not.toBe(Object.prototype);
      else if (shape === "sparse" || shape === "inherited") expect(Object.hasOwn(p.files, "1769")).toBe(false);
      else if (shape === "extra-array") expect(Object.hasOwn(p.files, "extra")).toBe(true);
      else expect(Object.hasOwn(p, shape === "cycle" ? "cycle" : shape === "toJSON" ? "toJSON" : "extra")).toBe(true);
      if (shape === "cycle") expect(p.cycle).toBe(p);
      if (shape === "function") expect(typeof p.extra).toBe("function");
      if (shape === "toJSON") expect(typeof p.toJSON).toBe("function");
      if (shape === "undefined") expect(Object.getOwnPropertyDescriptor(p, "extra")!.value).toBeUndefined();
      if (shape === "bigint") expect(p.extra).toBe(1n);
      if (shape === "nan") expect(Number.isNaN(p.extra)).toBe(true);
      if (shape === "infinity") expect(p.extra).toBe(Infinity);
      if (shape === "negative-zero") expect(Object.is(p.extra, -0)).toBe(true);
      const captureError =
        shape === "hidden"
          ? "accessor or hidden policy field"
          : shape === "symbol"
            ? "symbol policy key"
            : shape === "foreign-prototype" || shape === "inherited"
              ? "foreign prototype"
              : shape === "sparse" || shape === "extra-array"
                ? "array holes or extra fields"
                : "non-JSON or cyclic policy";
      expect(() => authenticateWellKnownSymbolPolicy(p)).toThrow(captureError);
      refused(p);
      expect(calls).toBe(0);
      expect(digest(actual())).toBe(originalDigest);
      accepted();
    });
  it("rejects repeated warm mutations and reaccepts the exact authentic data after restoration", () => {
    const p = actual(),
      original = p.layers[10]!.minModules;
    for (let i = 0; i < 2; i++) {
      authenticateWellKnownSymbolPolicy(p);
      p.layers[10]!.minModules = 11;
      expect(p.layers[10]!.minModules).toBe(11);
      refused(p);
      p.layers[10]!.minModules = original;
      authenticateWellKnownSymbolPolicy(p);
    }
    accepted();
  });

  for (const index of [0, 1, 2, 3]) {
    for (const boundary of ["first", "last", "outside", "missing", "duplicate", "reordered"] as const)
      it(`rejects raw span ${index} ${boundary}`, () => {
        const text = raw(),
          spans = receipt().raw.spans,
          span = spans[index]!;
        let mutant: string;
        if (boundary === "missing")
          mutant = text.slice(0, span.afterOffset) + text.slice(span.afterOffset + span.after.length);
        else if (boundary === "duplicate")
          mutant = text.slice(0, span.afterOffset) + span.after + text.slice(span.afterOffset);
        else if (boundary === "reordered") {
          const next = spans[(index + 1) % 4]!;
          mutant = text.slice(0, span.afterOffset) + next.after + text.slice(span.afterOffset + span.after.length);
        } else {
          const at =
            boundary === "first"
              ? span.afterOffset
              : boundary === "last"
                ? span.afterOffset + span.after.length - 1
                : span.afterOffset - 1;
          mutant = text.slice(0, at) + (text[at] === "X" ? "Y" : "X") + text.slice(at + 1);
        }
        rawRefused(mutant);
      });
  }
  for (const drift of ["leading-space", "trailing-space", "crlf", "no-final-newline", "extra-final-newline"] as const)
    it(`rejects semantically equal raw ${drift}`, () => {
      const text = raw();
      const mutant =
        drift === "leading-space"
          ? " " + text
          : drift === "trailing-space"
            ? text + " "
            : drift === "crlf"
              ? text.replaceAll("\n", "\r\n")
              : drift === "no-final-newline"
                ? text.slice(0, -1)
                : text + "\n";
      expect(JSON.parse(mutant)).toEqual(JSON.parse(text));
      rawRefused(mutant);
    });
  it("refuses nonprimitive raw without invoking its conversion callback", () => {
    let calls = 0;
    const input = {
      toString() {
        calls++;
        return raw();
      },
    };
    expect(() => beforeWellKnownSymbolPolicySource(input as unknown as string)).toThrow();
    expect(calls).toBe(0);
    accepted();
  });
  for (const drift of [
    "whitespace",
    "newline",
    "before",
    "current",
    "inputs",
    "prefix",
    "census",
    "delta",
    "files",
    "activations",
    "edges",
    "unknown-field",
  ] as const)
    it(`rejects fixed receipt ${drift} drift and reaccepts the fresh original`, () => {
      const text = receiptText(),
        r = JSON.parse(text) as ReturnType<typeof receipt> & { extra?: boolean };
      if (drift === "before") r.before.source.bytes++;
      if (drift === "current") r.current.fileCount--;
      if (drift === "inputs") r.provenance.immutableInputs.pop();
      if (drift === "prefix") r.provenance.c1HelperPrefix.bytes--;
      if (drift === "census") r.census.classifiedBackend!++;
      if (drift === "delta") r.layerDeltas[0]!.currentMinModules++;
      if (drift === "files") r.addedFiles.reverse();
      if (drift === "activations") r.activationAdditions.reverse();
      if (drift === "edges") r.allowedEdgesSha256 = "0".repeat(64);
      if (drift === "unknown-field") r.extra = true;
      const mutant =
        drift === "whitespace" ? " " + text : drift === "newline" ? text.replaceAll("\n", "\r\n") : JSON.stringify(r);
      expect(sha(mutant)).not.toBe(sha(text));
      if (drift !== "whitespace" && drift !== "newline")
        expect(JSON.stringify(r)).not.toBe(JSON.stringify(JSON.parse(text)));
      expect(() => authenticateWellKnownSymbolPolicyEvolution(mutant)).toThrow("receipt digest mismatch");
      expect(receipt().current.fileCount).toBe(1771);
    });
  for (const index of [0, 1, 2, 3]) {
    for (const field of ["role", "beforeOffset", "afterOffset", "before", "after"] as const)
      it(`rejects fixed raw receipt span ${index} ${field} mutation`, () => {
        const r = clone(receipt());
        const span = r.raw.spans[index]!;
        if (field === "beforeOffset" || field === "afterOffset") span[field]++;
        else span[field] += "changed";
        expect(span[field]).not.toBe(receipt().raw.spans[index]![field]);
        expect(() => authenticateWellKnownSymbolPolicyEvolution(JSON.stringify(r))).toThrow("receipt digest mismatch");
        accepted();
      });
  }
});
