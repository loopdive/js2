// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  capture5883InventoryPredecessorPolicy,
  capture5883InventoryPredecessorPolicySource,
} from "./helpers/ir-5883-inventory-source-successor.js";
import {
  capturePositionFinallyMainPredecessorPolicy,
  capturePositionFinallyMainPredecessorPolicySource,
} from "./helpers/ir-position-finally-main-successor.js";
import {
  capturePositionClassFieldsMainPredecessorPolicy,
  capturePositionClassFieldsMainPredecessorPolicySource,
} from "./helpers/ir-position-class-fields-main-successor.js";
import {
  captureSourceMapPositionInventoryPredecessorPolicy,
  captureSourceMapPositionInventoryPredecessorPolicySource,
} from "./helpers/ir-source-map-position-inventory-successor.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  capture5883Main4bffInventoryView,
  capture5883Main4bffInventoryViewSource,
  inventory4bffViewsReceiptPath,
  type Inventory4bffView,
} from "./helpers/ir-5883-main-4bff-inventory-views.js";

// Authoring-time observations from fixed Git blobs and the parent-pinned union.
// No runtime Git, receipt-derived oracle, or changed production policy is admitted.
const profiles = {
  union: {
    bytes: 592524,
    sha256: "62dac966e6f945ba268a3ad76ee6b1e5215629234ab63e6f8ace744d8ecbfe22",
    gitBlob: "6514db6e1bed887cb3dc3dc36d030cb889d91abd",
    dataSha256: "1f76b106119f8cfa563f1cbc2674651a6407f38b8a16e47804a5995f3513b7c1",
    filesSha256: "3433dcc3c41d8f6d90bf9590c3f4cdd424fcd3dbe53c6dc475743345c8e3d0e5",
    fileCount: 1849,
  },
  d: {
    bytes: 591084,
    sha256: "8a8747f2771bd2aa9fa5c01233499f0d587b394d6b0e176e1889dae06900b765",
    gitBlob: "82e2c378a744f23c2ac3256ee8ceea16fe48a27e",
    dataSha256: "4a199b3a38331d81420879afbb49e0312ba60539ed8a927de10951c2e51af680",
    filesSha256: "32b10e52c025d69cef49b754d0c32c301cdb2ab51faf5b36a24d0f2393406d6a",
    fileCount: 1844,
  },
  main: {
    bytes: 590770,
    sha256: "b606727c951331096a458b46ef344e8042018089b04e0e1fa587d7045fad3d13",
    gitBlob: "126b9da52886d6c153271005953d87816189f19f",
    dataSha256: "4e5ff60c7e6357c7fddfc3e96997107b20eea9e3b5f04a8e076c8ed45c64be99",
    filesSha256: "a4e41dd90b18f9df122e6ba96d80bd00da465cc2c3393ff7e822657eb12c6a61",
    fileCount: 1845,
  },
  incoming: {
    bytes: 589117,
    sha256: "58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857",
    gitBlob: "e775a64483ace95ca46b0d65221cff9cf84c4500",
    dataSha256: "fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368",
    filesSha256: "b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92",
    fileCount: 1840,
  },
} as const;
const fixtureRemovals = {
  d: [
    {
      field: "files",
      index: 86,
      row: {
        path: "src/ir/program/source-map-position.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      field: "files",
      index: 1049,
      row: {
        path: "src/codegen/array/ta-iter-detach.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1769,
      row: {
        path: "src/codegen/expressions/callable-property-omittable-param.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1770,
      row: {
        path: "src/codegen/closures/host-boolean-callback.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1771,
      row: {
        path: "src/codegen/expressions/typeof-import-binding.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
  main: [
    {
      field: "moves",
      index: 0,
      row: {
        from: "src/codegen/promise-combinator-observable-protocol.ts",
        to: "src/codegen/promises/promise-combinator-observable-protocol.ts",
      },
    },
    {
      field: "moves",
      index: 1,
      row: {
        from: "src/codegen/promise-observable-combinators.ts",
        to: "src/codegen/promises/promise-observable-combinators.ts",
      },
    },
    {
      field: "moves",
      index: 2,
      row: {
        from: "src/codegen/vec-pop-body.ts",
        to: "src/codegen/vectors/vec-pop-body.ts",
      },
    },
    {
      field: "files",
      index: 52,
      row: {
        path: "src/runtime/wasmgc/values/vector-storage-copy-body.ts",
        state: "clean",
        layer: "native-runtime",
      },
    },
    {
      field: "files",
      index: 870,
      row: {
        path: "src/codegen/promises/promise-combinator-observable-protocol.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-driven observable protocol registration and emission from allocator-owned resources and canonical native bodies; retain the legacy adapter until full IR equivalence.",
      },
    },
    {
      field: "files",
      index: 871,
      row: {
        path: "src/codegen/promises/promise-observable-combinators.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate AST/context-driven observable combinator lowering, allocator-owned live aggregate resources, and canonical native body construction.",
      },
    },
    {
      field: "files",
      index: 1108,
      row: {
        path: "src/codegen/vectors/vec-pop-body.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Closed pop instruction builder separated from allocation; still uses backend physical types and handles, not a migrated semantic IR producer.",
      },
    },
  ],
  incoming: [
    {
      field: "moves",
      index: 0,
      row: {
        from: "src/codegen/promise-combinator-observable-protocol.ts",
        to: "src/codegen/promises/promise-combinator-observable-protocol.ts",
      },
    },
    {
      field: "moves",
      index: 1,
      row: {
        from: "src/codegen/promise-observable-combinators.ts",
        to: "src/codegen/promises/promise-observable-combinators.ts",
      },
    },
    {
      field: "moves",
      index: 2,
      row: {
        from: "src/codegen/vec-pop-body.ts",
        to: "src/codegen/vectors/vec-pop-body.ts",
      },
    },
    {
      field: "files",
      index: 52,
      row: {
        path: "src/runtime/wasmgc/values/vector-storage-copy-body.ts",
        state: "clean",
        layer: "native-runtime",
      },
    },
    {
      field: "files",
      index: 870,
      row: {
        path: "src/codegen/promises/promise-combinator-observable-protocol.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-driven observable protocol registration and emission from allocator-owned resources and canonical native bodies; retain the legacy adapter until full IR equivalence.",
      },
    },
    {
      field: "files",
      index: 871,
      row: {
        path: "src/codegen/promises/promise-observable-combinators.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate AST/context-driven observable combinator lowering, allocator-owned live aggregate resources, and canonical native body construction.",
      },
    },
    {
      field: "files",
      index: 891,
      row: {
        path: "src/codegen/object-model/proxy-forward-carriers.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1049,
      row: {
        path: "src/codegen/array/ta-iter-detach.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1108,
      row: {
        path: "src/codegen/vectors/vec-pop-body.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Closed pop instruction builder separated from allocation; still uses backend physical types and handles, not a migrated semantic IR producer.",
      },
    },
    {
      field: "files",
      index: 1769,
      row: {
        path: "src/codegen/expressions/callable-property-omittable-param.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1770,
      row: {
        path: "src/codegen/closures/host-boolean-callback.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      field: "files",
      index: 1771,
      row: {
        path: "src/codegen/expressions/typeof-import-binding.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
  ],
} as const;
const routes = [
  {
    view: "union-to-d",
    from: "union",
    to: "d",
    removals: [
      {
        field: "files",
        index: 86,
      },
      {
        field: "files",
        index: 1049,
      },
      {
        field: "files",
        index: 1769,
      },
      {
        field: "files",
        index: 1770,
      },
      {
        field: "files",
        index: 1771,
      },
    ],
  },
  {
    view: "union-to-incoming",
    from: "union",
    to: "incoming",
    removals: [
      {
        field: "moves",
        index: 0,
      },
      {
        field: "moves",
        index: 1,
      },
      {
        field: "moves",
        index: 2,
      },
      {
        field: "files",
        index: 52,
      },
      {
        field: "files",
        index: 870,
      },
      {
        field: "files",
        index: 871,
      },
      {
        field: "files",
        index: 891,
      },
      {
        field: "files",
        index: 1049,
      },
      {
        field: "files",
        index: 1108,
      },
      {
        field: "files",
        index: 1769,
      },
      {
        field: "files",
        index: 1770,
      },
      {
        field: "files",
        index: 1771,
      },
    ],
  },
  {
    view: "main-to-incoming",
    from: "main",
    to: "incoming",
    removals: [
      {
        field: "files",
        index: 888,
      },
      {
        field: "files",
        index: 1046,
      },
      {
        field: "files",
        index: 1765,
      },
      {
        field: "files",
        index: 1766,
      },
      {
        field: "files",
        index: 1767,
      },
    ],
  },
] as const;
type Epoch = keyof typeof profiles;
type Policy = Record<string, unknown> & { files: Record<string, unknown>[]; moves: Record<string, unknown>[] };
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (raw: string): string => createHash("sha256").update(raw).digest("hex");
function assertProfile(raw: string, epoch: Epoch): Policy {
  const expected = profiles[epoch];
  expect(Buffer.byteLength(raw)).toBe(expected.bytes);
  expect(sha(raw)).toBe(expected.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(raw)}\0`)
      .update(raw)
      .digest("hex"),
  ).toBe(expected.gitBlob);
  const data = JSON.parse(raw) as Policy;
  expect(sha(JSON.stringify(data))).toBe(expected.dataSha256);
  expect(sha(JSON.stringify(data.files))).toBe(expected.filesSha256);
  expect(data.files).toHaveLength(expected.fileCount);
  return data;
}
function fixture(epoch: Epoch): string {
  const union = read("scripts/compiler-boundaries.json");
  const data = assertProfile(union, "union");
  if (epoch === "union") return union;
  let raw = union;
  const spans: { offset: number; text: string }[] = [];
  for (const removal of fixtureRemovals[epoch]) {
    expect(data[removal.field][removal.index]).toEqual(removal.row);
    const text =
      JSON.stringify(removal.row, null, 2)
        .split("\n")
        .map((line) => "    " + line)
        .join("\n") + ",\n";
    const offset = union.indexOf(text);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(union.indexOf(text, offset + 1)).toBe(-1);
    spans.push({ offset, text });
  }
  for (const span of spans.sort((a, b) => b.offset - a.offset))
    raw = raw.slice(0, span.offset) + raw.slice(span.offset + span.text.length);
  // Full independent raw/data/blob authorities, not just a row count.
  assertProfile(raw, epoch);
  let replay = raw;
  let removed = 0;
  const forward = [...spans]
    .sort((a, b) => a.offset - b.offset)
    .map((span) => {
      const entry = { offset: span.offset - removed, text: span.text };
      removed += span.text.length;
      return entry;
    });
  for (const span of forward.reverse()) replay = replay.slice(0, span.offset) + span.text + replay.slice(span.offset);
  expect(replay).toBe(union);
  return raw;
}
describe("5883 pinned 4bff explicit physical inventory views", () => {
  it("pins the independent fixed receipt bytes", () => {
    expect(inventory4bffViewsReceiptPath).toBe("tests/helpers/ir-5883-main-4bff-inventory-views.json");
    const raw = read(inventory4bffViewsReceiptPath);
    expect(Buffer.byteLength(raw)).toBe(21555);
    expect(sha(raw)).toBe("2b11315b63f58739bb17506a16ab6290ff7fc276c85b506ce8c0d73e8cfec136");
  });
  it("rejects unknown view names before authority I/O", () => {
    let reads = 0;
    const authority = () => {
      reads++;
      throw new Error("must not read");
    };
    expect(() => capture5883Main4bffInventoryView({}, "other" as Inventory4bffView, authority)).toThrow(
      /unknown named view/,
    );
    expect(() => capture5883Main4bffInventoryViewSource("{}", "other" as Inventory4bffView, authority)).toThrow(
      /unknown named view/,
    );
    expect(reads).toBe(0);
  });
  for (const route of routes) {
    it(`${route.view}: exact raw/semantic output, fresh authority and detached data`, () => {
      const raw = fixture(route.from),
        target = fixture(route.to);
      const current = JSON.parse(raw) as Policy,
        saved = JSON.stringify(current);
      const trace: string[] = [];
      const authority = (path: string) => {
        trace.push(path);
        return read(path);
      };
      expect(capture5883Main4bffInventoryViewSource(raw, route.view, authority)).toBe(target);
      const projected = capture5883Main4bffInventoryView(current, route.view, authority) as Policy;
      expect(projected).toEqual(JSON.parse(target));
      expect(JSON.stringify(current)).toBe(saved);
      expect(projected.files).not.toBe(current.files);
      expect(projected.files[0]).not.toBe(current.files[0]);
      projected.files[0]!.state = "mutant";
      expect(capture5883Main4bffInventoryView(current, route.view, authority)).toEqual(JSON.parse(target));
      expect(trace).toEqual([
        inventory4bffViewsReceiptPath,
        inventory4bffViewsReceiptPath,
        inventory4bffViewsReceiptPath,
      ]);
    });
    for (const epoch of ["union", "d", "main", "incoming"] as const) {
      if (epoch === route.from) continue;
      it(`${route.view}: refuses wrong physical epoch ${epoch}`, () => {
        const raw = fixture(epoch);
        expect(() => capture5883Main4bffInventoryViewSource(raw, route.view)).toThrow(
          /complete raw source profile mismatch/,
        );
        expect(() => capture5883Main4bffInventoryView(JSON.parse(raw), route.view)).toThrow(
          /complete policy profile mismatch/,
        );
      });
    }
    for (const removal of route.removals)
      for (const mode of ["omit", "duplicate", "reorder", "change"] as const) {
        it(`${route.view}: refuses ${mode} ${removal.field} at ${removal.index}`, () => {
          const data = JSON.parse(fixture(route.from)) as Policy;
          const rows = data[removal.field],
            index = removal.index;
          if (mode === "omit") rows.splice(index, 1);
          if (mode === "duplicate") rows.splice(index, 0, structuredClone(rows[index]!));
          if (mode === "reorder") [rows[index], rows[index + 1]] = [rows[index + 1]!, rows[index]!];
          if (mode === "change") rows[index]!.unexpected = true;
          expect(() => capture5883Main4bffInventoryView(data, route.view)).toThrow(/complete policy profile mismatch/);
          expect(() => capture5883Main4bffInventoryViewSource(JSON.stringify(data), route.view)).toThrow(
            /complete raw source profile mismatch/,
          );
        });
      }
    for (const mode of ["retained row", "non-files field"] as const) {
      it(`${route.view}: refuses changed ${mode}`, () => {
        const data = JSON.parse(fixture(route.from)) as Policy;
        if (mode === "retained row") data.files.at(-1)!.owner = "mutant";
        else data.description = "mutant";
        expect(() => capture5883Main4bffInventoryView(data, route.view)).toThrow(/complete policy profile mismatch/);
        expect(() => capture5883Main4bffInventoryViewSource(JSON.stringify(data), route.view)).toThrow(
          /complete raw source profile mismatch/,
        );
      });
    }
    it(`${route.view}: refuses raw formatting corruption`, () => {
      const raw = fixture(route.from);
      expect(() => capture5883Main4bffInventoryViewSource(raw + "\n", route.view)).toThrow(
        /complete raw source profile mismatch/,
      );
      expect(() => capture5883Main4bffInventoryViewSource(JSON.stringify(JSON.parse(raw)), route.view)).toThrow(
        /complete raw source profile mismatch/,
      );
    });
    for (const mode of [
      "boxed",
      "accessor",
      "sparse",
      "array accessor",
      "symbol",
      "cycle",
      "hidden",
      "undefined",
      "nonfinite",
    ] as const) {
      it(`${route.view}: refuses malformed ${mode} before authority I/O`, () => {
        const data = JSON.parse(fixture(route.from)) as Policy;
        let reads = 0,
          touched = 0;
        const authority = () => {
          reads++;
          return read(inventory4bffViewsReceiptPath);
        };
        const sentinel = () => {
          touched++;
          throw new Error("must not touch");
        };
        if (mode === "boxed") {
          const box = Object("clean");
          box.toString = sentinel;
          data.files[0]!.state = box;
        }
        if (mode === "accessor") Object.defineProperty(data, "extra", { get: sentinel, enumerable: true });
        if (mode === "sparse") expect(Reflect.deleteProperty(data.files, "0")).toBe(true);
        if (mode === "array accessor") Object.defineProperty(data.files, "0", { get: sentinel, enumerable: true });
        if (mode === "symbol") Object.defineProperty(data, Symbol("extra"), { value: 1 });
        if (mode === "cycle") data.extra = data;
        if (mode === "hidden") Object.defineProperty(data, "extra", { value: 1 });
        if (mode === "undefined") data.extra = undefined;
        if (mode === "nonfinite") data.extra = NaN;
        expect(() => capture5883Main4bffInventoryView(data, route.view, authority)).toThrow();
        expect(reads).toBe(0);
        expect(touched).toBe(0);
      });
    }
    for (const raw of ["", "{", "null", "[]", "0"]) {
      it(`${route.view}: refuses malformed raw ${JSON.stringify(raw)} before authority I/O`, () => {
        let reads = 0;
        expect(() =>
          capture5883Main4bffInventoryViewSource(raw, route.view, () => {
            reads++;
            return "";
          }),
        ).toThrow();
        expect(reads).toBe(0);
      });
    }
    it(`${route.view}: refuses boxed raw without coercion or authority I/O`, () => {
      let reads = 0,
        touched = 0;
      const box = Object("text");
      box.toString = () => {
        touched++;
        return fixture(route.from);
      };
      expect(() =>
        capture5883Main4bffInventoryViewSource(box as string, route.view, () => {
          reads++;
          return "";
        }),
      ).toThrow();
      expect(reads).toBe(0);
      expect(touched).toBe(0);
    });
    for (const mode of ["changed", "stale", "missing", "boxed"] as const) {
      it(`${route.view}: authenticates fresh ${mode} receipt after success and recovery`, () => {
        const raw = fixture(route.from),
          target = fixture(route.to);
        let broken = false;
        const trace: string[] = [];
        const authority = (path: string): string => {
          trace.push(path);
          if (!broken) return read(path);
          if (mode === "missing") throw new Error("missing authority");
          if (mode === "stale") return read("tests/helpers/ir-position-finally-main-successor.json");
          if (mode === "boxed") return Object(read(path)) as string;
          return read(path) + "\n";
        };
        expect(capture5883Main4bffInventoryViewSource(raw, route.view, authority)).toBe(target);
        broken = true;
        expect(() => capture5883Main4bffInventoryViewSource(raw, route.view, authority)).toThrow();
        expect(() => capture5883Main4bffInventoryView(JSON.parse(raw), route.view, authority)).toThrow();
        broken = false;
        expect(capture5883Main4bffInventoryViewSource(raw, route.view, authority)).toBe(target);
        expect(trace).toEqual(Array(4).fill(inventory4bffViewsReceiptPath));
      });
    }
    it(`${route.view}: rereads and refuses corrupted source after success`, () => {
      let operand = fixture(route.from);
      const readOperand = () => operand;
      expect(capture5883Main4bffInventoryViewSource(readOperand(), route.view)).toBe(fixture(route.to));
      operand += "\n";
      expect(() => capture5883Main4bffInventoryViewSource(readOperand(), route.view)).toThrow(
        /complete raw source profile mismatch/,
      );
      operand = fixture(route.from);
      expect(capture5883Main4bffInventoryViewSource(readOperand(), route.view)).toBe(fixture(route.to));
    });
  }
});

describe("5883 pinned 4bff historical chain equivalence", () => {
  it("raw D and incoming acquisition paths independently reach exact 588351 bytes", () => {
    const raw = fixture("union");
    const dRaw = capture5883Main4bffInventoryViewSource(raw, "union-to-d");
    const incomingRaw = capture5883Main4bffInventoryViewSource(raw, "union-to-incoming");
    assertProfile(dRaw, "d");
    assertProfile(incomingRaw, "incoming");
    const fromD = capture5883InventoryPredecessorPolicySource(dRaw);
    const fromIncoming = captureSourceMapPositionInventoryPredecessorPolicySource(
      capturePositionClassFieldsMainPredecessorPolicySource(
        capturePositionFinallyMainPredecessorPolicySource(incomingRaw),
      ),
    );
    for (const result of [fromD, fromIncoming]) {
      expect(Buffer.byteLength(result)).toBe(588351);
      expect(sha(result)).toBe("4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05");
      expect(
        createHash("sha1")
          .update(`blob ${Buffer.byteLength(result)}\0`)
          .update(result)
          .digest("hex"),
      ).toBe("c5da824f89dded25e85e7e315825d2d61d97f906");
    }
    expect(fromIncoming).toBe(fromD);
  });
  it("semantic D and incoming acquisition paths independently reach the exact 588351 policy", () => {
    const current = JSON.parse(fixture("union")) as Policy;
    const saved = JSON.stringify(current);
    const fromD = capture5883InventoryPredecessorPolicy(capture5883Main4bffInventoryView(current, "union-to-d"));
    const fromIncoming = captureSourceMapPositionInventoryPredecessorPolicy(
      capturePositionClassFieldsMainPredecessorPolicy(
        capturePositionFinallyMainPredecessorPolicy(capture5883Main4bffInventoryView(current, "union-to-incoming")),
      ),
    );
    for (const result of [fromD, fromIncoming]) {
      expect(sha(JSON.stringify(result))).toBe("56532a3cda4a9a8ec083fc0ebb7d38300fe754dd8f7cc4d49c20784ae77f05e0");
      expect(result.files).toHaveLength(1837);
      expect(sha(JSON.stringify(result.files))).toBe(
        "fdd1e7da8bc2decab20f41771aa30b724a3ecda1929f590f286e2f530171be9c",
      );
    }
    expect(fromIncoming).toEqual(fromD);
    expect(fromIncoming).not.toBe(fromD);
    expect(fromIncoming.files).not.toBe(fromD.files);
    expect(JSON.stringify(current)).toBe(saved);
  });
});
