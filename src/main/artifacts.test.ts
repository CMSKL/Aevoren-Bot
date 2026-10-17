import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveArtifact } from "./artifacts";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});
describe("artifacts", () => {
  it("writes a Markdown result once with a safe filename", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-artifact-"));
    directories.push(directory);
    const path = join(directory, "result.md");
    const saved = await saveArtifact(path, { name: "result", content: "# Result\n" });
    expect(saved).toMatchObject({ name: "result.md", path, size: 9 });
    expect(readFileSync(path, "utf8")).toBe("# Result\n");
    await expect(saveArtifact(path, { name: "result", content: "other" })).rejects.toMatchObject({ code: "ARTIFACT_ALREADY_EXISTS" });
  });
});
