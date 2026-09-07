# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.051ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.042ms | 0.014ms | 0.066ms | gc-native |
| string/split | 0.422ms | 7.39ms | 2.53ms | FAILED | js |
| string/replace | 0.097ms | 0.559ms | 0.268ms | FAILED | js |
| string/case-convert | 0.058ms | 0.515ms | 0.230ms | FAILED | js |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.08ms | 2.34ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.41ms | 2.42ms | 0.557ms | js |
| array/push-pop | 1.65ms | 0.596ms | 0.591ms | FAILED | gc-native |
| array/sort-i32 | 0.799ms | 0.488ms | 0.302ms | FAILED | gc-native |
| array/map-filter | 0.080ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 2.37ms | 0.595ms | 0.596ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/slice | 0.033ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.84ms | 3.97ms | 3.97ms | FAILED | host-call |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.21ms | gc-native |
| dom/create-elements | 0.038ms | 0.157ms | — | — | js |
| dom/set-attributes | 0.108ms | 0.546ms | — | — | js |
| dom/read-attributes | 0.058ms | 0.135ms | — | — | js |
| dom/modify-text | 0.029ms | 0.114ms | — | — | js |
| mixed/csv-parse | 0.960ms | 8.45ms | 0.548ms | FAILED | gc-native |
| mixed/text-search | 0.392ms | 4.18ms | 2.54ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.327ms | 0.327ms | 0.325ms | js |
| mixed/matrix-multiply | 0.185ms | 62.29ms | 63.11ms | 0.719ms | js |
| mixed/sieve | 1.82ms | 2.36ms | 2.31ms | FAILED | js |

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
| string/concat-short | 10000 | 3.00 | 5.09 | 4.93 | — |
| string/concat-long | 1000 | 4.11 | 5.01 | 3.49 | — |
| string/indexOf | 1000 | 18.99 | 60.42 | 12.25 | 16.54 |
| string/includes | 1000 | 18.67 | 41.96 | 13.79 | 65.74 |
| string/split | 10000 | 42.23 | 738.96 | 252.93 | — |
| string/replace | 1000 | 96.62 | 558.97 | 268.30 | — |
| string/case-convert | 2000 | 28.95 | 257.52 | 114.91 | — |
| string/substring | 10000 | 10.40 | 3.98 | 3.44 | — |
| string/trim | 10000 | 17.26 | 308.38 | 234.21 | — |
| string/startsWith-endsWith | 20000 | 20.64 | 120.61 | 121.20 | 27.84 |
| array/map-filter | 30000 | 2.66 | 2.18 | 2.17 | — |
| array/indexOf | 1000 | 4458.94 | 2860.51 | 2861.45 | — |
| dom/create-elements | 2000 | 18.82 | 78.70 | — | — |
| dom/set-attributes | 6000 | 17.98 | 90.96 | — | — |
| dom/read-attributes | 3000 | 19.41 | 44.98 | — | — |
| dom/modify-text | 2000 | 14.60 | 56.91 | — | — |
| mixed/csv-parse | 11000 | 87.30 | 768.30 | 49.86 | — |
| mixed/text-search | 40000 | 9.80 | 104.39 | 63.52 | 28.29 |
| mixed/fibonacci | 10000 | 12.54 | 32.72 | 32.74 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.48 | 498.34 | 504.89 | 5.75 |
| mixed/sieve | 200000 | 9.12 | 11.78 | 11.57 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.70x slower | 1.65x slower | — |
| string/concat-long | 1.22x slower | 1.18x faster | — |
| string/indexOf | 3.18x slower | 1.55x faster | 1.15x faster |
| string/includes | 2.25x slower | 1.35x faster | 3.52x slower |
| string/split | 17.50x slower | 5.99x slower | — |
| string/replace | 5.79x slower | 2.78x slower | — |
| string/case-convert | 8.90x slower | 3.97x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 17.87x slower | 13.57x slower | — |
| string/startsWith-endsWith | 5.84x slower | 5.87x slower | 1.35x slower |
| array/push-pop | 2.77x faster | 2.80x faster | — |
| array/sort-i32 | 1.64x faster | 2.65x faster | — |
| array/map-filter | 1.22x faster | 1.22x faster | — |
| array/reduce | 3.98x faster | 3.97x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.13x faster | 2.01x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.82x faster | 1.82x faster | — |
| array/find | 18.46x faster | 18.48x faster | 4.44x slower |
| dom/create-elements | 4.18x slower | — | — |
| dom/set-attributes | 5.06x slower | — | — |
| dom/read-attributes | 2.32x slower | — | — |
| dom/modify-text | 3.90x slower | — | — |
| mixed/csv-parse | 8.80x slower | 1.75x faster | — |
| mixed/text-search | 10.65x slower | 6.48x slower | 2.89x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 337.63x slower | 342.07x slower | 3.90x slower |
| mixed/sieve | 1.29x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.43x faster |
| string/indexOf | 4.93x faster |
| string/includes | 3.04x faster |
| string/split | 2.92x faster |
| string/replace | 2.08x faster |
| string/case-convert | 2.24x faster |
| string/substring | 1.16x faster |
| string/trim | 1.32x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.62x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.06x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 15.41x faster |
| mixed/text-search | 1.64x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.02x faster |

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
| string/concat-short | 1575.0ms | 1016.3ms | — |
| string/concat-long | 723.9ms | 956.6ms | — |
| string/indexOf | 649.2ms | 923.2ms | 855.3ms |
| string/includes | 652.1ms | 929.5ms | 814.2ms |
| string/split | 776.1ms | 940.8ms | — |
| string/replace | 756.0ms | 987.1ms | — |
| string/case-convert | 760.4ms | 838.4ms | — |
| string/substring | 634.4ms | 753.2ms | — |
| string/trim | 727.4ms | 933.9ms | — |
| string/startsWith-endsWith | 741.7ms | 953.9ms | 875.4ms |
| array/push-pop | 747.0ms | 826.8ms | — |
| array/sort-i32 | 907.0ms | 971.4ms | — |
| array/map-filter | 945.0ms | 995.6ms | — |
| array/reduce | 833.7ms | 918.0ms | — |
| array/indexOf | 823.4ms | 929.9ms | — |
| array/slice | 761.9ms | 881.1ms | — |
| array/reverse | 755.5ms | 858.5ms | — |
| array/forEach | 899.9ms | 1003.1ms | — |
| array/find | 778.7ms | 851.4ms | 810.4ms |
| dom/create-elements | 714.3ms | — | — |
| dom/set-attributes | 719.8ms | — | — |
| dom/read-attributes | 694.0ms | — | — |
| dom/modify-text | 683.0ms | — | — |
| mixed/csv-parse | 776.7ms | 945.0ms | — |
| mixed/text-search | 775.0ms | 989.9ms | 896.0ms |
| mixed/fibonacci | 733.5ms | 809.2ms | 753.3ms |
| mixed/matrix-multiply | 879.0ms | 940.7ms | 808.0ms |
| mixed/sieve | 870.7ms | 925.3ms | — |
