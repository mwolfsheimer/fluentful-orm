const orm = require("@fluentful/orm");

if (typeof orm.defineTable !== "function" || typeof orm.createInMemoryDynamoDB !== "function") {
  throw new Error("CommonJS entry point does not expose the public API.");
}
