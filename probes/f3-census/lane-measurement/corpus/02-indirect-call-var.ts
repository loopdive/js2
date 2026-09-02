function inc(a: number): number {
  return a + 1;
}
function dbl(a: number): number {
  return a * 2;
}
export function entry(x: number): number {
  const f: (a: number) => number = x > 0 ? inc : dbl;
  return f(x);
}
