# js2wasm Benchmark Results

Date: 2026-09-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.047ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.013ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.116ms | 0.015ms | 0.016ms | gc-native |
| string/split | 0.412ms | 7.96ms | 2.93ms | FAILED | js |
| string/replace | 0.105ms | 0.678ms | 0.336ms | FAILED | js |
| string/case-convert | 0.059ms | 0.578ms | 0.281ms | FAILED | js |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.10ms | 2.83ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.92ms | 3.09ms | 0.560ms | js |
| array/push-pop | 1.40ms | 0.502ms | 0.505ms | FAILED | host-call |
| array/sort-i32 | 0.799ms | 0.292ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.15ms | 0.509ms | 0.507ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.262ms | 0.016ms | 0.015ms | 1.08ms | gc-native |
| dom/create-elements | 0.034ms | 0.175ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.123ms | — | — | js |
| dom/modify-text | 0.030ms | 0.105ms | — | — | js |
| mixed/csv-parse | 0.996ms | 8.21ms | 0.650ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 5.13ms | 2.87ms | 1.09ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.156ms | 73.34ms | 79.16ms | 0.719ms | js |
| mixed/sieve | 1.55ms | 2.10ms | 2.10ms | FAILED | js |

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
| string/concat-short | 10000 | 3.09 | 4.68 | 4.09 | — |
| string/concat-long | 1000 | 3.69 | 4.76 | 3.55 | — |
| string/indexOf | 1000 | 19.16 | 63.67 | 12.57 | 21.84 |
| string/includes | 1000 | 19.20 | 115.66 | 14.70 | 15.86 |
| string/split | 10000 | 41.21 | 795.98 | 293.40 | — |
| string/replace | 1000 | 105.46 | 677.70 | 335.70 | — |
| string/case-convert | 2000 | 29.61 | 288.81 | 140.60 | — |
| string/substring | 10000 | 9.82 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.97 | 409.59 | 283.00 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 146.07 | 154.47 | 28.01 |
| array/map-filter | 30000 | 4.28 | 2.34 | 2.32 | — |
| array/indexOf | 1000 | 3963.48 | 2640.97 | 2638.99 | — |
| dom/create-elements | 2000 | 16.95 | 87.53 | — | — |
| dom/set-attributes | 6000 | 17.23 | 36.13 | — | — |
| dom/read-attributes | 3000 | 18.54 | 41.11 | — | — |
| dom/modify-text | 2000 | 14.81 | 52.74 | — | — |
| mixed/csv-parse | 11000 | 90.57 | 746.36 | 59.06 | — |
| mixed/text-search | 40000 | 9.74 | 128.24 | 71.68 | 27.21 |
| mixed/fibonacci | 10000 | 12.17 | 28.29 | 28.30 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.25 | 586.76 | 633.32 | 5.75 |
| mixed/sieve | 200000 | 7.75 | 10.50 | 10.51 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.51x slower | 1.32x slower | — |
| string/concat-long | 1.29x slower | 1.04x faster | — |
| string/indexOf | 3.32x slower | 1.52x faster | 1.14x slower |
| string/includes | 6.03x slower | 1.31x faster | 1.21x faster |
| string/split | 19.31x slower | 7.12x slower | — |
| string/replace | 6.43x slower | 3.18x slower | — |
| string/case-convert | 9.75x slower | 4.75x slower | — |
| string/substring | 2.63x faster | 3.19x faster | — |
| string/trim | 24.14x slower | 16.68x slower | — |
| string/startsWith-endsWith | 7.28x slower | 7.69x slower | 1.40x slower |
| array/push-pop | 2.80x faster | 2.78x faster | — |
| array/sort-i32 | 2.73x faster | 2.73x faster | — |
| array/map-filter | 1.83x faster | 1.84x faster | — |
| array/reduce | 4.22x faster | 4.23x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.72x faster | — |
| array/find | 16.67x faster | 16.90x faster | 4.11x slower |
| dom/create-elements | 5.16x slower | — | — |
| dom/set-attributes | 2.10x slower | — | — |
| dom/read-attributes | 2.22x slower | — | — |
| dom/modify-text | 3.56x slower | — | — |
| mixed/csv-parse | 8.24x slower | 1.53x faster | — |
| mixed/text-search | 13.16x slower | 7.36x slower | 2.79x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.31x slower |
| mixed/matrix-multiply | 469.01x slower | 506.23x slower | 4.60x slower |
| mixed/sieve | 1.35x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.34x faster |
| string/indexOf | 5.06x faster |
| string/includes | 7.87x faster |
| string/split | 2.71x faster |
| string/replace | 2.02x faster |
| string/case-convert | 2.05x faster |
| string/substring | 1.22x faster |
| string/trim | 1.45x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 12.64x faster |
| mixed/text-search | 1.79x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.00x slower |

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
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1123.6ms | 618.7ms | — |
| string/concat-long | 432.7ms | 668.2ms | — |
| string/indexOf | 376.8ms | 667.7ms | 524.1ms |
| string/includes | 375.3ms | 683.4ms | 542.7ms |
| string/split | 502.7ms | 685.9ms | — |
| string/replace | 509.9ms | 754.8ms | — |
| string/case-convert | 519.1ms | 609.3ms | — |
| string/substring | 375.9ms | 445.0ms | — |
| string/trim | 481.1ms | 739.8ms | — |
| string/startsWith-endsWith | 479.0ms | 689.9ms | 630.7ms |
| array/push-pop | 498.5ms | 576.5ms | — |
| array/sort-i32 | 668.0ms | 709.7ms | — |
| array/map-filter | 697.3ms | 767.0ms | — |
| array/reduce | 606.9ms | 673.8ms | — |
| array/indexOf | 589.1ms | 692.8ms | — |
| array/slice | 501.1ms | 610.6ms | — |
| array/reverse | 486.9ms | 575.3ms | — |
| array/forEach | 632.4ms | 728.8ms | — |
| array/find | 502.9ms | 578.4ms | 545.7ms |
| dom/create-elements | 409.7ms | — | — |
| dom/set-attributes | 378.3ms | — | — |
| dom/read-attributes | 381.5ms | — | — |
| dom/modify-text | 371.2ms | — | — |
| mixed/csv-parse | 513.8ms | 691.6ms | — |
| mixed/text-search | 493.2ms | 706.3ms | 626.4ms |
| mixed/fibonacci | 466.3ms | 515.2ms | 471.7ms |
| mixed/matrix-multiply | 635.5ms | 721.1ms | 516.3ms |
| mixed/sieve | 584.8ms | 664.7ms | — |
