# js2wasm Benchmark Results

Date: 2026-11-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.036ms | 0.036ms | FAILED | js |
| string/concat-long | 0.003ms | 0.003ms | 0.002ms | FAILED | gc-native |
| string/indexOf | 0.012ms | 0.012ms | 0.012ms | 0.012ms | gc-native |
| string/includes | 0.012ms | 0.015ms | 0.015ms | 0.014ms | js |
| string/split | 0.276ms | 0.328ms | 0.329ms | FAILED | js |
| string/replace | 0.065ms | 0.041ms | 0.041ms | FAILED | host-call |
| string/case-convert | 0.042ms | 0.005ms | 0.005ms | FAILED | host-call |
| string/substring | 0.080ms | 0.025ms | 0.025ms | FAILED | host-call |
| string/trim | 0.113ms | 0.120ms | 0.120ms | FAILED | js |
| string/startsWith-endsWith | 0.389ms | 0.160ms | 0.160ms | 0.421ms | host-call |
| array/push-pop | 1.12ms | 0.381ms | 0.375ms | FAILED | gc-native |
| array/sort-i32 | 0.484ms | 0.344ms | 0.343ms | FAILED | gc-native |
| array/map-filter | 0.099ms | 0.070ms | 0.076ms | FAILED | host-call |
| array/reduce | 1.11ms | 0.375ms | 0.376ms | FAILED | host-call |
| array/indexOf | 4.21ms | 4.91ms | 4.93ms | FAILED | js |
| array/slice | 0.019ms | 0.037ms | 0.035ms | FAILED | js |
| array/reverse | 5.33ms | 2.94ms | 2.94ms | FAILED | gc-native |
| array/forEach | 0.046ms | 0.034ms | 0.034ms | FAILED | gc-native |
| array/find | 0.227ms | 0.013ms | 0.012ms | 0.754ms | gc-native |
| dom/create-elements | 0.051ms | 0.716ms | — | — | js |
| dom/set-attributes | 0.100ms | 5.89ms | — | — | js |
| dom/read-attributes | 0.060ms | FAILED | — | — | js |
| dom/modify-text | 0.046ms | 1.34ms | — | — | js |
| mixed/csv-parse | 0.324ms | 0.229ms | 0.228ms | FAILED | gc-native |
| mixed/text-search | 0.329ms | 0.200ms | 0.201ms | 0.900ms | host-call |
| mixed/fibonacci | 0.106ms | 0.169ms | 0.169ms | 0.168ms | js |
| mixed/matrix-multiply | 0.146ms | 0.182ms | 0.182ms | 0.566ms | js |
| mixed/sieve | 1.31ms | 1.99ms | 1.98ms | FAILED | js |

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
| dom/read-attributes | host-call | warmup | dereferencing a null pointer |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 3.50 | 3.57 | 3.62 | — |
| string/concat-long | 1000 | 3.13 | 2.55 | 2.38 | — |
| string/indexOf | 1000 | 12.18 | 12.01 | 11.87 | 11.95 |
| string/includes | 1000 | 12.19 | 14.75 | 14.78 | 13.56 |
| string/split | 10000 | 27.61 | 32.83 | 32.87 | — |
| string/replace | 1000 | 65.04 | 40.56 | 40.61 | — |
| string/case-convert | 2000 | 21.12 | 2.62 | 2.63 | — |
| string/substring | 10000 | 7.97 | 2.48 | 2.48 | — |
| string/trim | 10000 | 11.31 | 12.00 | 11.99 | — |
| string/startsWith-endsWith | 20000 | 19.44 | 8.01 | 8.01 | 21.07 |
| array/map-filter | 30000 | 3.30 | 2.34 | 2.53 | — |
| array/indexOf | 1000 | 4211.76 | 4911.84 | 4926.91 | — |
| dom/create-elements | 2000 | 25.43 | 358.06 | — | — |
| dom/set-attributes | 6000 | 16.61 | 981.76 | — | — |
| dom/read-attributes | 3000 | 20.06 | — | — | — |
| dom/modify-text | 2000 | 22.88 | 670.60 | — | — |
| mixed/csv-parse | 11000 | 29.43 | 20.83 | 20.76 | — |
| mixed/text-search | 40000 | 8.22 | 5.00 | 5.02 | 22.50 |
| mixed/fibonacci | 10000 | 10.59 | 16.88 | 16.89 | 16.76 |
| mixed/matrix-multiply | 125000 | 1.17 | 1.45 | 1.46 | 4.52 |
| mixed/sieve | 200000 | 6.56 | 9.96 | 9.89 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x slower | 1.03x slower | — |
| string/concat-long | 1.23x faster | 1.32x faster | — |
| string/indexOf | 1.01x faster | 1.03x faster | 1.02x faster |
| string/includes | 1.21x slower | 1.21x slower | 1.11x slower |
| string/split | 1.19x slower | 1.19x slower | — |
| string/replace | 1.60x faster | 1.60x faster | — |
| string/case-convert | 8.07x faster | 8.04x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.06x slower | 1.06x slower | — |
| string/startsWith-endsWith | 2.43x faster | 2.43x faster | 1.08x slower |
| array/push-pop | 2.95x faster | 2.99x faster | — |
| array/sort-i32 | 1.41x faster | 1.41x faster | — |
| array/map-filter | 1.41x faster | 1.30x faster | — |
| array/reduce | 2.95x faster | 2.94x faster | — |
| array/indexOf | 1.17x slower | 1.17x slower | — |
| array/slice | 1.92x slower | 1.86x slower | — |
| array/reverse | 1.81x faster | 1.81x faster | — |
| array/forEach | 1.38x faster | 1.38x faster | — |
| array/find | 18.10x faster | 18.42x faster | 3.33x slower |
| dom/create-elements | 14.08x slower | — | — |
| dom/set-attributes | 59.11x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 29.31x slower | — | — |
| mixed/csv-parse | 1.41x faster | 1.42x faster | — |
| mixed/text-search | 1.64x faster | 1.64x faster | 2.74x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.58x slower |
| mixed/matrix-multiply | 1.24x slower | 1.25x slower | 3.88x slower |
| mixed/sieve | 1.52x slower | 1.51x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x slower |
| string/concat-long | 1.07x faster |
| string/indexOf | 1.01x faster |
| string/includes | 1.00x slower |
| string/split | 1.00x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.03x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.5KB | 1.5KB | — |
| string/concat-long | 18.8KB | 18.8KB | — |
| string/indexOf | 18.9KB | 18.9KB | 10.4KB |
| string/includes | 19.0KB | 19.0KB | 10.4KB |
| string/split | 26.7KB | 26.7KB | — |
| string/replace | 27.5KB | 27.5KB | — |
| string/case-convert | 26.3KB | 26.3KB | — |
| string/substring | 1.0KB | 1.0KB | — |
| string/trim | 26.3KB | 26.3KB | — |
| string/startsWith-endsWith | 27.3KB | 27.3KB | 1.7KB |
| array/push-pop | 25.3KB | 25.3KB | — |
| array/sort-i32 | 28.1KB | 28.1KB | — |
| array/map-filter | 29.2KB | 29.3KB | — |
| array/reduce | 27.7KB | 27.7KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.9KB | 27.9KB | — |
| array/find | 61.9KB | 61.9KB | 666B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 1019B |
| mixed/sieve | 26.6KB | 26.6KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1023.1ms | 453.0ms | — |
| string/concat-long | 804.2ms | 717.2ms | — |
| string/indexOf | 736.1ms | 711.0ms | 433.2ms |
| string/includes | 742.1ms | 727.4ms | 440.7ms |
| string/split | 811.1ms | 792.9ms | — |
| string/replace | 849.9ms | 801.6ms | — |
| string/case-convert | 785.5ms | 815.4ms | — |
| string/substring | 405.1ms | 392.8ms | — |
| string/trim | 801.4ms | 775.8ms | — |
| string/startsWith-endsWith | 819.5ms | 801.6ms | 491.7ms |
| array/push-pop | 789.2ms | 773.0ms | — |
| array/sort-i32 | 1380.4ms | 1384.4ms | — |
| array/map-filter | 1427.1ms | 1439.6ms | — |
| array/reduce | 1431.3ms | 1366.5ms | — |
| array/indexOf | 816.7ms | 843.5ms | — |
| array/slice | 803.8ms | 793.7ms | — |
| array/reverse | 788.4ms | 793.0ms | — |
| array/forEach | 1383.9ms | 1371.8ms | — |
| array/find | 2297.3ms | 2261.6ms | 448.5ms |
| dom/create-elements | 528.1ms | — | — |
| dom/set-attributes | 468.8ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 503.9ms | — | — |
| mixed/csv-parse | 799.4ms | 821.4ms | — |
| mixed/text-search | 848.9ms | 818.7ms | 505.1ms |
| mixed/fibonacci | 450.6ms | 440.9ms | 392.0ms |
| mixed/matrix-multiply | 807.2ms | 827.9ms | 422.9ms |
| mixed/sieve | 847.6ms | 812.3ms | — |
