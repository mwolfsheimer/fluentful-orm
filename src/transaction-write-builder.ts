import {ExecutionBinding} from './execution-options';
import type {ExecutionOptions} from './types';
import {TransactWriteItemsCommand} from '@aws-sdk/client-dynamodb';
import type {DynamoDBClient, TransactWriteItem, TransactWriteItemsCommandOutput} from '@aws-sdk/client-dynamodb';
import type {QueryBuilder} from './query-builder';
import type {ReturnConsumedCapacity} from './types';
import {ValueUtils} from './value-utils';

type QueryLogger = null | ((message: any) => void);

/** Controls the payload returned when a transaction item's condition fails. */
export interface TransactionItemOptions {
    /** Requests no previous item or the complete previous item from DynamoDB. */
    returnValuesOnConditionCheckFailure?: 'NONE' | 'ALL_OLD';
}

/** Mutable builder for an atomic DynamoDB TransactWriteItems request. */
export class TransactionWriteBuilder {
    private execution = new ExecutionBinding();
    private items: TransactWriteItem[] = [];
    private requestToken: string | undefined;
    private _logger: QueryLogger = null;
    private returnConsumedCapacity: ReturnConsumedCapacity = 'INDEXES';
    private itemCollectionMetricsMode: 'NONE' | 'SIZE' = 'NONE';
    private executed: Promise<TransactWriteItemsCommandOutput> | null = null;

    constructor(
        private dynamoDB: DynamoDBClient,
        private createBuilder: (tableName: string) => QueryBuilder
    ) {}

    /** Adds a configured create, update, delete, or condition-check item. */
    add(
        tableName: string,
        configure: (query: QueryBuilder) => unknown,
        options: TransactionItemOptions = {}
    ): TransactionWriteBuilder {
        if (this.executed !== null) {
            throw new Error('Cannot add operations after a transaction has executed');
        }

        if (this.items.length >= 100) {
            throw new Error('TransactWriteItems supports at most 100 operations');
        }

        const builder = this.createBuilder(tableName);
        configure(builder);
        return this.addBuilder(builder, options);
    }

    /** Adds an already configured QueryBuilder operation to the transaction. */
    addBuilder(builder: QueryBuilder, options: TransactionItemOptions = {}): TransactionWriteBuilder {
        if (this.executed !== null) {
            throw new Error('Cannot add operations after a transaction has executed');
        }

        if (this.items.length >= 100) {
            throw new Error('TransactWriteItems supports at most 100 operations');
        }

        this.items.push(ValueUtils.clone(builder.toTransactionItem(options)));
        return this;
    }

    /** Sets the DynamoDB idempotency token for this transaction. */
    clientRequestToken(token: string): TransactionWriteBuilder {
        this.requestToken = token;
        return this;
    }

    /** Enables or disables request logging for this transaction. */
    logger(logger: QueryLogger = null): TransactionWriteBuilder {
        this._logger = logger;
        return this;
    }

    /** Requests consumed-capacity metadata in the transaction response. */
    returnCapacity(mode: ReturnConsumedCapacity = 'INDEXES'): TransactionWriteBuilder {
        this.returnConsumedCapacity = mode;
        return this;
    }

    /** Requests local-secondary-index item-collection metrics in the transaction response. */
    returnItemCollectionMetrics(): TransactionWriteBuilder {
        this.itemCollectionMetricsMode = 'SIZE';
        return this;
    }

    /** Executes the transaction and caches the returned promise. */
    toPromise(options: ExecutionOptions = {}): Promise<TransactWriteItemsCommandOutput> {
        this.execution.bind(options);
        if (this.executed !== null) {
            return this.executed;
        }

        if (this.items.length === 0) {
            throw new Error('TransactWriteItems requires at least one operation');
        }

        const input = {
            ReturnConsumedCapacity: this.returnConsumedCapacity,
            ReturnItemCollectionMetrics: this.itemCollectionMetricsMode,
            TransactItems: this.items,
            ClientRequestToken: this.requestToken
        };
        this._logger && this._logger({method: 'transactWriteItems', query: JSON.stringify(input)});
        this.executed = Promise.resolve().then(() => {
            this.execution.signal?.throwIfAborted();
            return this.dynamoDB.send(new TransactWriteItemsCommand(input), {abortSignal: this.execution.signal});
        }).then((result) => {
            this._logger && this._logger({
                method: 'transactWriteItems',
                result: {count: this.items.length},
                capacity: result.ConsumedCapacity
            });
            return result;
        });
        return this.executed;
    }
}
