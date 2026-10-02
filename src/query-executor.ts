import {abortableDelay} from './execution-options';
import {pathSegments} from './document-path';
import type {AttributePath} from './document-path';
import {
    BatchGetItemCommand,
    BatchWriteItemCommand,
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    ScanCommand,
    TransactWriteItemsCommand,
    UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import type {BatchGetItemCommandOutput, BatchWriteItemCommandOutput, QueryCommandOutput, ScanCommandOutput} from "@aws-sdk/client-dynamodb";
import type {AttributeValue, BatchGetItemCommandInput, BatchWriteItemCommandInput, ConsumedCapacity, ItemCollectionMetrics} from "@aws-sdk/client-dynamodb";
import type {QueryOperation} from "./query-operation";
import {QuerySerializer} from "./query-serializer";
import type {DynamoResponse, GenericDocument, QueryCursor, QueryPage} from "./types";
import {ValueUtils} from './value-utils';

type QueryLogger = null | ((message: any) => void);
type DocumentParser = null | ((document: unknown, projection?: readonly AttributePath[] | null, partial?: boolean) => GenericDocument<any>);
type ExecutionResult<T> = T | GenericDocument<any> | GenericDocument<any>[] | null | undefined;
export type BatchRequestItems = NonNullable<BatchGetItemCommandInput['RequestItems']> | NonNullable<BatchWriteItemCommandInput['RequestItems']>;
export type BatchObserver = (submitted: BatchRequestItems, unprocessed?: BatchRequestItems) => void;
type LastEvaluatedKey = Record<string, AttributeValue>;
type MetadataOutput = {ConsumedCapacity?: ConsumedCapacity | ConsumedCapacity[], ItemCollectionMetrics?: ItemCollectionMetrics | ItemCollectionMetrics[] | Record<string, ItemCollectionMetrics[]>};

/** Unprocessed work and completed read results from one exhausted batch chunk, not the entire batch call. */
export class BatchRetryError extends Error {
    readonly unprocessedItems: BatchRequestItems;
    readonly partialResults: readonly GenericDocument<unknown>[];
    constructor(readonly operation: 'batchGetItem' | 'batchWriteItem', requestItems: BatchRequestItems, results: GenericDocument<unknown>[]) {
        super('DynamoDB batch operation still had unprocessed items after 8 retries');
        this.name = 'BatchRetryError';
        this.unprocessedItems = ValueUtils.clone(requestItems);
        this.partialResults = ValueUtils.clone(results);
    }
}

/** Executes one QueryBuilder operation against DynamoDB and parses its results. */
export class QueryExecutor {
    private output: GenericDocument<any>[] = [];
    private batchRetryCount = 0;
    private consumedCapacity: ConsumedCapacity[] = [];
    private itemCollectionMetrics: ItemCollectionMetrics[] = [];

    /** Creates an executor for one assembled operation and its result parser. */
    constructor(
        private dynamoDB: DynamoDBClient,
        private operation: QueryOperation,
        private documents: GenericDocument<any>[],
        private hardLimit: number | null,
        private logger: QueryLogger,
        private requestId: string,
        private documentParser: DocumentParser,
        private projection: readonly AttributePath[] | null = null,
        private signal?: AbortSignal,
        private batchObserver?: BatchObserver
    ) {
        this.operation = ValueUtils.clone(operation);
        this.documents = ValueUtils.clone(documents);
        this.projection = ValueUtils.clone(projection);
    }

    /** Executes the operation, following query/scan pages and retrying unprocessed batches. */
    execute<T>(): Promise<ExecutionResult<T>> {
        return this.executeResponse<T>().then((response) => response.value);
    }

    batchResults<T>(): T[] {
        return ValueUtils.clone(this.output) as T[];
    }

    /** Executes the operation and includes capacity and item-collection metadata. */
    async executeResponse<T>(): Promise<DynamoResponse<ExecutionResult<T>>> {
        const value = await this.executeOperation<T>();
        return {
            value: value,
            consumedCapacity: this.consumedCapacity,
            itemCollectionMetrics: this.itemCollectionMetrics
        };
    }

    /** Executes one query or scan page from an optional cursor. */
    async executePage<T>(cursor: QueryCursor | null = null): Promise<QueryPage<T>> {
        if (this.operation.kind !== 'query' && this.operation.kind !== 'scan') {
            throw new Error('Pages are supported only for query and scan operations');
        }

        this.signal?.throwIfAborted();
        this.applyLastEvaluatedKey(cursor === null ? null : QuerySerializer.serialiseMap(cursor));
        this.logRequest();
        const result = this.operation.kind === 'query'
            ? await this.dynamoDB.send(new QueryCommand(this.operation.input), {abortSignal: this.signal})
            : await this.dynamoDB.send(new ScanCommand(this.operation.input), {abortSignal: this.signal});
        this.captureMetadata(result);
        const items = result.Items ? result.Items.map((item) => this.parseDocument(item)) as T[] : [];
        this.logResult(items.length, result.ConsumedCapacity);

        return {
            items: items,
            ...(result.Count === undefined ? {} : {count: result.Count}),
            ...(result.ScannedCount === undefined ? {} : {scannedCount: result.ScannedCount}),
            ...(result.ConsumedCapacity === undefined ? {} : {consumedCapacity: ValueUtils.clone(result.ConsumedCapacity)}),
            cursor: result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length > 0
                ? QuerySerializer.parseItem(result.LastEvaluatedKey) as QueryCursor : null
        };
    }

    /** Lazily iterates through query or scan pages. */
    async *pages<T>(cursor: QueryCursor | null = null): AsyncIterable<QueryPage<T>> {
        let nextCursor = cursor === null ? null : ValueUtils.clone(cursor);

        do {
            const page = await this.executePage<T>(nextCursor);
            const pageCursor = page.cursor === null ? null : ValueUtils.clone(page.cursor);
            yield page;
            nextCursor = pageCursor;
        } while (nextCursor !== null);
    }

    /** Lazily iterates through records across query or scan pages. */
    async *items<T>(cursor: QueryCursor | null = null): AsyncIterable<T> {
        for await (const page of this.pages<T>(cursor)) {
            for (const item of page.items) {
                this.signal?.throwIfAborted();
                yield item;
            }
        }
    }

    private async executeOperation<T>(lastEvaluatedKey: LastEvaluatedKey | null = null): Promise<ExecutionResult<T>> {
        this.signal?.throwIfAborted();
        this.applyLastEvaluatedKey(lastEvaluatedKey);

        if ((this.operation.kind === 'query' || this.operation.kind === 'scan') && this.operation.input.Select === 'COUNT') {
            return this.executeCount<T>();
        }

        this.logRequest();

        switch (this.operation.kind) {
            case 'getItem':
                return this.dynamoDB.send(new GetItemCommand(this.operation.input), {abortSignal: this.signal}).then((result) => {
                    this.captureMetadata(result);
                    if (result.Item) {
                        const parsed = this.parseDocument(result.Item);
                        this.logResult(parsed ? 1 : 0, result.ConsumedCapacity);
                        return parsed;
                    }

                    return null;
                });

            case 'batchGetItem':
                this.batchObserver?.(this.operation.input.RequestItems!);
                return this.dynamoDB.send(new BatchGetItemCommand(this.operation.input), {abortSignal: this.signal})
                    .then((result) => this.handleBatchGetResult<T>(result));

            case 'deleteItem':
                return this.dynamoDB.send(new DeleteItemCommand(this.operation.input), {abortSignal: this.signal}).then((result) => {
                    this.captureMetadata(result);
                    if (result.Attributes) {
                        const parsed = this.parseDocument(result.Attributes);
                        this.logResult(parsed ? 1 : 0, result.ConsumedCapacity);
                        return parsed;
                    }

                    return this.operation.kind === 'deleteItem' && this.operation.input.ReturnValues === 'NONE' ? undefined : null;
                });

            case 'query':
                return this.dynamoDB.send(new QueryCommand(this.operation.input), {abortSignal: this.signal})
                    .then((result) => this.handlePagedResult<T>(result));

            case 'scan':
                return this.dynamoDB.send(new ScanCommand(this.operation.input), {abortSignal: this.signal})
                    .then((result) => this.handlePagedResult<T>(result));

            case 'updateItem':
                return this.dynamoDB.send(new UpdateItemCommand(this.operation.input), {abortSignal: this.signal}).then((result) => {
                    this.captureMetadata(result);
                    if (result.Attributes) {
                        const parsed = this.parseDocument(result.Attributes);
                        this.logResult(parsed ? 1 : 0, result.ConsumedCapacity);
                        return parsed;
                    }

                    return this.operation.kind === 'updateItem' && this.operation.input.ReturnValues === 'NONE' ? undefined : null;
                });

            case 'putItem':
                const putReturnValues = this.operation.input.ReturnValues;
                return this.dynamoDB.send(new PutItemCommand(this.operation.input), {abortSignal: this.signal}).then((result) => {
                    const returnsOld = (this.operation.input as {ReturnValues?: string}).ReturnValues === 'ALL_OLD';
                    this.captureMetadata(result);
                    this.logResult(1, result.ConsumedCapacity);
                    if (returnsOld) {
                        return result.Attributes ? this.parseDocument(result.Attributes) : null;
                    }
                    if (putReturnValues === 'ALL_OLD') {
                        return result.Attributes ? this.parseDocument(result.Attributes) : null;
                    }
                    return this.documents[0];
                });

            case 'conditionCheck':
                if (!this.operation.input.ConditionExpression) {
                    return Promise.reject(new Error('conditionCheck requires at least one condition'));
                }
                return this.dynamoDB.send(new TransactWriteItemsCommand({
                    ReturnConsumedCapacity: 'INDEXES',
                    TransactItems: [{ConditionCheck: {
                        ...this.operation.input,
                        ConditionExpression: this.operation.input.ConditionExpression
                    }}]
                }), {abortSignal: this.signal}).then((result) => {
                    this.captureMetadata(result);
                    this.logResult(0, result.ConsumedCapacity);
                    return result as T;
                });

            case 'batchWriteItem':
                this.batchObserver?.(this.operation.input.RequestItems!);
                return this.dynamoDB.send(new BatchWriteItemCommand(this.operation.input), {abortSignal: this.signal})
                    .then((result) => this.handleBatchWriteResult<T>(result));
        }
    }

    private handleBatchGetResult<T>(result: BatchGetItemCommandOutput): Promise<ExecutionResult<T>> | GenericDocument<any>[] {
        if (this.operation.kind === 'batchGetItem') this.batchObserver?.(this.operation.input.RequestItems!, result.UnprocessedKeys ?? {});
        this.captureMetadata(result);
        if (result.Responses) {
            Object.keys(result.Responses).forEach((tableName) => {
                if (result.Responses) {
                    result.Responses[tableName].forEach(item => this.output.push(this.parseDocument(item)));
                }
            });
            this.logResult(this.output.length, result.ConsumedCapacity);
        }

        if (result.UnprocessedKeys && Object.keys(result.UnprocessedKeys).length > 0) {
            return this.retryUnprocessedBatch<T>(result.UnprocessedKeys);
        }

        return this.output;
    }

    private handleBatchWriteResult<T>(result: BatchWriteItemCommandOutput): Promise<ExecutionResult<T>> | GenericDocument<any>[] {
        if (this.operation.kind === 'batchWriteItem') this.batchObserver?.(this.operation.input.RequestItems!, result.UnprocessedItems ?? {});
        this.captureMetadata(result);
        if (result.UnprocessedItems && Object.keys(result.UnprocessedItems).length > 0) {
            return this.retryUnprocessedBatch<T>(result.UnprocessedItems);
        }

        return this.documents;
    }

    private handlePagedResult<T>(result: QueryCommandOutput | ScanCommandOutput): Promise<ExecutionResult<T>> | GenericDocument<any>[] {
        this.captureMetadata(result);
        if (result.Items) {
            const parsed = result.Items.map((item) => this.parseDocument(item));
            this.logResult(parsed.length, result.ConsumedCapacity);
            parsed.forEach((document) => this.output.push(document));
        }

        if (result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length > 0 && (this.hardLimit === null || this.output.length < this.hardLimit)) {
            this.logger && this.logger({id: this.requestId, event: 'next_page'});
            return this.executeOperation<T>(result.LastEvaluatedKey);
        }

        return this.hardLimit !== null && this.output.length > this.hardLimit
            ? this.output.slice(0, this.hardLimit)
            : this.output;
    }

    private async executeCount<T>(): Promise<ExecutionResult<T>> {
        let count = 0;
        let cursor: LastEvaluatedKey | null = null;

        do {
            this.signal?.throwIfAborted();
            this.applyLastEvaluatedKey(cursor);
            this.logRequest();
            let result: QueryCommandOutput | ScanCommandOutput;
            if (this.operation.kind === 'query') {
                result = await this.dynamoDB.send(new QueryCommand(this.operation.input), {abortSignal: this.signal});
            } else if (this.operation.kind === 'scan') {
                result = await this.dynamoDB.send(new ScanCommand(this.operation.input), {abortSignal: this.signal});
            } else {
                throw new Error('Count is supported only for query and scan operations');
            }
            this.captureMetadata(result);
            count += result.Count || 0;
            this.logResult(result.Count || 0, result.ConsumedCapacity);
            cursor = result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length > 0 ? result.LastEvaluatedKey : null;
        } while (cursor !== null);

        return count as T;
    }

    private retryUnprocessedBatch<T>(requestItems: BatchRequestItems): Promise<ExecutionResult<T>> {
        const maxBatchRetries = 8;

        if (this.batchRetryCount >= maxBatchRetries) {
            return Promise.reject(new BatchRetryError(this.operation.kind as 'batchGetItem' | 'batchWriteItem', requestItems, this.output));
        }

        const maximumDelay = Math.min(25 * Math.pow(2, this.batchRetryCount), 1000);
        const delay = Math.floor(Math.random() * (maximumDelay + 1));
        this.batchRetryCount++;

        if (this.operation.kind === 'batchGetItem') {
            this.operation.input.RequestItems = requestItems as NonNullable<BatchGetItemCommandInput['RequestItems']>;
        } else if (this.operation.kind === 'batchWriteItem') {
            this.operation.input.RequestItems = requestItems as NonNullable<BatchWriteItemCommandInput['RequestItems']>;
        }

        this.logger && this.logger({id: this.requestId, method: this.operation.kind, event: 'retry_unprocessed_batch', attempt: this.batchRetryCount, delay: delay});

    return abortableDelay(delay, this.signal)
            .then(() => this.executeOperation<T>());
    }

    private applyLastEvaluatedKey(lastEvaluatedKey: LastEvaluatedKey | null): void {
        if (this.operation.kind !== 'query' && this.operation.kind !== 'scan') {
            return;
        }

        if (lastEvaluatedKey) {
            this.operation.input.ExclusiveStartKey = lastEvaluatedKey;
        } else {
            delete this.operation.input.ExclusiveStartKey;
        }
    }

    private captureMetadata(result: MetadataOutput): void {
            if (Array.isArray(result.ConsumedCapacity)) {
            this.consumedCapacity.push(...result.ConsumedCapacity);
        } else if (result.ConsumedCapacity !== undefined) {
            this.consumedCapacity.push(result.ConsumedCapacity);
        }
        const metrics = result.ItemCollectionMetrics;
        if (metrics === undefined) {
            return;
        }
        if (Array.isArray(metrics)) {
            this.itemCollectionMetrics.push(...metrics);
            return;
        }
        if ('ItemCollectionKey' in metrics || 'SizeEstimateRangeGB' in metrics) {
            this.itemCollectionMetrics.push(metrics as ItemCollectionMetrics);
            return;
        }
        if ('ItemCollectionKey' in metrics) {
            this.itemCollectionMetrics.push(metrics);
            return;
        }
        Object.values(metrics as Record<string, ItemCollectionMetrics[]>).forEach((entries) => this.itemCollectionMetrics.push(...entries));
    }

    private logResult(count: number, capacity: unknown): void {
        this.logger && this.logger({
            id: this.requestId,
            method: this.operation.kind,
            result: {count: count},
            capacity: capacity
        });
    }

    private logRequest(): void {
        this.logger && this.logger({id: this.requestId, method: this.operation.kind, query: JSON.stringify(this.operation.input)});
    }

    private parseDocument(item: Record<string, AttributeValue>): GenericDocument<any> {
        const parsed = QuerySerializer.parseItem(item);
        const projected = this.projection === null
            ? parsed
            : Object.fromEntries([...new Set(this.projection.map(attribute => pathSegments(attribute)[0] as string))]
                .filter(attribute => Object.prototype.hasOwnProperty.call(parsed, attribute))
                .map(attribute => [attribute, parsed[attribute]]));
        return this.documentParser === null ? projected : this.documentParser(projected, this.projection, this.operation.kind === 'updateItem'
            && (this.operation.input.ReturnValues === 'UPDATED_NEW' || this.operation.input.ReturnValues === 'UPDATED_OLD'));
    }
}
