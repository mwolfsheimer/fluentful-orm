# Connect to DynamoDB on AWS

Keep the typed-table API and replace the local engine with a configured AWS SDK client. Unlike the first tutorial, this guide makes a real AWS read and can incur charges.

## Before you begin

- Complete [the local tutorial](./first-application.md).
- Choose an AWS account and region deliberately.
- Create a table using your infrastructure tooling or the DynamoDB console. For this example, use a **string partition key named `id` and no sort key**. Wait until the table is active.
- Configure credentials through the AWS SDK's supported provider chain. Use a workload role in deployed applications; do not hard-code access keys or place them in examples.
- Grant `dynamodb:GetItem` for the selected table. Creation/deletion or later writes require additional permissions.

See AWS's [credential provider chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html). For library provisioning helpers, see [table administration](../reference/table-admin.md); they do not replace a complete infrastructure deployment.

`defineTable()` never creates a table. Its key definition must match the storage table's key definition.

## Configure your shell

PowerShell:

```powershell
$env:AWS_REGION = 'eu-west-2'
$env:TASKS_TABLE = 'your-existing-table'
# Optional for local development with a configured profile:
$env:AWS_PROFILE = 'your-profile'
```

POSIX shell:

```sh
export AWS_REGION=eu-west-2
export TASKS_TABLE=your-existing-table
export AWS_PROFILE=your-profile
```

Use your own region and profile. Environment variable values do not provision resources or grant permissions.

## Read a task

This is a complete, read-only Node script. Save it as `aws.ts` and run it with your project's TypeScript runner. It is typechecked with the examples, but deliberately excluded from offline execution.

<!-- example: examples/docs/aws.ts -->
```ts
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {defineTable} from '@fluentful/orm';
import {z} from 'zod';

async function main() {
    const name = process.env['TASKS_TABLE'];
    const region = process.env['AWS_REGION'];
    if (!name || !region) {
        throw new Error('Set TASKS_TABLE and AWS_REGION for an existing table.');
    }
    const dynamoDB = new DynamoDBClient({region});
    try {
        const tasks = defineTable({
            name,
            key: {partition: 'id'},
            schema: z.object({
                id: z.string(),
                title: z.string(),
                status: z.enum(['todo', 'doing', 'done'])
            }).strict()
        }).using(dynamoDB);
        const task = await tasks.get({id: 'task-1'}).toPromise();
        console.log(JSON.stringify(task));
    } finally {
        dynamoDB.destroy();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
```
<!-- /example -->

Expected result: `null` if task-1 does not exist, or its JSON record if it matches the declared schema. A schema mismatch throws a Zod error. Missing credentials, permission failures, and wrong-region/table errors are not converted to null.

## Before adding writes

Review [create-only guards](../guides/read-write.md#create) and [update existence conditions](../guides/updates.md#prevent-accidental-upserts). Use temporary tables for experiments, record their names, and delete resources you created when finished. Do not run destructive cleanup against a shared table.

For a composite-key application, use the schema and storage definition from [task setup](./task-setup.md), bind `tasksTable` to the AWS client, and provision the declared index too.

## Browser applications

The package can be bundled for browsers, but Node's credential provider chain is not a browser authentication strategy. Use an appropriate AWS identity flow and least-privilege permissions; never embed long-lived AWS secrets in browser code.

See [browser and persistence boundaries](../guides/local-storage.md). Browser bundling does not imply direct native ESM/CDN support.
