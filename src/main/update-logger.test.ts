import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeUpdateDiagnostic, UpdateLogger } from "./update-logger";

describe("update diagnostics", () => {
  it("preserves error codes while removing URLs, credentials and local paths", () => {
    const examplePath = ["", "Users", "example", "private", "file"].join("/");
    const error = Object.assign(new Error(`request failed at https://user:password@updates.invalid/pkg?token=private ${examplePath}`), { code: "ERR_NETWORK_CHANGED" });
    expect(sanitizeUpdateDiagnostic(error)).toBe("ERR_NETWORK_CHANGED: request failed at [url redacted] [path redacted]");
    expect(sanitizeUpdateDiagnostic("download failed C:\\Users\\Alice\\AppData\\update.zip")).not.toContain("Alice");
    expect(sanitizeUpdateDiagnostic("Authorization: Bearer private-token")).not.toContain("private-token");
    expect(sanitizeUpdateDiagnostic({ apiKey: "private-api-key" })).not.toContain("private-api-key");
    expect(sanitizeUpdateDiagnostic({ access_token: "private-access-token" })).not.toContain("private-access-token");
    expect(sanitizeUpdateDiagnostic({ Authorization: "private-authorization" })).not.toContain("private-authorization");
    expect(sanitizeUpdateDiagnostic("Invalid release feed. XML: <private>account</private>")).not.toContain("account");
    expect(sanitizeUpdateDiagnostic("password=private-password")).not.toContain("private-password");
    expect(sanitizeUpdateDiagnostic("x".repeat(5_000))).toHaveLength(4_000);
  });

  it("writes real local logs in order with restricted permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-update-log-"));
    try {
      const path = join(directory, "logs", "updates.log");
      const logger = new UpdateLogger(path);
      logger.info("checking for update");
      logger.error(Object.assign(new Error("net::ERR_CONNECTION_RESET https://private.invalid"), { code: "ERR_CONNECTION_RESET" }));
      await logger.flush();
      const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(records).toEqual([
        expect.objectContaining({ level: "info", message: "checking for update" }),
        expect.objectContaining({ level: "error", message: "ERR_CONNECTION_RESET: net::ERR_CONNECTION_RESET [url redacted]" }),
      ]);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rotates only its own log and remains usable after an unwritable path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-update-log-"));
    try {
      const path = join(directory, "updates.log");
      const logger = new UpdateLogger(path, 160);
      logger.info("first update check");
      await logger.flush();
      logger.error("second update check failed");
      await logger.flush();
      expect(readFileSync(`${path}.previous`, "utf8")).toContain("first update check");
      expect(readFileSync(path, "utf8")).toContain("second update check failed");
      const blocked = join(directory, "not-a-directory");
      writeFileSync(blocked, "existing data");
      const unavailable = new UpdateLogger(join(blocked, "updates.log"));
      unavailable.error("cannot persist");
      await expect(unavailable.flush()).resolves.toBeUndefined();
      expect(readFileSync(blocked, "utf8")).toBe("existing data");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
