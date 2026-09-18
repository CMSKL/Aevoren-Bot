import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const catalog = JSON.parse(execFileSync(pnpm, ["licenses", "list", "--prod", "--long", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}));

const components = Object.entries(catalog)
  .flatMap(([license, entries]) => entries.flatMap((entry) => {
    const versions = Array.isArray(entry.versions) ? entry.versions : entry.version ? [entry.version] : [];
    return versions.map((version) => ({
      name: String(entry.name),
      version: String(version),
      license,
      homepage: typeof entry.homepage === "string" ? entry.homepage : "",
    }));
  }))
  .toSorted((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const componentRows = components.map((component) => ({
  type: "library",
  "bom-ref": `pkg:npm/${encodePackageName(component.name)}@${component.version}`,
  name: component.name,
  version: component.version,
  purl: `pkg:npm/${encodePackageName(component.name)}@${component.version}`,
  licenses: [{ license: { name: component.license } }],
  ...(component.homepage ? { externalReferences: [{ type: "website", url: component.homepage }] } : {}),
}));

const applicationRef = `pkg:npm/${packageJson.name}@${packageJson.version}`;
const digest = createHash("sha256")
  .update(JSON.stringify({ application: applicationRef, components: componentRows }))
  .digest("hex");
const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
const outputPath = resolve(process.env.SBOM_OUTPUT || "dist/aevoren-bot-sbom.cdx.json");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({
  $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: serial,
  version: 1,
  metadata: {
    tools: [{ vendor: "Aevoren Bot contributors", name: "generate-sbom.mjs", version: packageJson.version }],
    component: {
      type: "application",
      "bom-ref": applicationRef,
      name: packageJson.name,
      version: packageJson.version,
      licenses: [{ license: { id: packageJson.license } }],
    },
  },
  components: componentRows,
}, null, 2)}\n`, "utf8");
process.stdout.write(`generated ${outputPath} components=${componentRows.length}\n`);

function encodePackageName(name) {
  return name.startsWith("@") ? `%40${name.slice(1).replace("/", "%2F")}` : name;
}
