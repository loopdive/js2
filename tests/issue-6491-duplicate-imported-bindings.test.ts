// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6491 — duplicate ImportedBoundNames are an early error on EVERY path.
//
// §16.2.1.1 puts ImportedBindings in a ModuleItemList's LexicallyDeclaredNames,
// so two imports that bind the same name are a SyntaxError even though neither
// declaration duplicates anything on its own. Nothing enforced that rule: the
// single-source path only appeared to, because its import preprocessing rewrote
// unresolvable imports into declarations that the duplicate-lexical check then
// caught. The multi-file path never rewrites, so the same source compiled clean
// there — `language/import/dup-bound-names.js` passed the honest test262 lane
// and failed the linked one for that reason alone.

import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { detectEarlyErrors } from "../src/compiler/validation.js";

function errorsFor(source: string): string[] {
  const sourceFile = ts.createSourceFile("test.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  return detectEarlyErrors(sourceFile, { moduleGoal: true })
    .filter((error) => error.severity !== "warning")
    .map((error) => error.message);
}

describe("#6491 duplicate imported bound names", () => {
  it.each([
    ['import { x } from "./a.js";\nimport { y as x } from "./b.js";\n', "two named imports"],
    ['import x from "./a.js";\nimport { x } from "./b.js";\n', "default plus named"],
    ['import * as x from "./a.js";\nimport { x } from "./b.js";\n', "namespace plus named"],
    ['import { x, x } from "./a.js";\n', "one clause, twice"],
  ])("rejects %s (%s)", (source) => {
    expect(errorsFor(source)).toContain("Duplicate identifier 'x'");
  });

  it.each([
    ['import { x } from "./a.js";\nimport { y } from "./b.js";\n', "distinct names"],
    ['import { x as a, x as b } from "./a.js";\n', "same export bound under two names"],
    ['import x from "./a.js";\nimport * as ns from "./b.js";\n', "default plus namespace"],
  ])("accepts %s (%s)", (source) => {
    expect(errorsFor(source)).not.toContain("Duplicate identifier 'x'");
  });
});
