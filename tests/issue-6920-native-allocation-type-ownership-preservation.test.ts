// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authenticateIrNativeAllocationTypeOwnershipReceipt,
  assertIrNativeAllocationTypeOwnershipSourceRoles,
  irNativeAllocationTypeOwnershipPaths as paths,
  irNativeAllocationTypeOwnershipReceiptPath as receiptPath,
  readBeforeIrNativeAllocationTypeOwnership as readBefore,
  reconstructIrNativeAllocationTypeOwnershipDraft as inverse,
  replayIrNativeAllocationTypeOwnershipDraft as forward,
  type IrNativeAllocationTypeOwnershipReceipt,
} from "./helpers/ir-native-allocation-type-ownership-successor.js";
import { ALLOC_NAMESPACES } from "../src/ir/analysis/contracts/allocations.js";
import { ALLOC_NAMESPACES as registryNamespaces } from "../src/ir/analysis/alloc-registry.js";

const actual = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const receipt = () => authenticateIrNativeAllocationTypeOwnershipReceipt(actual(receiptPath));
const current = () => new Map<string, string>(paths.map((p) => [p, actual(p)]));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const draft = () => JSON.parse(actual(receiptPath)) as IrNativeAllocationTypeOwnershipReceipt;
function changed(path: string, text: string) {
  return (p: string) => (p === path ? text : actual(p));
}
function replaceOnce(text: string, from: string, to: string): string {
  const index = text.indexOf(from);
  if (index < 0 || text.indexOf(from, index + 1) >= 0) throw Error(`one mutation span required: ${from}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}
function repinCurrent(r: IrNativeAllocationTypeOwnershipReceipt, values: ReadonlyMap<string, string>) {
  return {
    ...r,
    current: r.current.map((row) => {
      const text = values.get(row.path)!;
      return {
        ...row,
        bytes: Buffer.byteLength(text),
        sha256: hash(text),
        gitBlob: createHash("sha1")
          .update(`blob ${Buffer.byteLength(text)}\0`)
          .update(text)
          .digest("hex"),
      };
    }),
  };
}

describe("issue-6920 live allocation type/namespace ownership successor", () => {
  it("independently recovers and replays all four complete authentic sources", () => {
    const r = receipt(),
      live = current(),
      before = inverse(r, live),
      replay = forward(r, before);
    expect([...before.keys()]).toEqual(paths);
    expect([...replay]).toEqual([...live]);
    for (const pin of r.before) {
      expect(Buffer.byteLength(before.get(pin.path)!)).toBe(pin.bytes);
      expect(hash(before.get(pin.path)!)).toBe(pin.sha256);
      expect(readBefore(pin.path, actual)).toBe(before.get(pin.path));
    }
    const j1 = JSON.parse(actual(r.historical[0]!.path)),
      ae28 = JSON.parse(actual(r.historical[2]!.path));
    expect(j1.current.find((p: { path: string }) => p.path === paths[0])).toEqual(r.before[0]);
    expect(ae28.current.find((p: { path: string }) => p.path === paths[2])).toEqual(r.before[2]);
    for (const old of r.historical) {
      expect(hash(actual(old.path))).toBe(old.sha256);
    }
  });
  it("independently assembles the forward transfer test-side from authenticated predecessor bytes", () => {
    const r = receipt(),
      before = inverse(r, current());
    const assembled = new Map<string, string>();
    assembled.set(paths[0], before.get(paths[0])! + "\n" + r.transfers.map((t) => t.beforeText).join("\n\n") + "\n");
    for (const transfer of r.transfers) {
      const bytes = Buffer.from(before.get(transfer.source)!);
      expect(bytes.subarray(transfer.beforeStart, transfer.beforeEnd).toString()).toBe(transfer.beforeText);
      assembled.set(
        transfer.source,
        Buffer.concat([
          bytes.subarray(0, transfer.beforeStart),
          Buffer.from(transfer.currentText),
          bytes.subarray(transfer.beforeEnd),
        ]).toString(),
      );
    }
    expect([...assembled.keys()]).toEqual(paths);
    for (const path of paths) expect(assembled.get(path)).toBe(actual(path));
  });
  it("retains actual canonical namespace binding/value identity", () => {
    expect(registryNamespaces).toBe(ALLOC_NAMESPACES);
    expect(ALLOC_NAMESPACES).toEqual({
      ownership: "ownership",
      encoding: "encoding",
      lifetime: "lifetime",
      escape: "escape",
    });
  });
  it("authenticates all current owners even before unrelated passthrough", () => {
    const calls: string[] = [];
    expect(
      readBefore("package.json", (p) => {
        calls.push(p);
        return actual(p);
      }),
    ).toBe(actual("package.json"));
    expect(calls).toEqual([receiptPath, ...paths, ...receipt().historical.map((p) => p.path), "package.json"]);
    expect(() => readBefore("package.json", changed(paths[0], actual(paths[0]) + "\nvoid 0;\n"))).toThrow(/source pin/);
  });
  it("returns the captured authenticated receipt and historical bytes without an unchecked reread", () => {
    for (const requested of [receiptPath, ...receipt().historical.map((p) => p.path)]) {
      const calls = new Map<string, number>();
      const changingReader = (path: string) => {
        const count = (calls.get(path) ?? 0) + 1;
        calls.set(path, count);
        return path === requested && count > 1 ? actual(path) + " altered after authentication" : actual(path);
      };
      expect(readBefore(requested, changingReader)).toBe(actual(requested));
      expect(calls.get(requested)).toBe(1);
    }
  });
  it.each([receiptPath, ...paths, ...[0, 1, 2, 3].map((i) => receipt().historical[i]!.path)])(
    "requires live owner %s",
    (missing) => {
      expect(() =>
        readBefore(paths[0], (p) => {
          if (p === missing) throw Error(`missing ${missing}`);
          return actual(p);
        }),
      ).toThrow(`missing ${missing}`);
    },
  );
  it.each(paths)("rejects warmed drift in %s", (path) => {
    let dirty = false;
    const reader = (p: string) => (p === path && dirty ? actual(p) + "\n// warmed source mutation\n" : actual(p));
    expect(readBefore(paths[0], reader)).toBe(inverse(receipt(), current()).get(paths[0]));
    dirty = true;
    expect(() => readBefore(paths[0], reader)).toThrow(/source pin/);
  });
  it.each([
    [paths[0], '"owned" | "borrowed" | "shared" | "escaped"', '"owned" | "shared" | "borrowed" | "escaped"'],
    [paths[0], "readonly stackAllocatable: boolean;", "stackAllocatable: boolean;"],
    [paths[0], 'ownership: "ownership"', 'ownership: "encoding"'],
    [paths[0], "export const ALLOC_NAMESPACES", "const ALLOC_NAMESPACES"],
    [paths[1], "export type { Ownership }", "export { Ownership }"],
    [paths[2], "import type { EscapeClass, EscapeInfo }", "import { EscapeClass, EscapeInfo }"],
    [paths[3], "export { ALLOC_NAMESPACES }", "export type { ALLOC_NAMESPACES }"],
    [paths[3], "export { ALLOC_NAMESPACES }", "export { ALLOC_NAMESPACES as PretendNamespaces }"],
  ] as const)("rejects actual binding/role mutation in %s (%s)", (path, from, to) => {
    const live = current();
    assertIrNativeAllocationTypeOwnershipSourceRoles(live);
    live.set(path, replaceOnce(live.get(path)!, from, to));
    expect(() => assertIrNativeAllocationTypeOwnershipSourceRoles(live)).toThrow(
      /^native allocation ownership successor:/,
    );
    expect(() => inverse(repinCurrent(draft(), live), live)).toThrow();
  });
  it.each(paths)("rejects complete source repin of changed scaffold in %s", (path) => {
    const live = current();
    live.set(path, live.get(path)! + "\n// forged scaffold\n");
    const forged = repinCurrent(draft(), live);
    expect(() => inverse(forged, live)).toThrow();
    expect(() => authenticateIrNativeAllocationTypeOwnershipReceipt(JSON.stringify(forged))).toThrow(/digest/);
  });
  it("rejects changed destination append and a mutually repinned false forward", () => {
    const r = receipt(),
      before = inverse(r, current());
    const altered = {
      ...draft(),
      contractAppend: r.contractAppend.replace('ownership: "ownership"', 'ownership: "encoding"'),
    };
    expect(() => forward(altered, before)).toThrow(/append/);
    const transfer = r.transfers[2]!;
    const falseForward = {
      ...draft(),
      transfers: r.transfers.map((t, i) =>
        i === 2 ? { ...t, beforeText: t.beforeText.replace('ownership: "ownership"', 'ownership: "ownershiP"') } : t,
      ),
      contractAppend: r.contractAppend.replace('ownership: "ownership"', 'ownership: "ownershiP"'),
    };
    // Text lengths match and both forward recipe locations agree; exact donor source still refuses.
    expect(falseForward.transfers[2]!.beforeText.length).toBe(transfer.beforeText.length);
    expect(() => forward(falseForward, before)).toThrow();
  });
  it("rejects extra/missing/reordered complete map inventories", () => {
    const r = receipt(),
      live = current(),
      before = inverse(r, live);
    const missing = new Map(live);
    missing.delete(paths[3]);
    expect(() => inverse(r, missing)).toThrow(/inventory/);
    const extra = new Map(live);
    extra.set("src/ir/analysis/unowned.ts", "");
    expect(() => inverse(r, extra)).toThrow(/inventory/);
    expect(() => forward(r, new Map([...before].reverse()))).toThrow(/inventory/);
  });
  it("rejects receipt equivalents, caller repins and closed schema extensions", () => {
    const text = actual(receiptPath),
      r = receipt();
    expect(JSON.parse(text + " ")).toEqual(r);
    expect(() => authenticateIrNativeAllocationTypeOwnershipReceipt(text + " ")).toThrow(/digest/);
    expect(() => authenticateIrNativeAllocationTypeOwnershipReceipt(JSON.stringify(r))).toThrow(/digest/);
    expect(() => inverse({ ...r, unreviewed: true } as IrNativeAllocationTypeOwnershipReceipt, current())).toThrow(
      /closed/,
    );
    expect(() => readBefore(paths[0], changed(receiptPath, text + " "))).toThrow(/digest/);
  });
});
