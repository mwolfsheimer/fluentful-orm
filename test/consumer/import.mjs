import orm from "@fluentful/orm";

if (typeof orm.defineTable !== "function" || typeof orm.createEngine?.memory !== "function") {
  throw new Error("ESM default import does not expose the public API.");
}
