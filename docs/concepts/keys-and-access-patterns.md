# Keys and access patterns

An **access pattern** is a question your application needs the database to answer. Start with the question, then choose the keys.

For our example:

- Get one task using its project and task identifiers.
- List tasks belonging to one project.
- List tasks across projects by status and priority.

## Identify one record

A partition key is the required first part of a table key. A sort key is an optional second part. Together they uniquely identify a record.

In the task example:

```ts
key: {partition: 'projectId', sort: 'taskId'}
```

To retrieve one task, provide **both** fields:

```ts
const task = await tasks.get({
    projectId: 'project-1', taskId: 'task-1'
}).toPromise();
```

This is a fragment using the [task setup](../getting-started/task-setup.md). Giving only `projectId` cannot identify which task to get. Exact keys also reject unrelated fields.

A DynamoDB partition key is not a relational foreign-key declaration. It does not automatically link or load a project record.

## Retrieve a group

A query selects one partition-key value:

```ts
const projectTasks = await tasks.query({projectId: 'project-1'}).toPromise();
```

A sort-key comparison can narrow that group. Query ordering follows the selected sort key, not insertion time or an arbitrary document field.

The example uses readable identifiers. String sort keys compare lexically: `task-10` can sort before `task-2`. Choose an encoding that matches your intended ordering.

## Ask a different question

The table key does not directly answer "all todo tasks across projects". A secondary index provides another key-based route to the same records.

Our status index uses status as its partition key and priority as its sort key. This explains the example; real designs must consider traffic distribution and low-cardinality keys rather than copying it blindly.

Read [indexes and consistency](./indexes-and-consistency.md) next.

## What the library validates, and what you still decide

The typed API checks key field names, types, completeness, and supported comparisons. It does not decide whether your keys distribute traffic well or meet every future query requirement.

For AWS's underlying model, see [DynamoDB core components](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.CoreComponents.html). For exact library constraints, see [typed tables](../reference/typed-tables.md).
