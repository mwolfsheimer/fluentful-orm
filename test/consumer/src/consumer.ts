import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createEngine, defineTable, path, ref, QueryBuilder } from "@fluentful/orm";
import type { ExpressionAttributeType, TypedPredicateScope } from "@fluentful/orm";
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

const operandTable = defineTable({
  name: "operand-smoke",
  schema: z.object({
    id: z.string(),
    sort: z.string().regex(/^ITEM#\\d+$/),
    labels: z.array(z.string()).min(2).readonly().optional(),
    tags: z.set(z.string()).min(2).readonly()
  }),
  key: { partition: "id", sort: "sort" }
}).using(engine.db);

operandTable.scan().where("labels").contains("one").where("tags").contains("one");
operandTable.query({ id: "partition" }).sortKey().beginsWith("ITEM#");

const nested = defineTable({
  name: "nested-smoke",
  schema: z.object({
    id: z.string(), category: z.string(), used: z.number(), quota: z.number(),
    profile: z.object({ city: z.string() }).optional(), labels: z.array(z.string())
  }),
  key: { partition: "id" },
  indexes: { category: { kind: "global", partition: "category" } }
}).using(engine.db);
const city = nested.path("profile", "city");
const expressionType: ExpressionAttributeType = "M";
nested.scan().whereAny(group => group.where(city).beginsWith("Lon").where("used").lte(nested.ref("quota")))
  .where("profile").attributeType(expressionType).where("labels").size().not().between(-0.5, 2.5)
  .select("id", city, nested.path("labels", 0)).parallel(0, 2);
nested.index("category").scan().where("category").eq("news").limit(25).select("id", city);
nested.update({ id: "one" }).set(city).eq("London").remove(nested.path("labels", 0));
new QueryBuilder("nested-smoke", engine.db).scan().where(path("profile", "city")).eq("London")
  .where("used").lte(ref("quota"));
const predicateOnly = (group: TypedPredicateScope<{ id: string }>) => group.where("id").exists();
void predicateOnly;

async function verifyBrowserPersistence(): Promise<void> {
  const databaseName = `fluentful-orm-browser-${Date.now()}`;
  const first = createEngine.browser(databaseName);
  await QueryBuilder.createTable("browser-records", "id", first.db);
  await new QueryBuilder("browser-records", first.db).create({
    id: "record-1",
    bytes: new Uint8Array([1, 2, 3]),
    profile: { city: "London" }, labels: ["first", "second"]
  }).toPromise();
  await first.close();

  const restored = createEngine.browser(databaseName);
  const record = await new QueryBuilder("browser-records", restored.db)
    .get({ id: "record-1" })
    .toPromise<{ id: string; bytes: Uint8Array }>();
  const projected = await new QueryBuilder("browser-records", restored.db).get({ id: "record-1" })
    .select(path("profile", "city"), path("labels", 1))
    .toPromise<{ profile: { city: string }; labels: string[] }>();
  await restored.close();
  if (!(record?.bytes instanceof Uint8Array) || record.bytes.length !== 3) {
    throw new Error("IndexedDB record did not persist across engine instances.");
  }
  if (projected.profile.city !== "London" || projected.labels.join() !== "second") {
    throw new Error("Nested IndexedDB projection did not retain its document structure.");
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
