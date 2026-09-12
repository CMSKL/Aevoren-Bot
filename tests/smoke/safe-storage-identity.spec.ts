import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { MsBotApi } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";

test("decrypts ciphertext from the established ms-bot safeStorage identity when launched from the package", async () => {
  test.setTimeout(30_000);
  const directory = mkdtempSync(join(tmpdir(), "ms-bot-safe-storage-identity-"));
  const ciphertextPath = join(directory, "ciphertext");
  const databasePath = join(directory, "ms-bot.sqlite");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  let legacyApplication: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/v1/models" && request.headers.authorization === "Bearer safe-storage-compatibility-token") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
      return;
    }
    response.writeHead(401);
    response.end();
  });
  try {
    legacyApplication = await electron.launch({
      args: [join(process.cwd(), "tests/fixtures/safe-storage-legacy.mjs")],
      cwd: process.cwd(),
      env: { ...inherited, MS_BOT_SAFE_STORAGE_FIXTURE_PATH: ciphertextPath },
    });
    await expect.poll(() => {
      try {
        return readFileSync(ciphertextPath, "utf8").length;
      } catch {
        return 0;
      }
    }).toBeGreaterThan(0);
    await legacyApplication.close();
    legacyApplication = undefined;

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind to a TCP port");
    const repository = new AppRepository(databasePath);
    repository.setSetting("model.baseUrl", `http://127.0.0.1:${address.port}/v1`, false);
    repository.setSetting("model.modelId", "safe-storage-compatibility-model", false);
    repository.setSetting("model.apiKey", readFileSync(ciphertextPath, "utf8"), true);
    repository.close();

    const environment = Object.fromEntries(
      Object.entries(inherited).filter(([key]) => ![
        "MS_BOT_FAKE_PROVIDER",
        "MS_BOT_USER_DATA_DIR",
        "MS_BOT_DB_PATH",
      ].includes(key)),
    );
    environment.MS_BOT_DB_PATH = databasePath;
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    expect(await application.evaluate(({ app }) => app.getName())).toBe("ms-bot");
    const page = await application.firstWindow();
    const connection = await page.evaluate(() =>
      (window as unknown as { msBot: MsBotApi }).msBot.settings.testModelConnection(),
    );
    expect(connection).toEqual({ ok: true, data: undefined });
  } finally {
    if (application) await application.close();
    if (legacyApplication) await legacyApplication.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
