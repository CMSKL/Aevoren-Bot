import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import electronExecutable from "electron";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";

const execFileAsync = promisify(execFile);
const electronPath = electronExecutable as unknown as string;

test("decrypts ciphertext from the established Aevoren Bot safeStorage identity when launched from the package", async () => {
  test.setTimeout(30_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-bot-safe-storage-identity-"));
  const ciphertextPath = join(directory, "ciphertext");
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
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
    // This standalone process only encrypts a fixed non-sensitive token; decryption happens through the product IPC path.
    await execFileAsync(electronPath, [join(process.cwd(), "tests/fixtures/safe-storage-legacy.mjs")], {
      cwd: process.cwd(),
      env: { ...inherited, AEVOREN_BOT_SAFE_STORAGE_FIXTURE_PATH: ciphertextPath },
    });
    expect(readFileSync(ciphertextPath, "utf8").length).toBeGreaterThan(0);

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
        "AEVOREN_BOT_FAKE_PROVIDER",
        "AEVOREN_BOT_USER_DATA_DIR",
        "AEVOREN_BOT_DB_PATH",
      ].includes(key)),
    );
    environment.AEVOREN_BOT_DB_PATH = databasePath;
    environment.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE = "1";
    application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
    expect(await application.evaluate(({ app }) => app.getName())).toBe("Aevoren Bot");
    expect(await application.evaluate(({ app }) => app.commandLine.hasSwitch("use-mock-keychain"))).toBe(false);
    const page = await application.firstWindow();
    const connection = await page.evaluate(() =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.testModelConnection(),
    );
    expect(connection).toEqual({ ok: true, data: undefined });
  } finally {
    if (application) await application.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
