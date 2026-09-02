function sum3(this: { off: number }, a: number, b: number, c: number): number {
  return this.off + a + b + c;
}
export function entry(x: number): number {
  const r1 = sum3.call({ off: 1 }, x, x, x);
  const r2 = sum3.apply({ off: 2 }, [x, x, x]);
  return r1 + r2;
}
