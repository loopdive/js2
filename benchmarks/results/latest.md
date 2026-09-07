# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.052ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.040ms | gc-native |
| string/includes | 0.019ms | 0.121ms | 0.014ms | 0.021ms | gc-native |
| string/split | 0.425ms | 8.04ms | 2.63ms | FAILED | js |
| string/replace | 0.097ms | 0.581ms | 0.278ms | FAILED | js |
| string/case-convert | 0.058ms | 0.558ms | 0.234ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.10ms | 2.33ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 2.44ms | 2.47ms | 0.560ms | js |
| array/push-pop | 1.66ms | 0.603ms | 0.611ms | FAILED | host-call |
| array/sort-i32 | 0.842ms | 0.550ms | 0.302ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.066ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.59ms | 0.591ms | 0.603ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.017ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.092ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | gc-native |
| dom/create-elements | 0.038ms | 0.154ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.546ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.133ms | — | — | js |
| dom/modify-text | 0.029ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.466ms | 8.42ms | 0.550ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.34ms | 2.41ms | 1.12ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.328ms | 1.41ms | js |
| mixed/matrix-multiply | 0.187ms | 63.29ms | 65.66ms | 0.717ms | js |
| mixed/sieve | 1.73ms | 2.29ms | 2.29ms | FAILED | js |

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
| string/concat-short | 10000 | 3.00 | 5.18 | 4.92 | — |
| string/concat-long | 1000 | 4.31 | 5.31 | 3.61 | — |
| string/indexOf | 1000 | 18.96 | 60.41 | 12.22 | 39.59 |
| string/includes | 1000 | 18.70 | 120.58 | 13.77 | 21.05 |
| string/split | 10000 | 42.51 | 803.51 | 262.62 | — |
| string/replace | 1000 | 96.97 | 581.05 | 277.81 | — |
| string/case-convert | 2000 | 28.91 | 279.06 | 116.80 | — |
| string/substring | 10000 | 10.39 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.30 | 309.99 | 232.72 | — |
| string/startsWith-endsWith | 20000 | 20.60 | 122.11 | 123.51 | 28.00 |
| array/map-filter | 30000 | 4.47 | 2.19 | 2.18 | — |
| array/indexOf | 1000 | 4459.52 | 2862.76 | 2859.93 | — |
| dom/create-elements | 2000 | 18.94 | 76.76 | — | — |
| dom/set-attributes | 6000 | 17.96 | 91.03 | — | — |
| dom/read-attributes | 3000 | 19.42 | 44.28 | — | — |
| dom/modify-text | 2000 | 14.71 | 56.29 | — | — |
| mixed/csv-parse | 11000 | 42.33 | 765.43 | 50.01 | — |
| mixed/text-search | 40000 | 10.07 | 108.56 | 60.20 | 28.05 |
| mixed/fibonacci | 10000 | 12.52 | 32.74 | 32.76 | 140.69 |
| mixed/matrix-multiply | 125000 | 1.50 | 506.32 | 525.27 | 5.74 |
| mixed/sieve | 200000 | 8.66 | 11.46 | 11.47 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.73x slower | 1.64x slower | — |
| string/concat-long | 1.23x slower | 1.19x faster | — |
| string/indexOf | 3.19x slower | 1.55x faster | 2.09x slower |
| string/includes | 6.45x slower | 1.36x faster | 1.13x slower |
| string/split | 18.90x slower | 6.18x slower | — |
| string/replace | 5.99x slower | 2.86x slower | — |
| string/case-convert | 9.65x slower | 4.04x slower | — |
| string/substring | 2.61x faster | 3.02x faster | — |
| string/trim | 17.92x slower | 13.45x slower | — |
| string/startsWith-endsWith | 5.93x slower | 6.00x slower | 1.36x slower |
| array/push-pop | 2.76x faster | 2.73x faster | — |
| array/sort-i32 | 1.53x faster | 2.79x faster | — |
| array/map-filter | 2.05x faster | 2.06x faster | — |
| array/reduce | 2.69x faster | 2.64x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.04x faster | 2.09x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.24x faster | 3.24x faster | — |
| array/find | 18.44x faster | 18.52x faster | 4.45x slower |
| dom/create-elements | 4.05x slower | — | — |
| dom/set-attributes | 5.07x slower | — | — |
| dom/read-attributes | 2.28x slower | — | — |
| dom/modify-text | 3.83x slower | — | — |
| mixed/csv-parse | 18.08x slower | 1.18x slower | — |
| mixed/text-search | 10.78x slower | 5.98x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 11.23x slower |
| mixed/matrix-multiply | 338.60x slower | 351.28x slower | 3.84x slower |
| mixed/sieve | 1.32x slower | 1.32x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x faster |
| string/concat-long | 1.47x faster |
| string/indexOf | 4.94x faster |
| string/includes | 8.76x faster |
| string/split | 3.06x faster |
| string/replace | 2.09x faster |
| string/case-convert | 2.39x faster |
| string/substring | 1.16x faster |
| string/trim | 1.33x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.82x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 15.30x faster |
| mixed/text-search | 1.80x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.00x slower |

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
| string/concat-short | 1638.0ms | 1004.6ms | — |
| string/concat-long | 739.3ms | 955.8ms | — |
| string/indexOf | 672.5ms | 943.0ms | 821.1ms |
| string/includes | 640.8ms | 917.5ms | 800.2ms |
| string/split | 742.7ms | 931.6ms | — |
| string/replace | 760.0ms | 1024.6ms | — |
| string/case-convert | 764.7ms | 919.5ms | — |
| string/substring | 645.0ms | 757.0ms | — |
| string/trim | 739.8ms | 967.6ms | — |
| string/startsWith-endsWith | 760.2ms | 978.9ms | 900.3ms |
| array/push-pop | 776.0ms | 845.7ms | — |
| array/sort-i32 | 905.4ms | 966.8ms | — |
| array/map-filter | 932.6ms | 1012.8ms | — |
| array/reduce | 857.6ms | 930.7ms | — |
| array/indexOf | 848.4ms | 915.8ms | — |
| array/slice | 771.5ms | 846.2ms | — |
| array/reverse | 755.6ms | 825.8ms | — |
| array/forEach | 863.2ms | 962.5ms | — |
| array/find | 752.4ms | 798.8ms | 771.0ms |
| dom/create-elements | 657.3ms | — | — |
| dom/set-attributes | 702.5ms | — | — |
| dom/read-attributes | 680.9ms | — | — |
| dom/modify-text | 669.2ms | — | — |
| mixed/csv-parse | 772.2ms | 922.8ms | — |
| mixed/text-search | 763.3ms | 941.6ms | 882.2ms |
| mixed/fibonacci | 727.6ms | 769.3ms | 738.6ms |
| mixed/matrix-multiply | 882.9ms | 941.4ms | 778.0ms |
| mixed/sieve | 838.4ms | 912.5ms | — |
