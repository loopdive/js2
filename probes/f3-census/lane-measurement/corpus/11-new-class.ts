class Vec {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  len2(): number {
    return this.x * this.x + this.y * this.y;
  }
}
export function entry(a: number, b: number): number {
  const v = new Vec(a, b);
  return v.len2();
}
