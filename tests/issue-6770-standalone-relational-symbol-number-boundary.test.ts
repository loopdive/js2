// UNAPPLIED ROOT-ONLY SOURCE PROPOSAL: not parsed, typechecked, compiled, or run.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";

const cases = [
  {
    name: "prototype-null wrapper relational throws",
    source:
      'Object.defineProperty(Symbol.prototype, Symbol.toPrimitive, { value: null });\nvar result = 0;\ntry { var comparison = Object(Symbol()) <= ""; if (comparison) result |= 2; } catch (error) { if (error instanceof TypeError) result |= 1; }\nexport function readResult() { return result; }',
    expected: 1,
  },
  {
    name: "prototype-undefined wrapper relational throws",
    source:
      'Object.defineProperty(Symbol.prototype, Symbol.toPrimitive, { value: undefined });\nvar result = 0;\ntry { var comparison = Object(Symbol()) <= ""; if (comparison) result |= 2; } catch (error) { if (error instanceof TypeError) result |= 1; }\nexport function readResult() { return result; }',
    expected: 1,
  },
  {
    name: "both relational operands reduce once before Symbol rejection",
    source:
      "var trace = 0;\nvar a = { get valueOf() { trace = trace * 10 + 1; return function () { trace = trace * 10 + 2; return Symbol(); }; } };\nvar b = { get valueOf() { trace = trace * 10 + 3; return function () { trace = trace * 10 + 4; return 0; }; } };\nvar threw = 0;\ntry { var comparison = a < b; if (comparison) trace += 100000; } catch (error) { if (error instanceof TypeError) threw = 1; }\nexport function readResult() { return trace === 1234 && threw === 1 ? 1 : 0; }",
    expected: 1,
  },
  {
    name: "abrupt left conversion preserves identity and suppresses right conversion",
    source:
      "var token = {};\nvar calls = 0;\nvar a = { valueOf() { calls++; throw token; } };\nvar b = { valueOf() { calls += 10; return 1; } };\nvar same = false;\ntry { var comparison = a < b; if (comparison) calls += 100; } catch (error) { same = error === token; }\nexport function readResult() { return calls === 1 && same ? 1 : 0; }",
    expected: 1,
  },
  {
    name: "lexicographic and ordinary mixed numeric arms remain separate",
    source:
      'var result = 0;\nif (Object("10") < Object("2")) result |= 1;\nif (!(Object("10") < 2)) result |= 2;\nif (Object(1) < "2") result |= 4;\nif (!(Object(NaN) <= 2)) result |= 8;\nexport function readResult() { return result; }',
    expected: 15,
  },
  {
    name: "Symbol property keys retain the nonthrowing numeric-index probe contract",
    source:
      'var key = Symbol("key");\nvar array = [11, 22];\nvar result = 0;\ntry { array[key] = 31; if (array[key] === 31) result |= 1; } catch (error) { result |= 8; }\nif (array.length === 2 && array[0] === 11 && array[1] === 22) result |= 2;\nexport function readResult() { return result; }',
    expected: 3,
  },
  {
    name: "earlier relational body sees a later materialized Symbol carrier",
    source:
      'function earlier(value) { return value <= ""; }\nvar symbol = Symbol("late");\nvar object = { valueOf() { return symbol; } };\nvar result = 0;\ntry { var comparison = earlier(object); if (comparison) result |= 2; } catch (error) { if (error instanceof TypeError) result |= 1; }\nexport function readResult() { return result; }',
    expected: 1,
  },
  {
    name: "Symbol results reject from either side for all four relational operators",
    source:
      "var a = { valueOf() { return Symbol(); } };\nvar count = 0;\ntry { var r1 = a < 0; } catch (error) { if (error instanceof TypeError) count++; }\ntry { var r2 = 0 <= a; } catch (error) { if (error instanceof TypeError) count++; }\ntry { var r3 = a > 0; } catch (error) { if (error instanceof TypeError) count++; }\ntry { var r4 = 0 >= a; } catch (error) { if (error instanceof TypeError) count++; }\nexport function readResult() { return count; }",
    expected: 4,
  },
];

const variants = [
  { label: "default", fused: undefined, smi: undefined },
  { label: "fused-off-smi-all", fused: "0", smi: "all" },
  { label: "fused-off-smi-off", fused: "0", smi: "0" },
] as const;
const flagKeys = ["JS2WASM_FUSED_TONUMBER", "JS2WASM_SMI_FASTPATH"] as const;

// Each registration has one fresh host realm and one compile. No host Object,
// Symbol, or TypeError is injected into the realm or retained between cases.
// Sequential execution is required because the compiler flags are process-global.
// Use the stock test deadline: one red variant cannot skip the other registrations.
describe.sequential("standalone relational primitive Symbol number boundary", () => {
  for (const entry of cases) {
    for (const variant of variants) {
      it(`${entry.name} [${variant.label}]`, async () => {
        const referenceSource =
          "(() => {\n" + entry.source.replace(/export function /g, "function ") + "\nreturn readResult();\n})()";
        const reference: unknown = runInNewContext(referenceSource, Object.create(null));
        expect(typeof reference).toBe("number");
        expect(reference).toBe(entry.expected);

        const saved = flagKeys.map((key) => process.env[key]);
        try {
          const flags = [variant.fused, variant.smi];
          for (const [index, key] of flagKeys.entries()) {
            const value = flags[index];
            if (value === undefined) Reflect.deleteProperty(process.env, key);
            else process.env[key] = value;
            expect(process.env[key]).toBe(value);
          }
          const options: CompileOptions = {
            target: "standalone",
            hostBridge: "off",
            fileName: "relational-symbol-number-boundary.js",
            allowJs: true,
            skipSemanticDiagnostics: true,
            deferTopLevelInit: true,
          };
          const result = await compile(entry.source, options);
          expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
          const bytes = Uint8Array.from(result.binary);
          expect(WebAssembly.validate(bytes)).toBe(true);
          const module = await WebAssembly.compile(bytes);
          expect(WebAssembly.Module.imports(module)).toEqual([]);
          const instance = await WebAssembly.instantiate(module, {});
          const initialize = instance.exports.__module_init;
          const readResult = instance.exports.readResult;
          expect(typeof initialize).toBe("function");
          expect(typeof readResult).toBe("function");
          if (typeof initialize !== "function" || typeof readResult !== "function") {
            throw new Error("Required module initialization and result exports are not callable");
          }
          initialize();
          const actual: unknown = readResult();
          expect(typeof actual).toBe("number");
          expect(actual).toBe(entry.expected);
        } finally {
          for (const [index, key] of flagKeys.entries()) {
            const value = saved[index];
            if (value === undefined) Reflect.deleteProperty(process.env, key);
            else process.env[key] = value;
          }
        }
      });
    }
  }
});
