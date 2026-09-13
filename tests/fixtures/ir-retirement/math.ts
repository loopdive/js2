import { value, helper as stateHelper } from "./state";
export function helper(x: number): number {
  let sum = 0;
  for (let i = 0; i < x; i++) {
    if (i % 2 === 0) sum += i;
  }
  return sum + value + stateHelper(x);
}
