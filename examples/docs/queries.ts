import {withTasks} from './task-setup';

withTasks(async ({tasks}) => {
    const projectTasks = await tasks.query({projectId: 'project-1'})
        .sortKey().beginsWith('task-')
        .toPromise();
    const todoTasks = await tasks.index('status-index')
        .query({status: 'todo'})
        .sortKey().gte(5)
        .toPromise();

    console.log(JSON.stringify({
        projectTitles: projectTasks.map(task => task.title),
        todoTitles: todoTasks.map(task => task.title)
    }));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
