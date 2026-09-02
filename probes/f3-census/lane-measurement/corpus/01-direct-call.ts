function add(a: number, b: number): number {
  return a + b;
}
export function entry(x: number): number {
  return add(x, 1) + add(x, 2);
}
