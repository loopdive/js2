# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.043ms | 0.043ms | 0.050ms | — | host-call |
| string/concat-long | 0.006ms | 0.012ms | 0.022ms | — | js |
| string/indexOf | 0.016ms | 0.438ms | 0.046ms | — | js |
| string/includes | 0.016ms | 0.423ms | 0.049ms | — | js |
| string/split | 0.280ms | 14.60ms | 0.855ms | — | js |
| string/replace | 0.039ms | 0.460ms | 0.098ms | — | js |
| string/case-convert | <0.001ms | 0.669ms | 4.10ms | — | js |
| string/substring | 0.003ms | 3.35ms | 0.044ms | — | js |
| string/trim | 0.104ms | 3.10ms | 0.494ms | — | js |
| string/startsWith-endsWith | 0.341ms | 7.11ms | 1.37ms | — | js |
| array/push-pop | 1.22ms | 1.38ms | 1.05ms | — | gc-native |
| array/sort-i32 | 0.465ms | 778.5ms | — | — | js |
| array/map-filter | 0.127ms | 1.11ms | 0.043ms | — | gc-native |
| array/reduce | 1.59ms | 1.38ms | 0.674ms | — | gc-native |
| array/indexOf | 3.91ms | 3.26ms | 1.98ms | — | gc-native |
| array/slice | 0.046ms | 0.228ms | 0.027ms | — | gc-native |
| array/reverse | 4.95ms | 2.75ms | 2.42ms | — | gc-native |
| array/forEach | 0.054ms | 0.092ms | 0.026ms | — | gc-native |
| array/find | 0.217ms | 0.370ms | — | — | js |
| dom/create-elements | 0.062ms | — | — | — | js |
| dom/set-attributes | 0.115ms | — | — | — | js |
| dom/read-attributes | 0.073ms | — | — | — | js |
| dom/modify-text | 0.075ms | — | — | — | js |
| mixed/csv-parse | 1.22ms | 21.93ms | 0.762ms | — | gc-native |
| mixed/text-search | 0.189ms | 14.44ms | 1.18ms | — | js |
| mixed/fibonacci | 0.091ms | 0.108ms | — | 0.111ms | js |
| mixed/matrix-multiply | 0.144ms | 1.35ms | 0.159ms | 1.21ms | js |
| mixed/sieve | 1.43ms | 1.82ms | 0.851ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x faster | 1.14x slower | — |
| string/concat-long | 2.11x slower | 3.78x slower | — |
| string/indexOf | 28.17x slower | 2.93x slower | — |
| string/includes | 25.97x slower | 3.01x slower | — |
| string/split | 52.11x slower | 3.05x slower | — |
| string/replace | 11.80x slower | 2.51x slower | — |
| string/case-convert | 2138.47x slower | 13110.41x slower | — |
| string/substring | 1202.50x slower | 15.65x slower | — |
| string/trim | 29.72x slower | 4.73x slower | — |
| string/startsWith-endsWith | 20.85x slower | 4.03x slower | — |
| array/push-pop | 1.13x slower | 1.16x faster | — |
| array/sort-i32 | 1673.16x slower | — | — |
| array/map-filter | 8.76x slower | 2.94x faster | — |
| array/reduce | 1.15x faster | 2.36x faster | — |
| array/indexOf | 1.20x faster | 1.98x faster | — |
| array/slice | 4.98x slower | 1.68x faster | — |
| array/reverse | 1.80x faster | 2.04x faster | — |
| array/forEach | 1.71x slower | 2.05x faster | — |
| array/find | 1.70x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 17.94x slower | 1.60x faster | — |
| mixed/text-search | 76.45x slower | 6.25x slower | — |
| mixed/fibonacci | 1.18x slower | — | 1.22x slower |
| mixed/matrix-multiply | 9.40x slower | 1.11x slower | 8.43x slower |
| mixed/sieve | 1.27x slower | 1.68x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x slower |
| string/concat-long | 1.79x slower |
| string/indexOf | 9.62x faster |
| string/includes | 8.63x faster |
| string/split | 17.07x faster |
| string/replace | 4.69x faster |
| string/case-convert | 6.13x slower |
| string/substring | 76.85x faster |
| string/trim | 6.29x faster |
| string/startsWith-endsWith | 5.17x faster |
| array/push-pop | 1.31x faster |
| array/map-filter | 25.73x faster |
| array/reduce | 2.05x faster |
| array/indexOf | 1.65x faster |
| array/slice | 8.37x faster |
| array/reverse | 1.13x faster |
| array/forEach | 3.51x faster |
| mixed/csv-parse | 28.77x faster |
| mixed/text-search | 12.22x faster |
| mixed/matrix-multiply | 8.47x faster |
| mixed/sieve | 2.14x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.7KB | — |
| string/replace | 289B | 2.5KB | — |
| string/case-convert | 249B | 11.5KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 2.4KB | 2.5KB | — |
| array/reduce | 1.7KB | 2.2KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 1.8KB | 2.4KB | — |
| array/find | 2.0KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | — | 173B |
| mixed/matrix-multiply | 1.5KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 960.8ms | 933.6ms | — |
| string/concat-long | 499.4ms | 779.3ms | — |
| string/indexOf | 461.1ms | 836.1ms | — |
| string/includes | 481.6ms | 794.7ms | — |
| string/split | 572.5ms | 713.2ms | — |
| string/replace | 422.2ms | 735.9ms | — |
| string/case-convert | 404.6ms | 908.8ms | — |
| string/substring | 391.0ms | 594.7ms | — |
| string/trim | 391.0ms | 667.9ms | — |
| string/startsWith-endsWith | 451.3ms | 690.3ms | — |
| array/push-pop | 561.6ms | 607.3ms | — |
| array/sort-i32 | 606.0ms | — | — |
| array/map-filter | 648.6ms | 685.1ms | — |
| array/reduce | 578.8ms | 629.0ms | — |
| array/indexOf | 537.3ms | 591.6ms | — |
| array/slice | 600.6ms | 622.2ms | — |
| array/reverse | 524.0ms | 568.9ms | — |
| array/forEach | 583.1ms | 710.3ms | — |
| array/find | 588.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 624.2ms | 690.8ms | — |
| mixed/text-search | 475.3ms | 726.5ms | — |
| mixed/fibonacci | 466.3ms | — | 495.1ms |
| mixed/matrix-multiply | 580.6ms | 683.1ms | 565.8ms |
| mixed/sieve | 561.8ms | 632.1ms | — |
