# js2wasm Benchmark Results

Date: 2026-08-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.044ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.076ms | 0.021ms | FAILED | js |
| string/includes | 0.019ms | 0.138ms | 0.021ms | FAILED | js |
| string/split | 0.412ms | 5.54ms | 0.451ms | FAILED | js |
| string/replace | 0.104ms | 0.319ms | 0.086ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.261ms | 0.119ms | FAILED | js |
| string/substring | 0.097ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.168ms | 0.935ms | 0.249ms | FAILED | js |
| string/startsWith-endsWith | 0.392ms | 2.85ms | 0.286ms | FAILED | gc-native |
| array/push-pop | 1.34ms | 0.499ms | 0.488ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.332ms | 0.332ms | FAILED | host-call |
| array/map-filter | 0.125ms | 0.547ms | 0.547ms | FAILED | js |
| array/reduce | 2.12ms | 0.501ms | 0.500ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 3.77ms | 3.78ms | FAILED | host-call |
| array/slice | 0.023ms | 0.026ms | 0.026ms | FAILED | js |
| array/reverse | 7.64ms | 3.52ms | 3.48ms | FAILED | gc-native |
| array/forEach | 0.085ms | 0.028ms | 0.027ms | FAILED | gc-native |
| array/find | 0.238ms | 0.016ms | 0.016ms | 0.995ms | gc-native |
| dom/create-elements | 0.188ms | 0.288ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.368ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.169ms | — | — | js |
| dom/modify-text | 0.045ms | 0.161ms | — | — | js |
| mixed/csv-parse | 0.509ms | 8.52ms | 0.810ms | FAILED | js |
| mixed/text-search | 0.380ms | 2.54ms | 0.326ms | FAILED | gc-native |
| mixed/fibonacci | 0.122ms | 0.044ms | 0.044ms | 0.044ms | linear-memory |
| mixed/matrix-multiply | 0.154ms | 0.190ms | 0.190ms | 0.705ms | js |
| mixed/sieve | 1.50ms | 1.38ms | 1.39ms | FAILED | host-call |

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
| string/concat-short | 10000 | 2.73 | 4.44 | 3.67 | — |
| string/concat-long | 1000 | 3.62 | 4.44 | 4.36 | — |
| string/indexOf | 1000 | 19.09 | 75.52 | 20.74 | — |
| string/includes | 1000 | 19.11 | 138.17 | 20.69 | — |
| string/split | 10000 | 41.23 | 554.40 | 45.06 | — |
| string/replace | 1000 | 104.01 | 318.82 | 86.24 | — |
| string/case-convert | 2000 | 28.98 | 130.44 | 59.55 | — |
| string/substring | 10000 | 9.68 | 3.75 | 3.07 | — |
| string/trim | 10000 | 16.78 | 93.51 | 24.85 | — |
| string/startsWith-endsWith | 20000 | 19.59 | 142.33 | 14.32 | — |
| array/map-filter | 30000 | 4.16 | 18.25 | 18.22 | — |
| array/indexOf | 1000 | 3908.72 | 3770.15 | 3775.65 | — |
| dom/create-elements | 2000 | 93.96 | 143.81 | — | — |
| dom/set-attributes | 6000 | 17.33 | 61.33 | — | — |
| dom/read-attributes | 3000 | 18.26 | 56.43 | — | — |
| dom/modify-text | 2000 | 22.26 | 80.73 | — | — |
| mixed/csv-parse | 11000 | 46.30 | 774.29 | 73.65 | — |
| mixed/text-search | 40000 | 9.50 | 63.57 | 8.15 | — |
| mixed/fibonacci | 10000 | 12.17 | 4.40 | 4.40 | 4.37 |
| mixed/matrix-multiply | 125000 | 1.23 | 1.52 | 1.52 | 5.64 |
| mixed/sieve | 200000 | 7.49 | 6.90 | 6.97 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.62x slower | 1.34x slower | — |
| string/concat-long | 1.23x slower | 1.21x slower | — |
| string/indexOf | 3.95x slower | 1.09x slower | — |
| string/includes | 7.23x slower | 1.08x slower | — |
| string/split | 13.45x slower | 1.09x slower | — |
| string/replace | 3.07x slower | 1.21x faster | — |
| string/case-convert | 4.50x slower | 2.05x slower | — |
| string/substring | 2.58x faster | 3.16x faster | — |
| string/trim | 5.57x slower | 1.48x slower | — |
| string/startsWith-endsWith | 7.27x slower | 1.37x faster | — |
| array/push-pop | 2.68x faster | 2.74x faster | — |
| array/sort-i32 | 2.38x faster | 2.38x faster | — |
| array/map-filter | 4.39x slower | 4.38x slower | — |
| array/reduce | 4.23x faster | 4.24x faster | — |
| array/indexOf | 1.04x faster | 1.04x faster | — |
| array/slice | 1.12x slower | 1.12x slower | — |
| array/reverse | 2.17x faster | 2.19x faster | — |
| array/forEach | 3.07x faster | 3.11x faster | — |
| array/find | 14.64x faster | 14.88x faster | 4.18x slower |
| dom/create-elements | 1.53x slower | — | — |
| dom/set-attributes | 3.54x slower | — | — |
| dom/read-attributes | 3.09x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 16.72x slower | 1.59x slower | — |
| mixed/text-search | 6.69x slower | 1.17x faster | — |
| mixed/fibonacci | 2.77x faster | 2.77x faster | 2.79x faster |
| mixed/matrix-multiply | 1.24x slower | 1.24x slower | 4.59x slower |
| mixed/sieve | 1.09x faster | 1.08x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.02x faster |
| string/indexOf | 3.64x faster |
| string/includes | 6.68x faster |
| string/split | 12.30x faster |
| string/replace | 3.70x faster |
| string/case-convert | 2.19x faster |
| string/substring | 1.22x faster |
| string/trim | 3.76x faster |
| string/startsWith-endsWith | 9.94x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.01x faster |
| array/forEach | 1.01x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 10.51x faster |
| mixed/text-search | 7.80x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 223B | 954B | — |
| string/indexOf | 401B | 1.3KB | — |
| string/includes | 388B | 1.3KB | — |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 4.0KB | — |
| string/case-convert | 1.6KB | 13.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.6KB | 3.5KB | — |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.6KB | 3.0KB | — |
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
| mixed/csv-parse | 2.2KB | 4.8KB | — |
| mixed/text-search | 1.8KB | 4.0KB | — |
| mixed/fibonacci | 235B | 235B | 251B |
| mixed/matrix-multiply | 1.5KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1258.3ms | 1112.9ms | — |
| string/concat-long | 623.8ms | 945.4ms | — |
| string/indexOf | 731.4ms | 997.7ms | — |
| string/includes | 734.0ms | 980.3ms | — |
| string/split | 737.2ms | 910.8ms | — |
| string/replace | 793.2ms | 1036.3ms | — |
| string/case-convert | 778.1ms | 1061.5ms | — |
| string/substring | 622.9ms | 691.8ms | — |
| string/trim | 708.1ms | 958.8ms | — |
| string/startsWith-endsWith | 716.3ms | 978.0ms | — |
| array/push-pop | 739.7ms | 827.8ms | — |
| array/sort-i32 | 915.1ms | 997.9ms | — |
| array/map-filter | 893.3ms | 929.4ms | — |
| array/reduce | 800.1ms | 873.7ms | — |
| array/indexOf | 824.8ms | 862.5ms | — |
| array/slice | 730.2ms | 815.5ms | — |
| array/reverse | 744.3ms | 808.9ms | — |
| array/forEach | 847.3ms | 958.7ms | — |
| array/find | 713.4ms | 810.2ms | 796.1ms |
| dom/create-elements | 614.5ms | — | — |
| dom/set-attributes | 695.9ms | — | — |
| dom/read-attributes | 680.4ms | — | — |
| dom/modify-text | 667.7ms | — | — |
| mixed/csv-parse | 771.1ms | 984.2ms | — |
| mixed/text-search | 711.2ms | 989.4ms | — |
| mixed/fibonacci | 721.7ms | 725.1ms | 703.9ms |
| mixed/matrix-multiply | 814.5ms | 844.7ms | 745.5ms |
| mixed/sieve | 778.9ms | 818.6ms | — |
