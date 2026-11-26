// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7380 — the shipped setting. vitest runs the Prepared self-checks (vitest.config.ts), but a production compile
// skips them, so this file compiles a deterministic sample of the proving-program corpus with the switch OFF.
// - every 2nd program: no exception out of compile(), and either a module the engine validates or a refusal;
// - every 67th program (12, kept small because the checks are slow): the same bytes or refusal text with the switch
//   on as off.
import { afterEach, describe, expect, it } from "vitest";
import { preparedValidationEnabled, setPreparedValidation } from "../src/shared/contracts/prepared-validation.js";
import { provingOutcome, provingPrograms } from "./helpers/prepared-proving-programs.js";

const atStart = preparedValidationEnabled();
afterEach(() => setPreparedValidation(atStart));

const rows = (step: number): number[] => provingPrograms.map((_, row) => row).filter((row) => row % step === 0);
// A strict compile awaits only settled promises, so a run of compiles never yields to the event loop and vitest's
// task-update RPC times out. Each program therefore ends with a turn of the loop, and rows run in batches of 100.
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const batches = Array.from({ length: Math.ceil(provingPrograms.length / 100) }, (_, batch) => batch * 100);

describe("#7380 — the proving programs with the self-checks off", () => {
  it.each(batches)(
    "every 2nd row from %i compiles or refuses without an exception",
    async (first) => {
      setPreparedValidation(false);
      for (const row of rows(2).filter((row) => row >= first && row < first + 100)) {
        const { outcome, binary } = await provingOutcome(provingPrograms[row]!);
        expect(outcome, `row ${row}`).toMatch(/^(bytes|refused) /);
        if (binary) expect(WebAssembly.validate(binary), `row ${row}`).toBe(true);
        await yieldToEventLoop();
      }
    },
    120_000,
  );

  it.each(rows(67))(
    "row %i gives the same outcome with the checks on",
    async (row) => {
      setPreparedValidation(false);
      const off = await provingOutcome(provingPrograms[row]!);
      setPreparedValidation(true);
      const on = await provingOutcome(provingPrograms[row]!);
      expect(off.outcome).toBe(on.outcome);
    },
    120_000,
  );
});
