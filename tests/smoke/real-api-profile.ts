import { DatabaseSync } from "node:sqlite";
import { AppRepository } from "../../src/main/database";

/** Reuse encrypted API settings only; never copy chats, memories or scheduled tasks. */
export function copyRealApiProfile(sourcePath: string, destinationPath: string): string {
  const repository = new AppRepository(destinationPath);
  repository.close();
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const destination = new DatabaseSync(destinationPath);
  try {
    const config = source.prepare("SELECT * FROM provider_instances WHERE id = 'openai-compatible.default'").get();
    const credential = source.prepare("SELECT * FROM app_settings WHERE key = 'provider.openai-compatible.default.apiKey' AND encrypted = 1").get();
    if (!config || !credential) throw new Error("Real configured API and encrypted credential are required");
    const model = source.prepare("SELECT model_id FROM bots WHERE provider_instance_id = 'openai-compatible.default' AND model_id <> '' ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1").get() as { model_id: string } | undefined;
    if (!model?.model_id) throw new Error("No previously configured API model is available");
    for (const [table, row] of [["provider_instances", config], ["app_settings", credential]] as const) {
      const columns = Object.keys(row);
      destination.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]!));
    }
    return model.model_id;
  } finally { destination.close(); source.close(); }
}
