import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const DYNAMIC_OPERATIONS_SOURCE = `
function addNumbers(left: any, right: any): number {
  const result = left + right;
  return +result;
}

function addStrings(left: any, right: any): number {
  const result = left + right;
  return result === "loopdive" ? 1 : 0;
}

function consumeNumber(value: number): number {
  return value;
}

function dynamicToNumberCall(value: any): number {
  return consumeNumber(value);
}

export function memberAddition(holder: any): number {
  return +(holder.value + 1);
}

function readAddedString(left: any, right: any): number {
  return +(left + right).charCodeAt(1);
}

function numericRelations(left: any, right: any): number {
  if (!(left < right)) return 0;
  if (!(left <= right)) return 0;
  if (left > right) return 0;
  if (left >= right) return 0;
  return 1;
}

function stringRelations(left: any, right: any): number {
  if (!(left < right)) return 0;
  if (!(left <= right)) return 0;
  if (left > right) return 0;
  if (left >= right) return 0;
  return 1;
}

function incomparableRelations(left: any, right: any): number {
  if (left < right) return 0;
  if (left <= right) return 0;
  if (left > right) return 0;
  if (left >= right) return 0;
  return 1;
}

export function callWithoutArgument(receiver: any): number {
  const result = receiver.read();
  return result === 37 ? 1 : 0;
}

export function callWithArgument(receiver: any, value: any): number {
  const result = receiver.add(value);
  return result === 42 ? 1 : 0;
}

function stringCharCodeAtZero(value: any): number {
  const result = value.charCodeAt();
  return +result;
}

function stringCharCodeAtOne(value: any, index: any): number {
  const result = value.charCodeAt(index);
  return +result;
}

function countDynamic(from: any, end: any): number {
  for (; from < end; from++) {}
  return +from;
}

function countDynamicDown(from: any, end: any): number {
  for (; from > end; from--) {}
  return +from;
}

function chooseDynamic(flag: boolean, left: any, right: any): number {
  const chosen = flag ? left : right;
  return chosen === "left" ? 1 : 0;
}

function addConditional(flag: boolean, left: any, right: any): number {
  const result = (flag ? left : right) + 1;
  return result === 42 ? 1 : 0;
}

export function runNumberAddition(): number {
  return addNumbers(19, 23);
}

export function runStringAddition(): number {
  return addStrings("loop", "dive");
}

export function runDynamicToNumberCall(): number {
  return dynamicToNumberCall("42");
}

export function runAddedStringMethod(): number {
  return readAddedString("A", "Z");
}

export function runNumericRelations(): number {
  return numericRelations(2, 10);
}

export function runStringRelations(): number {
  return stringRelations("10", "2");
}

export function runIncomparableRelations(): number {
  return incomparableRelations(0 / 0, 1);
}

export function runCustomCallZero(): number {
  const receiver: any = {};
  receiver["base"] = 37;
  receiver["read"] = function () {
    return (this as any).base;
  };
  return callWithoutArgument(receiver);
}

export function runCustomCallOne(): number {
  const receiver: any = {};
  receiver["base"] = 37;
  receiver["add"] = function (value: number) {
    return (this as any).base + value;
  };
  return callWithArgument(receiver, 5);
}

export function runCharCodeAtZero(): number {
  return stringCharCodeAtZero("AZ");
}

export function runCharCodeAtOne(): number {
  return stringCharCodeAtOne("AZ", 1);
}

export function runDynamicLoop(): number {
  return countDynamic("2", 5);
}

export function runDynamicLoopDown(): number {
  return countDynamicDown("5", 2);
}

export function runConditionalTrue(): number {
  return chooseDynamic(true, "left", "right");
}

export function runConditionalFalse(): number {
  return chooseDynamic(false, "right", "left");
}

export function runConditionalAddition(): number {
  if (addConditional(true, 41, 0) !== 1) return 0;
  return addConditional(false, 0, 41);
}
`;

const COMMON_FEATURE_FUNCTIONS = [
  "addNumbers",
  "addStrings",
  "consumeNumber",
  "dynamicToNumberCall",
  "readAddedString",
  "numericRelations",
  "stringRelations",
  "incomparableRelations",
  "stringCharCodeAtZero",
  "stringCharCodeAtOne",
  "countDynamic",
  "countDynamicDown",
  "chooseDynamic",
  "addConditional",
] as const;

async function compileTarget(target: "gc" | "standalone") {
  const result = await compile(DYNAMIC_OPERATIONS_SOURCE, {
    fileName: `issue-3790-ir-dynamic-string-loop-${target}.ts`,
    target,
    trackIrOutcomes: true,
  });

  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const expectedFunctions =
    target === "gc"
      ? [...COMMON_FEATURE_FUNCTIONS, "memberAddition", "callWithoutArgument", "callWithArgument"]
      : COMMON_FEATURE_FUNCTIONS;
  expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
    expect.arrayContaining(expectedFunctions),
  );
  return result;
}

describe("#3790 IR dynamic string operations and loop coercion", () => {
  it.each(["gc", "standalone"] as const)(
    "selects and executes the supported dynamic operations on %s",
    async (target) => {
      const result = await compileTarget(target);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
      const exports = instance.exports as Record<string, (...args: unknown[]) => number>;

      const expectedNoArgumentExports: Record<string, number> = {
        runNumberAddition: 42,
        runStringAddition: 1,
        runDynamicToNumberCall: 42,
        runAddedStringMethod: 90,
        runNumericRelations: 1,
        runStringRelations: 1,
        runIncomparableRelations: 1,
        runCharCodeAtZero: 65,
        runCharCodeAtOne: 90,
        runDynamicLoop: 5,
        runDynamicLoopDown: 2,
        runConditionalTrue: 1,
        runConditionalFalse: 1,
        runConditionalAddition: 1,
      };
      if (target === "gc") {
        expect(exports.memberAddition({ value: 41 })).toBe(42);
        expect(
          exports.callWithoutArgument({
            read() {
              return 37;
            },
          }),
        ).toBe(1);
        expect(
          exports.callWithArgument(
            {
              base: 37,
              add(value: number) {
                return this.base + value;
              },
            },
            5,
          ),
        ).toBe(1);
      } else {
        expectedNoArgumentExports.runCustomCallZero = 1;
        expectedNoArgumentExports.runCustomCallOne = 1;
      }

      for (const [name, expected] of Object.entries(expectedNoArgumentExports)) {
        expect(exports[name](), name).toBe(expected);
      }
    },
  );
});
