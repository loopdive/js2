# js2wasm Benchmark Results

Date: 2026-08-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.049ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.005ms | FAILED | js |
| string/indexOf | 0.019ms | 0.062ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.119ms | 0.024ms | FAILED | js |
| string/split | 0.420ms | 5.30ms | 0.505ms | FAILED | js |
| string/replace | 0.095ms | 0.221ms | 0.076ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.229ms | 0.117ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.215ms | 0.934ms | 0.263ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.43ms | 0.308ms | FAILED | gc-native |
| array/push-pop | 1.70ms | 0.612ms | 0.601ms | FAILED | gc-native |
| array/sort-i32 | 0.842ms | 0.332ms | 0.314ms | FAILED | gc-native |
| array/map-filter | 0.136ms | 0.061ms | 0.061ms | FAILED | host-call |
| array/reduce | 2.39ms | 0.600ms | 0.603ms | FAILED | host-call |
| array/indexOf | 4.46ms | 3.79ms | 3.79ms | FAILED | host-call |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 8.85ms | 3.97ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.282ms | 0.016ms | 0.016ms | 1.21ms | gc-native |
| dom/create-elements | 0.039ms | 0.168ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.502ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.152ms | — | — | js |
| dom/modify-text | 0.047ms | 0.128ms | — | — | js |
| mixed/csv-parse | 0.466ms | 7.95ms | 0.598ms | FAILED | js |
| mixed/text-search | 0.403ms | 2.27ms | 0.356ms | FAILED | gc-native |
| mixed/fibonacci | 0.125ms | 0.130ms | 0.130ms | 0.048ms | linear-memory |
| mixed/matrix-multiply | 0.186ms | 0.201ms | 0.200ms | 0.724ms | js |
| mixed/sieve | 1.78ms | 1.48ms | 1.51ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.03 | 4.88 | 4.20 | — |
| string/concat-long | 1000 | 3.89 | 5.42 | 4.97 | — |
| string/indexOf | 1000 | 18.96 | 61.91 | 23.52 | — |
| string/includes | 1000 | 18.73 | 118.63 | 23.64 | — |
| string/split | 10000 | 41.99 | 530.37 | 50.55 | — |
| string/replace | 1000 | 95.21 | 220.90 | 75.82 | — |
| string/case-convert | 2000 | 29.15 | 114.42 | 58.37 | — |
| string/substring | 10000 | 10.44 | 3.99 | 3.43 | — |
| string/trim | 10000 | 21.46 | 93.38 | 26.33 | — |
| string/startsWith-endsWith | 20000 | 20.67 | 121.69 | 15.38 | — |
| array/map-filter | 30000 | 4.54 | 2.04 | 2.05 | — |
| array/indexOf | 1000 | 4459.33 | 3786.82 | 3787.73 | — |
| dom/create-elements | 2000 | 19.48 | 83.84 | — | — |
| dom/set-attributes | 6000 | 18.05 | 83.65 | — | — |
| dom/read-attributes | 3000 | 19.45 | 50.65 | — | — |
| dom/modify-text | 2000 | 23.52 | 64.09 | — | — |
| mixed/csv-parse | 11000 | 42.38 | 722.69 | 54.33 | — |
| mixed/text-search | 40000 | 10.07 | 56.75 | 8.90 | — |
| mixed/fibonacci | 10000 | 12.52 | 13.00 | 13.00 | 4.76 |
| mixed/matrix-multiply | 125000 | 1.49 | 1.61 | 1.60 | 5.79 |
| mixed/sieve | 200000 | 8.88 | 7.39 | 7.54 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.61x slower | 1.39x slower | — |
| string/concat-long | 1.39x slower | 1.28x slower | — |
| string/indexOf | 3.26x slower | 1.24x slower | — |
| string/includes | 6.33x slower | 1.26x slower | — |
| string/split | 12.63x slower | 1.20x slower | — |
| string/replace | 2.32x slower | 1.26x faster | — |
| string/case-convert | 3.93x slower | 2.00x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 4.35x slower | 1.23x slower | — |
| string/startsWith-endsWith | 5.89x slower | 1.34x faster | — |
| array/push-pop | 2.78x faster | 2.83x faster | — |
| array/sort-i32 | 2.54x faster | 2.68x faster | — |
| array/map-filter | 2.22x faster | 2.22x faster | — |
| array/reduce | 3.99x faster | 3.97x faster | — |
| array/indexOf | 1.18x faster | 1.18x faster | — |
| array/slice | 2.05x faster | 2.07x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.84x faster | 1.85x faster | — |
| array/find | 17.66x faster | 18.05x faster | 4.29x slower |
| dom/create-elements | 4.30x slower | — | — |
| dom/set-attributes | 4.63x slower | — | — |
| dom/read-attributes | 2.60x slower | — | — |
| dom/modify-text | 2.73x slower | — | — |
| mixed/csv-parse | 17.05x slower | 1.28x slower | — |
| mixed/text-search | 5.64x slower | 1.13x faster | — |
| mixed/fibonacci | 1.04x slower | 1.04x slower | 2.63x faster |
| mixed/matrix-multiply | 1.08x slower | 1.08x slower | 3.88x slower |
| mixed/sieve | 1.20x faster | 1.18x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.09x faster |
| string/indexOf | 2.63x faster |
| string/includes | 5.02x faster |
| string/split | 10.49x faster |
| string/replace | 2.91x faster |
| string/case-convert | 1.96x faster |
| string/substring | 1.16x faster |
| string/trim | 3.55x faster |
| string/startsWith-endsWith | 7.91x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.06x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 13.30x faster |
| mixed/text-search | 6.38x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 427B | 1.3KB | — |
| string/includes | 414B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.1KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.1KB | 1.4KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 230B | — | — |
| dom/set-attributes | 497B | — | — |
| dom/read-attributes | 347B | — | — |
| dom/modify-text | 237B | — | — |
| mixed/csv-parse | 2.2KB | 4.6KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 263B | 263B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1289.9ms | 1104.5ms | — |
| string/concat-long | 621.7ms | 937.2ms | — |
| string/indexOf | 776.6ms | 992.0ms | — |
| string/includes | 775.2ms | 965.7ms | — |
| string/split | 738.8ms | 976.7ms | — |
| string/replace | 810.7ms | 1059.4ms | — |
| string/case-convert | 791.4ms | 1089.5ms | — |
| string/substring | 634.6ms | 726.1ms | — |
| string/trim | 723.5ms | 1135.8ms | — |
| string/startsWith-endsWith | 723.6ms | 1007.6ms | — |
| array/push-pop | 761.8ms | 843.8ms | — |
| array/sort-i32 | 942.8ms | 993.0ms | — |
| array/map-filter | 945.9ms | 1053.4ms | — |
| array/reduce | 840.1ms | 931.1ms | — |
| array/indexOf | 838.7ms | 883.1ms | — |
| array/slice | 731.9ms | 784.5ms | — |
| array/reverse | 777.6ms | 778.5ms | — |
| array/forEach | 815.5ms | 926.1ms | — |
| array/find | 738.1ms | 787.7ms | 827.8ms |
| dom/create-elements | 593.7ms | — | — |
| dom/set-attributes | 692.6ms | — | — |
| dom/read-attributes | 661.7ms | — | — |
| dom/modify-text | 664.1ms | — | — |
| mixed/csv-parse | 763.5ms | 972.0ms | — |
| mixed/text-search | 731.9ms | 991.4ms | — |
| mixed/fibonacci | 756.9ms | 782.1ms | 705.6ms |
| mixed/matrix-multiply | 803.9ms | 858.9ms | 782.4ms |
| mixed/sieve | 784.8ms | 848.7ms | — |
