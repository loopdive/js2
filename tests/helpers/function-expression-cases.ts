// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 Fa, F1) Function expressions as values on the strict Prepared path, as cases of `[label, program, holds,
// fails]`: `program` followed by `if (holds) throw 1;` returns in node and in the Prepared program, and followed by
// `if (fails) throw 1;` throws in both, so a pass cannot come from a check that never ran. A realm compile costs tens of
// seconds under the validator, so the cases are spread over a few test files.
import { expect, it } from "vitest";
import { runPrepared } from "./prepared-node-agreement.js";

export type FunctionExpressionCase = readonly [label: string, program: string, holds: string, fails: string];

export function runsFunctionExpressions(cases: readonly FunctionExpressionCase[]): void {
  it.each(cases)(
    "runs a function expression %s",
    async (_label, program, holds, fails) => {
      const right = `${program} if (${holds}) throw 1;`;
      const wrong = `${program} if (${fails}) throw 1;`;
      expect(() => new Function(right)()).not.toThrow();
      expect(() => new Function(wrong)()).toThrow();
      expect(await runPrepared(right)).toBe("returned");
      expect(await runPrepared(wrong)).toBe("threw");
    },
    240_000,
  );
}
