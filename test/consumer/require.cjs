const orm = require("@fluentful/orm");
const { z } = require("zod");
for (const name of ["transactGet", "typedReadTransaction", "literal", "ifNotExists", "listAppend", "plus", "minus",
  "listTablePage", "waitForTable", "waitForTableDeleted", "updateTable", "configureTimeToLive", "describeTimeToLive"]) {
  if (typeof orm[name] !== "function") throw new Error(`Missing CommonJS export: ${name}`);
}

const table = orm.defineTable({
  name: "operand-smoke",
  schema: z.object({
    id: z.string(),
    sort: z.string().regex(/^ITEM#\\d+$/),
    labels: z.array(z.string()).min(2).readonly().optional(),
    tags: z.set(z.string()).min(2).readonly(),
    binary: z.instanceof(Uint8Array).refine((bytes) => bytes.length === 8)
  }),
  key: { partition: "id", sort: "sort" }
});
table.parseContainsValue("labels", "one");
table.parseContainsValue("tags", "one");
table.parsePrefixValue("sort", "ITEM#");
table.parsePrefixValue("binary", new Uint8Array([1]));

if (typeof orm.defineTable !== "function" || typeof orm.createEngine?.memory !== "function"
    || typeof orm.path !== "function" || typeof orm.ref !== "function") {
  throw new Error("CommonJS entry point does not expose the public API.");
}

async function verifyExpressions() {
  const engine = orm.createEngine.memory([{
    name: "nested-smoke", key: { partition: "id" }, attributes: { id: "S", category: "S" },
    indexes: { category: { kind: "global", partition: "category" } }
  }]);
  try {
    const records = orm.defineTable({
      name: "nested-smoke", key: { partition: "id" },
      schema: z.object({ id: z.string(), category: z.string(), used: z.number(), quota: z.number(),
        profile: z.object({ city: z.string(), country: z.string().default("GB") }), labels: z.array(z.string()) }),
      indexes: { category: { kind: "global", partition: "category" } }
    }).using(engine.db);
    await records.create({ id: "one", category: "news", used: 1, quota: 3, profile: { city: "London" }, labels: ["a", "b"] }).toPromise();
    const result = await records.index("category").scan().where("category").eq("news")
      .whereAll(group => group.where("used").lte(records.ref("quota")).where("labels").size().eq(2))
      .select(records.path("profile", "city"), records.path("labels", 1)).toPromise();
    if (JSON.stringify(result) !== JSON.stringify([{ profile: { city: "London" }, labels: ["b"] }])) {
      throw new Error("Packaged nested expression API returned an incorrect projection.");
    }
  } finally {
    await engine.close();
  }
}
void verifyExpressions().catch(error => { console.error(error); process.exitCode = 1; });
