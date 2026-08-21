# Deno core bootstrap fixture

These files are unchanged copies of Deno's core bootstrap sources at commit
`1d4e6c1cb855b62a7fb572c6c138e4e8b4e7fa44` (Deno 2.9.2,
`deno_core` 0.407.0):

| Upstream path | SHA-256 |
| --- | --- |
| `libs/core/00_primordials.js` | `5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52` |
| `libs/core/00_infra.js` | `33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287` |
| `libs/core/01_core.js` | `6e67972322cc5385a2b642a4f7e941fccb6f992c9de662a5111d11fd0aaf1a3a` |

They are retained verbatim so the integration test cannot silently replace
Deno's real wrappers with a reduced reproduction. Deno distributes these
sources under the MIT license; see the copyright and license notice in each
file and Deno's repository-level `LICENSE.md`.
