import type {
    BatchGetItemCommandInput,
    BatchWriteItemCommandInput,
    DeleteItemCommandInput,
    GetItemCommandInput,
    PutItemCommandInput,
    QueryCommandInput,
    ScanCommandInput,
    ConditionCheck,
    UpdateItemCommandInput
} from "@aws-sdk/client-dynamodb";

export type ConditionCheckOperationInput = Omit<ConditionCheck, 'ConditionExpression'> & {ConditionExpression?: string};

export type QueryOperation =
    | {kind: 'getItem', input: GetItemCommandInput}
    | {kind: 'batchGetItem', input: BatchGetItemCommandInput}
    | {kind: 'deleteItem', input: DeleteItemCommandInput}
    | {kind: 'query', input: QueryCommandInput}
    | {kind: 'scan', input: ScanCommandInput}
    | {kind: 'updateItem', input: UpdateItemCommandInput}
    | {kind: 'putItem', input: PutItemCommandInput}
    | {kind: 'conditionCheck', input: ConditionCheckOperationInput}
    | {kind: 'batchWriteItem', input: BatchWriteItemCommandInput};