import { describe, expect, it } from "vitest";
import { ENV_COMMAND_MAX_BYTES } from "./environment-contracts";
import { skillArgsSchema, skillRunSchema, workerSkillInstallSchema } from "./skill-execution-schemas";
import { skillScriptCommand } from "./skill-execution-contracts";
const randomUUID = (): string => crypto.randomUUID();

describe("script execution canonical arguments", () => {
  it("normalizes omitted defaults without changing the run intent", () => {
    const input = { sessionId: randomUUID(), executorBotId: randomUUID(), clientNonce: randomUUID(), grantId: randomUUID(), expectedGrantVersion: 1 };
    expect(skillRunSchema.parse(input)).toEqual(skillRunSchema.parse({ ...input, args: [], cwd: ".", timeoutMs: 120_000 }));
  });
  it("retains valid control arguments while bounding their serialized command and rejecting surrogate drift", () => {
    const args = ["\u0001".repeat(3_995), "\u0002".repeat(3_995), "你好 👩🏽‍💻"];
    expect(skillArgsSchema.parse(args)).toEqual(args);
    const command = skillScriptCommand({ packageId: randomUUID(), packageDigest: "a".repeat(64), interpreter: "python", entryPath: "scripts/work.py", args });
    expect(new TextEncoder().encode(command).byteLength).toBeLessThan(ENV_COMMAND_MAX_BYTES);
    expect(() => skillArgsSchema.parse(["\u0001".repeat(4_000), "\u0001".repeat(4_000)])).toThrow();
    expect(() => skillArgsSchema.parse(["\ud800"])).toThrow();
    expect(() => skillArgsSchema.parse(["\0"])).toThrow();
  });
  it("rejects an install path with an unstable UTF-8 identity", () => {
    const reference = { resourceId: randomUUID(), revisionId: randomUUID(), digest: "a".repeat(64) };
    const file = { relativePath: "SKILL.md", size: 0, mimeType: "text/plain", sha256: "b".repeat(64), dataBase64: "" };
    const input = { id: randomUUID(), reference, files: [file, { ...file, relativePath: "scripts/你好.py" }] };
    expect(workerSkillInstallSchema.parse(input)).toEqual(input);
    expect(() => workerSkillInstallSchema.parse({ ...input, files: [file, { ...file, relativePath: "scripts/\ud800.py" }] })).toThrow();
  });
});
