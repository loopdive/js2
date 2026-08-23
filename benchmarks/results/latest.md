# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.022ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.427ms | 4.74ms | 0.506ms | FAILED | js |
| string/replace | 0.096ms | 0.231ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.223ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.931ms | 0.198ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.335ms | 0.308ms | 0.553ms | gc-native |
| array/push-pop | 1.66ms | 0.609ms | 0.604ms | FAILED | gc-native |
| array/sort-i32 | 0.849ms | 0.297ms | 0.298ms | FAILED | host-call |
| array/map-filter | 0.137ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 1.62ms | 0.611ms | 0.605ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.038ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.98ms | 3.98ms | FAILED | gc-native |
| array/forEach | 0.095ms | 0.029ms | 0.029ms | FAILED | host-call |
| array/find | 0.273ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.039ms | FAILED | — | — | js |
| dom/set-attributes | 0.110ms | FAILED | — | — | js |
| dom/read-attributes | 0.059ms | FAILED | — | — | js |
| dom/modify-text | 0.030ms | FAILED | — | — | js |
| mixed/csv-parse | 0.471ms | 7.03ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.39ms | 0.292ms | 1.14ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.315ms | 0.315ms | 0.310ms | js |
| mixed/matrix-multiply | 0.187ms | 0.212ms | 0.212ms | 0.723ms | js |
| mixed/sieve | 1.79ms | 1.49ms | 1.53ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.42 | 4.85 | 4.23 | — |
| string/concat-long | 1000 | 4.34 | 5.44 | 3.70 | — |
| string/indexOf | 1000 | 19.02 | 59.80 | 12.26 | 22.49 |
| string/includes | 1000 | 18.74 | 119.88 | 13.85 | 16.62 |
| string/split | 10000 | 42.68 | 474.04 | 50.61 | — |
| string/replace | 1000 | 96.45 | 230.80 | 59.51 | — |
| string/case-convert | 2000 | 29.18 | 111.35 | 2.62 | — |
| string/substring | 10000 | 10.42 | 4.00 | 3.44 | — |
| string/trim | 10000 | 17.30 | 93.14 | 19.79 | — |
| string/startsWith-endsWith | 20000 | 20.62 | 16.75 | 15.39 | 27.67 |
| array/map-filter | 30000 | 4.56 | 2.20 | 2.20 | — |
| array/indexOf | 1000 | 4461.60 | 2862.10 | 2861.19 | — |
| dom/create-elements | 2000 | 19.55 | — | — | — |
| dom/set-attributes | 6000 | 18.37 | — | — | — |
| dom/read-attributes | 3000 | 19.51 | — | — | — |
| dom/modify-text | 2000 | 14.99 | — | — | — |
| mixed/csv-parse | 11000 | 42.84 | 638.70 | 27.87 | — |
| mixed/text-search | 40000 | 10.07 | 34.83 | 7.31 | 28.56 |
| mixed/fibonacci | 10000 | 12.53 | 31.51 | 31.49 | 30.99 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.70 | 1.70 | 5.78 |
| mixed/sieve | 200000 | 8.93 | 7.43 | 7.66 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.23x slower | — |
| string/concat-long | 1.25x slower | 1.17x faster | — |
| string/indexOf | 3.14x slower | 1.55x faster | 1.18x slower |
| string/includes | 6.40x slower | 1.35x faster | 1.13x faster |
| string/split | 11.11x slower | 1.19x slower | — |
| string/replace | 2.39x slower | 1.62x faster | — |
| string/case-convert | 3.82x slower | 11.14x faster | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 5.39x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.73x faster | 2.76x faster | — |
| array/sort-i32 | 2.86x faster | 2.84x faster | — |
| array/map-filter | 2.07x faster | 2.07x faster | — |
| array/reduce | 2.65x faster | 2.67x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.24x faster | 2.17x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.29x faster | 3.28x faster | — |
| array/find | 18.32x faster | 18.29x faster | 4.42x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 14.91x slower | 1.54x faster | — |
| mixed/text-search | 3.46x slower | 1.38x faster | 2.84x slower |
| mixed/fibonacci | 2.51x slower | 2.51x slower | 2.47x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.87x slower |
| mixed/sieve | 1.20x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.47x faster |
| string/indexOf | 4.88x faster |
| string/includes | 8.66x faster |
| string/split | 9.37x faster |
| string/replace | 3.88x faster |
| string/case-convert | 42.50x faster |
| string/substring | 1.16x faster |
| string/trim | 4.71x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 22.92x faster |
| mixed/text-search | 4.77x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.03x slower |

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
| string/concat-short | 1265.9ms | 1054.6ms | — |
| string/concat-long | 633.5ms | 968.0ms | — |
| string/indexOf | 657.7ms | 943.6ms | 819.4ms |
| string/includes | 642.0ms | 998.6ms | 859.9ms |
| string/split | 765.3ms | 945.2ms | — |
| string/replace | 757.4ms | 1015.3ms | — |
| string/case-convert | 789.3ms | 887.5ms | — |
| string/substring | 661.5ms | 783.4ms | — |
| string/trim | 757.3ms | 927.4ms | — |
| string/startsWith-endsWith | 751.0ms | 948.4ms | 874.4ms |
| array/push-pop | 768.9ms | 821.5ms | — |
| array/sort-i32 | 895.0ms | 950.0ms | — |
| array/map-filter | 904.9ms | 1011.5ms | — |
| array/reduce | 870.7ms | 940.5ms | — |
| array/indexOf | 832.7ms | 927.8ms | — |
| array/slice | 760.6ms | 874.9ms | — |
| array/reverse | 785.9ms | 827.9ms | — |
| array/forEach | 883.4ms | 974.8ms | — |
| array/find | 738.5ms | 834.4ms | 844.5ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 783.6ms | 933.0ms | — |
| mixed/text-search | 775.9ms | 964.4ms | 901.6ms |
| mixed/fibonacci | 766.8ms | 791.7ms | 804.9ms |
| mixed/matrix-multiply | 842.7ms | 932.9ms | 793.9ms |
| mixed/sieve | 880.3ms | 900.1ms | — |
