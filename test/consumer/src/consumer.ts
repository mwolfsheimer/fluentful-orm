import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchRetryError, createEngine, defineTable, path, ref, QueryBuilder, plus, listAppend, typedReadTransaction } from "@fluentful/orm";
import type { AttributeReference, ExpressionAttributeType, TypedPredicateScope } from "@fluentful/orm";
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
  const transformed = defineTable({
    name: "browser-records", key: { partition: "id" },
    schema: z.object({ id: z.string(), value: z.string().transform(Number), count: z.number().default(0) }),
    outputSchema: z.object({ id: z.string(), value: z.number(), count: z.number() })
  }).using(first.db);
  const previous: { id: string; value: number; count: number } | null = await transformed
    .create({ id: "transformed", value: "3", count: 7 }).returningAllOld().toPromise();
  if (previous !== null || typeof BatchRetryError !== "function") throw new Error("Packaged write contracts are incorrect.");
  await transformed.update({ id: "transformed" }).with({ value: "4" }).toPromise();
  const sparse = await transformed.update({ id: "transformed" }).assign("count", fields => plus(fields.ref("count"), 1))
    .returningUpdatedNew().toPromise();
  if (JSON.stringify(sparse) !== JSON.stringify({ count: 8 })) throw new Error("Sparse update image is incorrect.");
  const typed = await transformed.get({ id: "transformed" }).toPromise();
  if (typed?.value !== 4 || typed.count !== 8) throw new Error("Typed browser round trip failed.");
  const recovery = await transformed.getBatchResult([{ id: "transformed" }, { id: "missing" }], { select: ["count"] });
  if (recovery.completed.length !== 2 || recovery.results[0].count !== 8 || recovery.resumable.length) throw new Error("Recoverable browser read failed.");
  await new QueryBuilder("browser-records", first.db).create({
    id: "record-1",
    bytes: new Uint8Array([1, 2, 3]),
    profile: { city: "London" }, labels: ["first", "second"]
  }).toPromise();
  await new QueryBuilder("browser-records", first.db).update({ id: "record-1" })
    .assign("labels", listAppend(ref("labels") as AttributeReference<string[]>, ["third"])).returningNone().toPromise();
  const transaction = await QueryBuilder.transactGet(first.db).add("browser-records", { id: "transformed" }, ["count"])
    .add("browser-records", { id: "missing" }).toPromise();
  if (transaction[0]?.count !== 8 || transaction[1] !== null) throw new Error("Atomic browser reads failed.");
  const typedDefinition = defineTable({ name: "browser-records", key: { partition: "id" },
    schema: z.object({ id: z.string(), value: z.number(), count: z.number() }) });
  const tuple = await typedReadTransaction(first.db).add(typedDefinition, { id: "transformed" }, ["value"]).toPromise();
  if (tuple[0]?.value !== 4) throw new Error("Typed atomic browser read failed.");
  await new QueryBuilder("browser-records", first.db).update({ id: "record-1" })
    .with({ tenant: "one", region: 1, rank: 2, token: new Uint8Array([3]) }).returningNone().toPromise();
  await QueryBuilder.updateTable("browser-records", first.db, { createIndex: {
    name: "multi", definition: { kind: "global", partition: ["tenant", "region"], sort: ["rank", "token"] },
    attributes: { tenant: "S", region: "N", rank: "N", token: "B" }
  } });
  await QueryBuilder.waitForTable("browser-records", first.db);
  const tablePage = await QueryBuilder.listTablePage(first.db, { limit: 1 });
  if (tablePage.names[0] !== "browser-records") throw new Error("Browser administration paging failed.");
  await first.close();

  const restored = createEngine.browser(databaseName);
  const record = await new QueryBuilder("browser-records", restored.db)
    .get({ id: "record-1" })
    .toPromise<{ id: string; bytes: Uint8Array }>();
  const projected = await new QueryBuilder("browser-records", restored.db).get({ id: "record-1" })
    .select(path("profile", "city"), path("labels", 1))
    .toPromise<{ profile: { city: string }; labels: string[] }>();
  const indexed = defineTable({ name: "browser-records", key: { partition: "id" },
    schema: z.object({ id: z.string(), tenant: z.string(), region: z.number(), rank: z.number(), token: z.instanceof(Uint8Array) }),
    indexes: { multi: { kind: "global", partition: ["tenant", "region"], sort: ["rank", "token"] } }
  }).using(restored.db);
  const matches = await indexed.index("multi").query({ tenant: "one", region: 1 })
    .sortKey("rank").eq(2).sortKey("token").beginsWith(new Uint8Array([3])).toPromise();
  if (matches.length !== 1 || matches[0].id !== "record-1") throw new Error("Browser multi-key index did not persist.");
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
