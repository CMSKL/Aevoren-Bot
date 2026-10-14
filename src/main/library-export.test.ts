import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedLibraryExport } from "./library-service";
import { AevorenBotError } from "./errors";
import { writeLibraryExport } from "./library-export";

const directories: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "aevoren-library-export-"));
  directories.push(path);
  return path;
}
function document(): PreparedLibraryExport {
  return { kind: "document", name: "Notes", resourceId: randomUUID(), revisionId: randomUUID(),
    files: [{ relativePath: "document.md", bytes: Buffer.from("真实文档正文\n", "utf8") }] };
}
function skill(): PreparedLibraryExport {
  return { kind: "skill", name: "Research", resourceId: randomUUID(), revisionId: randomUUID(), files: [
    { relativePath: "SKILL.md", bytes: Buffer.from("---\nname: research\ndescription: Reads sources\n---\nUse references/guide.md.") },
    { relativePath: "references/guide.md", bytes: Buffer.from("A verified source.") },
    { relativePath: "assets/example.png", bytes: Buffer.from([0, 255, 137, 80, 78, 71, 13, 10]) },
    { relativePath: "scripts/work.sh", bytes: Buffer.from("#!/bin/sh\ntouch never-run\n") },
  ] };
}
function noStaging(directory: string): void {
  expect(readdirSync(directory).filter((name) => name.startsWith(".aevoren-export-"))).toEqual([]);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("create-only library exports on real filesystems", () => {
  it("publishes an exact document with no temporary files", async () => {
    const directory = root();
    const target = join(directory, "notes.md");
    const snapshot = document();
    const output = await writeLibraryExport(snapshot, target, undefined, () => undefined);
    expect(output).toBe(join(await realpath(dirname(target)), basename(target)));
    expect(readFileSync(target)).toEqual(snapshot.files[0]!.bytes);
    expect(readdirSync(directory)).toEqual(["notes.md"]);
    noStaging(directory);
  });

  it("publishes a whole Skill with binary and nested paths without executing its scripts", async () => {
    const directory = root();
    const target = join(directory, "research-skill");
    const snapshot = skill();
    await writeLibraryExport(snapshot, target, undefined, () => undefined);
    for (const file of snapshot.files) expect(readFileSync(join(target, ...file.relativePath.split("/")))).toEqual(file.bytes);
    expect(existsSync(join(directory, "never-run"))).toBe(false);
    expect(readdirSync(directory)).toEqual(["research-skill"]);
    noStaging(directory);
  });

  it.each(["document", "skill"] as const)("preserves an existing file when exporting %s", async (kind) => {
    const directory = root();
    const target = join(directory, "existing");
    const sentinel = Buffer.from([0, 255, 1, 2, 3]);
    writeFileSync(target, sentinel);
    await expect(writeLibraryExport(kind === "document" ? document() : skill(), target, undefined, () => undefined))
      .rejects.toMatchObject({ code: "LIBRARY_EXPORT_CONFLICT" });
    expect(readFileSync(target)).toEqual(sentinel);
    expect(readdirSync(directory)).toEqual(["existing"]);
    noStaging(directory);
  });

  it.each(["document", "skill"] as const)("preserves an existing directory and sentinel when exporting %s", async (kind) => {
    const directory = root();
    const target = join(directory, "existing");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel.txt"), "KEEP");
    await expect(writeLibraryExport(kind === "document" ? document() : skill(), target, undefined, () => undefined))
      .rejects.toMatchObject({ code: "LIBRARY_EXPORT_CONFLICT" });
    expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("KEEP");
    expect(readdirSync(target)).toEqual(["sentinel.txt"]);
    expect(readdirSync(directory)).toEqual(["existing"]);
    noStaging(directory);
  });

  it("refuses an existing empty Skill directory without removing it", async () => {
    const directory = root();
    const target = join(directory, "empty");
    mkdirSync(target);
    await expect(writeLibraryExport(skill(), target, undefined, () => undefined)).rejects.toMatchObject({ code: "LIBRARY_EXPORT_CONFLICT" });
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(target)).toEqual([]);
    noStaging(directory);
  });

  it.each(["../escape.md", "/escape.md", "references/../escape.md", "references/file:stream", "assets/CON.txt"])("rejects traversal or unsafe path %s before publishing", async (relativePath) => {
    const directory = root();
    const target = join(directory, "unsafe");
    const snapshot = skill();
    snapshot.files.push({ relativePath, bytes: Buffer.from("bad") });
    await expect(writeLibraryExport(snapshot, target, undefined, () => undefined)).rejects.toMatchObject({ code: "LIBRARY_FILE_INVALID" });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("rejects duplicate paths and cleans failed staging without creating a target", async () => {
    const directory = root();
    const target = join(directory, "duplicate");
    const snapshot = skill();
    snapshot.files.push({ ...snapshot.files[0]! });
    await expect(writeLibraryExport(snapshot, target, undefined, () => undefined)).rejects.toMatchObject({ code: "LIBRARY_FILE_INVALID" });
    expect(existsSync(target)).toBe(false);
    noStaging(directory);
    const collision = skill();
    collision.files.push({ relativePath: "references", bytes: Buffer.from("file collides with a directory") });
    await expect(writeLibraryExport(collision, target, undefined, () => undefined)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    noStaging(directory);
  });

  it.each(["document", "skill"] as const)("cleans staged %s when permission is revoked before publication", async (kind) => {
    const directory = root();
    const target = join(directory, "revoked");
    await expect(writeLibraryExport(kind === "document" ? document() : skill(), target, undefined, () => {
      if (readdirSync(directory).some((name) => name.startsWith(".aevoren-export-"))) throw new AevorenBotError("LIBRARY_NOT_BOUND");
    })).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    expect(existsSync(target)).toBe(false);
    noStaging(directory);
  });

  it.each(["document", "skill"] as const)("rolls back newly published %s when permission is revoked before success", async (kind) => {
    const directory = root();
    const target = join(directory, "revoked-after-publish");
    writeFileSync(join(directory, "untouched.txt"), "KEEP");
    await expect(writeLibraryExport(kind === "document" ? document() : skill(), target, undefined, () => {
      if (kind === "document" ? existsSync(target) : existsSync(join(target, "SKILL.md"))) throw new AevorenBotError("LIBRARY_DISABLED");
    })).rejects.toMatchObject({ code: "LIBRARY_DISABLED" });
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(directory, "untouched.txt"), "utf8")).toBe("KEEP");
    noStaging(directory);
  });

  it.each(["document", "skill"] as const)("cancels partial publication of %s and removes only its new files", async (kind) => {
    const directory = root();
    const target = join(directory, "cancelled");
    const controller = new AbortController();
    await expect(writeLibraryExport(kind === "document" ? document() : skill(), target, controller.signal, () => {
      if (kind === "document" ? existsSync(target) : existsSync(join(target, "SKILL.md"))) controller.abort();
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(target)).toBe(false);
    noStaging(directory);
  });

  it("does not create a stage or output for an already cancelled request", async () => {
    const directory = root();
    const controller = new AbortController();
    controller.abort();
    await expect(writeLibraryExport(skill(), join(directory, "cancelled"), controller.signal, () => undefined)).rejects.toMatchObject({ name: "AbortError" });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("refuses to remove a destination replaced by another owner during rollback", async () => {
    const directory = root();
    const target = join(directory, "replaced");
    let replaced = false;
    await expect(writeLibraryExport(skill(), target, undefined, () => {
      if (!replaced && existsSync(join(target, "SKILL.md"))) {
        replaced = true;
        rmSync(target, { recursive: true });
        mkdirSync(target);
        writeFileSync(join(target, "sentinel.txt"), "ANOTHER OWNER");
        throw new AevorenBotError("LIBRARY_NOT_BOUND");
      }
    })).rejects.toThrow();
    expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("ANOTHER OWNER");
    noStaging(directory);
  });
});
