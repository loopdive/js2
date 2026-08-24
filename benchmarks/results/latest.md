# js2wasm Benchmark Results

Date: 2026-08-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.047ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.025ms | gc-native |
| string/includes | 0.019ms | 0.105ms | 0.014ms | 0.026ms | gc-native |
| string/split | 0.425ms | 4.60ms | 0.508ms | FAILED | js |
| string/replace | 0.109ms | 0.220ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.226ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.935ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.336ms | 0.308ms | 0.568ms | gc-native |
| array/push-pop | 1.63ms | 0.602ms | 0.601ms | FAILED | gc-native |
| array/sort-i32 | 0.844ms | 0.299ms | 0.547ms | FAILED | host-call |
| array/map-filter | 0.137ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 2.42ms | 0.605ms | 0.604ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.20ms | host-call |
| dom/create-elements | 0.039ms | FAILED | — | — | js |
| dom/set-attributes | 0.108ms | FAILED | — | — | js |
| dom/read-attributes | 0.060ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | FAILED | — | — | js |
| mixed/csv-parse | 0.470ms | 7.55ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.30ms | 0.293ms | 1.11ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.305ms | 0.315ms | 0.313ms | js |
| mixed/matrix-multiply | 0.185ms | 0.212ms | 0.212ms | 0.721ms | js |
| mixed/sieve | 1.77ms | 1.49ms | 1.51ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.34 | 4.73 | 4.24 | — |
| string/concat-long | 1000 | 4.13 | 5.08 | 3.46 | — |
| string/indexOf | 1000 | 18.99 | 59.67 | 12.23 | 24.88 |
| string/includes | 1000 | 18.71 | 105.32 | 13.78 | 25.75 |
| string/split | 10000 | 42.48 | 459.58 | 50.78 | — |
| string/replace | 1000 | 108.97 | 220.02 | 59.65 | — |
| string/case-convert | 2000 | 29.21 | 112.98 | 2.61 | — |
| string/substring | 10000 | 10.42 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.31 | 93.53 | 19.69 | — |
| string/startsWith-endsWith | 20000 | 20.66 | 16.80 | 15.42 | 28.38 |
| array/map-filter | 30000 | 4.55 | 2.19 | 2.19 | — |
| array/indexOf | 1000 | 4462.08 | 2860.56 | 2858.90 | — |
| dom/create-elements | 2000 | 19.41 | — | — | — |
| dom/set-attributes | 6000 | 17.97 | — | — | — |
| dom/read-attributes | 3000 | 20.12 | — | — | — |
| dom/modify-text | 2000 | 14.63 | — | — | — |
| mixed/csv-parse | 11000 | 42.77 | 686.12 | 27.94 | — |
| mixed/text-search | 40000 | 10.06 | 32.55 | 7.33 | 27.77 |
| mixed/fibonacci | 10000 | 12.53 | 30.50 | 31.48 | 31.29 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.70 | 1.69 | 5.76 |
| mixed/sieve | 200000 | 8.85 | 7.45 | 7.55 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.27x slower | — |
| string/concat-long | 1.23x slower | 1.20x faster | — |
| string/indexOf | 3.14x slower | 1.55x faster | 1.31x slower |
| string/includes | 5.63x slower | 1.36x faster | 1.38x slower |
| string/split | 10.82x slower | 1.20x slower | — |
| string/replace | 2.02x slower | 1.83x faster | — |
| string/case-convert | 3.87x slower | 11.18x faster | — |
| string/substring | 2.62x faster | 3.03x faster | — |
| string/trim | 5.40x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.34x faster | 1.37x slower |
| array/push-pop | 2.70x faster | 2.71x faster | — |
| array/sort-i32 | 2.83x faster | 1.54x faster | — |
| array/map-filter | 2.08x faster | 2.08x faster | — |
| array/reduce | 4.00x faster | 4.00x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.11x faster | 2.10x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.84x faster | — |
| array/find | 18.42x faster | 18.28x faster | 4.44x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 16.04x slower | 1.53x faster | — |
| mixed/text-search | 3.23x slower | 1.37x faster | 2.76x slower |
| mixed/fibonacci | 2.44x slower | 2.51x slower | 2.50x slower |
| mixed/matrix-multiply | 1.15x slower | 1.14x slower | 3.90x slower |
| mixed/sieve | 1.19x faster | 1.17x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.11x faster |
| string/concat-long | 1.47x faster |
| string/indexOf | 4.88x faster |
| string/includes | 7.64x faster |
| string/split | 9.05x faster |
| string/replace | 3.69x faster |
| string/case-convert | 43.23x faster |
| string/substring | 1.16x faster |
| string/trim | 4.75x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.83x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 24.55x faster |
| mixed/text-search | 4.44x faster |
| mixed/fibonacci | 1.03x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1225.2ms | 1045.1ms | — |
| string/concat-long | 631.5ms | 965.4ms | — |
| string/indexOf | 665.8ms | 953.1ms | 839.0ms |
| string/includes | 650.8ms | 961.2ms | 877.9ms |
| string/split | 766.5ms | 954.6ms | — |
| string/replace | 788.9ms | 1016.6ms | — |
| string/case-convert | 766.3ms | 860.6ms | — |
| string/substring | 651.8ms | 743.1ms | — |
| string/trim | 760.1ms | 986.2ms | — |
| string/startsWith-endsWith | 752.0ms | 1003.4ms | 920.6ms |
| array/push-pop | 793.9ms | 823.6ms | — |
| array/sort-i32 | 930.7ms | 985.2ms | — |
| array/map-filter | 915.3ms | 1003.3ms | — |
| array/reduce | 824.9ms | 955.5ms | — |
| array/indexOf | 818.8ms | 919.5ms | — |
| array/slice | 744.7ms | 818.3ms | — |
| array/reverse | 748.2ms | 834.8ms | — |
| array/forEach | 864.5ms | 990.4ms | — |
| array/find | 761.0ms | 815.2ms | 836.6ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 818.6ms | 925.0ms | — |
| mixed/text-search | 779.5ms | 972.2ms | 937.6ms |
| mixed/fibonacci | 757.3ms | 840.0ms | 792.6ms |
| mixed/matrix-multiply | 836.5ms | 955.8ms | 777.6ms |
| mixed/sieve | 842.2ms | 930.2ms | — |
