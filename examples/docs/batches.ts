import {withTasks} from './task-setup';

withTasks(async ({tasks, newTasks}) => {
    const outcome = await tasks.createBatchResult(newTasks, {concurrency: 2});
    console.log(JSON.stringify({
        completed: outcome.completed.length,
        resumable: outcome.resumable.length,
        unknown: outcome.unknown.length
    }));
    // Reconcile unknown writes before retrying; only resumable is safe to resubmit.
    if (outcome.errors.length > 0) {
        throw outcome.errors[0];
    }
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
