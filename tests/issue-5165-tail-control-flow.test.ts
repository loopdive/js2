// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5165 — the `tail-unhandled` residual of #2952: functions that END in a
// for/while/do loop (S1), returns out of a finally-LESS try/catch (S2), and
// functions that END in a try (S3).
//
// Every case runs the SAME program three ways — Node (the oracle, running the
// identical body as plain JS), the legacy compiler (`experimentalIR: false`)
// and the IR path — and asserts all three agree. Cases that are supposed to
// flip additionally assert the IR path was genuinely taken for the function
// carrying the shape (terminal outcome `emitted`, and the module's bytes differ
// from the legacy compile), so a silent demote fails instead of passing
// vacuously.
//
// Array-typed values never cross the Wasm boundary here: every export is a
// no-argument `main(): number` that builds its own data and folds the result to
// a scalar. The function under test is the INNER one, and its IR outcome is
// what the assertions read.
//
// The load-bearing NEGATIVE is `while (true) { if (x) return 1; break; }` in a
// non-void function: the `break` binds THIS loop, so control really does reach
// the fall-out. A condition-only "the loop never exits" proof would emit
// `unreachable` on a reachable path — a Wasm trap where JS returns `undefined`,
// i.e. a silent miscompile rather than a validation error. That shape must stay
// on the legacy path.
import { describe, expect, it } from "vitest";
import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

const JS_STRING = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

interface RunResult {
  /** `main()`'s completion, paired with `readState()`'s when that export exists. */
  observed: unknown;
  binary: Uint8Array;
  postClaim: unknown[];
  irOutcomes: readonly IrObservedOutcome[];
}

async function compileRun(source: string, experimentalIR: boolean): Promise<RunResult> {
  const r = await compile(source, { experimentalIR, trackFallbacks: true, trackIrOutcomes: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
  imports["wasm:js-string"] = JS_STRING as unknown as WebAssembly.ModuleImports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  built.setExports?.(instance.exports as Record<string, Function>);
  const exports = instance.exports as Record<string, unknown>;
  const main = exports.main;
  if (typeof main !== "function") throw new Error("export main missing");
  const completion = (main as () => unknown)();
  // A VOID `main` has no return value to compare, so those cases also export a
  // `readState()` that surfaces the side effect the loop/try actually produced.
  const readState = exports.readState;
  const observed = typeof readState === "function" ? [completion, (readState as () => unknown)()] : completion;
  return {
    observed,
    binary: r.binary,
    postClaim: r.irPostClaimErrors ?? [],
    irOutcomes: r.irOutcomes ?? [],
  };
}

/** Terminal IR outcome for one function of the compiled unit. */
function outcomeFor(result: RunResult, name: string): IrObservedOutcome | undefined {
  return result.irOutcomes.find((o) => o.displayName === name);
}

/**
 * Assert Node, legacy and IR all agree, the IR compile has ZERO post-claim
 * demotions, and `target`'s body was genuinely emitted through IR (not a
 * vacuous legacy-vs-legacy pass).
 */
async function expectAdopted(source: string, target: string, oracle: () => unknown): Promise<void> {
  const expected = oracle();
  const legacy = await compileRun(source, false);
  const ir = await compileRun(source, true);
  expect(legacy.observed, "legacy matches Node").toStrictEqual(expected);
  expect(ir.observed, "IR matches legacy/Node").toStrictEqual(legacy.observed);
  expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  const outcome = outcomeFor(ir, target);
  expect(outcome?.kind, `${target} claimed and emitted through IR (detail: ${outcome?.detail ?? "-"})`).toBe("emitted");
  expect(outcome?.irBodyEmitted, `${target} body emitted through IR`).toBe(true);
  expect(
    Buffer.compare(Buffer.from(legacy.binary), Buffer.from(ir.binary)) !== 0,
    "IR path exercised (bytes differ from legacy)",
  ).toBe(true);
}

/**
 * Assert `target` stays on the LEGACY path: its IR body must not be emitted,
 * and the observable result must still match legacy AND Node. Used for the
 * shapes this issue deliberately does not adopt (#5165 S4 — returns crossing a
 * `finally`) and for the break-falls-through negative.
 */
async function expectStillLegacy(source: string, target: string, oracle: () => unknown): Promise<void> {
  const legacy = await compileRun(source, false);
  const ir = await compileRun(source, true);
  const outcome = outcomeFor(ir, target);
  expect(outcome?.irBodyEmitted, `${target} must NOT be emitted through IR`).not.toBe(true);
  expect(outcome?.code, `${target} declined by the selector`).toBe("body-shape-rejected");
  expect(legacy.observed, "legacy matches Node").toStrictEqual(oracle());
  expect(ir.observed, "IR result still matches legacy").toStrictEqual(legacy.observed);
}

// ---------------------------------------------------------------------------
// S1 — tail for / while / do
// ---------------------------------------------------------------------------

describe("#5165 S1 — a function ENDING in a loop whose body returns", () => {
  it("tail `for` with an absent condition, non-void", async () => {
    await expectAdopted(
      `function findIndexOfThree(xs: number[]): number {
         for (let i = 0; ; i = i + 1) {
           if (xs[i] === 3) return i;
         }
       }
       export function main(): number {
         return findIndexOfThree([9, 7, 3, 1]);
       }`,
      "findIndexOfThree",
      () => {
        function findIndexOfThree(xs: number[]): number {
          for (let i = 0; ; i = i + 1) {
            if (xs[i] === 3) return i;
          }
        }
        return findIndexOfThree([9, 7, 3, 1]);
      },
    );
  });

  it("tail `while (true)`, non-void", async () => {
    await expectAdopted(
      `function firstAbove(xs: number[], limit: number): number {
         let i = 0;
         while (true) {
           if (xs[i] > limit) return i;
           i = i + 1;
         }
       }
       export function main(): number {
         return firstAbove([1, 2, 30, 4], 10);
       }`,
      "firstAbove",
      () => {
        function firstAbove(xs: number[], limit: number): number {
          let i = 0;
          while (true) {
            if (xs[i] > limit) return i;
            i = i + 1;
          }
        }
        return firstAbove([1, 2, 30, 4], 10);
      },
    );
  });

  it("tail `do … while (true)`, non-void", async () => {
    await expectAdopted(
      `function firstAboveDo(xs: number[], limit: number): number {
         let i = 0;
         do {
           if (xs[i] > limit) return i;
           i = i + 1;
         } while (true);
       }
       export function main(): number {
         return firstAboveDo([5, 5, 5, 99], 10);
       }`,
      "firstAboveDo",
      () => {
        function firstAboveDo(xs: number[], limit: number): number {
          let i = 0;
          do {
            if (xs[i] > limit) return i;
            i = i + 1;
            // biome-ignore lint/correctness/noConstantCondition: the constant condition IS the shape under test — this oracle must mirror the compiled source exactly
          } while (true);
        }
        return firstAboveDo([5, 5, 5, 99], 10);
      },
    );
  });

  it("tail loop with a return nested two `if`s deep", async () => {
    await expectAdopted(
      `function deepTailReturn(xs: number[]): number {
         for (let i = 0; ; i = i + 1) {
           if (xs[i] > 0) {
             if (xs[i] % 2 === 0) {
               return i;
             }
           }
         }
       }
       export function main(): number {
         return deepTailReturn([-2, 3, 7, 8, 1]);
       }`,
      "deepTailReturn",
      () => {
        function deepTailReturn(xs: number[]): number {
          for (let i = 0; ; i = i + 1) {
            if (xs[i] > 0) {
              if (xs[i] % 2 === 0) {
                return i;
              }
            }
          }
        }
        return deepTailReturn([-2, 3, 7, 8, 1]);
      },
    );
  });

  it("VOID tail loop with a genuine fall-through returns undefined", async () => {
    // `main` IS the void function under test, so its completion value is what
    // the tail arm's implicit-empty-return terminator produces: undefined.
    await expectAdopted(
      `let total = 0;
       export function main(): void {
         const xs = [1, 2, 3];
         for (let i = 0; i < xs.length; i = i + 1) {
           total = total + xs[i];
         }
       }
       export function readState(): number {
         return total;
       }`,
      "main",
      () => {
        let total = 0;
        const run = (): void => {
          const xs = [1, 2, 3];
          for (let i = 0; i < xs.length; i = i + 1) {
            total = total + xs[i]!;
          }
        };
        return [run() as unknown, total];
      },
    );
  });

  it("VOID tail loop that exits via `break` still returns undefined", async () => {
    // The break-falls-through shape that the NON-void arm must refuse is
    // perfectly safe in a void function: the fall-out reaches the implicit
    // empty return, which is exactly what JS produces.
    await expectAdopted(
      `let total = 0;
       export function main(): void {
         const xs = [4, 5];
         let i = 0;
         while (true) {
           if (i >= xs.length) break;
           total = total + xs[i];
           i = i + 1;
         }
       }
       export function readState(): number {
         return total;
       }`,
      "main",
      () => {
        let total = 0;
        const run = (): void => {
          const xs = [4, 5];
          let i = 0;
          while (true) {
            if (i >= xs.length) break;
            total = total + xs[i]!;
            i = i + 1;
          }
        };
        return [run() as unknown, total];
      },
    );
  });

  it("NEGATIVE: a `break` binding the tail loop keeps a non-void function on legacy", async () => {
    // `while (true) { if (x) return 1; break; }` — the break makes the loop
    // fall through, so `unreachable` after it would be a reachable trap.
    await expectStillLegacy(
      `function breakFallsThrough(x: number): number {
         while (true) {
           if (x > 0) return 1;
           break;
         }
       }
       export function main(): number {
         return breakFallsThrough(5);
       }`,
      "breakFallsThrough",
      () => {
        function breakFallsThrough(x: number): number {
          while (true) {
            if (x > 0) return 1;
            break;
          }
          return undefined as unknown as number;
        }
        return breakFallsThrough(5);
      },
    );
  });

  it("NEGATIVE: a LABELED break out of the tail loop keeps a non-void function on legacy", async () => {
    await expectStillLegacy(
      `function labeledBreakOut(x: number): number {
         outer: while (true) {
           while (true) {
             if (x > 0) return 1;
             break outer;
           }
         }
       }
       export function main(): number {
         return labeledBreakOut(7);
       }`,
      "labeledBreakOut",
      () => {
        function labeledBreakOut(x: number): number {
          outer: while (true) {
            while (true) {
              if (x > 0) return 1;
              break outer;
            }
          }
          return undefined as unknown as number;
        }
        return labeledBreakOut(7);
      },
    );
  });

  it("a break bound by an INNER loop does not make the tail loop fall through", async () => {
    // The `break` binds the inner `while`, not the tail loop — so the tail loop
    // still never completes normally and the shape IS adoptable.
    await expectAdopted(
      `function nestedBreakStillInfinite(xs: number[]): number {
         let i = 0;
         while (true) {
           while (true) {
             break;
           }
           if (xs[i] > 0) return i;
           i = i + 1;
         }
       }
       export function main(): number {
         return nestedBreakStillInfinite([0, -1, 6]);
       }`,
      "nestedBreakStillInfinite",
      () => {
        function nestedBreakStillInfinite(xs: number[]): number {
          let i = 0;
          while (true) {
            while (true) {
              break;
            }
            if (xs[i] > 0) return i;
            i = i + 1;
          }
        }
        return nestedBreakStillInfinite([0, -1, 6]);
      },
    );
  });

  it("a break bound by a nested SWITCH does not make the tail loop fall through", async () => {
    // §14.9: an unlabeled `break` binds the innermost loop OR switch. Both of
    // these bind the switch, so the tail loop still never completes normally.
    await expectAdopted(
      `function switchBreakInLoop(xs: number[]): number {
         let i = 0;
         while (true) {
           switch (xs[i]) {
             case 1:
               break;
             default:
               break;
           }
           if (xs[i] > 2) return i;
           i = i + 1;
         }
       }
       export function main(): number {
         return switchBreakInLoop([1, 0, 9]);
       }`,
      "switchBreakInLoop",
      () => {
        function switchBreakInLoop(xs: number[]): number {
          let i = 0;
          while (true) {
            switch (xs[i]) {
              case 1:
                break;
              default:
                break;
            }
            if (xs[i]! > 2) return i;
            i = i + 1;
          }
        }
        return switchBreakInLoop([1, 0, 9]);
      },
    );
  });

  it("NEGATIVE: a break inside a TRY still binds the tail loop", async () => {
    // A `try` is NOT a breakable statement, so this `break` crosses it and
    // binds the loop — the loop CAN fall out and must stay on legacy. This is
    // the sharpest nesting case: the break is two frames deep but still ours.
    await expectStillLegacy(
      `function breakOutOfTry(x: number): number {
         while (true) {
           try {
             if (x > 5) break;
           } catch (e) {
           }
           if (x > 0) return x;
           x = x + 1;
         }
       }
       export function main(): number {
         return breakOutOfTry(3);
       }`,
      "breakOutOfTry",
      () => {
        function breakOutOfTry(x: number): number {
          while (true) {
            try {
              if (x > 5) break;
            } catch (e) {
              // no-op
            }
            if (x > 0) return x;
            x = x + 1;
          }
          return undefined as unknown as number;
        }
        return breakOutOfTry(3);
      },
    );
  });

  it("a break bound by a nested LABELED block does not make the tail loop fall through", async () => {
    await expectAdopted(
      `function labeledBlockBreak(xs: number[]): number {
         let i = 0;
         while (true) {
           inner: {
             if (xs[i] < 0) break inner;
             if (xs[i] > 0) return i;
           }
           i = i + 1;
         }
       }
       export function main(): number {
         return labeledBlockBreak([-5, 0, 4]);
       }`,
      "labeledBlockBreak",
      () => {
        function labeledBlockBreak(xs: number[]): number {
          let i = 0;
          while (true) {
            // biome-ignore lint/suspicious/noConfusingLabels: a labeled BLOCK is the point — it binds the break so the tail loop still never completes normally
            inner: {
              if (xs[i] < 0) break inner;
              if (xs[i] > 0) return i;
            }
            i = i + 1;
          }
        }
        return labeledBlockBreak([-5, 0, 4]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// S2 — returns inside a finally-LESS try / catch
// ---------------------------------------------------------------------------

describe("#5165 S2 — early return out of a finally-LESS try/catch", () => {
  function safeDiv(a: number, b: number): number {
    try {
      if (b === 0) throw "div0";
    } catch (e) {
      return 0;
    }
    return a / b;
  }
  const SAFE_DIV = `function safeDiv(a: number, b: number): number {
      try {
        if (b === 0) throw "div0";
      } catch (e) {
        return 0;
      }
      return a / b;
    }`;

  it("catch returns — NON-throwing execution", async () => {
    await expectAdopted(`${SAFE_DIV}\nexport function main(): number { return safeDiv(10, 2); }`, "safeDiv", () =>
      safeDiv(10, 2),
    );
  });

  it("catch returns — THROWING execution", async () => {
    await expectAdopted(`${SAFE_DIV}\nexport function main(): number { return safeDiv(10, 0); }`, "safeDiv", () =>
      safeDiv(10, 0),
    );
  });

  function tryReturns(a: number): number {
    try {
      if (a < 0) throw "neg";
      return a * 2;
    } catch (e) {
      // fall out of the catch into the trailing return
    }
    return -1;
  }
  const TRY_RETURNS = `function tryReturns(a: number): number {
      try {
        if (a < 0) throw "neg";
        return a * 2;
      } catch (e) {
      }
      return -1;
    }`;

  it("try body returns — NON-throwing execution", async () => {
    await expectAdopted(`${TRY_RETURNS}\nexport function main(): number { return tryReturns(21); }`, "tryReturns", () =>
      tryReturns(21),
    );
  });

  it("try body returns — THROWING execution takes the trailing return", async () => {
    await expectAdopted(`${TRY_RETURNS}\nexport function main(): number { return tryReturns(-3); }`, "tryReturns", () =>
      tryReturns(-3),
    );
  });

  function bothReturn(a: number): number {
    try {
      if (a < 0) throw "neg";
      return a + 1;
    } catch (e) {
      return 100;
    }
    // (the compiled source keeps an unreachable trailing `return -1;` here, to
    // prove the tail is the trailing return rather than the try itself)
  }
  const BOTH_RETURN = `function bothReturn(a: number): number {
      try {
        if (a < 0) throw "neg";
        return a + 1;
      } catch (e) {
        return 100;
      }
      return -1;
    }`;

  it("both arms return, with a trailing return — NON-throwing", async () => {
    await expectAdopted(`${BOTH_RETURN}\nexport function main(): number { return bothReturn(8); }`, "bothReturn", () =>
      bothReturn(8),
    );
  });

  it("both arms return, with a trailing return — THROWING", async () => {
    await expectAdopted(`${BOTH_RETURN}\nexport function main(): number { return bothReturn(-8); }`, "bothReturn", () =>
      bothReturn(-8),
    );
  });

  function firstBad(xs: number[]): number {
    for (let i = 0; i < xs.length; i = i + 1) {
      try {
        if (xs[i]! < 0) throw "neg";
      } catch (e) {
        return i;
      }
    }
    return -1;
  }
  const TRY_IN_LOOP = `function firstBad(xs: number[]): number {
      for (let i = 0; i < xs.length; i = i + 1) {
        try {
          if (xs[i] < 0) throw "neg";
        } catch (e) {
          return i;
        }
      }
      return -1;
    }`;

  it("a finally-less try nested in a loop — THROWING execution returns from the catch", async () => {
    await expectAdopted(
      `${TRY_IN_LOOP}\nexport function main(): number { return firstBad([1, 2, -3, 4]); }`,
      "firstBad",
      () => firstBad([1, 2, -3, 4]),
    );
  });

  it("a finally-less try nested in a loop — NON-throwing execution falls out", async () => {
    await expectAdopted(
      `${TRY_IN_LOOP}\nexport function main(): number { return firstBad([1, 2, 3]); }`,
      "firstBad",
      () => firstBad([1, 2, 3]),
    );
  });
});

// ---------------------------------------------------------------------------
// S3 — a function ENDING in a try
// ---------------------------------------------------------------------------

describe("#5165 S3 — a function ENDING in a try", () => {
  function parseOrZero(xs: number[], i: number): number {
    try {
      if (xs[i]! < 0) throw "neg";
      return xs[i]!;
    } catch (e) {
      return 0;
    }
  }
  const TAIL_TRY = `function parseOrZero(xs: number[], i: number): number {
      try {
        if (xs[i] < 0) throw "neg";
        return xs[i];
      } catch (e) {
        return 0;
      }
    }`;

  it("tail try/catch, both arms return — NON-throwing execution", async () => {
    await expectAdopted(
      `${TAIL_TRY}\nexport function main(): number { return parseOrZero([7, 8], 1); }`,
      "parseOrZero",
      () => parseOrZero([7, 8], 1),
    );
  });

  it("tail try/catch, both arms return — THROWING execution", async () => {
    await expectAdopted(
      `${TAIL_TRY}\nexport function main(): number { return parseOrZero([7, -8], 1); }`,
      "parseOrZero",
      () => parseOrZero([7, -8], 1),
    );
  });

  // `main` IS the void function under test, so its completion value is what
  // the tail arm's implicit-empty-return terminator produces: undefined.
  const voidTailTry = (input: number): string => `let state = 0;
     export function main(): void {
       try {
         if (${input} < 0) throw "neg";
         state = ${input};
       } catch (e) {
         state = -1;
       }
     }
     export function readState(): number {
       return state;
     }`;
  const voidTailTryOracle = (input: number) => (): unknown => {
    let state = 0;
    const run = (): void => {
      try {
        if (input < 0) throw "neg";
        state = input;
      } catch (e) {
        state = -1;
      }
    };
    return [run() as unknown, state];
  };

  it("VOID tail try falls through to the implicit return — NON-throwing", async () => {
    await expectAdopted(voidTailTry(5), "main", voidTailTryOracle(5));
  });

  it("VOID tail try falls through to the implicit return — THROWING", async () => {
    await expectAdopted(voidTailTry(-5), "main", voidTailTryOracle(-5));
  });

  it("NEGATIVE: a non-void tail try that can fall out stays on legacy", async () => {
    // Neither arm terminates, so control reaches the (absent) implicit return.
    // Only the side effect is observed: what a non-void function returns when it
    // falls off the end is a pre-existing legacy/JS divergence, unrelated to
    // this issue, and asserting on it would test the wrong thing.
    await expectStillLegacy(
      `function fallsOutOfTry(xs: number[], out: number[]): number {
         try {
           out[0] = xs[0];
         } catch (e) {
           out[0] = -1;
         }
       }
       export function main(): number {
         const out = [0];
         fallsOutOfTry([3], out);
         return out[0];
       }`,
      "fallsOutOfTry",
      () => {
        function fallsOutOfTry(xs: number[], out: number[]): number {
          try {
            out[0] = xs[0]!;
          } catch (e) {
            out[0] = -1;
          }
          return undefined as unknown as number;
        }
        const out = [0];
        fallsOutOfTry([3], out);
        return out[0];
      },
    );
  });
});

// ---------------------------------------------------------------------------
// S4 boundary — returns crossing a `finally` stay on legacy (separate issue)
// ---------------------------------------------------------------------------

describe("#5165 — finally-crossing returns stay on the legacy path (S4)", () => {
  it("return directly inside a try/finally", async () => {
    await expectStillLegacy(
      `function crossFinally(a: number, log: number[]): number {
         try {
           return a * 2;
         } finally {
           log[0] = 1;
         }
       }
       export function main(): number {
         const log = [0];
         return crossFinally(3, log) + log[0];
       }`,
      "crossFinally",
      () => {
        function crossFinally(a: number, log: number[]): number {
          try {
            return a * 2;
          } finally {
            log[0] = 1;
          }
        }
        const log = [0];
        return crossFinally(3, log) + log[0]!;
      },
    );
  });

  it("catch returns while a finally is present", async () => {
    await expectStillLegacy(
      `function catchReturnWithFinally(a: number, log: number[]): number {
         try {
           if (a < 0) throw "neg";
         } catch (e) {
           return 0;
         } finally {
           log[0] = 1;
         }
         return a;
       }
       export function main(): number {
         const log = [0];
         return catchReturnWithFinally(-1, log) + log[0];
       }`,
      "catchReturnWithFinally",
      () => {
        function catchReturnWithFinally(a: number, log: number[]): number {
          try {
            if (a < 0) throw "neg";
          } catch (e) {
            return 0;
          } finally {
            log[0] = 1;
          }
          return a;
        }
        const log = [0];
        return catchReturnWithFinally(-1, log) + log[0]!;
      },
    );
  });

  it("DEPTH: a finally-LESS try nested inside a finally-BEARING try stays barred", async () => {
    await expectStillLegacy(
      `function nestedBarrier(a: number, log: number[]): number {
         try {
           try {
             if (a < 0) throw "neg";
           } catch (e) {
             return 0;
           }
         } finally {
           log[0] = 1;
         }
         return a;
       }
       export function main(): number {
         const log = [0];
         return nestedBarrier(-1, log) + log[0];
       }`,
      "nestedBarrier",
      () => {
        function nestedBarrier(a: number, log: number[]): number {
          try {
            try {
              if (a < 0) throw "neg";
            } catch (e) {
              return 0;
            }
          } finally {
            log[0] = 1;
          }
          return a;
        }
        const log = [0];
        return nestedBarrier(-1, log) + log[0]!;
      },
    );
  });

  it("DEPTH: a finally-LESS try inside a for-of body stays barred", async () => {
    await expectStillLegacy(
      `function forOfTryReturn(xs: number[]): number {
         for (const x of xs) {
           try {
             if (x < 0) throw "neg";
           } catch (e) {
             return 0;
           }
         }
         return -1;
       }
       export function main(): number {
         return forOfTryReturn([1, -2]);
       }`,
      "forOfTryReturn",
      () => {
        function forOfTryReturn(xs: number[]): number {
          for (const x of xs) {
            try {
              if (x < 0) throw "neg";
            } catch (e) {
              return 0;
            }
          }
          return -1;
        }
        return forOfTryReturn([1, -2]);
      },
    );
  });
});

/**
 * A generator / async export cannot go through the scalar `main()` harness, so
 * these get their own instantiate-and-drive helper.
 */
async function instantiate(source: string, experimentalIR: boolean) {
  const r = await compile(source, { experimentalIR, trackIrOutcomes: true });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": JS_STRING as unknown as WebAssembly.ModuleImports,
  });
  built.setExports?.(instance.exports as Record<string, Function>);
  return {
    exports: instance.exports as Record<string, unknown>,
    outcome: (r.irOutcomes ?? []).find((o) => o.displayName !== "<module-init>"),
  };
}

/** Drive `fn` on both paths and report each outcome as a value or a throw. */
async function bothPaths(source: string, drive: (f: never) => unknown | Promise<unknown>) {
  const settle = async (experimentalIR: boolean) => {
    const { exports, outcome } = await instantiate(source, experimentalIR);
    try {
      return { result: await drive(exports.main as never), outcome };
    } catch (e) {
      return { result: `THREW: ${String(e)}`, outcome };
    }
  };
  return { legacy: await settle(false), ir: await settle(true) };
}

// ---------------------------------------------------------------------------
// Generators — OUT of both new tail arms
// ---------------------------------------------------------------------------

describe("#5165 — generators stay on the legacy path for both new tail arms", () => {
  it("NEGATIVE: a generator ENDING in an infinite yield loop", async () => {
    // The IR generator lowering is EAGER: the body runs to completion into a
    // yield buffer. A tail loop with no normal completion — exactly what the
    // S1 proof establishes — therefore never terminates and blows that buffer,
    // where the legacy lazy generator suspends per `next()`. Claiming this
    // shape turns a working program into a RangeError.
    const source = `export function* main(n: number): Generator<number> {
        let i = n;
        while (true) {
          yield i;
          i = i + 1;
        }
      }`;
    const drive = (f: never) => {
      const it = (f as unknown as (n: number) => Iterator<number>)(5);
      return [it.next(), it.next(), it.next()];
    };
    const { legacy, ir } = await bothPaths(source, drive);
    expect(ir.outcome?.irBodyEmitted, "generator tail loop must NOT be emitted through IR").not.toBe(true);
    expect(legacy.result, "legacy matches Node").toStrictEqual([
      { value: 5, done: false },
      { value: 6, done: false },
      { value: 7, done: false },
    ]);
    expect(ir.result, "IR matches legacy").toStrictEqual(legacy.result);
  });

  it("NEGATIVE: a generator ENDING in a try whose arms all throw", async () => {
    const source = `export function* main(n: number): Generator<number> {
        try {
          throw "a";
        } catch (e) {
          throw "b";
        }
      }`;
    const drive = (f: never) => (f as unknown as (n: number) => Iterator<number>)(0).next();
    const { legacy, ir } = await bothPaths(source, drive);
    expect(ir.outcome?.irBodyEmitted, "generator tail try must NOT be emitted through IR").not.toBe(true);
    // Node throws the string "b"; so does legacy. Claiming this shape surfaced
    // a raw WebAssembly.Exception instead.
    expect(legacy.result, "legacy matches Node").toBe("THREW: b");
    expect(ir.result, "IR matches legacy").toStrictEqual(legacy.result);
  });
});

// ---------------------------------------------------------------------------
// Async — IN, and equivalent
// ---------------------------------------------------------------------------

describe("#5165 — async functions take the new tail arms and stay equivalent", () => {
  it("async function ENDING in a `while (true)` whose body returns", async () => {
    const source = `export async function main(n: number): Promise<number> {
        let i = 0;
        while (true) {
          if (i >= n) return i;
          i = i + 1;
        }
      }`;
    const drive = (f: never) => (f as unknown as (n: number) => Promise<number>)(4);
    const { legacy, ir } = await bothPaths(source, drive);
    expect(ir.outcome?.kind, "async tail loop emitted through IR").toBe("emitted");
    expect(legacy.result, "legacy matches Node").toBe(4);
    expect(ir.result, "IR matches legacy/Node").toStrictEqual(legacy.result);
  });

  it("async function ENDING in a try whose arms both return — THROWING", async () => {
    const source = `export async function main(n: number): Promise<number> {
        try {
          if (n < 0) throw "neg";
          return n;
        } catch (e) {
          return -1;
        }
      }`;
    const drive = (f: never) => (f as unknown as (n: number) => Promise<number>)(-7);
    const { legacy, ir } = await bothPaths(source, drive);
    expect(ir.outcome?.kind, "async tail try emitted through IR").toBe("emitted");
    expect(legacy.result, "legacy matches Node").toBe(-1);
    expect(ir.result, "IR matches legacy/Node").toStrictEqual(legacy.result);
  });
});
