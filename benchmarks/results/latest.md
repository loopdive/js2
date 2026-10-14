# js2wasm Benchmark Results

Date: 2026-10-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.052ms | 0.050ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.117ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.426ms | 7.82ms | 2.62ms | FAILED | js |
| string/replace | 0.094ms | 0.624ms | 0.277ms | FAILED | js |
| string/case-convert | 0.058ms | 0.559ms | 0.240ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.39ms | 2.38ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.57ms | 2.53ms | 0.559ms | js |
| array/push-pop | 1.69ms | 0.613ms | 0.607ms | FAILED | gc-native |
| array/sort-i32 | 0.841ms | 0.298ms | 0.301ms | FAILED | host-call |
| array/map-filter | 0.137ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.41ms | 0.603ms | 0.601ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.87ms | 2.87ms | FAILED | gc-native |
| array/slice | 0.037ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.095ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.272ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.038ms | 0.161ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.237ms | — | — | js |
| dom/read-attributes | 0.059ms | 0.136ms | — | — | js |
| dom/modify-text | 0.029ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.469ms | 8.27ms | 0.568ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.42ms | 2.51ms | 1.12ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 0.326ms | js |
| mixed/matrix-multiply | 0.186ms | 67.47ms | 70.27ms | 0.723ms | js |
| mixed/sieve | 1.79ms | 2.31ms | 2.33ms | FAILED | js |

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
| string/concat-short | 10000 | 3.02 | 5.23 | 5.02 | — |
| string/concat-long | 1000 | 4.16 | 5.10 | 3.66 | — |
| string/indexOf | 1000 | 18.98 | 59.89 | 12.21 | 16.73 |
| string/includes | 1000 | 18.74 | 117.10 | 13.88 | 16.79 |
| string/split | 10000 | 42.64 | 782.36 | 262.20 | — |
| string/replace | 1000 | 93.95 | 624.44 | 276.86 | — |
| string/case-convert | 2000 | 29.01 | 279.46 | 120.18 | — |
| string/substring | 10000 | 10.52 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.32 | 338.78 | 238.18 | — |
| string/startsWith-endsWith | 20000 | 20.64 | 128.27 | 126.50 | 27.93 |
| array/map-filter | 30000 | 4.55 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4457.86 | 2870.16 | 2869.57 | — |
| dom/create-elements | 2000 | 19.14 | 80.35 | — | — |
| dom/set-attributes | 6000 | 18.41 | 39.48 | — | — |
| dom/read-attributes | 3000 | 19.58 | 45.47 | — | — |
| dom/modify-text | 2000 | 14.70 | 56.59 | — | — |
| mixed/csv-parse | 11000 | 42.64 | 752.04 | 51.67 | — |
| mixed/text-search | 40000 | 10.07 | 110.56 | 62.74 | 28.06 |
| mixed/fibonacci | 10000 | 12.52 | 32.71 | 32.74 | 32.62 |
| mixed/matrix-multiply | 125000 | 1.49 | 539.72 | 562.18 | 5.78 |
| mixed/sieve | 200000 | 8.94 | 11.57 | 11.65 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.73x slower | 1.66x slower | — |
| string/concat-long | 1.23x slower | 1.14x faster | — |
| string/indexOf | 3.16x slower | 1.55x faster | 1.13x faster |
| string/includes | 6.25x slower | 1.35x faster | 1.12x faster |
| string/split | 18.35x slower | 6.15x slower | — |
| string/replace | 6.65x slower | 2.95x slower | — |
| string/case-convert | 9.63x slower | 4.14x slower | — |
| string/substring | 2.64x faster | 3.06x faster | — |
| string/trim | 19.56x slower | 13.75x slower | — |
| string/startsWith-endsWith | 6.22x slower | 6.13x slower | 1.35x slower |
| array/push-pop | 2.75x faster | 2.78x faster | — |
| array/sort-i32 | 2.83x faster | 2.80x faster | — |
| array/map-filter | 2.08x faster | 2.08x faster | — |
| array/reduce | 3.99x faster | 4.01x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.14x faster | 2.13x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.29x faster | 3.29x faster | — |
| array/find | 18.49x faster | 18.26x faster | 4.44x slower |
| dom/create-elements | 4.20x slower | — | — |
| dom/set-attributes | 2.14x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.85x slower | — | — |
| mixed/csv-parse | 17.64x slower | 1.21x slower | — |
| mixed/text-search | 10.98x slower | 6.23x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 361.94x slower | 377.00x slower | 3.88x slower |
| mixed/sieve | 1.29x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.39x faster |
| string/indexOf | 4.91x faster |
| string/includes | 8.43x faster |
| string/split | 2.98x faster |
| string/replace | 2.26x faster |
| string/case-convert | 2.33x faster |
| string/substring | 1.16x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.56x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1132.1ms | 591.3ms | — |
| string/concat-long | 469.3ms | 675.2ms | — |
| string/indexOf | 377.1ms | 653.9ms | 539.9ms |
| string/includes | 383.9ms | 666.2ms | 557.7ms |
| string/split | 514.4ms | 693.4ms | — |
| string/replace | 495.3ms | 769.0ms | — |
| string/case-convert | 532.0ms | 609.4ms | — |
| string/substring | 394.5ms | 487.0ms | — |
| string/trim | 487.3ms | 698.0ms | — |
| string/startsWith-endsWith | 475.8ms | 698.5ms | 611.0ms |
| array/push-pop | 505.3ms | 570.5ms | — |
| array/sort-i32 | 652.7ms | 707.6ms | — |
| array/map-filter | 677.7ms | 730.5ms | — |
| array/reduce | 619.7ms | 713.6ms | — |
| array/indexOf | 577.3ms | 641.8ms | — |
| array/slice | 510.6ms | 600.9ms | — |
| array/reverse | 508.3ms | 601.5ms | — |
| array/forEach | 641.5ms | 715.0ms | — |
| array/find | 494.7ms | 596.2ms | 539.9ms |
| dom/create-elements | 428.5ms | — | — |
| dom/set-attributes | 379.9ms | — | — |
| dom/read-attributes | 381.5ms | — | — |
| dom/modify-text | 371.4ms | — | — |
| mixed/csv-parse | 529.4ms | 683.9ms | — |
| mixed/text-search | 515.4ms | 689.1ms | 598.8ms |
| mixed/fibonacci | 448.0ms | 512.6ms | 462.3ms |
| mixed/matrix-multiply | 642.2ms | 697.7ms | 518.2ms |
| mixed/sieve | 586.4ms | 686.8ms | — |
