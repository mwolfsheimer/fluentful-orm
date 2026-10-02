import {createEngine, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

async function main() {
    const engine = createEngine.memory();
    try {
        // This creates storage; defineTable below only describes validation.
        await QueryBuilder.createTable('tasks', 'id', engine.db);
        const tasks = defineTable({
            name: 'tasks',
            key: {partition: 'id'},
            schema: z.object({
                id: z.string(),
                title: z.string(),
                status: z.enum(['todo', 'doing', 'done'])
            }).strict()
        }).using(engine.db);

        await tasks.create({
            id: 'task-1', title: 'Write the guide', status: 'todo'
        }).toPromise();
        const task = await tasks.get({id: 'task-1'}).toPromise();
        console.log(JSON.stringify(task));
    } finally {
        await engine.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
