import orm from "@fluentful/orm";

if (typeof orm.defineTable !== "function" || typeof orm.createEngine?.memory !== "function"
    || typeof orm.path !== "function" || typeof orm.ref !== "function") {
  throw new Error("ESM default import does not expose the public API.");
}
if (!Object.isFrozen(orm.path("profile", "city")) || !Object.isFrozen(orm.ref("quota"))) {
  throw new Error("Packaged document descriptors are not immutable.");
}
