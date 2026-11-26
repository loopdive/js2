// #3518 — moving type declarations must preserve the kind-neutrality population,
// verdicts and quote identities. Exercise the real checker on composed source;
// absent canonical source is a failure, never a reason to skip these controls.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REPO = process.cwd();
const SCRIPT = "scripts/check-ir-kind-neutrality.mjs";
const BASELINE = "scripts/ir-kind-neutrality-baseline.json";
const NODES = "src/ir/nodes.ts";
const CORE_NODES = "src/ir/core/nodes.ts";
const VALUE_REFERENCES = "src/ir/value-references.ts";
const CORE_TYPES = "src/ir/core/types.ts";
const CORE_VALUE_REFERENCES = "src/ir/core/value-references.ts";
const DIALECT = "src/ir/dialect/js.ts";
const CORE_DIALECT = "src/ir/core/dialect/js.ts";
const SCANNED_FILES = [NODES, CORE_NODES, VALUE_REFERENCES, CORE_TYPES, CORE_VALUE_REFERENCES, DIALECT, CORE_DIALECT];
const SHAPE_CITES = [
  { kind: "object.new", quote: "export interface IrObjectShape {", hash: "3044daed9a17" },
  { kind: "class.new", quote: "export interface IrClassShape {", hash: "e0a49156ba51" },
];
const REFERENCES = [
  { name: "IrTypeRef", kind: "type", file: CORE_TYPES, facade: NODES },
  { name: "IrFuncRef", kind: "func", file: CORE_VALUE_REFERENCES, facade: VALUE_REFERENCES },
  { name: "IrGlobalRef", kind: "global", file: CORE_VALUE_REFERENCES, facade: VALUE_REFERENCES },
];

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
  it.each([CORE_TYPES, CORE_VALUE_REFERENCES, CORE_NODES, CORE_DIALECT])("requires canonical source %s", (file) => {
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
    expect(readIn(CORE_NODES)).toContain("export type IrInstr =");
    writeIn(
      CORE_NODES,
      readIn(CORE_NODES).replace("export type IrInstr =", "export type IrInstr =\n  | IrInstrUnreviewed"),
    );
    expectFailure('UNCLASSIFIED KIND "unreviewed"');
  });

  it.each(["remove", "rename", "kind", "move", "duplicate"] as const)(
    "rejects %s of the reviewed canonical named payload",
    (mutation) => {
      expect(runGate().code).toBe(0);
      const original = declaration(CORE_TYPES, "IrSupportRefType");
      if (mutation === "remove" || mutation === "move") writeIn(CORE_TYPES, readIn(CORE_TYPES).replace(original, ""));
      if (mutation === "rename")
        writeIn(
          CORE_TYPES,
          readIn(CORE_TYPES).replace("export interface IrSupportRefType", "export interface RenamedSupportRef"),
        );
      if (mutation === "kind")
        writeIn(
          CORE_TYPES,
          readIn(CORE_TYPES).replace('readonly kind: "support-ref";', 'readonly kind: "unreviewed-payload";'),
        );
      if (mutation === "move" || mutation === "duplicate") writeIn(NODES, `${readIn(NODES)}\n${original}\n`);
      expectFailure(
        mutation === "duplicate"
          ? "duplicate kind-bearing interface `IrSupportRefType`"
          : "named payload IrSupportRefType requires canonical",
      );
    },
  );

  it.each(["missing", "comment", "nested", "duplicate", "malformed"] as const)(
    "rejects %s direct payload membership instead of trusting a text mention",
    (mutation) => {
      expect(runGate().code).toBe(0);
      const replacements = {
        missing: "",
        comment: "  // | IrSupportRefType",
        nested: "  | { payload: IrSupportRefType }",
        duplicate: "  | IrSupportRefType\n  | IrSupportRefType",
        malformed: "  | IrSupportRefType<",
      };
      expect(readIn(CORE_TYPES)).toContain("  | IrSupportRefType\n");
      writeIn(CORE_TYPES, readIn(CORE_TYPES).replace("  | IrSupportRefType\n", replacements[mutation] + "\n"));
      expectFailure("named payload IrSupportRefType requires exactly one direct IrType union arm");
    },
  );

  it.each(["IrInstr", "IrTerminator"])("does not exempt a named payload promoted into %s", (union) => {
    expect(runGate().code).toBe(0);
    writeIn(
      CORE_NODES,
      readIn(CORE_NODES).replace(
        new RegExp(`export type ${union} =\\s*\\|?`),
        `export type ${union} =\n  | IrSupportRefType\n  |`,
      ),
    );
    expectFailure("named payload IrSupportRefType must not be an IrInstr or IrTerminator arm");
  });

  it("does not automatically admit another named IrType payload", () => {
    expect(runGate().code).toBe(0);
    writeIn(
      CORE_TYPES,
      readIn(CORE_TYPES).replace("export type IrType =", "export type IrType =\n  | IrUnreviewedPayload") +
        '\nexport interface IrUnreviewedPayload {\n  readonly kind: "unreviewed-payload";\n}\n',
    );
    expectFailure('`IrUnreviewedPayload` declares kind "unreviewed-payload"');
  });

  it("does not accept a comment as the named payload discriminant", () => {
    expect(runGate().code).toBe(0);
    writeIn(
      CORE_TYPES,
      readIn(CORE_TYPES).replace(
        '  readonly kind: "support-ref";',
        '  /*\n  readonly kind: "support-ref";\n  */\n  readonly kind: "different-payload";',
      ),
    );
    expectFailure("named payload IrSupportRefType requires its exact readonly kind discriminant in canonical syntax");
  });
});
