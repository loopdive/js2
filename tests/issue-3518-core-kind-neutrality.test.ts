// #3518 — moving type declarations must preserve the kind-neutrality population,
// verdicts and quote identities. Exercise the real checker on composed source;
// absent canonical source is a failure, never a reason to skip these controls.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REPO = process.cwd();
const SCRIPT = "scripts/check-ir-kind-neutrality.mjs";
const BASELINE = "scripts/ir-kind-neutrality-baseline.json";
const NODES = "src/ir/nodes.ts";
const VALUE_REFERENCES = "src/ir/value-references.ts";
const CORE_TYPES = "src/ir/core/types.ts";
const CORE_VALUE_REFERENCES = "src/ir/core/value-references.ts";
const DIALECT = "src/ir/dialect/js.ts";
const SCANNED_FILES = [NODES, VALUE_REFERENCES, CORE_TYPES, CORE_VALUE_REFERENCES, DIALECT];

// Exact baseline blob at 25b9a41c3828dfb403797003dc6b66c72a2547ba. Pin the
// entire pre-relocation record without requiring Git history in shallow CI.
const ORIGINAL_BASELINE_BLOB = "905b33823e259908f964bbaa47c0c8177c256e4f";
const SHAPE_CITES = [
  { kind: "object.new", quote: "export interface IrObjectShape {", hash: "3044daed9a17" },
  { kind: "class.new", quote: "export interface IrClassShape {", hash: "e0a49156ba51" },
];
const REFERENCES = [
  { name: "IrTypeRef", kind: "type", file: CORE_TYPES, facade: NODES },
  { name: "IrFuncRef", kind: "func", file: CORE_VALUE_REFERENCES, facade: VALUE_REFERENCES },
  { name: "IrGlobalRef", kind: "global", file: CORE_VALUE_REFERENCES, facade: VALUE_REFERENCES },
];

interface KindRecord {
  verdict: string;
  where: string;
  declaredAt: string;
  evidence: string[];
}

interface GateRecord {
  generated: string;
  populationRule: string;
  ratchet: Record<string, number>;
  counts: Record<string, number>;
  kinds: Record<string, KindRecord>;
}

let sandbox: string;
const readIn = (file: string) => readFileSync(path.join(sandbox, file), "utf8");
const writeIn = (file: string, text: string) => writeFileSync(path.join(sandbox, file), text);

function runGate(args: string[] = []): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: sandbox,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      }),
    };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }
}

function originalBaselineText() {
  let text = readIn(BASELINE);
  for (const { hash } of SHAPE_CITES) {
    const moved = `${CORE_TYPES}#${hash}`;
    expect(text.split(moved)).toHaveLength(2);
    text = text.replace(moved, `${NODES}#${hash}`);
  }
  const blob = createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
  expect(blob, "no baseline byte may change beyond the two reviewed file prefixes").toBe(ORIGINAL_BASELINE_BLOB);
  return text;
}

function declaration(file: string, name: string) {
  const matches = [...readIn(file).matchAll(new RegExp(`^export interface ${name}[^\\n]*\\{[\\s\\S]*?^}`, "gm"))];
  expect(matches, `${file} must contain exactly one ${name} declaration`).toHaveLength(1);
  return matches[0]![0];
}

function expectFailure(message: string) {
  const result = runGate();
  expect(result.code, result.out).toBe(1);
  expect(result.out).toContain(message);
  expect(result.out).not.toContain("IR kind-neutrality gate: OK");
}

beforeAll(() => {
  const root = path.join(REPO, ".tmp");
  mkdirSync(root, { recursive: true });
  sandbox = mkdtempSync(path.join(root, "issue-3518-core-kind-"));
  mkdirSync(path.join(sandbox, "scripts"));
  cpSync(path.join(REPO, "src/ir"), path.join(sandbox, "src/ir"), { recursive: true });
  cpSync(path.join(REPO, SCRIPT), path.join(sandbox, SCRIPT));
});

beforeEach(() => {
  for (const file of [...SCANNED_FILES, BASELINE]) {
    cpSync(path.join(REPO, file), path.join(sandbox, file));
  }
});

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe("#3518 core type relocation preserves kind-neutrality evidence", () => {
  it("changes exactly two citation file prefixes in the entire pinned baseline", () => {
    const original = JSON.parse(originalBaselineText()) as GateRecord;
    const candidate = JSON.parse(readIn(BASELINE)) as GateRecord;
    const deltas: { kind: string; before: string; after: string }[] = [];
    for (const [kind, entry] of Object.entries(candidate.kinds)) {
      entry.evidence.forEach((cite, index) => {
        const before = original.kinds[kind]!.evidence[index]!;
        if (cite !== before) deltas.push({ kind, before, after: cite });
      });
    }
    expect(deltas.sort((a, b) => a.kind.localeCompare(b.kind))).toEqual(
      SHAPE_CITES.map(({ kind, hash }) => ({
        kind,
        before: `${NODES}#${hash}`,
        after: `${CORE_TYPES}#${hash}`,
      })).sort((a, b) => a.kind.localeCompare(b.kind)),
    );
    for (const { quote, hash } of SHAPE_CITES) {
      expect(createHash("sha1").update(quote).digest("hex").slice(0, 12)).toBe(hash);
    }
  });

  it("computes the old counts, ratchets and verdicts on the actual composed source", () => {
    const original = JSON.parse(originalBaselineText()) as GateRecord;
    const result = runGate(["--json"]);
    expect(result.code, result.out).toBe(0);
    const computed = JSON.parse(result.out) as GateRecord;
    expect(computed.counts).toEqual(original.counts);
    expect(computed.ratchet).toEqual(original.ratchet);
    expect(computed.populationRule).toBe(original.populationRule);
    for (const { kind, hash } of SHAPE_CITES) {
      computed.kinds[kind]!.evidence = computed.kinds[kind]!.evidence.map((cite) =>
        cite === `${CORE_TYPES}#${hash}` ? `${NODES}#${hash}` : cite,
      );
    }
    expect(computed.kinds).toEqual(original.kinds);
    expect(computed.counts).toEqual({
      total: 85,
      neutral: 55,
      js: 27,
      unresolved: 3,
      core: 58,
      dialect: 27,
      jsInCore: 0,
      residuals: 8,
    });
    const human = runGate();
    expect(human.code, human.out).toBe(0);
    expect(human.out).toContain("81 IrInstr arms + 4 terminators");
    expect(human.out).toContain("3 symbolic-reference kinds excluded, 88 `readonly kind:` fields reconciled");
  });

  it.each([CORE_TYPES, CORE_VALUE_REFERENCES])("requires canonical source %s", (file) => {
    rmSync(path.join(sandbox, file));
    expectFailure(`${file}: required kind-population source is missing or unreadable`);
  });

  it.each(REFERENCES)("does not forgive removal of excluded $name", ({ name, file }) => {
    writeIn(file, readIn(file).replace(declaration(file, name), ""));
    expectFailure(`the population rule excludes \`${name}\`, which no longer exists`);
  });

  it.each(REFERENCES)("does not forgive renaming excluded $name", ({ name, file }) => {
    writeIn(file, readIn(file).replace(`export interface ${name} {`, `export interface Renamed${name} {`));
    expectFailure(`the population rule excludes \`${name}\`, which no longer exists`);
  });

  it.each(REFERENCES)("retains the exact discriminant of excluded $name", ({ name, kind, file }) => {
    const original = declaration(file, name);
    const changed = original.replace(`readonly kind: "${kind}";`, 'readonly kind: "fourth-reference";');
    expect(changed).not.toBe(original);
    writeIn(file, readIn(file).replace(original, changed));
    expectFailure(`\`${name}\` declares kind "fourth-reference"`);
  });

  it.each(REFERENCES)("rejects a facade-only replacement for canonical $name", ({ name, file, facade }) => {
    const original = declaration(file, name);
    writeIn(file, readIn(file).replace(original, ""));
    writeIn(facade, `${readIn(facade)}\n${original}\n`);
    expectFailure(`\`${name}\` must be declared in ${file}, not ${facade}`);
  });

  it.each(REFERENCES)("rejects a duplicate old declaration of $name", ({ name, file, facade }) => {
    writeIn(facade, `${readIn(facade)}\n${declaration(file, name)}\n`);
    expectFailure(`duplicate kind-bearing interface \`${name}\``);
  });

  it.each(SCANNED_FILES)("rejects a fourth excluded reference in %s", (file) => {
    writeIn(file, `${readIn(file)}\nexport interface IrFourthRef {\n  readonly kind: "fourth-reference";\n}\n`);
    expectFailure('`IrFourthRef` declares kind "fourth-reference"');
  });

  it.each(SHAPE_CITES)("fails R2 when the relocated $kind shape quote is deleted", ({ kind, quote }) => {
    expect(readIn(CORE_TYPES)).toContain(quote);
    writeIn(CORE_TYPES, readIn(CORE_TYPES).replace(quote, quote.replace("Shape", "ShapeChanged")));
    expectFailure(`"${kind}": the cited evidence is gone from ${CORE_TYPES}`);
  });

  it.each(SHAPE_CITES)("does not accept old-node evidence instead of canonical $kind evidence", ({ kind, quote }) => {
    expect(readIn(CORE_TYPES)).toContain(quote);
    writeIn(CORE_TYPES, readIn(CORE_TYPES).replace(quote, quote.replace("Shape", "ShapeChanged")));
    writeIn(NODES, `${readIn(NODES)}\n// ${quote}\n`);
    expectFailure(`"${kind}": the cited evidence is gone from ${CORE_TYPES}`);
  });

  it.each(SCANNED_FILES)("still requires a verdict for a new instruction declared in %s", (file) => {
    writeIn(file, `${readIn(file)}\nexport interface IrInstrUnreviewed {\n  readonly kind: "unreviewed";\n}\n`);
    expect(readIn(NODES)).toContain("export type IrInstr =");
    writeIn(NODES, readIn(NODES).replace("export type IrInstr =", "export type IrInstr =\n  | IrInstrUnreviewed"));
    expectFailure('UNCLASSIFIED KIND "unreviewed"');
  });
});
