import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const builder = createRequire(require.resolve("app-builder-lib"));
const electronGet = createRequire(builder.resolve("@electron/get"));
const got = createRequire(electronGet.resolve("got"));
const cacheableRequest = createRequire(got.resolve("cacheable-request"));
const policyPath = cacheableRequest.resolve("http-cache-semantics");
const CachePolicy = cacheableRequest("http-cache-semantics");
const policyPackage = createRequire(policyPath)("./package.json");

assert.equal(policyPackage.version, "4.2.0", "Review and remove the audit exception when the upstream package changes");
const patch = readFileSync(new URL("../patches/http-cache-semantics@4.2.0.patch", import.meta.url), "utf8");
assert.ok(patch.includes("GHSA-ch52-4w7c-c8xp"));
assert.ok(readFileSync(policyPath, "utf8").includes("Aevoren backport"), "The mandatory cache privacy patch is not installed");

const request = { url: "https://downloads.example.org/app.zip", method: "GET", headers: { host: "downloads.example.org" } };
let checks = 0;
for (const responseHeaders of [
  { "cache-control": "max-age=600", "set-cookie": "session=other-user" },
  { "cache-control": "immutable", "set-cookie": "session=other-user" },
  { "cache-control": "proxy-revalidate, max-age=600" },
  { "cache-control": "no-cache, max-age=600" },
  { "cache-control": "private, max-age=600" },
  { "cache-control": "no-store, max-age=600" },
  { "cache-control": "public, max-age=600", vary: "*" },
]) {
  const original = new CachePolicy(request, { status: 200, headers: responseHeaders });
  for (const policy of [original, CachePolicy.fromObject(original.toObject())]) {
    for (const directive of ["max-stale", "max-stale=999999999"]) {
      const incoming = { ...request, headers: { ...request.headers, "cache-control": directive } };
      assert.equal(policy.satisfiesWithoutRevalidation(incoming), false);
      const result = policy.evaluateRequest(incoming);
      assert.equal(result.response, undefined, "A privacy-protected cache entry must not expose cached headers or body");
      assert.equal(result.revalidation.synchronous, true);
      checks += 1;
    }
  }
}

const publicPolicy = new CachePolicy(request, { status: 200, headers: { "cache-control": "public, max-age=600" } });
assert.equal(publicPolicy.satisfiesWithoutRevalidation(request), true);
assert.equal(CachePolicy.fromObject(publicPolicy.toObject()).satisfiesWithoutRevalidation(request), true);
const expiredPublicPolicy = new CachePolicy(request, { status: 200, headers: { "cache-control": "public, max-age=0" } });
assert.equal(expiredPublicPolicy.satisfiesWithoutRevalidation({ ...request, headers: { ...request.headers, "cache-control": "max-stale=600" } }), true);
assert.equal(new CachePolicy(request, { status: 200, headers: { "cache-control": "max-age=600", "set-cookie": "personal-session" } }, { shared: false }).satisfiesWithoutRevalidation(request), true);
process.stdout.write(`cache privacy backport verified: ${checks + 4} checks against the installed library\n`);
