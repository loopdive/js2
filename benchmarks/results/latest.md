# js2wasm Benchmark Results

Date: 2026-08-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.025ms | 0.046ms | 0.040ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.013ms | 0.019ms | gc-native |
| string/includes | 0.020ms | 0.109ms | 0.016ms | 0.078ms | gc-native |
| string/split | 0.418ms | 4.94ms | 0.449ms | FAILED | js |
| string/replace | 0.111ms | 0.310ms | 0.061ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.244ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.039ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.182ms | 0.922ms | 0.189ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 0.367ms | 0.303ms | 0.562ms | gc-native |
| array/push-pop | 1.50ms | 0.537ms | 0.527ms | FAILED | gc-native |
| array/sort-i32 | 0.816ms | 0.344ms | 0.316ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.075ms | 0.074ms | FAILED | gc-native |
| array/reduce | 2.28ms | 0.529ms | 0.528ms | FAILED | gc-native |
| array/indexOf | 3.96ms | 2.75ms | 2.79ms | FAILED | host-call |
| array/slice | 0.029ms | 0.031ms | 0.030ms | FAILED | js |
| array/reverse | 7.86ms | 3.58ms | 3.56ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.032ms | 0.030ms | FAILED | gc-native |
| array/find | 0.260ms | 0.019ms | 0.017ms | 1.19ms | gc-native |
| dom/create-elements | 0.039ms | 0.164ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.556ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.124ms | — | — | js |
| dom/modify-text | 0.032ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.486ms | 7.27ms | 0.359ms | FAILED | gc-native |
| mixed/text-search | 0.417ms | 1.66ms | 0.274ms | 1.12ms | gc-native |
| mixed/fibonacci | 0.123ms | 0.292ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.165ms | 0.221ms | 0.258ms | 0.730ms | js |
| mixed/sieve | 1.68ms | 1.56ms | 1.46ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.46 | 4.56 | 4.01 | — |
| string/concat-long | 1000 | 3.91 | 4.52 | 4.01 | — |
| string/indexOf | 1000 | 19.39 | 66.31 | 12.56 | 18.97 |
| string/includes | 1000 | 19.97 | 108.86 | 15.69 | 77.52 |
| string/split | 10000 | 41.84 | 493.92 | 44.94 | — |
| string/replace | 1000 | 111.27 | 309.56 | 61.45 | — |
| string/case-convert | 2000 | 29.00 | 122.13 | 2.56 | — |
| string/substring | 10000 | 10.39 | 3.85 | 3.13 | — |
| string/trim | 10000 | 18.24 | 92.19 | 18.91 | — |
| string/startsWith-endsWith | 20000 | 20.14 | 18.37 | 15.15 | 28.08 |
| array/map-filter | 30000 | 4.63 | 2.49 | 2.47 | — |
| array/indexOf | 1000 | 3957.26 | 2753.67 | 2787.56 | — |
| dom/create-elements | 2000 | 19.34 | 81.92 | — | — |
| dom/set-attributes | 6000 | 18.40 | 92.73 | — | — |
| dom/read-attributes | 3000 | 19.24 | 41.42 | — | — |
| dom/modify-text | 2000 | 15.77 | 56.45 | — | — |
| mixed/csv-parse | 11000 | 44.15 | 661.11 | 32.60 | — |
| mixed/text-search | 40000 | 10.43 | 41.39 | 6.84 | 27.90 |
| mixed/fibonacci | 10000 | 12.29 | 29.23 | 29.24 | 28.64 |
| mixed/matrix-multiply | 125000 | 1.32 | 1.77 | 2.06 | 5.84 |
| mixed/sieve | 200000 | 8.41 | 7.79 | 7.29 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.85x slower | 1.63x slower | — |
| string/concat-long | 1.16x slower | 1.03x slower | — |
| string/indexOf | 3.42x slower | 1.54x faster | 1.02x faster |
| string/includes | 5.45x slower | 1.27x faster | 3.88x slower |
| string/split | 11.80x slower | 1.07x slower | — |
| string/replace | 2.78x slower | 1.81x faster | — |
| string/case-convert | 4.21x slower | 11.33x faster | — |
| string/substring | 2.70x faster | 3.32x faster | — |
| string/trim | 5.06x slower | 1.04x slower | — |
| string/startsWith-endsWith | 1.10x faster | 1.33x faster | 1.39x slower |
| array/push-pop | 2.79x faster | 2.84x faster | — |
| array/sort-i32 | 2.38x faster | 2.59x faster | — |
| array/map-filter | 1.86x faster | 1.87x faster | — |
| array/reduce | 4.31x faster | 4.32x faster | — |
| array/indexOf | 1.44x faster | 1.42x faster | — |
| array/slice | 1.07x slower | 1.05x slower | — |
| array/reverse | 2.20x faster | 2.21x faster | — |
| array/forEach | 1.62x faster | 1.71x faster | — |
| array/find | 13.77x faster | 15.50x faster | 4.56x slower |
| dom/create-elements | 4.24x slower | — | — |
| dom/set-attributes | 5.04x slower | — | — |
| dom/read-attributes | 2.15x slower | — | — |
| dom/modify-text | 3.58x slower | — | — |
| mixed/csv-parse | 14.97x slower | 1.35x faster | — |
| mixed/text-search | 3.97x slower | 1.52x faster | 2.68x slower |
| mixed/fibonacci | 2.38x slower | 2.38x slower | 2.33x slower |
| mixed/matrix-multiply | 1.34x slower | 1.56x slower | 4.41x slower |
| mixed/sieve | 1.08x faster | 1.15x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.13x faster |
| string/indexOf | 5.28x faster |
| string/includes | 6.94x faster |
| string/split | 10.99x faster |
| string/replace | 5.04x faster |
| string/case-convert | 47.71x faster |
| string/substring | 1.23x faster |
| string/trim | 4.88x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.09x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.01x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.01x faster |
| array/forEach | 1.05x faster |
| array/find | 1.13x faster |
| mixed/csv-parse | 20.28x faster |
| mixed/text-search | 6.05x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.17x slower |
| mixed/sieve | 1.07x faster |

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
| string/concat-short | 1347.6ms | 1117.5ms | — |
| string/concat-long | 644.7ms | 963.4ms | — |
| string/indexOf | 675.8ms | 976.7ms | 863.5ms |
| string/includes | 668.5ms | 983.1ms | 851.2ms |
| string/split | 824.0ms | 1028.2ms | — |
| string/replace | 804.5ms | 1084.1ms | — |
| string/case-convert | 823.8ms | 909.5ms | — |
| string/substring | 692.2ms | 774.6ms | — |
| string/trim | 753.0ms | 962.4ms | — |
| string/startsWith-endsWith | 798.3ms | 992.7ms | 919.5ms |
| array/push-pop | 822.8ms | 906.9ms | — |
| array/sort-i32 | 939.2ms | 1024.2ms | — |
| array/map-filter | 951.7ms | 1028.9ms | — |
| array/reduce | 846.2ms | 933.3ms | — |
| array/indexOf | 847.6ms | 932.7ms | — |
| array/slice | 778.1ms | 886.8ms | — |
| array/reverse | 776.5ms | 861.5ms | — |
| array/forEach | 915.9ms | 983.6ms | — |
| array/find | 795.9ms | 875.4ms | 870.4ms |
| dom/create-elements | 626.7ms | — | — |
| dom/set-attributes | 711.9ms | — | — |
| dom/read-attributes | 725.1ms | — | — |
| dom/modify-text | 616.1ms | — | — |
| mixed/csv-parse | 811.7ms | 970.2ms | — |
| mixed/text-search | 810.1ms | 1074.5ms | 959.4ms |
| mixed/fibonacci | 805.3ms | 859.5ms | 835.9ms |
| mixed/matrix-multiply | 887.8ms | 943.1ms | 852.4ms |
| mixed/sieve | 894.7ms | 982.4ms | — |
