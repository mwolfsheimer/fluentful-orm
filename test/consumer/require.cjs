const orm = require("@fluentful/orm");
const { z } = require("zod");

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

if (typeof orm.defineTable !== "function" || typeof orm.createEngine?.memory !== "function") {
  throw new Error("CommonJS entry point does not expose the public API.");
}
