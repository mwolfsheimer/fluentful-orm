import {withTasks} from './task-setup';

withTasks(async ({tasks, key}) => {
    const complete = () => tasks.update(key)
        .set('status').eq('done')
        .where('status').eq('doing')
        .onConditionFailure().returningAllOld()
        .toResult();

    const first = await complete();
    const second = await complete();
    console.log(JSON.stringify({
        firstApplied: first.applied,
        secondApplied: second.applied,
        previousStatus: second.applied ? null : second.previous?.status
    }));
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
