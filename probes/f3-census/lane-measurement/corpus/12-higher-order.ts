function compose(f: (x: number) => number, g: (x: number) => number): (x: number) => number {
  return (x: number): number => f(g(x));
}
function inc(x: number): number {
  return x + 1;
}
function dbl(x: number): number {
  return x * 2;
}
export function entry(x: number): number {
  const h = compose(inc, dbl);
  return h(x);
}
