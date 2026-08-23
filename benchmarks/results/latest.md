# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.053ms | 0.057ms | 0.071ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.007ms | FAILED | js |
| string/indexOf | 0.015ms | 0.049ms | 0.011ms | 0.027ms | gc-native |
| string/includes | 0.015ms | 0.090ms | 0.013ms | 0.018ms | gc-native |
| string/split | 0.327ms | 4.07ms | 0.393ms | FAILED | js |
| string/replace | 0.093ms | 0.224ms | 0.050ms | FAILED | gc-native |
| string/case-convert | 0.047ms | 0.171ms | 0.006ms | FAILED | gc-native |
| string/substring | 0.107ms | 0.036ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.150ms | 0.720ms | 0.155ms | FAILED | js |
| string/startsWith-endsWith | 0.451ms | 0.316ms | 0.247ms | 0.535ms | gc-native |
| array/push-pop | 1.45ms | 0.472ms | 0.501ms | FAILED | host-call |
| array/sort-i32 | 0.612ms | 0.320ms | 0.322ms | FAILED | host-call |
| array/map-filter | 0.142ms | 0.077ms | 0.077ms | FAILED | host-call |
| array/reduce | 1.99ms | 0.465ms | 0.462ms | FAILED | gc-native |
| array/indexOf | 5.10ms | 2.47ms | 2.50ms | FAILED | host-call |
| array/slice | 0.040ms | 0.038ms | 0.041ms | FAILED | host-call |
| array/reverse | 7.96ms | 3.60ms | 3.60ms | FAILED | gc-native |
| array/forEach | 0.085ms | 0.024ms | 0.026ms | FAILED | host-call |
| array/find | 0.279ms | 0.016ms | 0.017ms | 0.945ms | host-call |
| dom/create-elements | 0.066ms | FAILED | — | — | js |
| dom/set-attributes | 0.127ms | FAILED | — | — | js |
| dom/read-attributes | 0.072ms | FAILED | — | — | js |
| dom/modify-text | 0.061ms | FAILED | — | — | js |
| mixed/csv-parse | 0.393ms | 5.90ms | 0.297ms | FAILED | gc-native |
| mixed/text-search | 0.409ms | 1.19ms | 0.247ms | 1.04ms | gc-native |
| mixed/fibonacci | 0.127ms | 0.201ms | 0.201ms | 0.189ms | js |
| mixed/matrix-multiply | 0.179ms | 0.216ms | 0.217ms | 0.680ms | js |
| mixed/sieve | 1.57ms | 1.56ms | 1.54ms | FAILED | gc-native |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 5.34 | 5.72 | 7.08 | — |
| string/concat-long | 1000 | 5.42 | 5.76 | 6.67 | — |
| string/indexOf | 1000 | 15.30 | 48.82 | 10.51 | 26.96 |
| string/includes | 1000 | 15.43 | 90.45 | 13.39 | 17.81 |
| string/split | 10000 | 32.73 | 406.87 | 39.26 | — |
| string/replace | 1000 | 93.32 | 223.74 | 50.05 | — |
| string/case-convert | 2000 | 23.73 | 85.67 | 2.81 | — |
| string/substring | 10000 | 10.66 | 3.60 | 3.06 | — |
| string/trim | 10000 | 14.98 | 71.98 | 15.48 | — |
| string/startsWith-endsWith | 20000 | 22.55 | 15.79 | 12.36 | 26.76 |
| array/map-filter | 30000 | 4.72 | 2.56 | 2.57 | — |
| array/indexOf | 1000 | 5096.24 | 2471.28 | 2500.26 | — |
| dom/create-elements | 2000 | 32.90 | — | — | — |
| dom/set-attributes | 6000 | 21.13 | — | — | — |
| dom/read-attributes | 3000 | 23.98 | — | — | — |
| dom/modify-text | 2000 | 30.59 | — | — | — |
| mixed/csv-parse | 11000 | 35.76 | 536.57 | 27.04 | — |
| mixed/text-search | 40000 | 10.23 | 29.64 | 6.18 | 26.03 |
| mixed/fibonacci | 10000 | 12.75 | 20.14 | 20.13 | 18.88 |
| mixed/matrix-multiply | 125000 | 1.43 | 1.73 | 1.73 | 5.44 |
| mixed/sieve | 200000 | 7.83 | 7.82 | 7.68 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x slower | 1.32x slower | — |
| string/concat-long | 1.06x slower | 1.23x slower | — |
| string/indexOf | 3.19x slower | 1.46x faster | 1.76x slower |
| string/includes | 5.86x slower | 1.15x faster | 1.15x slower |
| string/split | 12.43x slower | 1.20x slower | — |
| string/replace | 2.40x slower | 1.86x faster | — |
| string/case-convert | 3.61x slower | 8.45x faster | — |
| string/substring | 2.96x faster | 3.49x faster | — |
| string/trim | 4.80x slower | 1.03x slower | — |
| string/startsWith-endsWith | 1.43x faster | 1.82x faster | 1.19x slower |
| array/push-pop | 3.07x faster | 2.89x faster | — |
| array/sort-i32 | 1.91x faster | 1.90x faster | — |
| array/map-filter | 1.84x faster | 1.84x faster | — |
| array/reduce | 4.27x faster | 4.30x faster | — |
| array/indexOf | 2.06x faster | 2.04x faster | — |
| array/slice | 1.05x faster | 1.02x slower | — |
| array/reverse | 2.21x faster | 2.21x faster | — |
| array/forEach | 3.47x faster | 3.25x faster | — |
| array/find | 17.18x faster | 16.82x faster | 3.38x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 15.01x slower | 1.32x faster | — |
| mixed/text-search | 2.90x slower | 1.65x faster | 2.54x slower |
| mixed/fibonacci | 1.58x slower | 1.58x slower | 1.48x slower |
| mixed/matrix-multiply | 1.21x slower | 1.21x slower | 3.80x slower |
| mixed/sieve | 1.00x faster | 1.02x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.24x slower |
| string/concat-long | 1.16x slower |
| string/indexOf | 4.64x faster |
| string/includes | 6.76x faster |
| string/split | 10.36x faster |
| string/replace | 4.47x faster |
| string/case-convert | 30.51x faster |
| string/substring | 1.18x faster |
| string/trim | 4.65x faster |
| string/startsWith-endsWith | 1.28x faster |
| array/push-pop | 1.06x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.01x slower |
| array/slice | 1.06x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.07x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 19.84x faster |
| mixed/text-search | 4.79x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1205.5ms | 996.1ms | — |
| string/concat-long | 587.5ms | 893.1ms | — |
| string/indexOf | 610.9ms | 885.7ms | 757.2ms |
| string/includes | 583.9ms | 877.6ms | 788.0ms |
| string/split | 717.0ms | 933.4ms | — |
| string/replace | 698.9ms | 938.6ms | — |
| string/case-convert | 689.5ms | 780.7ms | — |
| string/substring | 629.3ms | 674.9ms | — |
| string/trim | 696.1ms | 928.3ms | — |
| string/startsWith-endsWith | 731.3ms | 889.9ms | 830.1ms |
| array/push-pop | 717.5ms | 772.0ms | — |
| array/sort-i32 | 868.9ms | 901.2ms | — |
| array/map-filter | 851.9ms | 933.0ms | — |
| array/reduce | 782.3ms | 860.0ms | — |
| array/indexOf | 773.0ms | 818.8ms | — |
| array/slice | 703.9ms | 777.2ms | — |
| array/reverse | 701.1ms | 760.8ms | — |
| array/forEach | 817.2ms | 904.4ms | — |
| array/find | 691.9ms | 795.8ms | 770.1ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 748.6ms | 883.9ms | — |
| mixed/text-search | 677.6ms | 951.9ms | 848.8ms |
| mixed/fibonacci | 714.7ms | 749.8ms | 718.0ms |
| mixed/matrix-multiply | 824.6ms | 859.8ms | 745.5ms |
| mixed/sieve | 805.9ms | 872.3ms | — |
