import { captureDenoPostPositionDenoPredecessorPolicySource } from "./helpers/ir-deno-post-position-main-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent test-only policy-source proof, not compiler or runtime acceptance.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { captureDenoCallbackInventoryPredecessorPolicySource } from "./helpers/ir-deno-callback-inventory-successor.js";
import { captureMainInventoryPredecessorPolicy } from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureDenoClassFieldsMainPredecessorPolicy,
  captureDenoClassFieldsMainPredecessorPolicySource,
} from "./helpers/ir-deno-class-fields-main-successor.js";

// Independent literals reconstructed from exact old/current source bytes and the frozen row specification.
const expected = {
  before: {
    bytes: 594018,
    sha256: "59752f826a8a2298966e4bbae6ec29e15a168f7e45fb58379dbb923ccd2f2694",
    gitBlob: "dfd1b16089d1d66982e0eef5d79b50f74fd6d869",
    fileCount: 1855,
    dataSha256: "07d3bc5470d5864ae6f1e7d199eed523b382119aace6366db92804a7c7c63380",
    filesSha256: "f30f8e6a86c56fc16e6c9ad768d52930b70f73beef57feffae69ad932d5bf78c",
    rootWithoutFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  },
  current: {
    bytes: 594346,
    sha256: "4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a",
    gitBlob: "e70ee1b32f53de5d5935aa0ac52987959effc64a",
    fileCount: 1856,
    dataSha256: "5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7",
    filesSha256: "fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9",
    rootWithoutFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  },
  topLevelKeys: [
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
  ],
  spans: [
    {
      beforeOffset: 548059,
      afterOffset: 548059,
      before: "",
      after:
        '    {\n      "path": "src/codegen/classes/externref-class-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
    },
  ],
  added: [
    {
      index: 1664,
      row: {
        path: "src/codegen/classes/externref-class-fields.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/error-subclass-proto-chain.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/class-proto-toplevel-write.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
} as const;
const root = resolve(import.meta.dirname, "..");
const lineage = {
  beforeMain: "abb3471c46bb9e7129b28812fe16313c857cda69",
  deliveredMain: "cdc0255882d45181072342d9fd57f291aca93092",
  beforeSource: {
    bytes: 588351,
    sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
    gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
  },
  deliveredSource: {
    bytes: 588679,
    sha256: "e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e",
    gitBlob: "6066caa751c06e8726076ee622311f509bdd5f77",
  },
  index: 1647,
  beforeOffset: 542771,
  afterOffset: 542771,
  insertion:
    '    {\n      "path": "src/codegen/classes/externref-class-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
} as const;
const sourcePath = "scripts/compiler-boundaries.json";
const receiptPath = "tests/helpers/ir-deno-class-fields-main-successor.json";
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown> & { path: string };
type Policy = Record<string, unknown> & { files: Row[] };
function profile(value: Policy, which: "current" | "before") {
  const pin = expected[which];
  expect(Object.keys(value)).toEqual(expected.topLevelKeys);
  expect(value.files).toHaveLength(pin.fileCount);
  expect(sha(JSON.stringify(value))).toBe(pin.dataSha256);
  expect(sha(JSON.stringify(value.files))).toBe(pin.filesSha256);
  expect(sha(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "files"))))).toBe(
    pin.rootWithoutFilesSha256,
  );
}
function independentRawBefore(current: string): string {
  expect(Buffer.byteLength(current)).toBe(expected.current.bytes);
  expect(sha(current)).toBe(expected.current.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(current)}\0`)
      .update(current)
      .digest("hex"),
  ).toBe(expected.current.gitBlob);
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const span of expected.spans) {
    expect(span.before).toBe("");
    expect(bytes.subarray(span.afterOffset, span.afterOffset + Buffer.byteLength(span.after)).toString("utf8")).toBe(
      span.after,
    );
    parts.push(bytes.subarray(cursor, span.afterOffset), Buffer.from(span.before));
    cursor = span.afterOffset + Buffer.byteLength(span.after);
  }
  parts.push(bytes.subarray(cursor));
  const before = Buffer.concat(parts).toString("utf8");
  expect(Buffer.byteLength(before)).toBe(expected.before.bytes);
  expect(sha(before)).toBe(expected.before.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(before)}\0`)
      .update(before)
      .digest("hex"),
  ).toBe(expected.before.gitBlob);
  const old = Buffer.from(before),
    replay: Buffer[] = [];
  cursor = 0;
  for (const span of expected.spans) {
    replay.push(old.subarray(cursor, span.beforeOffset), Buffer.from(span.after));
    cursor = span.beforeOffset;
  }
  replay.push(old.subarray(cursor));
  expect(Buffer.concat(replay).toString("utf8")).toBe(current);
  return before;
}
function independentPolicyBefore(current: Policy): Policy {
  profile(current, "current");
  const indices = new Set<number>();
  for (const { index, row } of expected.added) {
    expect(current.files[index]).toEqual(row);
    const literal = expected.added.find((added) => added.index === index)!;
    expect(current.files[index - 1]).toEqual(literal.previous);
    expect(current.files[index + 1]).toEqual(literal.next);
    indices.add(index);
  }
  const before = { ...current, files: current.files.filter((_row, index) => !indices.has(index)) };
  profile(before, "before");
  return before;
}
function authorityReader() {
  const trace: string[] = [];
  return {
    trace,
    read: (path: string): string => {
      trace.push(path);
      return read(path);
    },
  };
}
function healthy() {
  const receipt = read(receiptPath),
    helper = read("tests/helpers/ir-deno-class-fields-main-successor.ts");
  expect(Buffer.byteLength(receipt)).toBe(4285);
  expect(sha(receipt)).toBe("5856ce8883af5e4f57a3540277bbdbc6bc0aef71c17394d59af6ba7d3d9b0593");
  expect(Buffer.byteLength(helper)).toBe(11719);
  expect(sha(helper)).toBe("de2a2abbedd85f719f036d630ff2ba67324a8a647dc5c3ce2e7b5d6ec12126c4");
  const current = captureDenoPostPositionDenoPredecessorPolicySource(read(sourcePath)),
    before = independentRawBefore(current),
    input = JSON.parse(current) as Policy;
  const sourceAuthority = authorityReader(),
    semanticAuthority = authorityReader();
  expect(captureDenoClassFieldsMainPredecessorPolicySource(current, sourceAuthority.read)).toBe(before);
  expect(captureDenoClassFieldsMainPredecessorPolicy(input, semanticAuthority.read)).toEqual(
    independentPolicyBefore(input),
  );
  expect(sourceAuthority.trace).toEqual([receiptPath]);
  expect(semanticAuthority.trace).toEqual([receiptPath]);
  return { current, before, input };
}
function freezeGraph(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) freezeGraph(descriptor.value);
  Object.freeze(value);
}

describe("fixed Deno class fields main inventory successor independent proof", () => {
  it("independently binds the delivered main insertion and exact row with full before/current replay", () => {
    const { current, before, input } = healthy();
    expect(expected.spans).toHaveLength(1);
    expect(expected.added).toHaveLength(1);
    expect(JSON.parse(before)).toEqual(independentPolicyBefore(input));
    console.info(
      "Deno class fields main inventory proof-only",
      JSON.stringify({
        currentBytes: Buffer.byteLength(current),
        historicalBytes: Buffer.byteLength(before),
        currentRows: input.files.length,
        historicalRows: JSON.parse(before).files.length,
        spans: expected.spans.length,
        addedRows: expected.added.length,
      }),
    );
  });
  it("preserves every retained field and row, detaches output and leaves a frozen actual operand unchanged", () => {
    const { input } = healthy();
    const retained = JSON.stringify(input),
      expectedBefore = independentPolicyBefore(input);
    freezeGraph(input);
    const result = captureDenoClassFieldsMainPredecessorPolicy(input) as Policy;
    expect(result).toEqual(expectedBefore);
    expect(result).not.toBe(input);
    for (const key of expected.topLevelKeys) if (key !== "files") expect(result[key]).toEqual(input[key]);
    expect(result.files).not.toBe(input.files);
    for (let index = 0; index < result.files.length; index++)
      expect(result.files[index]).not.toBe(expectedBefore.files[index]);
    expect(JSON.stringify(input)).toBe(retained);
  });
  for (const kind of ["tail edit", "changed retained field", "already historical operand"] as const)
    it(`refuses raw ${kind} after healthy capture and observes exact restoration`, () => {
      const witness = healthy();
      const data = JSON.parse(witness.current);
      data.description += " mutant";
      const mutant =
        kind === "tail edit"
          ? witness.current + "\n"
          : kind === "changed retained field"
            ? JSON.stringify(data)
            : witness.before;
      expect(() => captureDenoClassFieldsMainPredecessorPolicySource(mutant)).toThrow(
        /complete raw source profile mismatch/,
      );
      healthy();
    });
  for (const [name, mutate] of [
    [
      "omitted added row",
      (data) => {
        data.files.splice(expected.added[0].index, 1);
      },
    ],
    [
      "duplicated added row",
      (data) => {
        data.files.splice(expected.added[0].index, 0, structuredClone(data.files[expected.added[0].index]));
      },
    ],
    [
      "renamed added row",
      (data) => {
        data.files[expected.added[0].index].path += ".renamed";
      },
    ],
    [
      "changed retained row path",
      (data) => {
        data.files[0].path += ".mutant";
      },
    ],
    [
      "reordered current rows",
      (data) => {
        const index = expected.added[0].index;
        [data.files[index], data.files[index + 1]] = [data.files[index + 1], data.files[index]];
      },
    ],
    [
      "changed retained top-level field",
      (data) => {
        data.description = "mutant";
      },
    ],
    [
      "changed non-files boundary rules",
      (data) => {
        data.allowedEdges = {};
      },
    ],
    [
      "unexpected top-level field",
      (data) => {
        data.unrelated = true;
      },
    ],
  ] satisfies [string, (data: Policy) => void][])
    it(`refuses semantic ${name} between genuine healthy captures`, () => {
      const { input } = healthy();
      mutate(input);
      expect(() => captureDenoClassFieldsMainPredecessorPolicy(input)).toThrow(/complete policy profile mismatch/);
      healthy();
    });
  for (const kind of ["top-level getter", "row getter", "array element getter", "sparse array"] as const)
    it(`refuses ${kind} before authority IO or getter execution`, () => {
      const { input } = healthy();
      let calls = 0;
      if (kind === "top-level getter") {
        const value = input.files;
        Object.defineProperty(input, "files", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "row getter") {
        const value = input.files[0].owner;
        Object.defineProperty(input.files[0], "owner", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "array element getter") {
        const value = input.files[3];
        Object.defineProperty(input.files, "3", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "sparse array") Reflect.deleteProperty(input.files, "3");
      const authority = authorityReader();
      expect(() => captureDenoClassFieldsMainPredecessorPolicy(input, authority.read)).toThrow();
      expect(calls).toBe(0);
      expect(authority.trace).toEqual([]);
      healthy();
    });
  for (const lane of ["raw", "semantic"] as const)
    it(`rejects boxed ${lane} data without coercion or authority IO`, () => {
      const { current } = healthy();
      let calls = 0;
      const boxed = Object(current);
      Object.defineProperty(boxed, Symbol.toPrimitive, {
        get() {
          calls++;
          return () => {
            calls++;
            return current;
          };
        },
      });
      const authority = authorityReader();
      expect(() =>
        lane === "raw"
          ? captureDenoClassFieldsMainPredecessorPolicySource(boxed as string, authority.read)
          : captureDenoClassFieldsMainPredecessorPolicy(boxed, authority.read),
      ).toThrow();
      expect(calls).toBe(0);
      expect(authority.trace).toEqual([]);
      healthy();
    });
  for (const kind of ["corrupt", "missing"] as const)
    it(`refuses a physically ${kind} fixed receipt after warm capture and restores exact original bytes`, () => {
      const witness = healthy();
      const path = resolve(root, receiptPath),
        original = readFileSync(path),
        originalHash = sha(original);
      const scratchRoot = resolve(root, ".tmp", "pr6341-inventory/authority-faults");
      mkdirSync(scratchRoot, { recursive: true });
      const directory = mkdtempSync(resolve(scratchRoot, "proof-")),
        backup = resolve(directory, "receipt-original.json");
      let moved = false;
      try {
        if (kind === "missing") {
          renameSync(path, backup);
          moved = true;
        } else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
        expect(() => captureDenoClassFieldsMainPredecessorPolicySource(witness.current)).toThrow(
          kind === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
        );
        expect(() => captureDenoClassFieldsMainPredecessorPolicy(witness.input)).toThrow(
          kind === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
        );
      } finally {
        if (moved) renameSync(backup, path);
        else writeFileSync(path, original);
        expect(sha(readFileSync(path))).toBe(originalHash);
        expect(readFileSync(path)).toEqual(original);
        rmSync(directory, { recursive: true, force: true });
      }
      healthy();
    });
});

describe("Deno class fields main inventory fresh source and authority controls", () => {
  it("passes the exact predecessor into the unchanged eleven-row inverse", () => {
    const { current, before } = healthy();
    expect(() => captureDenoClassFieldsMainPredecessorPolicy(JSON.parse(before))).toThrow(
      "complete policy profile mismatch",
    );
    const original = captureDenoCallbackInventoryPredecessorPolicySource(before);
    expect(captureMainInventoryPredecessorPolicy(JSON.parse(original)).files).toHaveLength(1826);
    expect(Buffer.byteLength(original)).toBe(lineage.beforeSource.bytes);
    expect(sha(original)).toBe(lineage.beforeSource.sha256);
    const originalBytes = Buffer.from(original);
    const delivered = Buffer.concat([
      originalBytes.subarray(0, lineage.beforeOffset),
      Buffer.from(lineage.insertion),
      originalBytes.subarray(lineage.beforeOffset),
    ]).toString("utf8");
    expect(Buffer.byteLength(delivered)).toBe(lineage.deliveredSource.bytes);
    expect(sha(delivered)).toBe(lineage.deliveredSource.sha256);
    expect(
      createHash("sha1")
        .update(`blob ${Buffer.byteLength(delivered)}\0`)
        .update(delivered)
        .digest("hex"),
    ).toBe(lineage.deliveredSource.gitBlob);
    expect(() => captureDenoClassFieldsMainPredecessorPolicySource(delivered)).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => captureDenoClassFieldsMainPredecessorPolicy(JSON.parse(delivered))).toThrow(
      "complete policy profile mismatch",
    );
    expect(captureDenoClassFieldsMainPredecessorPolicySource(current)).toBe(before);
  });
  for (const lane of ["raw", "semantic"] as const)
    for (const kind of ["malformed", "boxed", "missing", "absent reader"] as const)
      it(`rejects ${kind} authority on the ${lane} channel with exact fresh read counts`, () => {
        const { current, input } = healthy();
        let reads = 0;
        const reader = (path: string): string => {
          reads++;
          expect(path).toBe(receiptPath);
          if (kind === "missing") throw new Error("missing fixed receipt");
          return kind === "boxed" ? (Object(read(path)) as string) : "{";
        };
        expect(() =>
          lane === "raw"
            ? captureDenoClassFieldsMainPredecessorPolicySource(
                current,
                kind === "absent reader" ? (null as never) : reader,
              )
            : captureDenoClassFieldsMainPredecessorPolicy(input, kind === "absent reader" ? (null as never) : reader),
        ).toThrow();
        expect(reads).toBe(kind === "absent reader" ? 0 : 1);
        healthy();
      });
  it("rejects a physically corrupted full policy after healthy capture and observes exact restored bytes", () => {
    const witness = healthy();
    // Stage this proof's genuinely authenticated1856 operand before the old fault interval.
    mkdirSync(resolve(root, ".tmp"), { recursive: true });
    const directory = mkdtempSync(resolve(root, ".tmp", "deno-class-fields-1856-policy-fault-"));
    const path = resolve(directory, "compiler-boundaries.json");
    writeFileSync(path, witness.current);
    const original = readFileSync(path);
    independentRawBefore(original.toString("utf8"));
    try {
      const mutant = JSON.parse(original.toString("utf8"));
      mutant.files[expected.added[0].index].path += ".corrupt";
      writeFileSync(path, JSON.stringify(mutant));
      const rawAuthority = authorityReader(),
        semanticAuthority = authorityReader();
      expect(() =>
        captureDenoClassFieldsMainPredecessorPolicySource(readFileSync(path, "utf8"), rawAuthority.read),
      ).toThrow(/complete raw source profile mismatch/);
      expect(() =>
        captureDenoClassFieldsMainPredecessorPolicy(JSON.parse(readFileSync(path, "utf8")), semanticAuthority.read),
      ).toThrow(/complete policy profile mismatch/);
      expect(rawAuthority.trace).toEqual([receiptPath]);
      expect(semanticAuthority.trace).toEqual([receiptPath]);
    } finally {
      writeFileSync(path, original);
      expect(readFileSync(path)).toEqual(original);
      expect(captureDenoClassFieldsMainPredecessorPolicySource(readFileSync(path, "utf8"))).toBe(witness.before);
      rmSync(directory, { recursive: true, force: true });
    }
    healthy();
  });
});

it("refuses changed main-row debt profile and raw prefix or whitespace between healthy captures", () => {
  const witness = healthy();
  const mutant = structuredClone(witness.input);
  mutant.files[expected.added[0].index]!.state = "clean";
  expect(() => captureDenoClassFieldsMainPredecessorPolicy(mutant)).toThrow("complete policy profile mismatch");
  healthy();
  for (const raw of [" " + witness.current, witness.current.replace('"files": [', '"files" : [')]) {
    expect(() => captureDenoClassFieldsMainPredecessorPolicySource(raw)).toThrow(
      "complete raw source profile mismatch",
    );
    healthy();
  }
});
