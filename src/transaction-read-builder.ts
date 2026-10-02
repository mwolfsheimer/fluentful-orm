import {TransactGetItemsCommand} from '@aws-sdk/client-dynamodb';
import type {DynamoDBClient, TransactGetItem} from '@aws-sdk/client-dynamodb';
import type {AttributePath} from './document-path';
import {uniquePaths} from './document-path';
import {ExpressionBuilder} from './expression-builder';
import {ExecutionBinding} from './execution-options';
import {QuerySerializer} from './query-serializer';
import {ValueUtils} from './value-utils';
import {assertDynamoKeyValue} from './dynamodb-values';
import type {DynamoResponse, ExecutionOptions, GetDocumentSelector} from './types';

/** One atomic read, never split into multiple requests. Missing items retain their positions. */
export class TransactionReadBuilder<TResults extends unknown[] = []> {
    private requests: TransactGetItem[] = [];
    private parsers: Array<(document: unknown) => unknown> = [];
    private execution = new ExecutionBinding();
    private response: Promise<DynamoResponse<TResults>> | null = null;
    private executed: Promise<TResults> | null = null;
    private capacity: 'TOTAL' | 'NONE' = 'NONE';
    private log: ((message: unknown) => void) | null = null;

    constructor(private db: DynamoDBClient) {}

    /** Adds a key and optional projection, cloning input before retaining it. */
    add<T = Record<string, unknown>>(
        table: string, key: GetDocumentSelector, select?: readonly AttributePath[],
        parser: (document: unknown) => T = document => document as T
    ): TransactionReadBuilder<[...TResults, T | null]> {
        if (this.response !== null) throw new Error('Cannot add operations after a transaction has executed');
        if (this.requests.length >= 100) throw new Error('TransactGetItems supports at most 100 operations');
        if (!table || !Object.keys(key).length) throw new Error('Transaction reads require a table and primary key');
        Object.values(key).forEach(value => assertDynamoKeyValue(value));
        const expressions = new ExpressionBuilder();
        const request: NonNullable<TransactGetItem['Get']> = {TableName: table, Key: QuerySerializer.serialiseMap(key)};
        if (select !== undefined) request.ProjectionExpression = uniquePaths(select).map(field => expressions.addPath(field)).join(', ');
        expressions.applyTo(request);
        this.requests.push(ValueUtils.clone({Get: request}));
        this.parsers.push(parser);
        return this as unknown as TransactionReadBuilder<[...TResults, T | null]>;
    }

    returnCapacity(mode: 'TOTAL' | 'NONE' = 'TOTAL'): this {
        if (this.response !== null) throw new Error('Cannot change options after a transaction has executed');
        if (mode !== 'TOTAL' && mode !== 'NONE') throw new Error('Transaction reads support TOTAL or NONE capacity reporting');
        this.capacity = mode;
        return this;
    }

    logger(logger: ((message: unknown) => void) | null = null): this {
        if (this.response !== null) throw new Error('Cannot change options after a transaction has executed');
        this.log = logger;
        return this;
    }

    toResponse(options: ExecutionOptions = {}): Promise<DynamoResponse<TResults>> {
        if (!this.requests.length) throw new Error('TransactGetItems requires at least one operation');
        this.execution.bind(options);
        if (this.response !== null) return this.response;
        const input = ValueUtils.clone({TransactItems: this.requests, ReturnConsumedCapacity: this.capacity});
        this.response = Promise.resolve().then(async () => {
            this.execution.signal?.throwIfAborted();
            this.log?.({method: 'transactGetItems', query: JSON.stringify(input)});
            const result = await this.db.send(new TransactGetItemsCommand(input), {abortSignal: this.execution.signal});
            if (!Array.isArray(result.Responses) || result.Responses.length !== input.TransactItems.length) {
                throw new Error('Malformed TransactGetItems response: expected one result per requested item');
            }
            const value = input.TransactItems.map((_request, index) => {
                const item = result.Responses?.[index]?.Item;
                return item === undefined ? null : this.parsers[index](QuerySerializer.parseItem(item));
            }) as TResults;
            return {value, consumedCapacity: ValueUtils.clone(result.ConsumedCapacity ?? []), itemCollectionMetrics: []};
        });
        return this.response;
    }

    toPromise(options: ExecutionOptions = {}): Promise<TResults> {
        const response = this.toResponse(options);
        if (this.executed === null) this.executed = response.then(result => result.value);
        return this.executed;
    }
}

export function transactGet(db: DynamoDBClient): TransactionReadBuilder {
    return new TransactionReadBuilder(db);
}