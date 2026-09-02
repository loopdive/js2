function scale(this: { factor: number }, x: number): number {
  return this.factor * x;
}
export function entry(x: number): number {
  const bound = scale.bind({ factor: 3 });
  return bound(x);
}
