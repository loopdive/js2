// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateRuntimePreparationRelocation,
  beforeRuntimePreparationRelocation,
  runtimePreparationRelocationCurrentPaths,
  runtimePreparationRelocationReceiptPath,
} from "./helpers/ir-runtime-preparation-relocation.js";
import {
  acceptedHistoricalDeclarations,
  assertCallableExtension,
  currentDeclarations,
  historicalIntrinsicSource,
} from "./helpers/ir-historical-runtime-reconstruction.js";
import {
  reconstructRuntimeContractReceiptSources,
  runtimeContractCurrentPaths,
} from "./helpers/ir-runtime-contract-evolution.js";

const repository = resolve(import.meta.dirname, "..");
type Reader = (path: string) => string;
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const rawRead: Reader = (path) => readFileSync(resolve(repository, path), "utf8");
const [support, implementation] = runtimePreparationRelocationCurrentPaths;
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const receiptText = rawRead(runtimePreparationRelocationReceiptPath);
const receipt = authenticateRuntimePreparationRelocation(receiptText);
afterEach(async () => {
  await setImmediate();
});

function positive(): Reader {
  const historicalReader = beforeRuntimePreparationRelocation(rawRead);
  expect(Buffer.byteLength(rawRead(support))).toBe(850);
  expect(hash(rawRead(support))).toBe("584322a7384556a6f3b82dc85cc30c2213510fe70f2cd437ccbef97826156351");
  expect(Buffer.byteLength(rawRead(implementation))).toBe(49541);
  expect(hash(rawRead(implementation))).toBe("bd27170fd1df4a9bbad2874e5f2db34bc455fb6807b26523da4be8c182f3622b");
  expect(Buffer.byteLength(historicalReader(support))).toBe(49626);
  expect(hash(historicalReader(support))).toBe("03e5d583b91a7589481c80e1ca1dd5a621fee3e593f5ca9537f9c573b8925e40");
  return historicalReader;
}
function override(reader: Reader, path: string, text: string): Reader {
  return (requested) => (requested === path ? text : reader(requested));
}
function replaceOne(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + from.length) !== -1 || from === to)
    throw Error("one exact changed span required");
  return text.slice(0, at) + to + text.slice(at + from.length);
}
function physicalRefusal(path: string, edit: (source: string) => string): void {
  positive();
  const original = rawRead(path),
    mutant = edit(original);
  expect(mutant).not.toBe(original);
  expect(() => beforeRuntimePreparationRelocation(override(rawRead, path, mutant))).toThrow(
    "runtime preparation relocation:",
  );
}
function historical(): Reader {
  const historicalReader = positive();
  const sources = reconstructRuntimeContractReceiptSources(historicalReader);
  expect(sources.size).toBe(runtimeContractCurrentPaths.length);
  for (const path of runtimeContractCurrentPaths) expect(sources.has(path)).toBe(true);
  return (path) => {
    if (!runtimeContractCurrentPaths.includes(path)) return historicalReader(path);
    const source = sources.get(path);
    if (source === undefined) throw Error("missing runtime historical source " + path);
    return source;
  };
}
function declarations(source: string) {
  return ts
    .createSourceFile(support, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    .statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
}
function reorder(source: string): string {
  const [first, second] = declarations(source);
  if (!first || !second) throw Error("two declarations required");
  return source.slice(0, first.getFullStart()) + second.getFullText() + first.getFullText() + source.slice(second.end);
}

describe("fixed runtime preparation source relocation", () => {
  it("authenticates the actual pair and independently replays every restored byte", () => {
    const historicalReader = positive(),
      restored = Buffer.from(historicalReader(support));
    expect(receipt.segments).toHaveLength(47);
    expect(receipt.segments.filter((segment) => segment.kind === "module-literal")).toHaveLength(23);
    const replay = Buffer.concat(
      receipt.segments.map((segment) =>
        segment.kind === "unchanged"
          ? restored.subarray(segment.beforeStart, segment.beforeEnd)
          : Buffer.from(segment.afterText!),
      ),
    );
    expect(replay.equals(Buffer.from(rawRead(implementation)))).toBe(true);
    expect(historicalReader(implementation)).toBe(rawRead(implementation));
  });

  it("reads the mandatory pair once and delegates all other paths unchanged", () => {
    positive();
    const calls: string[] = [];
    const reader = beforeRuntimePreparationRelocation((path) => {
      calls.push(path);
      return rawRead(path);
    });
    expect(calls).toEqual([runtimePreparationRelocationReceiptPath, support, implementation]);
    reader(support);
    reader(support);
    expect(calls).toHaveLength(3);
    expect(reader("package.json")).toBe(rawRead("package.json"));
    expect(calls.at(-1)).toBe("package.json");
  });

  it.each(runtimePreparationRelocationCurrentPaths)("refuses missing, undefined and empty %s", (path) => {
    positive();
    expect(() =>
      beforeRuntimePreparationRelocation((requested) => {
        if (requested === path) throw Error("missing physical source " + path);
        return rawRead(requested);
      }),
    ).toThrow("missing physical source " + path);
    expect(() => beforeRuntimePreparationRelocation(override(rawRead, path, undefined as unknown as string))).toThrow(
      "missing nonempty source",
    );
    expect(() => beforeRuntimePreparationRelocation(override(rawRead, path, ""))).toThrow("missing nonempty source");
  });

  const receiptMutations: readonly [string, (r: Mutable<typeof receipt>) => void][] = [
    [
      "schema",
      (r) => {
        r.schema = "unknown";
      },
    ],
    [
      "version",
      (r) => {
        r.schema = "ir-runtime-preparation-relocation-v2";
      },
    ],
    [
      "fixed path",
      (r) => {
        r.currentPaths[1] = "src/ir/wrong.ts";
      },
    ],
    [
      "restored path",
      (r) => {
        r.restoredPath = implementation;
      },
    ],
    [
      "source pin",
      (r) => {
        r.before.sha256 = "0".repeat(64);
      },
    ],
    [
      "span pin",
      (r) => {
        r.segments[0].afterSha256 = "0".repeat(64);
      },
    ],
    [
      "overlap",
      (r) => {
        r.segments[1].afterStart--;
      },
    ],
    [
      "gap",
      (r) => {
        r.segments[1].afterStart++;
      },
    ],
    [
      "order",
      (r) => {
        [r.segments[0], r.segments[2]] = [r.segments[2], r.segments[0]];
      },
    ],
    [
      "dropped segment",
      (r) => {
        r.segments.splice(2, 1);
      },
    ],
    [
      "extra segment",
      (r) => {
        r.segments.push(r.segments[0]);
      },
    ],
    [
      "duplicate literal ordinal",
      (r) => {
        r.segments[3].ordinal = 0;
      },
    ],
    [
      "wrong reciprocal literal",
      (r) => {
        r.segments[1].afterText = "./wrong.js";
      },
    ],
    [
      "wrong inverse literal",
      (r) => {
        r.segments[1].beforeText = "./wrong.js";
      },
    ],
  ];
  it.each(receiptMutations)("refuses altered immutable receipt %s", (_label, mutate) => {
    positive();
    const altered = JSON.parse(receiptText) as Mutable<typeof receipt>;
    mutate(altered);
    const text = JSON.stringify(altered);
    expect(text).not.toBe(receiptText);
    expect(() =>
      beforeRuntimePreparationRelocation(override(rawRead, runtimePreparationRelocationReceiptPath, text)),
    ).toThrow("immutable receipt bytes mismatch");
  });
  it("refuses a whitespace-only raw receipt edit", () => {
    positive();
    expect(() => authenticateRuntimePreparationRelocation(receiptText + "\n")).toThrow(
      "immutable receipt bytes mismatch",
    );
  });

  it.each([
    [
      "wrong facade target",
      (text: string) => replaceOne(text, "./runtime/contracts/prepared.js", "./runtime/contracts/wrong.js"),
    ],
    [
      "value/type export",
      (text: string) =>
        replaceOne(text, "export type { PreparedIrRuntimeManifest }", "export { PreparedIrRuntimeManifest }"),
    ],
    ["added executable facade body", (text: string) => text + "const preparationBody = 1;\n"],
    [
      "alternate all-through-implementation facade",
      (text: string) =>
        text
          .replace('export type { PreparedIrRuntimeManifest } from "./runtime/contracts/prepared.js";\n', "")
          .replace('export { verifyIrIntrinsicInstruction } from "./runtime/intrinsic-verification.js";\n', "")
          .replace("  prepareIrRuntimeManifest,", "  prepareIrRuntimeManifest,\n  verifyIrIntrinsicInstruction,")
          .replace("PrepareIrRuntimeManifestInput }", "PrepareIrRuntimeManifestInput, PreparedIrRuntimeManifest }"),
    ],
  ] as const)("refuses %s", (_label, edit) => physicalRefusal(support, edit));

  it.each(receipt.segments.map((segment, index) => ({ segment, index })))(
    "refuses changed live bytes in fixed segment $index",
    ({ segment }) =>
      physicalRefusal(implementation, (text) => {
        const bytes = Buffer.from(text);
        bytes[segment.afterStart] = bytes[segment.afterStart] === 120 ? 121 : 120;
        return bytes.toString("utf8");
      }),
  );
  it.each(receipt.segments.filter((segment) => segment.kind === "module-literal"))(
    "refuses wrong module literal at ordinal $ordinal",
    (segment) =>
      physicalRefusal(implementation, (text) => {
        const bytes = Buffer.from(text);
        return Buffer.concat([
          bytes.subarray(0, segment.afterStart),
          Buffer.from("./wrong.js"),
          bytes.subarray(segment.afterEnd),
        ]).toString("utf8");
      }),
  );
  it.each([
    ["header", (text: string) => text.replace("Copyright", "Copywrong")],
    [
      "comment",
      (text: string) =>
        replaceOne(text, "Project the semantic standalone clock intent", "Changed semantic standalone clock intent"),
    ],
    ["body", (text: string) => replaceOne(text, "function mapArray<T>", "function changedArray<T>")],
    ["trailer", (text: string) => text + "\n"],
    [
      "missing declaration",
      (text: string) => {
        const first = declarations(text)[0]!;
        return text.slice(0, first.getFullStart()) + text.slice(first.end);
      },
    ],
    ["duplicated declaration", (text: string) => text + declarations(text)[0]!.getFullText()],
    ["reordered declaration", reorder],
    [
      "removed overload",
      (text: string) => {
        const node = declarations(text).find((node) => ts.isFunctionDeclaration(node) && !node.body)!;
        if (!node) throw Error("overload required");
        return text.slice(0, node.getFullStart()) + text.slice(node.end);
      },
    ],
    [
      "duplicated overload",
      (text: string) => {
        const node = declarations(text).find((node) => ts.isFunctionDeclaration(node) && !node.body);
        if (!node) throw Error("overload required");
        return text.slice(0, node.end) + "\n" + node.getText() + text.slice(node.end);
      },
    ],
    [
      "reordered overload",
      (text: string) => {
        const overloads = declarations(text).filter((node) => ts.isFunctionDeclaration(node) && !node.body);
        const [first, second] = overloads;
        if (!first || !second) throw Error("two overloads required");
        return (
          text.slice(0, first.getFullStart()) + second.getFullText() + first.getFullText() + text.slice(second.end)
        );
      },
    ],
    [
      "duplicated literal",
      (text: string) =>
        text.replace('from "./contracts/prepared.js"', 'from "./contracts/prepared.js./contracts/prepared.js"'),
    ],
  ] as const)("refuses physical implementation %s", (_label, edit) => physicalRefusal(implementation, edit));

  it.each(runtimePreparationRelocationCurrentPaths)("recaptures changed %s after a successful invocation", (path) => {
    positive();
    let changed = false;
    const reader: Reader = (requested) =>
      rawRead(requested) + (changed && requested === path ? "\n// changed after success\n" : "");
    expect(hash(beforeRuntimePreparationRelocation(reader)(support))).toBe(receipt.before.sha256);
    changed = true;
    expect(() => beforeRuntimePreparationRelocation(reader)).toThrow("complete source SHA256/length mismatch: " + path);
  });
  it("refuses an old body or a second inverse instead of silently restoring pristine bytes", () => {
    const historicalReader = positive();
    expect(() => beforeRuntimePreparationRelocation(historicalReader)).toThrow(
      "complete source SHA256/length mismatch: " + support,
    );
    expect(() =>
      beforeRuntimePreparationRelocation(
        override(rawRead, support, historicalReader(support) + "\n// historical mutant\n"),
      ),
    ).toThrow("complete source SHA256/length mismatch: " + support);
  });
});

describe("historical mutations occur after the physical relocation inverse", () => {
  it("replays the provider reordered-declaration guard in the old logical source", () => {
    const historicalReader = positive();
    expect(() => currentDeclarations(support, historicalReader)).not.toThrow();
    const mutant = reorder(historicalReader(support));
    expect(mutant).not.toBe(historicalReader(support));
    expect(() => currentDeclarations(support, override(historicalReader, support, mutant))).toThrow(
      /current declaration order/,
    );
  });
  it("preserves runtime-evolution changed input and old source injection refusals", () => {
    const historicalReader = positive();
    const sources = reconstructRuntimeContractReceiptSources(historicalReader);
    const old = sources.get(support)!;
    expect(old).not.toBe(historicalReader(support));
    for (const mutant of [historicalReader(support) + "\n// changed evolution input\n", old]) {
      expect(() => reconstructRuntimeContractReceiptSources(override(historicalReader, support, mutant))).toThrow(
        "runtime contract evolution: complete source SHA256/length mismatch: " + support,
      );
    }
  });
  it("preserves historical reconstruction mutation and declaration-mutation guards", () => {
    const source = historical();
    expect(() => assertCallableExtension(source)).not.toThrow();
    expect(acceptedHistoricalDeclarations(support, source)).toHaveLength(41);
    const original = source(support);
    // Replay the existing semantic vector mutation within a declaration. A
    // trailing source comment is outside this legacy declaration receipt's domain.
    const changedVectorDemand = replaceOne(
      original,
      "assertVectorCallableDemands(input.functions, input.vectorDemands)",
      "assertVectorCallableDemands([], input.vectorDemands)",
    );
    for (const [mutant, diagnostic] of [
      [changedVectorDemand, "exact clock/vector delta/neighbors function:prepareIrRuntimeManifest#2"],
      [reorder(original), "current declaration order/identity in " + support],
    ]) {
      expect(mutant).not.toBe(original);
      expect(() => acceptedHistoricalDeclarations(support, override(source, support, mutant))).toThrow(diagnostic);
    }
  });
  it("retains the program-data initial reconstruction chain and supplied reader authority", () => {
    const source = historical();
    expect(historicalIntrinsicSource(source).length).toBeGreaterThan(0);
    const historicalReader = positive();
    const calls: string[] = [];
    expect(
      reconstructRuntimeContractReceiptSources((path) => {
        calls.push(path);
        return historicalReader(path);
      }).size,
    ).toBe(runtimeContractCurrentPaths.length);
    expect(calls).toEqual(runtimeContractCurrentPaths);
    expect(() => reconstructRuntimeContractReceiptSources(override(historicalReader, support, ""))).toThrow(
      "runtime contract evolution: complete source SHA256/length mismatch: " + support,
    );
    expect(() => reconstructRuntimeContractReceiptSources(historicalReader, "{}")).toThrow(
      "runtime contract evolution:",
    );
  });
});
