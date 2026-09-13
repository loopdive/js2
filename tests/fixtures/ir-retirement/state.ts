export let value = 4;
export function helper(x: number): number {
  return x + 10;
}
export function bump(x: number): number {
  value += x;
  return value;
}
