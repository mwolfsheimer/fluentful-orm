import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createEngine, defineTable, QueryBuilder } from "@fluentful/orm";
import { z } from "zod";

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  createdAt: z.string()
});

const client = new DynamoDBClient({ region: "us-east-1" });
const engine = createEngine.memory();

const users = defineTable({
  name: "users",
  schema: userSchema,
  key: { partition: "id" }
});

void client;
void users;
void engine;

async function verifyBrowserPersistence(): Promise<void> {
  const databaseName = `fluentful-orm-browser-${Date.now()}`;
  const first = createEngine.indexDB(databaseName);
  await QueryBuilder.createTable("browser-records", "id", first.db);
  await new QueryBuilder("browser-records", first.db).create({
    id: "record-1",
    bytes: new Uint8Array([1, 2, 3])
  }).toPromise();
  await first.close();

  const restored = createEngine.indexDB(databaseName);
  const record = await new QueryBuilder("browser-records", restored.db)
    .get({ id: "record-1" })
    .toPromise<{ id: string; bytes: Uint8Array }>();
  await restored.close();
  if (!(record?.bytes instanceof Uint8Array) || record.bytes.length !== 3) {
    throw new Error("IndexedDB record did not persist across engine instances.");
  }
}

if (typeof document !== "undefined") {
  void verifyBrowserPersistence().then(
    () => { document.body.dataset.browserTest = "passed"; },
    (error: unknown) => {
      document.body.dataset.browserTest = "failed";
      document.body.textContent = error instanceof Error ? error.stack || error.message : String(error);
    }
  );
}
