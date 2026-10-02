import {typedTransaction} from '@fluentful/orm';
import {withTasks} from './task-setup';

withTasks(async ({tasks, tasksTable, dynamoDB, key}) => {
    const secondKey = {...key, taskId: 'task-2'};
    await typedTransaction(dynamoDB)
        .add(tasksTable, table => table.update(key)
            .set('status').eq('done').where('status').eq('doing'))
        .add(tasksTable, table => table.update(secondKey)
            .set('status').eq('doing').where('status').eq('todo'))
        .toPromise();

    const first = await tasks.get(key).toPromise();
    const second = await tasks.get(secondKey).toPromise();
    console.log(JSON.stringify({firstStatus: first?.status, secondStatus: second?.status}));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
