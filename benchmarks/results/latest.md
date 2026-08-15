# js2wasm Benchmark Results

Date: 2026-08-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.048ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.023ms | gc-native |
| string/includes | 0.019ms | 0.101ms | 0.014ms | 0.041ms | gc-native |
| string/split | 0.425ms | 4.72ms | 0.507ms | FAILED | js |
| string/replace | 0.095ms | 0.218ms | 0.060ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.224ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 1.02ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.412ms | 0.344ms | 0.309ms | 0.554ms | gc-native |
| array/push-pop | 1.66ms | 0.614ms | 0.607ms | FAILED | gc-native |
| array/sort-i32 | 0.840ms | 0.301ms | 0.297ms | FAILED | gc-native |
| array/map-filter | 0.134ms | 0.066ms | 0.066ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.605ms | 0.608ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | host-call |
| dom/create-elements | 0.039ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.537ms | — | — | js |
| dom/read-attributes | 0.063ms | 0.138ms | — | — | js |
| dom/modify-text | 0.029ms | 0.111ms | — | — | js |
| mixed/csv-parse | 0.466ms | 7.32ms | 0.306ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.33ms | 0.294ms | 1.29ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.313ms | 0.315ms | 0.313ms | js |
| mixed/matrix-multiply | 0.185ms | 0.210ms | 0.210ms | 0.722ms | js |
| mixed/sieve | 1.78ms | 1.52ms | 1.49ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.00 | 4.83 | 4.24 | — |
| string/concat-long | 1000 | 4.16 | 5.37 | 3.46 | — |
| string/indexOf | 1000 | 18.91 | 59.94 | 12.19 | 23.26 |
| string/includes | 1000 | 18.64 | 101.44 | 13.84 | 41.19 |
| string/split | 10000 | 42.50 | 472.23 | 50.75 | — |
| string/replace | 1000 | 95.25 | 218.46 | 59.70 | — |
| string/case-convert | 2000 | 29.30 | 112.18 | 2.62 | — |
| string/substring | 10000 | 10.42 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.30 | 102.29 | 19.75 | — |
| string/startsWith-endsWith | 20000 | 20.61 | 17.21 | 15.44 | 27.72 |
| array/map-filter | 30000 | 4.46 | 2.20 | 2.20 | — |
| array/indexOf | 1000 | 4459.37 | 2862.77 | 2860.84 | — |
| dom/create-elements | 2000 | 19.37 | 77.47 | — | — |
| dom/set-attributes | 6000 | 18.01 | 89.50 | — | — |
| dom/read-attributes | 3000 | 21.10 | 46.02 | — | — |
| dom/modify-text | 2000 | 14.60 | 55.55 | — | — |
| mixed/csv-parse | 11000 | 42.34 | 665.64 | 27.79 | — |
| mixed/text-search | 40000 | 10.07 | 33.14 | 7.34 | 32.36 |
| mixed/fibonacci | 10000 | 12.53 | 31.33 | 31.49 | 31.27 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.68 | 1.68 | 5.78 |
| mixed/sieve | 200000 | 8.88 | 7.62 | 7.46 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.61x slower | 1.42x slower | — |
| string/concat-long | 1.29x slower | 1.20x faster | — |
| string/indexOf | 3.17x slower | 1.55x faster | 1.23x slower |
| string/includes | 5.44x slower | 1.35x faster | 2.21x slower |
| string/split | 11.11x slower | 1.19x slower | — |
| string/replace | 2.29x slower | 1.60x faster | — |
| string/case-convert | 3.83x slower | 11.20x faster | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 5.91x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.20x faster | 1.34x faster | 1.34x slower |
| array/push-pop | 2.70x faster | 2.73x faster | — |
| array/sort-i32 | 2.79x faster | 2.83x faster | — |
| array/map-filter | 2.03x faster | 2.03x faster | — |
| array/reduce | 3.96x faster | 3.94x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.15x faster | 2.04x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.82x faster | 1.82x faster | — |
| array/find | 18.56x faster | 18.09x faster | 4.45x slower |
| dom/create-elements | 4.00x slower | — | — |
| dom/set-attributes | 4.97x slower | — | — |
| dom/read-attributes | 2.18x slower | — | — |
| dom/modify-text | 3.80x slower | — | — |
| mixed/csv-parse | 15.72x slower | 1.52x faster | — |
| mixed/text-search | 3.29x slower | 1.37x faster | 3.21x slower |
| mixed/fibonacci | 2.50x slower | 2.51x slower | 2.50x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.91x slower |
| mixed/sieve | 1.17x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.55x faster |
| string/indexOf | 4.92x faster |
| string/includes | 7.33x faster |
| string/split | 9.31x faster |
| string/replace | 3.66x faster |
| string/case-convert | 42.89x faster |
| string/substring | 1.16x faster |
| string/trim | 5.18x faster |
| string/startsWith-endsWith | 1.12x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.03x slower |
| mixed/csv-parse | 23.95x faster |
| mixed/text-search | 4.51x faster |
| mixed/fibonacci | 1.01x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.0KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 914B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.6KB | 2.0KB | — |
| array/slice | 994B | 1.3KB | — |
| array/reverse | 972B | 1.3KB | — |
| array/forEach | 2.5KB | 2.8KB | — |
| array/find | 920B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.6KB | 1.9KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1286.3ms | 1044.3ms | — |
| string/concat-long | 630.5ms | 928.7ms | — |
| string/indexOf | 638.3ms | 921.7ms | 815.7ms |
| string/includes | 626.2ms | 934.7ms | 824.6ms |
| string/split | 720.0ms | 953.9ms | — |
| string/replace | 772.6ms | 1033.2ms | — |
| string/case-convert | 795.5ms | 840.0ms | — |
| string/substring | 622.2ms | 714.4ms | — |
| string/trim | 741.3ms | 941.9ms | — |
| string/startsWith-endsWith | 755.8ms | 948.4ms | 913.6ms |
| array/push-pop | 747.9ms | 880.4ms | — |
| array/sort-i32 | 919.0ms | 955.9ms | — |
| array/map-filter | 894.6ms | 979.9ms | — |
| array/reduce | 829.3ms | 940.3ms | — |
| array/indexOf | 814.3ms | 915.0ms | — |
| array/slice | 732.9ms | 821.5ms | — |
| array/reverse | 748.3ms | 835.7ms | — |
| array/forEach | 845.1ms | 946.1ms | — |
| array/find | 741.3ms | 819.4ms | 803.5ms |
| dom/create-elements | 578.0ms | — | — |
| dom/set-attributes | 676.0ms | — | — |
| dom/read-attributes | 662.9ms | — | — |
| dom/modify-text | 616.5ms | — | — |
| mixed/csv-parse | 774.1ms | 910.8ms | — |
| mixed/text-search | 732.8ms | 995.9ms | 914.3ms |
| mixed/fibonacci | 750.7ms | 777.5ms | 796.8ms |
| mixed/matrix-multiply | 856.2ms | 886.8ms | 797.9ms |
| mixed/sieve | 812.9ms | 907.5ms | — |
