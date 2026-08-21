# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.044ms | 0.037ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.129ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.415ms | 4.80ms | 0.449ms | FAILED | js |
| string/replace | 0.110ms | 0.301ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.237ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.967ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.295ms | 0.562ms | gc-native |
| array/push-pop | 1.39ms | 0.505ms | 0.499ms | FAILED | gc-native |
| array/sort-i32 | 0.794ms | 0.292ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.124ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 1.35ms | 0.504ms | 0.503ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.82ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.027ms | FAILED | gc-native |
| array/find | 0.252ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.034ms | 0.156ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.516ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.124ms | — | — | js |
| dom/modify-text | 0.028ms | 0.104ms | — | — | js |
| mixed/csv-parse | 0.486ms | 7.15ms | 0.316ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.66ms | 0.267ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.294ms | js |
| mixed/matrix-multiply | 0.157ms | 0.209ms | 0.210ms | 0.715ms | js |
| mixed/sieve | 1.55ms | 1.41ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.37 | 4.44 | 3.65 | — |
| string/concat-long | 1000 | 3.44 | 4.45 | 3.55 | — |
| string/indexOf | 1000 | 19.13 | 63.11 | 12.21 | 15.65 |
| string/includes | 1000 | 19.17 | 128.60 | 14.73 | 70.56 |
| string/split | 10000 | 41.50 | 480.00 | 44.86 | — |
| string/replace | 1000 | 110.06 | 301.47 | 56.24 | — |
| string/case-convert | 2000 | 27.92 | 118.53 | 2.51 | — |
| string/substring | 10000 | 9.85 | 3.74 | 3.11 | — |
| string/trim | 10000 | 16.98 | 96.70 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 17.84 | 14.77 | 28.08 |
| array/map-filter | 30000 | 4.14 | 2.33 | 2.32 | — |
| array/indexOf | 1000 | 3948.32 | 2635.73 | 2632.52 | — |
| dom/create-elements | 2000 | 16.93 | 78.14 | — | — |
| dom/set-attributes | 6000 | 17.18 | 85.97 | — | — |
| dom/read-attributes | 3000 | 18.75 | 41.20 | — | — |
| dom/modify-text | 2000 | 14.17 | 52.17 | — | — |
| mixed/csv-parse | 11000 | 44.18 | 649.73 | 28.71 | — |
| mixed/text-search | 40000 | 9.74 | 41.61 | 6.67 | 27.21 |
| mixed/fibonacci | 10000 | 12.17 | 29.21 | 29.18 | 29.41 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.68 | 1.68 | 5.72 |
| mixed/sieve | 200000 | 7.77 | 7.03 | 6.98 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.32x slower | 1.08x slower | — |
| string/concat-long | 1.29x slower | 1.03x slower | — |
| string/indexOf | 3.30x slower | 1.57x faster | 1.22x faster |
| string/includes | 6.71x slower | 1.30x faster | 3.68x slower |
| string/split | 11.57x slower | 1.08x slower | — |
| string/replace | 2.74x slower | 1.96x faster | — |
| string/case-convert | 4.25x slower | 11.13x faster | — |
| string/substring | 2.63x faster | 3.17x faster | — |
| string/trim | 5.70x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.36x faster | 1.40x slower |
| array/push-pop | 2.76x faster | 2.79x faster | — |
| array/sort-i32 | 2.72x faster | 2.71x faster | — |
| array/map-filter | 1.78x faster | 1.79x faster | — |
| array/reduce | 2.68x faster | 2.68x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.74x faster | — |
| array/find | 16.27x faster | 16.05x faster | 4.24x slower |
| dom/create-elements | 4.61x slower | — | — |
| dom/set-attributes | 5.00x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.68x slower | — | — |
| mixed/csv-parse | 14.71x slower | 1.54x faster | — |
| mixed/text-search | 4.27x slower | 1.46x faster | 2.79x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.42x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.56x slower |
| mixed/sieve | 1.10x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.17x faster |
| string/includes | 8.73x faster |
| string/split | 10.70x faster |
| string/replace | 5.36x faster |
| string/case-convert | 47.27x faster |
| string/substring | 1.20x faster |
| string/trim | 5.19x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.63x faster |
| mixed/text-search | 6.24x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.0KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1297.1ms | 1068.8ms | — |
| string/concat-long | 638.0ms | 957.0ms | — |
| string/indexOf | 657.1ms | 943.7ms | 825.9ms |
| string/includes | 628.2ms | 955.3ms | 839.7ms |
| string/split | 804.9ms | 961.9ms | — |
| string/replace | 759.6ms | 1017.7ms | — |
| string/case-convert | 790.3ms | 830.7ms | — |
| string/substring | 631.3ms | 707.7ms | — |
| string/trim | 724.8ms | 952.1ms | — |
| string/startsWith-endsWith | 768.0ms | 978.8ms | 879.7ms |
| array/push-pop | 762.2ms | 851.8ms | — |
| array/sort-i32 | 890.6ms | 969.3ms | — |
| array/map-filter | 896.5ms | 1009.6ms | — |
| array/reduce | 846.0ms | 916.8ms | — |
| array/indexOf | 843.5ms | 915.9ms | — |
| array/slice | 753.6ms | 866.4ms | — |
| array/reverse | 749.8ms | 833.2ms | — |
| array/forEach | 844.3ms | 985.4ms | — |
| array/find | 765.0ms | 801.8ms | 826.2ms |
| dom/create-elements | 633.4ms | — | — |
| dom/set-attributes | 702.7ms | — | — |
| dom/read-attributes | 672.5ms | — | — |
| dom/modify-text | 588.2ms | — | — |
| mixed/csv-parse | 778.9ms | 929.1ms | — |
| mixed/text-search | 748.5ms | 985.2ms | 880.9ms |
| mixed/fibonacci | 750.8ms | 834.8ms | 765.9ms |
| mixed/matrix-multiply | 858.1ms | 926.3ms | 798.2ms |
| mixed/sieve | 825.7ms | 913.0ms | — |
