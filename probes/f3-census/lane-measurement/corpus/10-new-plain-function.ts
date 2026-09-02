function Point(this: { x: number; y: number }, x: number, y: number): void {
  this.x = x;
  this.y = y;
}
export function entry(a: number, b: number): number {
  const p = new (Point as unknown as new (x: number, y: number) => { x: number; y: number })(a, b);
  return p.x + p.y;
}
