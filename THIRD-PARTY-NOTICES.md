# Third-party notices

This project is MIT licensed (see `LICENSE`). Below is the licensing position of
everything it depends on, and why none of it constrains how this code may be
licensed or used.

## Summary

**No GPL or AGPL anywhere in the tree.** Those are the licenses that could
oblige this project to be released under the same terms; neither is present.
Across all 165 transitive dependencies:

| License | Count | Type |
|---|---|---|
| MIT | 141 | permissive |
| ISC | 9 | permissive |
| Apache-2.0 | 6 | permissive |
| BSD-2/3-Clause | 4 | permissive |
| 0BSD, dual-licensed | 3 | permissive |
| **LGPL-3.0-or-later** | 2 | weak copyleft — see below |
| **MPL-2.0** | 2 | weak copyleft — dev only |

## The two weak-copyleft cases

### LGPL-3.0-or-later — `@img/sharp-libvips-*`

`sharp` itself is Apache-2.0. It ships prebuilt binaries of **libvips**, the
image-processing library it wraps, which is LGPL-3.0-or-later.

This does **not** require this project to be LGPL. The LGPL is specifically
designed so that software may *use* the library without inheriting its terms;
the reciprocal obligation applies to modifications of the library itself. libvips
is used here unmodified, through sharp's public API, as a separate binary
installed by npm at deploy time. This project is also operated as a network
service rather than distributed as a binary, so the LGPL's distribution
obligations are not triggered in the first place.

If the app were ever redistributed as a packaged binary, the requirement would be
to include this notice and allow the recipient to substitute their own build of
libvips — not to open-source anything here.

### MPL-2.0 — `lightningcss`

MPL-2.0 is file-level copyleft: only modified MPL-licensed *files* must remain
MPL. Nothing here modifies it, and it is a **development dependency only**
(pulled in by Vitest via Vite). It is never part of what runs in production.

## Front-end dependencies loaded from a CDN

- **Filerobot Image Editor** (Scaleflex) — MIT. Used for the customer self-edit
  step, loaded from Scaleflex's CDN.
- **Stripe.js** — proprietary, and Stripe's terms *require* it to be loaded from
  their CDN rather than bundled. Free to use as part of using Stripe. It is not
  redistributed here.

## Attribution

Nothing above requires source disclosure. The permissive licenses (MIT, ISC,
BSD, Apache-2.0) do require that copyright notices be preserved, which is
satisfied by the license files inside each package in `node_modules`.

## Project ownership

Built by Clara Tucker for Pochron Studios, with their permission. The Pochron
Studios name, brand, pricing and product details are used with permission and
are not covered by the MIT license on this code.
