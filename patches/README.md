# Dependency security backports

## http-cache-semantics 4.2.0

The locked Electron packaging toolchain depends on `http-cache-semantics` 4.2.0. The upstream advisory [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) and [maintainer issue #56](https://github.com/kornelski/http-cache-semantics/issues/56) describe how a client `max-stale` directive can bypass shared-cache privacy rules. No corrected npm version was available when this backport was added on 2026-10-03.

`pnpm-workspace.yaml` applies the local patch through `patchedDependencies`. The patch forces synchronous revalidation, with no cached response, for shared cookies lacking explicit `public`, proxy revalidation, `no-cache`, `no-store`, private entries, and `Vary: *`. Ordinary public caching and private browser caches remain supported.

`pnpm security:audit` first tests the actually installed packaging dependency, including serialized/deserialized cache entries. It then reads the unfiltered high/critical audit JSON, rejects all other high/critical findings, and accepts this one advisory only when every affected path is the patched 4.2.0 build-time dependency. npm still reports the original 4.2.0 version because it cannot inspect a local patch. No global audit ignore list is configured. Registry failures, unknown report formats, unaccounted high/critical findings, a missing patch, or a changed package version fail verification. Moderate findings retain the existing non-blocking release policy and their count is reported. Replace the backport with an upstream corrected version and remove the exception and verifier when that release is available.

## Upstream license for http-cache-semantics

BSD-2-Clause. The original package license is retained by the installed dependency; the patch includes portions of its source context.

Copyright 2016-2018 Kornel Lesiński

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
