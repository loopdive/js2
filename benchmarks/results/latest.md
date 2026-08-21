# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.024ms | gc-native |
| string/includes | 0.019ms | 0.120ms | 0.014ms | 0.066ms | gc-native |
| string/split | 0.413ms | 4.52ms | 0.505ms | FAILED | js |
| string/replace | 0.098ms | 0.239ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.224ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.172ms | 0.941ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.340ms | 0.308ms | 0.558ms | gc-native |
| array/push-pop | 1.64ms | 0.589ms | 0.602ms | FAILED | host-call |
| array/sort-i32 | 0.844ms | 0.303ms | 0.296ms | FAILED | gc-native |
| array/map-filter | 0.133ms | 0.065ms | 0.065ms | FAILED | host-call |
| array/reduce | 2.37ms | 0.597ms | 0.589ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.016ms | 0.016ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.029ms | 0.028ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.12ms | host-call |
| dom/create-elements | 0.056ms | 0.177ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.558ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.135ms | — | — | js |
| dom/modify-text | 0.031ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.469ms | 6.75ms | 0.307ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.36ms | 0.292ms | 1.14ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.306ms | 0.315ms | 0.313ms | js |
| mixed/matrix-multiply | 0.184ms | 0.209ms | 0.209ms | 0.723ms | js |
| mixed/sieve | 1.74ms | 1.50ms | 1.47ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.30 | 4.95 | 4.24 | — |
| string/concat-long | 1000 | 3.99 | 5.29 | 3.39 | — |
| string/indexOf | 1000 | 18.94 | 59.50 | 12.18 | 23.69 |
| string/includes | 1000 | 18.68 | 119.86 | 13.80 | 65.68 |
| string/split | 10000 | 41.27 | 451.97 | 50.52 | — |
| string/replace | 1000 | 97.74 | 238.57 | 59.83 | — |
| string/case-convert | 2000 | 28.94 | 112.17 | 2.61 | — |
| string/substring | 10000 | 10.40 | 3.99 | 3.43 | — |
| string/trim | 10000 | 17.24 | 94.08 | 19.69 | — |
| string/startsWith-endsWith | 20000 | 20.65 | 17.02 | 15.39 | 27.90 |
| array/map-filter | 30000 | 4.42 | 2.17 | 2.18 | — |
| array/indexOf | 1000 | 4456.65 | 2859.92 | 2859.47 | — |
| dom/create-elements | 2000 | 28.19 | 88.47 | — | — |
| dom/set-attributes | 6000 | 18.36 | 93.08 | — | — |
| dom/read-attributes | 3000 | 20.32 | 44.90 | — | — |
| dom/modify-text | 2000 | 15.66 | 56.64 | — | — |
| mixed/csv-parse | 11000 | 42.61 | 613.75 | 27.90 | — |
| mixed/text-search | 40000 | 10.07 | 34.03 | 7.29 | 28.48 |
| mixed/fibonacci | 10000 | 12.53 | 30.56 | 31.50 | 31.27 |
| mixed/matrix-multiply | 125000 | 1.47 | 1.67 | 1.67 | 5.78 |
| mixed/sieve | 200000 | 8.71 | 7.48 | 7.36 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.50x slower | 1.29x slower | — |
| string/concat-long | 1.33x slower | 1.18x faster | — |
| string/indexOf | 3.14x slower | 1.55x faster | 1.25x slower |
| string/includes | 6.42x slower | 1.35x faster | 3.52x slower |
| string/split | 10.95x slower | 1.22x slower | — |
| string/replace | 2.44x slower | 1.63x faster | — |
| string/case-convert | 3.88x slower | 11.07x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.46x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.21x faster | 1.34x faster | 1.35x slower |
| array/push-pop | 2.79x faster | 2.73x faster | — |
| array/sort-i32 | 2.78x faster | 2.85x faster | — |
| array/map-filter | 2.04x faster | 2.03x faster | — |
| array/reduce | 3.98x faster | 4.03x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.05x faster | 1.99x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.79x faster | 1.80x faster | — |
| array/find | 18.42x faster | 18.40x faster | 4.12x slower |
| dom/create-elements | 3.14x slower | — | — |
| dom/set-attributes | 5.07x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.62x slower | — | — |
| mixed/csv-parse | 14.40x slower | 1.53x faster | — |
| mixed/text-search | 3.38x slower | 1.38x faster | 2.83x slower |
| mixed/fibonacci | 2.44x slower | 2.51x slower | 2.50x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.93x slower |
| mixed/sieve | 1.17x faster | 1.18x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.17x faster |
| string/concat-long | 1.56x faster |
| string/indexOf | 4.88x faster |
| string/includes | 8.68x faster |
| string/split | 8.95x faster |
| string/replace | 3.99x faster |
| string/case-convert | 42.90x faster |
| string/substring | 1.16x faster |
| string/trim | 4.78x faster |
| string/startsWith-endsWith | 1.11x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 22.00x faster |
| mixed/text-search | 4.67x faster |
| mixed/fibonacci | 1.03x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1207.9ms | 1052.8ms | — |
| string/concat-long | 614.3ms | 930.9ms | — |
| string/indexOf | 635.2ms | 908.9ms | 811.1ms |
| string/includes | 632.1ms | 945.0ms | 796.4ms |
| string/split | 762.6ms | 911.3ms | — |
| string/replace | 741.0ms | 992.9ms | — |
| string/case-convert | 735.4ms | 814.7ms | — |
| string/substring | 621.2ms | 689.0ms | — |
| string/trim | 725.4ms | 932.9ms | — |
| string/startsWith-endsWith | 730.7ms | 928.9ms | 863.5ms |
| array/push-pop | 750.2ms | 805.0ms | — |
| array/sort-i32 | 867.4ms | 924.8ms | — |
| array/map-filter | 876.5ms | 973.2ms | — |
| array/reduce | 807.1ms | 917.1ms | — |
| array/indexOf | 806.2ms | 910.0ms | — |
| array/slice | 730.3ms | 818.9ms | — |
| array/reverse | 736.2ms | 816.3ms | — |
| array/forEach | 833.7ms | 915.8ms | — |
| array/find | 750.6ms | 814.7ms | 820.7ms |
| dom/create-elements | 615.7ms | — | — |
| dom/set-attributes | 689.5ms | — | — |
| dom/read-attributes | 654.8ms | — | — |
| dom/modify-text | 580.4ms | — | — |
| mixed/csv-parse | 771.0ms | 903.2ms | — |
| mixed/text-search | 755.9ms | 940.5ms | 849.7ms |
| mixed/fibonacci | 716.7ms | 755.1ms | 783.4ms |
| mixed/matrix-multiply | 801.5ms | 876.2ms | 758.6ms |
| mixed/sieve | 845.3ms | 895.4ms | — |
