// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { beforeArrayMainRefresh } from "./helpers/array-main-refresh-port.js";
import ts from "typescript";
import type { Instr } from "../src/wasm/model/instructions.js";
import { describe, expect, it } from "vitest";
import {
  buildOwnPropertyBody,
  buildPropertyIsEnumerableBody,
} from "../src/runtime/wasmgc/values/own-property-bodies.js";
import { stringExoticHasOwnPrologue } from "../src/codegen/string-exotic-own-props.js";
import { bagHasIfAbsent } from "../src/codegen/carrier-bag-visibility.js";
import { protoIndexOwnViewSubstituteInstrs } from "../src/codegen/proto-index-store.js";
import {
  applyOwnPropertyExtraction,
  ownPropertyReceipt,
  ownPropertyReceiptPath,
} from "./helpers/own-property-extraction.js";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const receipt = ownPropertyReceipt(),
  rawCurrent = read(receipt.path),
  current = beforeArrayMainRefresh(receipt.path, rawCurrent),
  donor = applyOwnPropertyExtraction(current, true);
/** Executes the actual adapter spans with real prologue constructors; records construction, not native authority. */
function capture(source: string, bits: number) {
  const start = source.indexOf("  const hasOwnNpcArm ="),
    end = source.indexOf("  // ── __extern_has", start);
  if (start < 0 || end < 0) throw Error("missing adapter capture");
  const events: unknown[] = [],
    definitions: unknown[] = [];
  const map = new Map<string, number>();
  if (bits & 1) map.set("__protoidx_own_recv", 70);
  if (bits & 2) map.set("__carrier_bag_has", 80);
  const ctx = {
    funcMap: {
      get(key: string) {
        events.push(["get", key]);
        return map.get(key);
      },
    },
  };
  const bindings = {
    ctx,
    objectTypeIdx: 10,
    propEntryTypeIdx: 11,
    objFindIdx: 30,
    bfnGetMetaIdx: bits & 4 ? 40 : undefined,
    strExoticHasOwnIdx: bits & 8 ? 50 : undefined,
    entryRefNull: { kind: "ref_null", typeIdx: 11 },
    FLAG_ENUMERABLE: 2,
    CARRIER_BAG_HAS: "__carrier_bag_has",
    buildOwnPropertyBody,
    buildPropertyIsEnumerableBody,
    protoIndexOwnViewSubstituteInstrs,
    stringExoticHasOwnPrologue,
    bagHasIfAbsent,
    registerNative: (...args: unknown[]) => {
      events.push(["register", args[0]]);
      definitions.push(args);
      if (bits & 16) map.set("__carrier_bag_has", 81);
    },
  };
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  return { events, definitions };
}
describe("eager own-property donor preservation", () => {
  it("reconstructs and replays the complete signed donor", () => {
    expect(applyOwnPropertyExtraction(donor, false)).toBe(current);
    expect(receipt.base).toBe("637a810dc268bb7aa516aaffd08c0f72379d7c43");
  });
  it.each(Array.from({ length: 16 }, (_, i) => i))(
    "preserves definitions/acquisition order for optional providers %s",
    (bits) => {
      expect(capture(rawCurrent, bits)).toStrictEqual(capture(donor, bits));
    },
  );
  it("reads the bag provider again for the second independently registered predicate", () => {
    const result = capture(rawCurrent, 31);
    expect(result).toStrictEqual(capture(donor, 31));
    expect(JSON.stringify(result.definitions)).toContain('"funcIdx":81');
  });
  it("constructs fresh kernel instruction trees for both helpers", () => {
    const d = {
      objectTypeIdx: 10,
      propEntryTypeIdx: 11,
      findOwnIdx: 30,
      builtinMetadataIdx: 40,
      nonObjectArm: {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      } as Instr,
      enumerableFlag: 2,
    };
    for (const build of [buildOwnPropertyBody, buildPropertyIsEnumerableBody]) {
      const a = build(d),
        b = build(d);
      const nodes = (value: unknown): object[] =>
        value && typeof value === "object" ? [value, ...Object.values(value).flatMap(nodes)] : [];
      const borrowed = new Set(nodes(d.nonObjectArm));
      const seen = new Set(nodes(a).filter((node) => !borrowed.has(node)));
      if (build === buildOwnPropertyBody) {
        expect(a.includes(d.nonObjectArm)).toBe(true);
        expect(b.includes(d.nonObjectArm)).toBe(true);
      }
      expect(nodes(b).some((x) => seen.has(x))).toBe(false);
      expect(a).toStrictEqual(b);
    }
  });
  it.each(receipt.spans.map((_, i) => i))("rejects changed extraction span %s", (index) => {
    const span = receipt.spans[index]!;
    expect(() => applyOwnPropertyExtraction(current.replace(span.after, span.before), true)).toThrow();
  });
  it("rejects duplicate extraction text", () =>
    expect(() => applyOwnPropertyExtraction(current + receipt.spans[1]!.after, true)).toThrow());
  it("rejects unrelated donor changes", () => expect(() => applyOwnPropertyExtraction(donor + "\n", false)).toThrow());
  it("authenticates the actual runtime builder", () =>
    expect(() =>
      applyOwnPropertyExtraction(current, true, (p) => (p === receipt.modules[0]!.path ? read(p) + "\n" : read(p))),
    ).toThrow("builder mismatch"));
  it("rejects a changed receipt", () =>
    expect(() => ownPropertyReceipt((p) => (p === ownPropertyReceiptPath ? read(p) + "\n" : read(p)))).toThrow(
      "receipt mismatch",
    ));
});
