// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { isStrictContext, isStrictFunction } from "../src/codegen/helpers/is-strict-function.js";

describe("#3017 strictness follows incremental source context", () => {
  for (const inferModuleStrict of [false, true]) {
    it(`rechecks a reused function when a directive is inserted (module inference ${inferModuleStrict})`, () => {
      const text = "var marker = 0;\nfunction f(){return f.caller;}";
      const prefix = '"use strict";\n';
      const source = ts.createSourceFile("test.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const fn = source.statements[1] as ts.FunctionDeclaration;
      expect(isStrictFunction(fn, inferModuleStrict)).toBe(false);
      const updated = ts.updateSourceFile(
        source,
        prefix + text,
        ts.createTextChangeRange(ts.createTextSpan(0, 0), prefix.length),
      );
      const reused = updated.statements[2] as ts.FunctionDeclaration;
      expect(reused).toBe(fn);
      expect(reused.parent).toBe(updated);
      expect(isStrictFunction(reused, inferModuleStrict)).toBe(true);
      expect(isStrictContext(reused.body!, inferModuleStrict)).toBe(true);
    });

    it(`rechecks a reused function when a directive is removed (module inference ${inferModuleStrict})`, () => {
      const text = "var marker = 0;\nfunction f(){return f.caller;}";
      const prefix = '"use strict";\n';
      const source = ts.createSourceFile("test.js", prefix + text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const fn = source.statements[2] as ts.FunctionDeclaration;
      expect(isStrictFunction(fn, inferModuleStrict)).toBe(true);
      const updated = ts.updateSourceFile(
        source,
        text,
        ts.createTextChangeRange(ts.createTextSpan(0, prefix.length), 0),
      );
      const reused = updated.statements[1] as ts.FunctionDeclaration;
      expect(reused).toBe(fn);
      expect(reused.parent).toBe(updated);
      expect(isStrictFunction(reused, inferModuleStrict)).toBe(false);
      expect(isStrictContext(reused.body!, inferModuleStrict)).toBe(false);
    });
  }

  it("keeps module inference modes independent", () => {
    const source = ts.createSourceFile("test.ts", "export function f() {}", ts.ScriptTarget.Latest, true);
    const fn = source.statements[0] as ts.FunctionDeclaration;
    expect(isStrictFunction(fn, true)).toBe(true);
    expect(isStrictFunction(fn, false)).toBe(false);
    expect(isStrictFunction(fn, true)).toBe(true);
  });
});
