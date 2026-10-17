import { createHash, randomUUID } from "node:crypto";
import { SKILL_PACKAGE_MAX_BYTES, type WorkerSkillInstallRequest } from "@shared/skill-execution-contracts";

export const skillFixtureFile = (relativePath: string, bytes: Buffer, mimeType = "application/octet-stream") => ({ relativePath,
  size: bytes.length, mimeType, sha256: createHash("sha256").update(bytes).digest("hex"), dataBase64: bytes.toString("base64") });
export const skillFixturePackage = (): WorkerSkillInstallRequest => ({ id: randomUUID(),
  reference: { resourceId: randomUUID(), revisionId: randomUUID(), digest: "a".repeat(64) },
  files: [skillFixtureFile("SKILL.md", Buffer.from("---\nname: fixture\ndescription: owned bytes\n---\n# Fixture"), "text/markdown"),
    skillFixtureFile("scripts/main.js", Buffer.from("console.log('fixture');"), "text/javascript"),
    skillFixtureFile("assets/raw.bin", Buffer.from([0, 255, 1, 128]))] });

export function maximumSkillPackage(): WorkerSkillInstallRequest {
  const result = skillFixturePackage(); result.files = [];
  let remaining = SKILL_PACKAGE_MAX_BYTES;
  for (let index = 0; index < 251; index++) {
    const size = index === 250 ? remaining : Math.floor(SKILL_PACKAGE_MAX_BYTES / 251); remaining -= size;
    const path = index === 0 ? "SKILL.md" : `assets/${Array.from({ length: 5 }, () => "中".repeat(82)).join("/")}/${"中".repeat(74)}_${String(index).padStart(3, "0")}`;
    result.files.push(skillFixtureFile(path, Buffer.alloc(size, 0xab), `${"a".repeat(60)}/${"b".repeat(59)}`));
  }
  return result;
}
