import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createInMemoryDynamoDB, defineTable } from "@fluentful/orm";
import { z } from "zod";

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  createdAt: z.string()
});

const client = new DynamoDBClient({ region: "us-east-1" });
const inMemoryDynamoDB = createInMemoryDynamoDB();

const users = defineTable({
  name: "users",
  schema: userSchema,
  key: { partition: "id" }
});

void client;
void users;
void inMemoryDynamoDB;
