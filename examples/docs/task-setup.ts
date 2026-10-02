import {createEngine, defineTable, QueryBuilder} from '@fluentful/orm';
import {z} from 'zod';

export const taskSchema = z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    status: z.enum(['todo', 'doing', 'done']),
    title: z.string().min(1),
    priority: z.number().int().min(0),
    tags: z.set(z.string()).optional(),
    notes: z.string().optional(),
    createdAt: z.number().optional(),
    modifiedAt: z.number().optional()
}).strict();

export const tasksTable = defineTable({
    name: 'tasks',
    schema: taskSchema,
    key: {partition: 'projectId', sort: 'taskId'},
    indexes: {
        'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
    }
});

const key = {projectId: 'project-1', taskId: 'task-1'};
const newTask = {
    projectId: 'project-1', taskId: 'task-3',
    status: 'todo' as const, title: 'Review the guide', priority: 3
};
const newTasks = [
    newTask,
    {...newTask, taskId: 'task-4', title: 'Publish the guide'}
];

type TaskContext = {
    tasks: ReturnType<typeof tasksTable.using>;
    tasksTable: typeof tasksTable;
    taskSchema: typeof taskSchema;
    dynamoDB: Parameters<typeof tasksTable.using>[0];
    key: typeof key;
    newTask: typeof newTask;
    newTasks: typeof newTasks;
    taskKeys: Array<typeof key>;
};

export async function withTasks(run: (context: TaskContext) => Promise<void>) {
    const engine = createEngine.memory();
    try {
        await QueryBuilder.createTable({
            name: 'tasks',
            key: {partition: 'projectId', sort: 'taskId'},
            attributes: {projectId: 'S', taskId: 'S', status: 'S', priority: 'N'},
            indexes: {
                'status-index': {kind: 'global', partition: 'status', sort: 'priority'}
            }
        }, engine.db);
        const tasks = tasksTable.using(engine.db);
        await tasks.createBatch([
            {...key, status: 'doing', title: 'Write the guide', priority: 10},
            {...key, taskId: 'task-2', status: 'todo', title: 'Add examples', priority: 5}
        ]);
        await run({
            tasks, tasksTable, taskSchema, dynamoDB: engine.db,
            key, newTask, newTasks,
            taskKeys: [key, {...key, taskId: 'task-2'}]
        });
    } finally {
        await engine.close();
    }
}
