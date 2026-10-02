import {withTasks} from './task-setup';

withTasks(async ({tasks}) => {
    const pageSizes: number[] = [];
    const titles: string[] = [];
    for await (const page of tasks.query({projectId: 'project-1'})
        .where('status').eq('todo')
        .pages({limit: 1})) {
        pageSizes.push(page.items.length);
        titles.push(...page.items.map(task => task.title));
    }
    console.log(JSON.stringify({pageSizes, titles}));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
