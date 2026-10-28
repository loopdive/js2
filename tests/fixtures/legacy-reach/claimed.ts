// #7143 B0 fixture — a unit the IR claims on every target.
export function sum(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += i;
  return total;
}
