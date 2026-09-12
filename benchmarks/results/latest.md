# js2wasm Benchmark Results

Date: 2026-09-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.048ms | 0.047ms | 0.044ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.119ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.423ms | 8.29ms | 2.73ms | FAILED | js |
| string/replace | 0.106ms | 0.685ms | 0.328ms | FAILED | js |
| string/case-convert | 0.056ms | 0.588ms | 0.256ms | FAILED | js |
| string/substring | 0.100ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.89ms | 2.68ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 2.72ms | 2.92ms | 0.561ms | js |
| array/push-pop | 1.44ms | 0.516ms | 0.506ms | FAILED | gc-native |
| array/sort-i32 | 0.814ms | 0.293ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.511ms | 0.511ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.027ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.262ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.093ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.216ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.126ms | — | — | js |
| dom/modify-text | 0.031ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.994ms | 8.76ms | 0.631ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 4.88ms | 3.02ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 69.29ms | 71.03ms | 0.720ms | js |
| mixed/sieve | 1.60ms | 2.12ms | 2.11ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 4.79 | 4.71 | 4.44 | — |
| string/concat-long | 1000 | 3.62 | 4.62 | 3.77 | — |
| string/indexOf | 1000 | 19.17 | 63.69 | 12.07 | 15.63 |
| string/includes | 1000 | 19.23 | 118.91 | 14.84 | 15.40 |
| string/split | 10000 | 42.34 | 828.73 | 273.37 | — |
| string/replace | 1000 | 106.14 | 684.69 | 328.45 | — |
| string/case-convert | 2000 | 27.78 | 294.06 | 128.22 | — |
| string/substring | 10000 | 9.98 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.99 | 389.15 | 268.00 | — |
| string/startsWith-endsWith | 20000 | 20.17 | 136.08 | 145.90 | 28.03 |
| array/map-filter | 30000 | 4.34 | 2.37 | 2.36 | — |
| array/indexOf | 1000 | 3949.83 | 2641.71 | 2642.13 | — |
| dom/create-elements | 2000 | 17.88 | 46.47 | — | — |
| dom/set-attributes | 6000 | 17.52 | 36.08 | — | — |
| dom/read-attributes | 3000 | 19.54 | 41.93 | — | — |
| dom/modify-text | 2000 | 15.53 | 53.99 | — | — |
| mixed/csv-parse | 11000 | 90.40 | 795.96 | 57.32 | — |
| mixed/text-search | 40000 | 9.75 | 121.90 | 75.44 | 27.05 |
| mixed/fibonacci | 10000 | 12.18 | 28.33 | 28.31 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.26 | 554.32 | 568.21 | 5.76 |
| mixed/sieve | 200000 | 8.02 | 10.62 | 10.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x faster | 1.08x faster | — |
| string/concat-long | 1.28x slower | 1.04x slower | — |
| string/indexOf | 3.32x slower | 1.59x faster | 1.23x faster |
| string/includes | 6.18x slower | 1.30x faster | 1.25x faster |
| string/split | 19.57x slower | 6.46x slower | — |
| string/replace | 6.45x slower | 3.09x slower | — |
| string/case-convert | 10.58x slower | 4.61x slower | — |
| string/substring | 2.67x faster | 3.25x faster | — |
| string/trim | 22.90x slower | 15.77x slower | — |
| string/startsWith-endsWith | 6.75x slower | 7.23x slower | 1.39x slower |
| array/push-pop | 2.79x faster | 2.84x faster | — |
| array/sort-i32 | 2.78x faster | 2.77x faster | — |
| array/map-filter | 1.83x faster | 1.84x faster | — |
| array/reduce | 4.25x faster | 4.25x faster | — |
| array/indexOf | 1.50x faster | 1.49x faster | — |
| array/slice | 1.04x slower | 1.04x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.73x faster | — |
| array/find | 16.35x faster | 16.38x faster | 4.13x slower |
| dom/create-elements | 2.60x slower | — | — |
| dom/set-attributes | 2.06x slower | — | — |
| dom/read-attributes | 2.15x slower | — | — |
| dom/modify-text | 3.48x slower | — | — |
| mixed/csv-parse | 8.80x slower | 1.58x faster | — |
| mixed/text-search | 12.51x slower | 7.74x slower | 2.77x slower |
| mixed/fibonacci | 2.33x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 438.60x slower | 449.59x slower | 4.56x slower |
| mixed/sieve | 1.33x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.06x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.28x faster |
| string/includes | 8.01x faster |
| string/split | 3.03x faster |
| string/replace | 2.08x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.22x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.07x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 13.89x faster |
| mixed/text-search | 1.62x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1139.3ms | 631.5ms | — |
| string/concat-long | 449.2ms | 667.5ms | — |
| string/indexOf | 387.1ms | 684.9ms | 571.2ms |
| string/includes | 393.4ms | 667.9ms | 564.1ms |
| string/split | 518.2ms | 682.7ms | — |
| string/replace | 520.1ms | 742.8ms | — |
| string/case-convert | 519.7ms | 578.8ms | — |
| string/substring | 404.0ms | 496.3ms | — |
| string/trim | 488.1ms | 684.7ms | — |
| string/startsWith-endsWith | 487.8ms | 706.3ms | 644.9ms |
| array/push-pop | 511.0ms | 561.2ms | — |
| array/sort-i32 | 645.5ms | 720.5ms | — |
| array/map-filter | 665.7ms | 753.7ms | — |
| array/reduce | 618.8ms | 697.8ms | — |
| array/indexOf | 587.9ms | 679.7ms | — |
| array/slice | 503.7ms | 592.7ms | — |
| array/reverse | 482.9ms | 588.7ms | — |
| array/forEach | 622.7ms | 707.4ms | — |
| array/find | 487.1ms | 564.4ms | 569.4ms |
| dom/create-elements | 411.7ms | — | — |
| dom/set-attributes | 422.6ms | — | — |
| dom/read-attributes | 415.5ms | — | — |
| dom/modify-text | 402.8ms | — | — |
| mixed/csv-parse | 524.1ms | 687.8ms | — |
| mixed/text-search | 499.7ms | 723.4ms | 622.6ms |
| mixed/fibonacci | 453.0ms | 521.9ms | 481.6ms |
| mixed/matrix-multiply | 638.4ms | 717.1ms | 530.7ms |
| mixed/sieve | 570.5ms | 664.2ms | — |
