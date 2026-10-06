// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import {
  authenticateRuntimeProgramRelocationReceipt,
  assertRuntimeProgramRelocationSource,
  readRuntimeProgramRelocationActual as read,
  reconstructRuntimeProgramRelocationPopulation,
  reconstructRuntimeProgramRelocationSources,
  runtimeProgramRelocationCurrentPaths,
  runtimeProgramRelocationDependencyPaths,
  runtimeProgramRelocationGitBlob,
  runtimeProgramRelocationPairs,
  runtimeProgramRelocationPopulationPaths,
  runtimeProgramRelocationReceiptPath,
  runtimeProgramRelocationSha256,
  runtimeProgramRelocationStatements,
  type RuntimeProgramRelocationStatement,
} from "./helpers/ir-runtime-program-relocation.js";

const population = (): Map<string, string> =>
  new Map(runtimeProgramRelocationPopulationPaths.map((path) => [path, read(path)]));
// This census contains metadata only. Genuine source is freshly read for each control.
const receipt = authenticateRuntimeProgramRelocationReceipt();
const moved = receipt.transfers.filter((t) => t.moved);
const retained = receipt.transfers.filter((t) => !t.moved);
function positive(): Map<string, string> {
  const actual = population(),
    originals = reconstructRuntimeProgramRelocationPopulation(actual);
  expect(originals.size).toBe(4);
  for (const record of receipt.originals) {
    const text = originals.get(record.path as (typeof runtimeProgramRelocationPairs)[number][0])!;
    expect(Buffer.byteLength(text)).toBe(record.bytes);
    expect(runtimeProgramRelocationSha256(text)).toBe(record.sha256);
    expect(runtimeProgramRelocationGitBlob(text)).toBe(record.gitBlob);
    expect(runtimeProgramRelocationStatements(record.path, text)).toEqual(record.statements);
  }
  return actual;
}
function rejectSource(path: string, mutate: (text: string) => string): void {
  const actual = positive(),
    text = actual.get(path)!;
  const mutant = mutate(text);
  expect(mutant).not.toBe(text); // Negative controls cannot silently leave their operand unchanged.
  actual.set(path, mutant);
  expect(() => reconstructRuntimeProgramRelocationPopulation(actual)).toThrow(/runtime program relocation/);
}
function replaceSpan(text: string, s: RuntimeProgramRelocationStatement, replacement: string): string {
  return text.slice(0, s.docStart) + replacement + text.slice(s.end);
}
function rejectReceipt(mutate: (r: any) => void): void {
  const actual = positive(),
    candidate = JSON.parse(read(runtimeProgramRelocationReceiptPath));
  mutate(candidate);
  const text = JSON.stringify(candidate, null, 2) + "\n";
  expect(text).not.toBe(read(runtimeProgramRelocationReceiptPath));
  expect(() => reconstructRuntimeProgramRelocationPopulation(actual, text)).toThrow(/receipt digest/);
}

describe("C1 four-donor/eight-current reciprocal source preservation", () => {
  it("authenticates the positive full source population and both byte-identical directions", () => {
    positive();
    expect(runtimeProgramRelocationCurrentPaths).toHaveLength(8);
    expect(receipt.originals).toHaveLength(4);
    expect(receipt.transfers).toHaveLength(91);
    expect(moved).toHaveLength(12);
    expect(retained).toHaveLength(79);
    expect(receipt.dependencies.map((d) => d.path)).toEqual(runtimeProgramRelocationDependencyPaths);
    expect(runtimeProgramRelocationDependencyPaths).toHaveLength(38);
    expect(receipt.originals.map((r) => r.statements.filter((s) => s.role === null).length)).toEqual([37, 3, 42, 9]);
  });
  it("captures each actual source and receipt exactly once on every independent operation", () => {
    const calls = new Map<string, number>();
    const capture = () =>
      reconstructRuntimeProgramRelocationSources((path) => {
        calls.set(path, (calls.get(path) ?? 0) + 1);
        return read(path);
      });
    expect([...capture()]).toEqual([...capture()]);
    expect([...calls.keys()]).toEqual([
      runtimeProgramRelocationReceiptPath,
      ...runtimeProgramRelocationPopulationPaths,
    ]);
    expect([...calls.values()].every((n) => n === 2)).toBe(true);
  });
  it("does not reuse a successful capture after a moved body changes", () => {
    expect(reconstructRuntimeProgramRelocationSources().size).toBe(4);
    const path = runtimeProgramRelocationPairs[0][1];
    expect(() =>
      reconstructRuntimeProgramRelocationSources((p) =>
        p === path ? read(p).replace("if (!owner)", "if (owner)") : read(p),
      ),
    ).toThrow(/length\/SHA256/);
  });
  it("keeps generator private helpers, six public exports and the prepared-function type alias", () => {
    const record = receipt.current.find((r) => r.path === "src/ir/runtime/generator-support.ts")!;
    expect(record.statements.filter((s) => s.role === null).map((s) => s.name)).toEqual([
      "mapArray",
      "valueTypesOf",
      "irGeneratorPushProviderSymbol",
      "irGeneratorSetReturnNeedsBoxing",
      "forEachIrGeneratorSetReturn",
      "irGeneratorNumberBoxDemand",
      "requireSameProvider",
      "attachIrGeneratorSupport",
      "collectAttachedGeneratorProviders",
    ]);
    const source = positive().get(record.path)!;
    expect(
      record.statements.filter((s) => s.role === null && source.slice(s.start, s.end).startsWith("export function")),
    ).toHaveLength(6);
    expect(
      record.statements.find((s) => s.kind === "ImportDeclaration" && s.role?.module === "./contracts/prepared.js")
        ?.role,
    ).toEqual({
      module: "./contracts/prepared.js",
      typeOnly: true,
      default: null,
      namespace: null,
      symbols: [{ name: "PreparedIrFunction", alias: "IrFunction", typeOnly: false }],
    });
  });
  it("holds no executable or type declaration snapshots in recipe literals", () => {
    positive();
    for (const record of [...receipt.originals, ...receipt.current])
      for (const piece of record.recipe) {
        if ("literal" in piece)
          expect(runtimeProgramRelocationStatements("scaffold.ts", piece.literal).every((s) => s.role !== null)).toBe(
            true,
          );
      }
  });
  const transactionFreezes = retained.filter((t) => t.after.kind === "ExpressionStatement");
  it("authenticates both genuine retained transaction freeze statements with their empty names and exact spans", () => {
    const actual = positive();
    expect(transactionFreezes).toHaveLength(2);
    expect(transactionFreezes.map((t) => [t.after.name, t.after.occurrence])).toEqual([
      ["", 0],
      ["", 1],
    ]);
    const text = actual.get("src/ir/program.ts")!;
    const statements = runtimeProgramRelocationStatements("src/ir/program.ts", text);
    for (const t of transactionFreezes) {
      expect(statements[t.after.ordinal]).toEqual(t.after);
      expect(t.before.body).toEqual(t.after.body);
      expect(t.before.docs).toEqual(t.after.docs);
      expect(text.slice(t.after.start, t.after.end)).toContain("Object.freeze(");
      assertRuntimeProgramRelocationSource(
        text.slice(t.after.fullStart, t.after.end),
        t.after.full,
        "transaction freeze full span",
      );
    }
  });
  it.each(transactionFreezes.map((t) => [t.after.occurrence, t.after] as const))(
    "rejects changed real transaction freeze call occurrence %s",
    (_occurrence, s) =>
      rejectSource(s.path, (text) =>
        replaceSpan(text, s, text.slice(s.docStart, s.end).replace("Object.freeze", "Object.seal")),
      ),
  );
  it.each(transactionFreezes.map((t) => [t.after.occurrence, t.after] as const))(
    "rejects deleted transaction freeze occurrence %s",
    (_occurrence, s) => rejectSource(s.path, (text) => replaceSpan(text, s, "")),
  );
  it.each(transactionFreezes.map((t) => [t.after.occurrence, t.after] as const))(
    "rejects duplicated transaction freeze occurrence %s",
    (_occurrence, s) =>
      rejectSource(s.path, (text) =>
        replaceSpan(text, s, text.slice(s.docStart, s.end) + "\n" + text.slice(s.docStart, s.end)),
      ),
  );
  it.each(moved.map((t) => [t.after.name, t.after] as const))("rejects edited moved body %s", (_name, s) => {
    rejectSource(
      s.path,
      (text) => text.slice(0, s.end - 1) + 'throw new Error("foreign moved algorithm");' + text.slice(s.end - 1),
    );
  });
  it.each(retained.map((t) => [t.after.name, t.after] as const))(
    "rejects edited genuine retained declaration %s",
    (_name, s) => {
      rejectSource(s.path, (text) => text.slice(0, s.end - 1) + "/* retained-body change */" + text.slice(s.end - 1));
    },
  );
  for (const [label, statements] of [
    ["moved", moved.map((t) => t.after)],
    [
      "retained",
      runtimeProgramRelocationPairs.slice(0, 3).map(([path]) => retained.find((t) => t.after.path === path)!.after),
    ],
  ] as const) {
    describe(`${label} declaration shape controls`, () => {
      it.each(statements.map((s) => [s.name, s] as const))("rejects deleted %s", (_name, s) =>
        rejectSource(s.path, (text) => replaceSpan(text, s, "")),
      );
      it.each(statements.map((s) => [s.name, s] as const))("rejects duplicated identity/body %s", (_name, s) =>
        rejectSource(s.path, (text) =>
          replaceSpan(text, s, text.slice(s.docStart, s.end) + "\n" + text.slice(s.docStart, s.end)),
        ),
      );
      it.each(statements.map((s) => [s.name, s] as const))("rejects renamed %s", (_name, s) =>
        rejectSource(s.path, (text) =>
          replaceSpan(text, s, text.slice(s.docStart, s.end).replace(s.name, `${s.name}Foreign`)),
        ),
      );
      it.each(statements.map((s) => [s.name, s] as const))("rejects reordered %s", (_name, s) =>
        rejectSource(s.path, (text) => {
          const body = text.slice(s.docStart, s.end);
          return body + "\n" + replaceSpan(text, s, "");
        }),
      );
    });
  }
  const documented = [...moved, ...retained].map((t) => t.after).filter((s) => s.start > s.docStart);
  it.each(documented.map((s) => [`${s.path}:${s.name}`, s] as const))(
    "rejects changed original docs %s",
    (_name, s) => {
      rejectSource(
        s.path,
        (text) =>
          text.slice(0, s.docStart) +
          text.slice(s.docStart, s.start).replace("/**", "/** changed") +
          text.slice(s.start),
      );
    },
  );
  for (const [label, mode] of [
    ["delete", ""],
    ["duplicate", "duplicate"],
  ] as const) {
    it.each(
      runtimeProgramRelocationPairs
        .slice(0, 3)
        .map(([path, owner]) => [path, moved.find((t) => t.after.path === owner)!.after] as const),
    )(`rejects ${label} moved declaration docs for %s`, (_path, s) => {
      rejectSource(
        s.path,
        (text) =>
          text.slice(0, s.docStart) + (mode ? text.slice(s.docStart, s.start).repeat(2) : "") + text.slice(s.start),
      );
    });
  }
  for (const side of ["moved", "retained"] as const) {
    const s = (side === "moved" ? moved : retained).find((t) => t.after.start > t.after.docStart)!.after;
    it(`rejects reordered ${side} original docs`, () =>
      rejectSource(
        s.path,
        (text) =>
          text.slice(0, s.docStart) +
          text.slice(s.start, s.end) +
          "\n" +
          text.slice(s.docStart, s.start) +
          text.slice(s.end),
      ));
    it(`rejects renamed ${side} original docs`, () =>
      rejectSource(
        s.path,
        (text) =>
          text.slice(0, s.docStart) +
          text.slice(s.docStart, s.start).replace("/**", "/** Foreign declaration docs:") +
          text.slice(s.start),
      ));
    it(`rejects deleted ${side} original docs`, () =>
      rejectSource(s.path, (text) => text.slice(0, s.docStart) + text.slice(s.start)));
    it(`rejects duplicated ${side} original docs`, () =>
      rejectSource(
        s.path,
        (text) => text.slice(0, s.docStart) + text.slice(s.docStart, s.start) + text.slice(s.docStart),
      ));
  }
  for (const [donor, owner] of runtimeProgramRelocationPairs) {
    it(`pairs a real moved-body change with changed old facade/residue: ${donor}`, () => {
      const s = moved.find((t) => t.after.path === owner)!.after;
      rejectSource(
        owner,
        (text) => text.slice(0, s.end - 1) + 'throw new Error("foreign moved algorithm");' + text.slice(s.end - 1),
      );
      rejectSource(donor, (text) =>
        text.replace(`from "./${owner.slice("src/ir/".length).replace(/\.ts$/, ".js")}"`, `from "./foreign.js"`),
      );
    });
    it(`rejects absent destination ${owner}`, () => {
      const actual = positive();
      actual.delete(owner);
      expect(() => reconstructRuntimeProgramRelocationPopulation(actual)).toThrow(/live population/);
    });
    it(`rejects body-equivalent second issuer in facade ${donor}`, () => {
      const actual = positive(),
        s = moved.find((t) => t.after.path === owner)!.after;
      const duplicated = actual.get(owner)!.slice(s.docStart, s.end);
      actual.set(donor, actual.get(donor)! + "\n" + duplicated + "\n");
      expect(() => reconstructRuntimeProgramRelocationPopulation(actual)).toThrow(/length\/SHA256/);
    });
  }
  it.each(
    runtimeProgramRelocationPairs
      .slice(0, 3)
      .map(
        ([path]) =>
          [path, retained.find((t) => t.after.path === path && t.after.kind === "FunctionDeclaration")!.after] as const,
      ),
  )("rejects changed genuine retained algorithm in %s", (_path, s) =>
    rejectSource(
      s.path,
      (text) => text.slice(0, s.end - 1) + 'throw new Error("foreign retained algorithm");' + text.slice(s.end - 1),
    ),
  );
  const roleMutants: readonly [string, string, string, string][] = [
    [
      "generator prepared alias",
      "src/ir/runtime/generator-support.ts",
      "PreparedIrFunction as IrFunction",
      "PreparedIrFunction as IrOtherFunction",
    ],
    [
      "generator prepared contract type-only",
      "src/ir/runtime/generator-support.ts",
      "import type { PreparedIrFunction",
      "import { PreparedIrFunction",
    ],
    ["owner type-only role", "src/ir/program/owner.ts", "import type { IrUnitId }", "import { IrUnitId }"],
    ["owner imported alias", "src/ir/program/owner.ts", "{ IrUnitId }", "{ IrUnitId as ForeignId }"],
    [
      "owner module path",
      "src/ir/program/owner.ts",
      "../../shared/contracts/ir-identity.js",
      "../../shared/contracts/foreign.js",
    ],
    [
      "generator public export alias",
      "src/ir/generator-support.ts",
      "  attachIrGeneratorSupport,",
      "  attachIrGeneratorSupport as attachForeignGeneratorSupport,",
    ],
    [
      "generator private helper exposure",
      "src/ir/runtime/generator-support.ts",
      "function mapArray",
      "export function mapArray",
    ],
    [
      "generator exported function name",
      "src/ir/runtime/generator-support.ts",
      "export function attachIrGeneratorSupport",
      "export function attachForeignGeneratorSupport",
    ],
  ];
  it.each(roleMutants)("rejects changed %s", (_name, path, before, after) =>
    rejectSource(path, (text) => text.replace(before, after)),
  );
  it.each(runtimeProgramRelocationDependencyPaths)("rejects changed explicitly used dependency %s", (path) =>
    rejectSource(path, (text) => text + "\n/* foreign dependency */\n"),
  );
  it("rejects an extra live population file", () => {
    const actual = positive();
    actual.set("src/ir/program/foreign.ts", "export const foreign = true;\n");
    expect(() => reconstructRuntimeProgramRelocationPopulation(actual)).toThrow(/live population/);
  });
  it("rejects missing dependency population", () => {
    const actual = positive();
    actual.delete(runtimeProgramRelocationDependencyPaths[0]!);
    expect(() => reconstructRuntimeProgramRelocationPopulation(actual)).toThrow(/live population/);
  });
  it("propagates an unavailable real source without returning an old view", () => {
    positive();
    expect(() =>
      reconstructRuntimeProgramRelocationSources((path) => {
        if (path === runtimeProgramRelocationPairs[0][1]) throw new Error("destination unavailable");
        return read(path);
      }),
    ).toThrow("destination unavailable");
  });
  it("rejects extra declaration on current owner", () =>
    rejectSource(runtimeProgramRelocationPairs[0][1], (text) => text + "\nexport const unknown = 1;\n"));
  it("rejects invalid UTF8 surrogate source", () =>
    rejectSource(runtimeProgramRelocationPairs[0][1], (text) => text + "\uD800"));
  it("checks each source component independently against a genuine positive pin", () => {
    const actual = positive(),
      r = receipt.current[0]!,
      text = actual.get(r.path)!;
    assertRuntimeProgramRelocationSource(text, r, r.path);
    for (const expected of [
      { ...r, bytes: r.bytes + 1 },
      { ...r, sha256: "0".repeat(64) },
      { ...r, gitBlob: "0".repeat(40) },
    ]) {
      expect(() => assertRuntimeProgramRelocationSource(text, expected, r.path)).toThrow(/length\/SHA256|Git blob/);
    }
  });
  const malformed: readonly [string, (r: any) => void][] = [
    [
      "extra top-level field",
      (r) => {
        r.unknown = true;
      },
    ],
    [
      "missing top-level field",
      (r) => {
        expect(Reflect.deleteProperty(r, "scope")).toBe(true);
        expect(Object.hasOwn(r, "scope")).toBe(false);
      },
    ],
    [
      "foreign profile",
      (r) => {
        r.kind = "other";
      },
    ],
    [
      "extra original file",
      (r) => {
        r.originals.push(r.originals[0]);
      },
    ],
    [
      "missing original file",
      (r) => {
        r.originals.pop();
      },
    ],
    [
      "extra current file",
      (r) => {
        r.current.push(r.current[0]);
      },
    ],
    [
      "missing current file",
      (r) => {
        r.current.pop();
      },
    ],
    [
      "reordered current population",
      (r) => {
        r.current.reverse();
      },
    ],
    [
      "extra dependency",
      (r) => {
        r.dependencies.push(r.dependencies[0]);
      },
    ],
    [
      "missing dependency",
      (r) => {
        r.dependencies.pop();
      },
    ],
    [
      "dependency pin",
      (r) => {
        r.dependencies[0].sha256 = "0".repeat(64);
      },
    ],
    [
      "source bytes",
      (r) => {
        r.current[0].bytes++;
      },
    ],
    [
      "original hash",
      (r) => {
        r.originals[0].sha256 = "0".repeat(64);
      },
    ],
    [
      "source blob",
      (r) => {
        r.current[0].gitBlob = "0".repeat(40);
      },
    ],
    [
      "declaration ordinal",
      (r) => {
        r.transfers[0].after.ordinal++;
      },
    ],
    [
      "overload occurrence",
      (r) => {
        r.transfers[0].after.occurrence++;
      },
    ],
    [
      "doc span",
      (r) => {
        r.transfers[0].after.docStart++;
      },
    ],
    [
      "full span",
      (r) => {
        r.transfers[0].after.fullStart++;
      },
    ],
    [
      "UTF8 byte boundary",
      (r) => {
        r.transfers[0].after.startByte++;
      },
    ],
    [
      "declaration kind",
      (r) => {
        r.transfers[0].after.kind = "ClassDeclaration";
      },
    ],
    [
      "extra statement field",
      (r) => {
        r.current[0].statements[0].unknown = true;
      },
    ],
    [
      "import type-only role",
      (r) => {
        r.current[0].statements[0].role.typeOnly = false;
      },
    ],
    [
      "import alias",
      (r) => {
        r.current[0].statements[0].role.symbols[0].alias = "Foreign";
      },
    ],
    [
      "deleted transfer",
      (r) => {
        r.transfers.pop();
      },
    ],
    [
      "duplicate transfer",
      (r) => {
        r.transfers.push(r.transfers[0]);
      },
    ],
    [
      "foreign inverse slice",
      (r) => {
        r.originals[0].recipe.find((p: any) => p.slice).slice.path = "foreign.ts";
      },
    ],
    [
      "slice bound",
      (r) => {
        r.originals[0].recipe.find((p: any) => p.slice).slice.end++;
      },
    ],
    [
      "slice hash",
      (r) => {
        r.originals[0].recipe.find((p: any) => p.slice).slice.sha256 = "0".repeat(64);
      },
    ],
    [
      "executable historical literal",
      (r) => {
        r.originals[0].recipe.push({ literal: "export function secondIssuer() {}" });
      },
    ],
    [
      "nonreciprocal forward recipe",
      (r) => {
        r.current[0].recipe.push({ literal: "\n// nonreciprocal replay\n" });
      },
    ],
    [
      "receipt donor-owner role",
      (r) => {
        r.donorOwners[0].owner = r.donorOwners[1].owner;
      },
    ],
  ];
  it.each(malformed)("fails closed on malformed receipt: %s", (_name, mutate) => rejectReceipt(mutate));
  it("leaves later historical injected mutants raw after the initial reconstruction", () => {
    const reconstructed = reconstructRuntimeProgramRelocationSources();
    const path = runtimeProgramRelocationPairs[0][0],
      original = reconstructed.get(path)!;
    const mutant = original.replace("if (!owner)", "if (owner)");
    expect(mutant).not.toBe(original);
    expect(runtimeProgramRelocationSha256(mutant)).not.toBe(receipt.originals[0]!.sha256);
    // No reconstruction is applied to the injected historical operand.
    expect(mutant).toContain("if (owner) return undefined;");
    const current = positive();
    current.set(path, mutant);
    expect(() => reconstructRuntimeProgramRelocationPopulation(current)).toThrow(/length\/SHA256/);
  });
});
