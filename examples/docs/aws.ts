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
