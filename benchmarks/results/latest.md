# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.046ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.007ms | 0.008ms | FAILED | js |
| string/indexOf | 0.019ms | 0.084ms | 0.024ms | FAILED | js |
| string/includes | 0.019ms | 0.162ms | 0.022ms | FAILED | js |
| string/split | 0.413ms | 6.15ms | 1.42ms | FAILED | js |
| string/replace | 0.046ms | 0.286ms | 0.101ms | FAILED | js |
| string/case-convert | 0.060ms | 0.239ms | 0.106ms | FAILED | js |
| string/substring | 0.099ms | 1.99ms | 0.907ms | FAILED | js |
| string/trim | 0.171ms | 1.34ms | 0.644ms | FAILED | js |
| string/startsWith-endsWith | 0.389ms | 3.01ms | 0.527ms | FAILED | js |
| array/push-pop | 1.45ms | 2.20ms | 2.18ms | FAILED | js |
| array/sort-i32 | 0.790ms | 0.393ms | 0.392ms | FAILED | gc-native |
| array/map-filter | 0.130ms | 0.641ms | 0.641ms | FAILED | js |
| array/reduce | 2.14ms | 2.17ms | 2.18ms | FAILED | js |
| array/indexOf | 3.94ms | 3.42ms | 3.42ms | FAILED | gc-native |
| array/slice | 0.024ms | 0.035ms | 0.035ms | FAILED | js |
| array/reverse | 7.83ms | 3.43ms | 3.43ms | FAILED | gc-native |
| array/forEach | 0.086ms | 0.114ms | 0.114ms | FAILED | js |
| array/find | 0.239ms | 0.458ms | 0.458ms | 4.86ms | js |
| dom/create-elements | 0.190ms | 0.292ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.357ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.169ms | — | — | js |
| dom/modify-text | 0.048ms | 0.171ms | — | — | js |
| mixed/csv-parse | 0.480ms | 7.65ms | 0.828ms | FAILED | js |
| mixed/text-search | 0.392ms | 5.78ms | 1.06ms | FAILED | js |
| mixed/fibonacci | 0.122ms | 0.261ms | 0.261ms | 0.259ms | js |
| mixed/matrix-multiply | 0.157ms | 0.555ms | 0.555ms | 2.13ms | js |
| mixed/sieve | 1.55ms | 1.39ms | 1.39ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
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
| string/concat-short | 10000 | 2.90 | 4.57 | 3.79 | — |
| string/concat-long | 1000 | 3.58 | 7.50 | 8.15 | — |
| string/indexOf | 1000 | 19.14 | 83.53 | 23.57 | — |
| string/includes | 1000 | 19.18 | 162.36 | 22.33 | — |
| string/split | 10000 | 41.33 | 614.55 | 142.34 | — |
| string/replace | 1000 | 46.48 | 286.39 | 100.60 | — |
| string/case-convert | 2000 | 29.92 | 119.46 | 52.76 | — |
| string/substring | 10000 | 9.85 | 199.33 | 90.67 | — |
| string/trim | 10000 | 17.08 | 133.70 | 64.39 | — |
| string/startsWith-endsWith | 20000 | 19.45 | 150.28 | 26.33 | — |
| mixed/csv-parse | 11000 | 43.67 | 695.50 | 75.25 | — |
| mixed/text-search | 40000 | 9.79 | 144.55 | 26.60 | — |
| mixed/fibonacci | 10000 | 12.18 | 26.13 | 26.10 | 25.90 |
| mixed/matrix-multiply | 125000 | 1.26 | 4.44 | 4.44 | 17.03 |
| mixed/sieve | 200000 | 7.73 | 6.94 | 6.95 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.31x slower | — |
| string/concat-long | 2.09x slower | 2.28x slower | — |
| string/indexOf | 4.37x slower | 1.23x slower | — |
| string/includes | 8.46x slower | 1.16x slower | — |
| string/split | 14.87x slower | 3.44x slower | — |
| string/replace | 6.16x slower | 2.16x slower | — |
| string/case-convert | 3.99x slower | 1.76x slower | — |
| string/substring | 20.23x slower | 9.20x slower | — |
| string/trim | 7.83x slower | 3.77x slower | — |
| string/startsWith-endsWith | 7.73x slower | 1.35x slower | — |
| array/push-pop | 1.51x slower | 1.50x slower | — |
| array/sort-i32 | 2.01x faster | 2.01x faster | — |
| array/map-filter | 4.95x slower | 4.95x slower | — |
| array/reduce | 1.01x slower | 1.02x slower | — |
| array/indexOf | 1.15x faster | 1.15x faster | — |
| array/slice | 1.41x slower | 1.43x slower | — |
| array/reverse | 2.28x faster | 2.28x faster | — |
| array/forEach | 1.33x slower | 1.33x slower | — |
| array/find | 1.92x slower | 1.92x slower | 20.32x slower |
| dom/create-elements | 1.54x slower | — | — |
| dom/set-attributes | 3.44x slower | — | — |
| dom/read-attributes | 3.07x slower | — | — |
| dom/modify-text | 3.56x slower | — | — |
| mixed/csv-parse | 15.93x slower | 1.72x slower | — |
| mixed/text-search | 14.76x slower | 2.72x slower | — |
| mixed/fibonacci | 2.15x slower | 2.14x slower | 2.13x slower |
| mixed/matrix-multiply | 3.52x slower | 3.52x slower | 13.52x slower |
| mixed/sieve | 1.11x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.20x faster |
| string/concat-long | 1.09x slower |
| string/indexOf | 3.54x faster |
| string/includes | 7.27x faster |
| string/split | 4.32x faster |
| string/replace | 2.85x faster |
| string/case-convert | 2.26x faster |
| string/substring | 2.20x faster |
| string/trim | 2.08x faster |
| string/startsWith-endsWith | 5.71x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 9.24x faster |
| mixed/text-search | 5.43x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 233B | 964B | — |
| string/indexOf | 412B | 1.3KB | — |
| string/includes | 398B | 1.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 1.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 297B | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1286.5ms | 1122.1ms | — |
| string/concat-long | 629.3ms | 965.4ms | — |
| string/indexOf | 755.6ms | 1013.0ms | — |
| string/includes | 740.5ms | 1020.0ms | — |
| string/split | 820.4ms | 1030.3ms | — |
| string/replace | 827.0ms | 1114.7ms | — |
| string/case-convert | 793.2ms | 1079.1ms | — |
| string/substring | 704.2ms | 925.5ms | — |
| string/trim | 793.6ms | 1016.9ms | — |
| string/startsWith-endsWith | 820.4ms | 1011.9ms | — |
| array/push-pop | 783.1ms | 841.4ms | — |
| array/sort-i32 | 946.5ms | 1030.3ms | — |
| array/map-filter | 969.6ms | 1043.6ms | — |
| array/reduce | 835.3ms | 892.6ms | — |
| array/indexOf | 775.9ms | 840.4ms | — |
| array/slice | 766.7ms | 830.9ms | — |
| array/reverse | 770.4ms | 828.1ms | — |
| array/forEach | 888.4ms | 937.0ms | — |
| array/find | 888.1ms | 954.7ms | 817.6ms |
| dom/create-elements | 661.1ms | — | — |
| dom/set-attributes | 719.9ms | — | — |
| dom/read-attributes | 689.9ms | — | — |
| dom/modify-text | 724.0ms | — | — |
| mixed/csv-parse | 860.8ms | 1009.2ms | — |
| mixed/text-search | 815.6ms | 1017.2ms | — |
| mixed/fibonacci | 807.7ms | 850.7ms | 787.4ms |
| mixed/matrix-multiply | 858.6ms | 941.5ms | 793.8ms |
| mixed/sieve | 797.4ms | 884.8ms | — |
