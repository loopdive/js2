// R6 family-3 lane measurement runner. Read-only over src/; writes JSON+MD here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, type CompileOptions, type CompileResult } from "/home/user/js2/src/index.ts";

const HERE = "/home/user/js2/.tmp/r6-f3-census/lane-measurement";
const CORPUS = join(HERE, "corpus");
const LANES: Record<string, CompileOptions> = {
  "gc-host": {},
  "gc-strict-no-host": { strictNoHostImports: true },
  standalone: { target: "standalone" },
  wasi: { target: "wasi" },
};

interface UnitRow {
  name: string;
  unitKind: string;
  kind: string;
  stage: string;
  code?: string;
  detail?: string;
  irBodyEmitted: boolean;
  legacyBodyEmitted: boolean;
}
interface Cell {
  shape: string;
  lane: string;
  success: boolean;
  bytes: number;
  errors: string[];
  imports: string[];
  importIntents: Record<string, string>;
  units: UnitRow[];
  irCompiledFuncs: string[];
  irFirstSkipped: string[];
  irPostClaimErrors: { kind: string; func: string; message: string }[];
  terminalUnits: number;
  irEmittedUnits: number;
  legacyUnits: number;
  unsupported: string[];
  irClaimed: boolean;
  threw?: string;
}

const cells: Cell[] = [];
for (const file of readdirSync(CORPUS)
  .filter((f) => f.endsWith(".ts"))
  .sort()) {
  const source = readFileSync(join(CORPUS, file), "utf8");
  for (const [lane, opts] of Object.entries(LANES)) {
    let r: CompileResult | undefined;
    let threw: string | undefined;
    try {
      r = await compile(source, {
        ...opts,
        fileName: file,
        trackIrOutcomes: true,
        emitWat: false,
        ...({ experimentalIR: true, trackFallbacks: true } as object),
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    const units: UnitRow[] = (r?.irOutcomes ?? []).map((o: any) => ({
      name: o.displayName,
      unitKind: o.unitKind,
      kind: o.kind,
      stage: o.stage,
      code: o.code,
      detail: o.detail,
      irBodyEmitted: o.irBodyEmitted,
      legacyBodyEmitted: o.legacyBodyEmitted,
    }));
    const term = units.filter((u) => u.kind !== "non-executable");
    const irEmitted = term.filter((u) => u.kind === "emitted" && u.irBodyEmitted && !u.legacyBodyEmitted);
    const legacy = term.filter((u) => u.legacyBodyEmitted || u.kind !== "emitted");
    const unsupported = term
      .filter((u) => u.kind !== "emitted")
      .map((u) => `${u.name}: ${u.kind}/${u.stage}/${u.code ?? "?"} — ${u.detail ?? ""}`);
    const imports = (r?.imports ?? []).map((i) => `${i.module}.${i.name}`).sort();
    const importIntents: Record<string, string> = {};
    for (const i of r?.imports ?? []) importIntents[`${i.module}.${i.name}`] = String((i as any).intent);
    cells.push({
      shape: file.replace(/\.ts$/, ""),
      lane,
      success: r?.success ?? false,
      bytes: r?.binary?.length ?? 0,
      errors: (r?.errors ?? []).map((e) => `[${e.severity}] L${e.line}: ${e.message.slice(0, 160)}`),
      imports,
      importIntents,
      units,
      irCompiledFuncs: [...(r?.irCompiledFuncs ?? [])],
      irFirstSkipped: [...(r?.irFirstSkipped ?? [])],
      irPostClaimErrors: r?.irPostClaimErrors ?? [],
      terminalUnits: term.length,
      irEmittedUnits: irEmitted.length,
      legacyUnits: legacy.length,
      unsupported,
      irClaimed:
        (r?.success ?? false) && term.length > 0 && legacy.length === 0 && (r?.irPostClaimErrors ?? []).length === 0,
      threw,
    });
    process.stderr.write(
      `${file} ${lane}: ok=${r?.success} bytes=${r?.binary?.length} ir=${irEmitted.length}/${term.length} legacy=${legacy.length}${threw ? " THREW " + threw : ""}\n`,
    );
  }
}
writeFileSync(join(HERE, "results.json"), JSON.stringify(cells, null, 2));

// Markdown
const laneNames = Object.keys(LANES);
const shapes = [...new Set(cells.map((c) => c.shape))];
let md = `# R6 family 3 — per-shape lane measurement (origin/main 33ea8606aa, ${new Date().toISOString()})\n\n`;
md += `Lanes: ${laneNames.map((l) => `\`${l}\` = \`${JSON.stringify(LANES[l])}\``).join(", ")}. All compiles: \`trackIrOutcomes: true, emitWat: false\`.\n\n`;
md += `## Success / IR-claim / bytes\n\n| shape | ${laneNames.map((l) => `${l}`).join(" | ")} |\n|---|${laneNames.map(() => "---").join("|")}|\n`;
for (const s of shapes) {
  md += `| ${s} | ${laneNames
    .map((l) => {
      const c = cells.find((x) => x.shape === s && x.lane === l)!;
      return `${c.success ? "ok" : "FAIL"} ${c.irClaimed ? "IR" : "LEGACY"} ${c.irEmittedUnits}/${c.terminalUnits} ${c.bytes}B`;
    })
    .join(" | ")} |\n`;
}
md += `\nCell = success · IR/LEGACY verdict · ir-emitted terminal units / terminal units · wasm bytes.\n\n## Imports per shape × lane (module.name)\n\n`;
for (const s of shapes) {
  md += `### ${s}\n\n`;
  for (const l of laneNames) {
    const c = cells.find((x) => x.shape === s && x.lane === l)!;
    md += `- **${l}** (${c.imports.length}): ${c.imports.length ? c.imports.map((i) => `\`${i}\``).join(", ") : "_none_"}\n`;
  }
  const anyUnsup = cells.filter(
    (x) => x.shape === s && (x.unsupported.length || x.errors.length || x.irPostClaimErrors.length),
  );
  for (const c of anyUnsup) {
    if (c.unsupported.length) md += `- ${c.lane} unsupported: ${c.unsupported.map((u) => `\`${u}\``).join("; ")}\n`;
    if (c.errors.length) md += `- ${c.lane} errors: ${c.errors.map((u) => `\`${u}\``).join("; ")}\n`;
    if (c.irPostClaimErrors.length)
      md += `- ${c.lane} postClaimErrors: ${c.irPostClaimErrors.map((e) => `\`${e.kind}/${e.func}: ${e.message}\``).join("; ")}\n`;
  }
  md += "\n";
}
// Unit table
md += `## Terminal units per shape (gc-host lane)\n\n| shape | unit | kind | outcome | stage | code |\n|---|---|---|---|---|---|\n`;
for (const s of shapes)
  for (const u of cells.find((x) => x.shape === s && x.lane === "gc-host")!.units)
    md += `| ${s} | ${u.name} | ${u.unitKind} | ${u.kind}${u.irBodyEmitted ? " (ir)" : ""}${u.legacyBodyEmitted ? " (legacy)" : ""} | ${u.stage} | ${u.code ?? ""} |\n`;
writeFileSync(join(HERE, "results.md"), md);
console.log("wrote results.json + results.md");
