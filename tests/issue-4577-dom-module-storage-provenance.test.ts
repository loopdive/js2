// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { compileMulti } from "../src/index.js";
import {
  irGlobalBindingKey,
  irModuleGlobalRef,
  irSourceGlobalRef,
  sameIrGlobalBinding,
} from "../src/ir/abi-bindings.js";
import { makeIrStandaloneDomCapabilityPlan, sourceTouchesIrStandaloneDomSurface } from "../src/ir/dom-capability.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord, type IrUnitId } from "../src/ir/identity.js";
import { asBlockId, asValueId, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import {
  derivePreparedComponentDependencies,
  type PreparedComponentAbiEntry,
  type PreparedComponentAbiLookup,
} from "../src/ir/prepared-component-dependencies.js";
import { ProgramAbiMap, type ProgramAbiPlanEntry } from "../src/ir/program-abi.js";
import { ts } from "../src/ts-api.js";

const CALENDAR_SOURCE = readFileSync(
  new URL("../website/playground/examples/dom/calendar.ts", import.meta.url),
  "utf8",
);
const BUILTINS_SOURCE = readFileSync(new URL("../website/playground/examples/js/builtins.ts", import.meta.url), "utf8");
const DOM_BINDING_NAMES = new Set(["gridEl", "monthEl", "yearEl", "nightsEl", "totalEl"]);

function calendarPlan(source: string) {
  const analyzed = analyzeSource(source, "calendar.ts");
  return makeIrStandaloneDomCapabilityPlan(analyzed.checker, analyzed.sourceFile);
}

function irFunction(
  unit: Pick<IrTerminalUnitRecord, "id" | "displayName">,
  instrs: readonly IrInstr[] = [],
): IrFunction {
  return {
    unitId: unit.id,
    name: unit.displayName,
    params: [],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: instrs.reduce((count, instr) => Math.max(count, (instr.result ?? -1) + 1), 0),
  };
}

function abiLookup(entries: readonly PreparedComponentAbiEntry[]): PreparedComponentAbiLookup {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  return { get: (id) => byId.get(id), entries: () => entries };
}

describe("#4577 exact Calendar DOM module storage", () => {
  it("certifies exactly five closed Calendar bindings and keeps base dom@1 storage-free", () => {
    const calendar = analyzeSource(CALENDAR_SOURCE, "calendar.ts");
    const builtins = analyzeSource(BUILTINS_SOURCE, "builtins.ts");
    const calendarCapability = makeIrStandaloneDomCapabilityPlan(calendar.checker, calendar.sourceFile);
    const builtinsCapability = makeIrStandaloneDomCapabilityPlan(builtins.checker, builtins.sourceFile);

    expect(calendarCapability?.requiresInteraction).toBe(true);
    expect(builtinsCapability?.requiresInteraction).toBe(false);
    const declarations = calendar.sourceFile.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    );
    const certified = declarations.filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        DOM_BINDING_NAMES.has(declaration.name.text) &&
        calendarCapability?.moduleBinding(declaration)?.capability === "dom",
    );
    expect(certified.map((declaration) => (declaration.name as ts.Identifier).text).sort()).toEqual(
      [...DOM_BINDING_NAMES].sort(),
    );
    expect(builtinsCapability?.moduleBinding(certified[0]!)).toBeUndefined();
  });

  it.each([
    ["local alias", `const escaped = gridEl;`],
    ["bare return", `return gridEl as never;`],
    ["foreign call", `console.log(gridEl);`],
  ])("rejects a %s use outside the closed receiver/null/argument census", (_label, injected) => {
    const source = CALENDAR_SOURCE.replace(
      `if (gridEl === null) return;`,
      `if (gridEl === null) return;\n  ${injected}`,
    );
    expect(source).not.toBe(CALENDAR_SOURCE);
    expect(calendarPlan(source)).toBeUndefined();
  });

  it("rejects an aliased el producer and a sixth nullable DOM binding", () => {
    const aliasedFactory = CALENDAR_SOURCE.replace(
      `gridEl = el("div", "display:grid;grid-template-columns:repeat(7,1fr);gap:2px");`,
      `const makeElement = el;\n  gridEl = makeElement("div", "display:grid;grid-template-columns:repeat(7,1fr);gap:2px");`,
    );
    const sixthBinding = CALENDAR_SOURCE.replace(
      `let totalEl: HTMLElement | null = null;`,
      `let totalEl: HTMLElement | null = null;\nlet extraEl: HTMLElement | null = null;`,
    );
    expect(calendarPlan(aliasedFactory)).toBeUndefined();
    expect(calendarPlan(sixthBinding)).toBeUndefined();
  });

  it("requires the exact ten-terminal component and a closed el producer", () => {
    const extraTerminal = `${CALENDAR_SOURCE}\nclass ForeignTerminal { run(): void {} }`;
    const reassignedFactoryResult = CALENDAR_SOURCE.replace(
      `e.style.cssText = css;\n  return e;`,
      `e.style.cssText = css;\n  e = document.body;\n  return e;`,
    );
    expect(calendarPlan(extraTerminal)).toBeUndefined();
    expect(calendarPlan(reassignedFactoryResult)).toBeUndefined();
  });

  it("marks a second source's ambient DOM and provider-descriptor near misses as authority demand", () => {
    const calendar = analyzeSource(CALENDAR_SOURCE, "calendar.ts");
    const harmless = analyzeSource(`export function harmless(): number { return 1; }`, "harmless.ts");
    const ordinaryDocumentProperty = analyzeSource(
      `
        const fixture = { document: 1 };
        export function harmless(): number { return fixture.document; }
      `,
      "ordinary-document-property.ts",
    );
    const nonValueDocumentSpelling = analyzeSource(
      `
        type document = number;
        type Alias = document;
        type Query = typeof document;
        export function harmless(): number {
          document: { break document; }
          return 1;
        }
      `,
      "non-value-document-spelling.ts",
    );
    const ambient = analyzeSource(
      `export function leak(): HTMLElement { return document.body; }`,
      "ambient-near-miss.ts",
    );
    const uncertainDocument = analyzeSource(
      `declare const document: any; export function leak(): any { return document.body; }`,
      "uncertain-document-near-miss.ts",
    );
    const descriptor = analyzeSource(
      `
        declare function global_document(): HTMLElement;
        export function leak(): HTMLElement { return global_document(); }
      `,
      "descriptor-near-miss.ts",
    );

    expect(sourceTouchesIrStandaloneDomSurface(calendar.checker, calendar.sourceFile)).toBe(true);
    expect(makeIrStandaloneDomCapabilityPlan(calendar.checker, calendar.sourceFile)).toBeDefined();
    expect(sourceTouchesIrStandaloneDomSurface(harmless.checker, harmless.sourceFile)).toBe(false);
    expect(
      sourceTouchesIrStandaloneDomSurface(ordinaryDocumentProperty.checker, ordinaryDocumentProperty.sourceFile),
    ).toBe(false);
    expect(
      sourceTouchesIrStandaloneDomSurface(nonValueDocumentSpelling.checker, nonValueDocumentSpelling.sourceFile),
    ).toBe(false);
    expect(sourceTouchesIrStandaloneDomSurface(ambient.checker, ambient.sourceFile)).toBe(true);
    expect(sourceTouchesIrStandaloneDomSurface(uncertainDocument.checker, uncertainDocument.sourceFile)).toBe(true);
    expect(sourceTouchesIrStandaloneDomSurface(descriptor.checker, descriptor.sourceFile)).toBe(true);
    expect(makeIrStandaloneDomCapabilityPlan(ambient.checker, ambient.sourceFile)).toBeUndefined();
    expect(makeIrStandaloneDomCapabilityPlan(uncertainDocument.checker, uncertainDocument.sourceFile)).toBeUndefined();
    expect(makeIrStandaloneDomCapabilityPlan(descriptor.checker, descriptor.sourceFile)).toBeUndefined();
  });

  it("walks namespace exports transitively without treating harmless or cyclic graphs as DOM authority", () => {
    const analyzeNamespace = (files: Record<string, string>, imported: string) => {
      const analyzed = analyzeMultiSource(
        {
          ...files,
          "./consumer.ts": `
            import * as provider from "${imported}";
            const raw = provider as any;
            export const escaped = raw.value;
          `,
        },
        "./consumer.ts",
        undefined,
        { skipSemanticDiagnostics: true },
      );
      const consumer = analyzed.sourceFiles.find(({ fileName }) => fileName.endsWith("consumer.ts"));
      if (!consumer) throw new Error("missing namespace consumer fixture");
      return sourceTouchesIrStandaloneDomSurface(analyzed.checker, consumer);
    };

    expect(analyzeNamespace({ "./provider.ts": `export let value: HTMLElement | null = null;` }, "./provider")).toBe(
      true,
    );
    expect(
      analyzeNamespace(
        {
          "./provider.ts": `export let value: HTMLElement | null = null;`,
          "./bridge.ts": `export * as provider from "./provider";`,
        },
        "./bridge",
      ),
    ).toBe(true);
    expect(analyzeNamespace({ "./provider.ts": `export const value = 1;` }, "./provider")).toBe(false);
    expect(
      analyzeNamespace(
        {
          "./provider.ts": `export const value = 1;`,
          "./bridge.ts": `export * as provider from "./provider";`,
        },
        "./bridge",
      ),
    ).toBe(false);
    expect(
      analyzeNamespace(
        {
          "./a.ts": `export * as b from "./b"; export const value = 1;`,
          "./b.ts": `export * as a from "./a"; export const other = 2;`,
        },
        "./a",
      ),
    ).toBe(false);
    expect(analyzeNamespace({ "./bridge.ts": `export * as unresolved from "./missing";` }, "./bridge")).toBe(true);
  });

  it.each([
    ["ambient document", CALENDAR_SOURCE, `export function leak(): HTMLElement { return document.body; }`],
    [
      "source-local any document",
      CALENDAR_SOURCE,
      `declare const document: any; export function leak(): any { return document.body; }`,
    ],
    [
      "provider descriptor",
      CALENDAR_SOURCE,
      `declare function Document_get_body(value: HTMLElement): HTMLElement;
       export function leak(value: HTMLElement): HTMLElement { return Document_get_body(value); }`,
    ],
    [
      "cross-source DOM slot alias",
      CALENDAR_SOURCE.replace(
        `let gridEl: HTMLElement | null = null;`,
        `export let gridEl: HTMLElement | null = null;`,
      ),
      `import { gridEl } from "./calendar"; export const escaped = gridEl;`,
    ],
    [
      "any-erased namespace DOM slot alias",
      CALENDAR_SOURCE.replace(
        `let gridEl: HTMLElement | null = null;`,
        `export let gridEl: HTMLElement | null = null;`,
      ),
      `import * as calendar from "./calendar";
       const raw = calendar as any;
       export const escaped = raw.gridEl;`,
    ],
  ])("does not let an exact Calendar source authorize a second %s", async (_label, calendarSource, nearMiss) => {
    const result = await compileMulti(
      {
        "./calendar.ts": calendarSource,
        "./near-miss.ts": nearMiss,
      },
      "./calendar.ts",
      {
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect((result.capabilityRequirements ?? []).map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(["dom", "dom-interaction"]),
    );
    expect(result.errors.map(({ message }) => message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/host import leak|explicit DOM capability|DOM authority/i)]),
    );
  });

  it("does not let a transitive namespace re-export erase a Calendar DOM slot's authority", async () => {
    const calendarSource = CALENDAR_SOURCE.replace(
      `let gridEl: HTMLElement | null = null;`,
      `export let gridEl: HTMLElement | null = null;`,
    );
    const result = await compileMulti(
      {
        "./calendar.ts": calendarSource,
        "./bridge.ts": `export * as calendar from "./calendar";`,
        "./near-miss.ts": `
          import * as bridge from "./bridge";
          const raw = bridge as any;
          export const escaped = raw.calendar.gridEl;
        `,
      },
      "./calendar.ts",
      {
        target: "standalone",
        experimentalIR: true,
        trackFallbacks: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect((result.capabilityRequirements ?? []).map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(["dom", "dom-interaction"]),
    );
    expect(result.errors.map(({ message }) => message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/host import leak|explicit DOM capability|DOM authority/i)]),
    );
  });
});

describe("#4577 DOM global Program-ABI provenance", () => {
  function fixture() {
    const source = ts.createSourceFile(
      "/repo/dom-global.ts",
      `let state = 0; function read(): void {}`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([source], { entrySource: source });
    const read = inventory.terminalUnits.find((unit) => unit.displayName === "read");
    const moduleInit = inventory.terminalUnits.find((unit) => unit.kind === "module-init");
    if (!read || !moduleInit) throw new Error("invalid DOM-global fixture");
    const ref = irModuleGlobalRef(inventory.sources[0]!.id, 0, "__mod_state", "dom");
    const generic = irSourceGlobalRef(ref.binding.bindingId, "__mod_state");
    const instr: IrInstr = {
      kind: "global.get",
      result: asValueId(0),
      resultType: { kind: "extern", className: "HTMLElement" },
      target: ref,
    };
    const exactEntry: PreparedComponentAbiEntry = {
      id: ref.binding.bindingId,
      structuralReferenceKey: irGlobalBindingKey(ref.binding),
      slotPolicy: "required",
      intent: {
        kind: "global",
        origin: "source",
        valueType: '{"kind":"externref"}',
        mutable: true,
        capability: "dom",
        sourceId: inventory.sources[0]!.id,
        unitId: moduleInit.id,
      },
    };
    const report = (entries: readonly PreparedComponentAbiEntry[]) =>
      derivePreparedComponentDependencies({
        module: { functions: [irFunction(read, [instr]), irFunction(moduleInit)] },
        terminalUnitIds: new Set<IrUnitId>([read.id, moduleInit.id]),
        inventory,
        abi: abiLookup(entries),
      }).componentByTerminalUnitId.get(read.id)!;
    return { inventory, read, moduleInit, ref, generic, exactEntry, report };
  }

  it("makes DOM capability part of the source-global structural identity", () => {
    const { ref, generic } = fixture();
    expect(irGlobalBindingKey(ref.binding)).not.toBe(irGlobalBindingKey(generic.binding));
    expect(sameIrGlobalBinding(ref.binding, generic.binding)).toBe(false);
  });

  it("accepts an exact DOM allocator owner and rejects stripped provenance", () => {
    const { exactEntry, generic, report } = fixture();
    expect(report([exactEntry]).status).toBe("complete");

    const stripped: PreparedComponentAbiEntry = {
      ...exactEntry,
      structuralReferenceKey: irGlobalBindingKey(generic.binding),
      intent: { ...exactEntry.intent, capability: undefined },
    };
    const blocked = report([stripped]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.failures).toContainEqual(
      expect.objectContaining({ code: "abi-binding-contract-mismatch", bindingId: exactEntry.id }),
    );
  });

  it("rejects forged generic-extern and donor global reference keys at Program-ABI planning", () => {
    const { inventory, ref, generic, exactEntry } = fixture();
    const exactPlan: ProgramAbiPlanEntry = {
      id: exactEntry.id,
      order: { sourceOrder: inventory.sources[0]!.order, declarationOrder: 0 },
      displayName: ref.name,
      structuralReferenceKey: exactEntry.structuralReferenceKey,
      slotPolicy: "required",
      slotSpace: "global",
      intent: exactEntry.intent,
    };
    expect(() => new ProgramAbiMap(inventory).plan(exactPlan)).not.toThrow();

    const genericNearMiss = new ProgramAbiMap(inventory);
    expect(() =>
      genericNearMiss.plan({ ...exactPlan, structuralReferenceKey: irGlobalBindingKey(generic.binding) }),
    ).toThrowError(expect.objectContaining({ code: "invalid-binding-reference" }));

    const donor = irModuleGlobalRef(inventory.sources[0]!.id, 1, "__mod_donor", "dom");
    const donorNearMiss = new ProgramAbiMap(inventory);
    expect(() =>
      donorNearMiss.plan({
        ...exactPlan,
        structuralReferenceKey: irGlobalBindingKey(donor.binding),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-binding-reference" }));
  });

  it("rejects a capability label aliased onto a different allocator binding", () => {
    const { inventory, exactEntry, report } = fixture();
    const donor = irModuleGlobalRef(inventory.sources[0]!.id, 1, "__mod_donor", "dom");
    const donorEntry: PreparedComponentAbiEntry = {
      ...exactEntry,
      id: donor.binding.bindingId,
      structuralReferenceKey: irGlobalBindingKey(donor.binding),
    };
    const forgedAlias: PreparedComponentAbiEntry = {
      ...exactEntry,
      slotPolicy: "alias",
      aliasOf: donor.binding.bindingId,
    };
    const blocked = report([forgedAlias, donorEntry]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.failures).toContainEqual(
      expect.objectContaining({
        code: "abi-binding-contract-mismatch",
        bindingId: exactEntry.id,
        detail: expect.stringContaining("exact canonical allocator binding"),
      }),
    );
  });
});
