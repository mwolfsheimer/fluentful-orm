import {ConditionalCheckFailedException} from "@aws-sdk/client-dynamodb";
import type {DynamoDBClient, TransactWriteItem} from "@aws-sdk/client-dynamodb";
import type {TableDescription} from "@aws-sdk/client-dynamodb";
import {runBatchChunks} from "./batch-runner";
import {ExpressionBuilder} from "./expression-builder";
import {createComparisonQuery, createConditionalQuery} from "./fluent-query";
import {QueryExecutor} from "./query-executor";
import {QueryRequestState} from "./query-request-state";
import {QueryTableAdmin} from "./query-table-admin";
import type {DynamoDBTableDefinition} from "./query-table-admin";
import {QuerySerializer} from "./query-serializer";
import {TransactionWriteBuilder} from "./transaction-write-builder";

import type {TransactionItemOptions} from "./transaction-write-builder";
type Binary = Uint8Array;
import {defineTable as defineTypedTable} from "./typed-table";
import {UpdateExpressionType} from "./types";
import type {ConditionalWriteResult} from "./types";
import type {AddSubQuery, BatchGetOptions, BatchOptions, BatchWriteOptions, ConditionCheckNotWhereQuery, ConditionCheckQuery, ConditionFailureReturnOptions, CountFinal, CreateDocumentWith, CreateNotWhereQuery, CreateQuery, DeleteDocumentWith, DeleteNotWhereQuery, DeleteQuery, DynamoResponse, Final, GenericDocument, GetDocumentSelector, GetDocumentWith, GetSelector, IndexKind, PageOptions, Query, QueryCursor, QueryDocument, QueryPage, QueryScanWhereSubQuery, ReturnConsumedCapacity, Scan, SetSubQuery, SubQuery, UpdateDocumentSelector, UpdateDocumentWith, UpdateEqQuery, UpdateNotWhereQuery, UpdateQuery, UpdateSubQuery, UpdateWithQuery} from "./types";
import {ValueUtils} from "./value-utils";

let requestId = '0';

/** Mutable low-level DynamoDB builder for untyped CRUD, reads, batches, and transactions. */
export class QueryBuilder {
    private expressions = new ExpressionBuilder();
    private request = new QueryRequestState();
    private _hardLimit: number | null = null;
    private _docs: GenericDocument<any>[] = [];
    private _logger: null | ((msg: any) => void) = null;
    private _rid = (requestId = (parseInt(requestId, 16) + 1).toString(16));
    private _writeTimestamps: boolean = false;
    private _executed: Promise<any> | null = null;
    private _response: Promise<DynamoResponse<any>> | null = null;
    private _result: Promise<ConditionalWriteResult<unknown, unknown>> | null = null;
    private _executionMode: 'all' | 'page' | 'iterator' | null = null;
    private _projection: string[] | null = null;
    private _count = false;

    /** Creates a builder for one table and optionally supplies a result parser. */
    constructor(
        private tableName: string,
        private dynamoDB: DynamoDBClient,
        private documentParser: null | ((document: unknown, projection?: readonly string[] | null) => GenericDocument<any>) = null
    ) {}

    private with(doc: UpdateDocumentWith): UpdateWithQuery {

        doc = ValueUtils.clone(doc);
        this.applyModifiedTimestamp();

        this._docs.push(doc);

        for (let key in doc) {
            if (doc.hasOwnProperty(key) && doc[key] !== undefined && !this.request.hasKey(key)) {
                this.addExpressionAttributeName(key);
                this.addExpressionAttributeValue(key, doc[key]);
                this.addUpdateExpression(UpdateExpressionType.SET, key);
            }
        }

        return this.updateWithQuery();
    }

    private set_set(attribute: string): SetSubQuery {
        return {
            eq: (val: any): UpdateSubQuery => this.applyUpdate(UpdateExpressionType.SET, attribute, val)
        };
    }

    private set_add(attribute: string): AddSubQuery {
        return {
            eq: (val: Set<string | number | Binary> | number): UpdateSubQuery => this.applyUpdate(UpdateExpressionType.ADD, attribute, val)
        };
    }

    private set_delete(attribute: string): UpdateEqQuery {
        return {
            eq: (val: Set<string | number | Binary>): UpdateSubQuery => this.applyUpdate(UpdateExpressionType.DELETE, attribute, val)
        };
    }

    private set_remove(attribute: string): UpdateSubQuery {
        return this.applyUpdate(UpdateExpressionType.REMOVE, attribute);
    }

    private applyUpdate(type: UpdateExpressionType, attribute: string, value?: unknown): UpdateSubQuery {
        this.addExpressionAttributeName(attribute);
        this.addUpdateExpression(type, attribute);

        if (type !== UpdateExpressionType.REMOVE) {
            this.addExpressionAttributeValue(attribute, value);
        }

        this.applyModifiedTimestamp();
        return this.updateSubQuery();
    }

    private applyModifiedTimestamp(): void {
        if (!this._writeTimestamps) {
            return;
        }

        this.addExpressionAttributeName('modifiedAt');
        this.expressions.addValueIfAbsent('modifiedAt', Date.now());
        this.addUpdateExpression(UpdateExpressionType.SET, 'modifiedAt');
    }

    private updateSubQuery(): UpdateSubQuery {
        return {
            ...this.conditionFailureReturnQuery(() => this.updateSubQuery()),
            toResult: this.toResult.bind(this),
            where: this.updateWhereCondition.bind(this),
            returningAllNew: this.updateReturningAllNew.bind(this),
            returningAllOld: this.updateReturningAllOld.bind(this),
            returningNone: this.updateReturningNone.bind(this),
            returnCapacity: (mode) => {
                this.returnCapacity(mode);
                return this.updateSubQuery();
            },
            returnItemCollectionMetrics: () => {
                this.returnItemCollectionMetrics();
                return this.updateSubQuery();
            },
            set: this.set_set.bind(this),
            remove: this.set_remove.bind(this),
            add: this.set_add.bind(this),
            delete: this.set_delete.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this),
            toPromiseOrNull: this.toPromiseOrNull.bind(this)
        };
    }

    private updateWithQuery(): UpdateWithQuery {
        return this.updateSubQuery();
    }

    /** Starts a conditional PutItem operation. */
    public create(doc: CreateDocumentWith): CreateQuery {

        doc = ValueUtils.clone(doc)

        if (this._writeTimestamps) {
            (doc as any).createdAt = Date.now();
        }

        if (this.documentParser !== null) {
            doc = this.documentParser(doc);
        }

        const item = QuerySerializer.serialiseMap(doc);
        this._docs.push(QuerySerializer.parseItem(item));
        this.request.startPut(this.tableName, item);

        return this.createQueryResult();
    }

    private createBatchWorker(docs: CreateDocumentWith[]): QueryBuilder {
        const now = Date.now();

        if (this._writeTimestamps) {
            docs.forEach((doc) => (doc as any).createdAt = now);
        }

        if (this.documentParser !== null) {
            docs = docs.map((doc) => this.documentParser!(doc));
        }

        const items = docs.map((doc) => QuerySerializer.serialiseMap(doc));
        this._docs = this._docs.concat(items.map((item) => QuerySerializer.parseItem(item)));

        const requestItems = {[this.tableName]: items.map((item) => {
            return {
                PutRequest: {
                    Item: item
                }
            };
        })};
        this.request.startBatchWrite(requestItems);

        return this;
    }

    /** Creates records in batches of 25 with configurable concurrency. */
    public createBatch<T>(docs: CreateDocumentWith[], options: BatchWriteOptions | boolean = {}): Promise<T[]> {
        docs = ValueUtils.clone(docs) as CreateDocumentWith[];
        return runBatchChunks(docs, 25, this.batchConcurrency(options), (chunk) => {
            const builder = new QueryBuilder(this.tableName, this.dynamoDB, this.documentParser)
                .logger(this._logger)
                .timestamps(this._writeTimestamps)
                .createBatchWorker(chunk);
            if (typeof options !== 'boolean') {
                builder.returnCapacity(options.returnConsumedCapacity);
                if (options.returnItemCollectionMetrics === 'SIZE') {
                    builder.returnItemCollectionMetrics();
                }
            }
            return builder.toPromise<T[]>();
        })
            .then((result) => result.flat(1) as T[]);
    }

    /** Starts a DeleteItem operation for the supplied primary key. */
    public delete(doc: DeleteDocumentWith): DeleteQuery {
        const key: GenericDocument<GetSelector> = {};

        for (const keyName in doc) {
            if (doc.hasOwnProperty(keyName)) {
                key[keyName] = QuerySerializer.serialiseItem(doc[keyName]);
            }
        }
        this.request.startDelete(this.tableName, key);

        return this.deleteQueryResult();
    }

    /** Starts a condition-check operation for the supplied primary key. */
    public conditionCheck(doc: GetDocumentSelector): ConditionCheckQuery {
        const key: GenericDocument<GetSelector> = {};

        for (const keyName in doc) {
            if (doc.hasOwnProperty(keyName)) {
                key[keyName] = QuerySerializer.serialiseItem(doc[keyName]);
            }
        }
        this.request.startConditionCheck(this.tableName, key);

        return this.conditionCheckQueryResult();
    }

    private deleteBatchWorker(docs: CreateDocumentWith[]): QueryBuilder {
        const requestItems = {[this.tableName]: docs.map((item) => {
            return {
                DeleteRequest: {
                    Key: QuerySerializer.serialiseMap(item)
                }
            };
        })};
        this.request.startBatchWrite(requestItems);

        return this;
    }

    /** Deletes records in batches of 25 with configurable concurrency. */
    public deleteBatch<T>(docs: DeleteDocumentWith[], options: BatchWriteOptions | boolean = {}): Promise<void> {
        docs = ValueUtils.clone(docs) as CreateDocumentWith[];
        return runBatchChunks(docs, 25, this.batchConcurrency(options), (chunk) => {
            const builder = new QueryBuilder(this.tableName, this.dynamoDB, this.documentParser)
                .logger(this._logger)
                .timestamps(this._writeTimestamps)
                .deleteBatchWorker(chunk);
            if (typeof options !== 'boolean') {
                builder.returnCapacity(options.returnConsumedCapacity);
                if (options.returnItemCollectionMetrics === 'SIZE') {
                    builder.returnItemCollectionMetrics();
                }
            }
            return builder.toPromise();
        }).then(() => undefined);
    }

    /** Starts an UpdateItem operation for the supplied primary key. */
    public update(doc: UpdateDocumentSelector): UpdateQuery {
        const key: GenericDocument<GetSelector> = {};

        for (const keyName in doc) {
            if (doc.hasOwnProperty(keyName)) {
                key[keyName] = QuerySerializer.serialiseItem(doc[keyName]);
            }
        }
        this.request.startUpdate(this.tableName, key);

        return this.updateQuery();
    }

    /** Starts a GetItem operation for the supplied primary key. */
    public get(doc: GetDocumentSelector): QueryBuilder {
        const key: GenericDocument<GetSelector> = {};

        for (let keyName in doc) {
            if (doc.hasOwnProperty(keyName)) {
                key[keyName] = QuerySerializer.serialiseItem(doc[keyName]);
            }
        }
        this.request.startGet(this.tableName, key, false);

        return this
    }

    private getBatchWorker(keys: GenericDocument<GetSelector>[], consistentRead = false, select?: string[]): QueryBuilder {
        const unique = select === undefined ? undefined : Array.from(new Set(select));
        if (unique !== undefined && (unique.length === 0 || unique.some((attribute) => typeof attribute !== 'string' || attribute.length === 0))) {
            throw new Error('Projection requires at least one attribute');
        }
        if (unique !== undefined) {
            this._projection = unique;
        }
        const request = {ConsistentRead: consistentRead, Keys: keys} as {
            ConsistentRead: boolean;
            Keys: GenericDocument<GetSelector>[];
            ProjectionExpression?: string;
            ExpressionAttributeNames?: Record<string, string>;
        };
        if (unique !== undefined) {
            request.ProjectionExpression = unique.map((attribute) => `#${attribute}`).join(', ');
            request.ExpressionAttributeNames = Object.fromEntries(unique.map((attribute) => [`#${attribute}`, attribute]));
        }
        this.request.startBatchGet({[this.tableName]: request});

        return this
    }

    /** Reads records in batches of 100, deduplicating duplicate keys before sending requests. */
    public getBatch<T>(docs: GetDocumentWith[], options: BatchGetOptions | boolean = {}): Promise<T[]> {
        docs = ValueUtils.clone(docs) as GetDocumentWith[];

        // DynamoDB rejects BatchGetItem requests containing duplicate keys.
        const seenKeys = new Set<string>();
        const serialisedKeys: GenericDocument<GetSelector>[] = [];
        docs.forEach((doc) => {
            const serialised = QuerySerializer.serialiseMap(doc);
            const canonical = JSON.stringify(Object.keys(serialised).sort().map((key) => [key, serialised[key]]));

            if (seenKeys.has(canonical)) {
                return;
            }

            seenKeys.add(canonical);
            serialisedKeys.push(serialised);
        });

        const batchOptions: BatchGetOptions = typeof options === 'boolean' ? {} : options;
        const readConsistency = batchOptions.consistentRead === true;
        return runBatchChunks(serialisedKeys, 100, this.batchConcurrency(options), (chunk) => {
            const builder = new QueryBuilder(this.tableName, this.dynamoDB, this.documentParser)
                .logger(this._logger)
                .timestamps(this._writeTimestamps)
                .getBatchWorker(chunk, readConsistency, batchOptions.select);
            builder.returnCapacity(batchOptions.returnConsumedCapacity);
            return builder.toPromise<T[]>();
        }).then((result) => result.flat(1));
    }

    private batchConcurrency(options: BatchOptions | boolean): number {
        if (typeof options === 'boolean') {
            return options ? 1 : Number.MAX_SAFE_INTEGER;
        }
        const concurrency = options.concurrency === undefined ? 4 : options.concurrency;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new Error('Batch concurrency must be a positive integer');
        }
        return concurrency;
    }

    /** Selects a secondary index for the current query or scan operation. */
    public usingIndex(index: string, kind: IndexKind = 'global'): SubQuery {
        this.request.setIndex(index, kind);

        return {
            consistent: this.subQueryConsistent.bind(this),
            ascending: this.subQueryAscending.bind(this),
            descending: this.subQueryDescending.bind(this),
            returnCapacity: this.subQueryReturnCapacity.bind(this),
            where: this.queryAndScanWhere.bind(this),
            select: this.subQuerySelect.bind(this),
            count: this.count.bind(this),
            page: this.page.bind(this),
            pages: this.pages.bind(this),
            items: this.items.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    /** Starts a Scan operation. */
    public scan(): Scan {
        this.request.startScan(this.tableName, false);
        return this.scanResult();
    }

    /** Sets an optional request logger and returns this builder. */
    public logger(logger: null | ((msg: any) => void) = null): QueryBuilder {
        this._logger = logger;
        return this;
    }

    /** Requests a strongly consistent get, query, or scan. */
    public consistent(): QueryBuilder {
        this.request.setConsistentRead();
        return this;
    }

    /** Requests DynamoDB consumed-capacity metadata for toResponse(). */
    public returnCapacity(mode: ReturnConsumedCapacity = 'INDEXES'): QueryBuilder {
        this.request.setReturnConsumedCapacity(mode);
        return this;
    }

    /** Requests local-secondary-index item-collection metrics for toResponse(). */
    public returnItemCollectionMetrics(): QueryBuilder {
        this.request.setReturnItemCollectionMetrics('SIZE');
        return this;
    }

    /** Orders a query by ascending sort key. */
    public ascending(): QueryBuilder {
        this.request.setScanIndexForward(true);
        return this;
    }

    /** Orders a query by descending sort key. */
    public descending(): QueryBuilder {
        this.request.setScanIndexForward(false);
        return this;
    }

    /** Configures one segment of a parallel scan. */
    public parallel(segment: number, totalSegments: number): QueryBuilder {
        this.request.setParallelScan(segment, totalSegments);
        return this;
    }

    /** Projects selected attributes from a GetItem operation. */
    public select(...attributes: string[]): QueryBuilder {
        this.applyProjection(attributes);
        return this;
    }

    private queryConsistent(): Query {
        this.consistent();
        return this.queryResult();
    }

    private queryAscending(): Query {
        this.ascending();
        return this.queryResult();
    }

    private queryDescending(): Query {
        this.descending();
        return this.queryResult();
    }

    private queryReturnCapacity(mode?: ReturnConsumedCapacity): Query {
        this.returnCapacity(mode);
        return this.queryResult();
    }

    private subQueryConsistent(): SubQuery {
        this.consistent();
        return this.subQuery();
    }

    private subQueryAscending(): SubQuery {
        this.ascending();
        return this.subQuery();
    }

    private subQueryDescending(): SubQuery {
        this.descending();
        return this.subQuery();
    }

    private subQueryReturnCapacity(mode?: ReturnConsumedCapacity): SubQuery {
        this.returnCapacity(mode);
        return this.subQuery();
    }

    private scanConsistent(): Scan {
        this.consistent();
        return this.scanResult();
    }

    private scanParallel(segment: number, totalSegments: number): Scan {
        this.parallel(segment, totalSegments);
        return this.scanResult();
    }

    private scanReturnCapacity(mode?: ReturnConsumedCapacity): Scan {
        this.returnCapacity(mode);
        return this.scanResult();
    }

    /** Enables or disables automatic `createdAt` and `modifiedAt` write timestamps. */
    public timestamps(state: boolean = true): QueryBuilder {
        this._writeTimestamps = state;
        return this;
    }

    /** Chooses whether a failed conditional write includes the previous item. */
    public onConditionFailure(): ConditionFailureReturnOptions<QueryBuilder> {
        return this.conditionFailureReturnQuery(() => this).onConditionFailure();
    }

    private conditionFailureReturnQuery<T>(result: () => T) {
        return {
            onConditionFailure: () => ({
                returningAllOld: (): T => {
                    this.request.setReturnValuesOnConditionCheckFailure('ALL_OLD');
                    return result();
                },
                returningNone: (): T => {
                    this.request.setReturnValuesOnConditionCheckFailure('NONE');
                    return result();
                }
            })
        };
    }

    /** Starts a Query operation using equality conditions for the supplied partition-key document. */
    public query(doc: QueryDocument): Query {
        this.request.startQuery(this.tableName, false);

        for (const key in doc) {
            if (doc.hasOwnProperty(key)) {
                this.addKeyConditionExpression(key, '=');
                this.addExpressionAttributeName(key);
                this.addExpressionAttributeValue(key, doc[key]);
            }
        }

        return {
            limit: this.queryLimit.bind(this),
            consistent: this.queryConsistent.bind(this),
            ascending: this.queryAscending.bind(this),
            descending: this.queryDescending.bind(this),
            returnCapacity: this.queryReturnCapacity.bind(this),
            where: this.queryAndScanWhere.bind(this),
            usingIndex: this.usingIndex.bind(this),
            sortKey: this.querySortKey.bind(this),
            select: this.querySelect.bind(this),
            count: this.count.bind(this),
            page: this.page.bind(this),
            pages: this.pages.bind(this),
            items: this.items.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private querySortKey(attribute: string) {
        return {
            eq: (value: string | number | Binary) => this.addQuerySortKey(attribute, '=', value),
            gt: (value: string | number | Binary) => this.addQuerySortKey(attribute, '>', value),
            gte: (value: string | number | Binary) => this.addQuerySortKey(attribute, '>=', value),
            lt: (value: string | number | Binary) => this.addQuerySortKey(attribute, '<', value),
            lte: (value: string | number | Binary) => this.addQuerySortKey(attribute, '<=', value),
            between: (lower: string | number | Binary, upper: string | number | Binary) => {
                this.expressions.addKeyBetween(attribute, lower, upper);
                return this.queryResult();
            },
            beginsWith: (value: string | Binary) => {
                this.expressions.addKeyBeginsWith(attribute, value);
                return this.queryResult();
            }
        };
    }

    private addQuerySortKey(attribute: string, operator: string, value: string | number | Binary): Query {
        this.expressions.addKeyComparison(attribute, operator, value);
        return this.queryResult();
    }

    private queryResult(): Query {
        return {
            limit: this.queryLimit.bind(this),
            consistent: this.queryConsistent.bind(this),
            ascending: this.queryAscending.bind(this),
            descending: this.queryDescending.bind(this),
            returnCapacity: this.queryReturnCapacity.bind(this),
            where: this.queryAndScanWhere.bind(this),
            usingIndex: this.usingIndex.bind(this),
            sortKey: this.querySortKey.bind(this),
            select: this.querySelect.bind(this),
            count: this.count.bind(this),
            page: this.page.bind(this),
            pages: this.pages.bind(this),
            items: this.items.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private addUpdateExpression(type: UpdateExpressionType, name: string): void {
        this.expressions.addUpdate(type, name);
    }

    private addExpressionAttributeValue(attribute: string, val: any): void {
        this.expressions.addValue(attribute, val);
    }

    private addExpressionAttributeName(name: string): void {
        this.expressions.addName(name);
    }

    private addKeyConditionExpression(name: string, expression: string): void {
        this.expressions.addKeyCondition(name, expression);
    }

    private addWhereExpression(whereKey: string, operator: string, val: any, isNot: boolean, filter: boolean): void {
        this.expressions.addComparison(whereKey, operator, val, isNot, filter);
    }

    private addWhereInExpression(whereKey: string, val: (string | number | Binary)[], isNot: boolean, filter: boolean): void {
        this.expressions.addInComparison(whereKey, val, isNot, filter);
    }

    private queryAndScanWhere(whereKey: string): QueryScanWhereSubQuery {
        return createComparisonQuery(
            () => this.subQuery(),
            (operator, value, negated) => this.addWhereExpression(whereKey, operator, value, negated, true),
            (values, negated) => this.addWhereInExpression(whereKey, values, negated, true)
        );
    }

    private subQuery(): SubQuery {
        return {
            consistent: this.subQueryConsistent.bind(this),
            ascending: this.subQueryAscending.bind(this),
            descending: this.subQueryDescending.bind(this),
            returnCapacity: this.subQueryReturnCapacity.bind(this),
            where: this.queryAndScanWhere.bind(this),
            select: this.subQuerySelect.bind(this),
            count: this.count.bind(this),
            page: this.page.bind(this),
            pages: this.pages.bind(this),
            items: this.items.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private createWhereCondition(whereKey: string): CreateNotWhereQuery {
        return createConditionalQuery(
            () => this.createQueryResult(),
            (operator, value, negated) => this.addWhereExpression(whereKey, operator, value, negated, false),
            (values, negated) => this.addWhereInExpression(whereKey, values, negated, false),
            (exists) => this.expressions.addExistsCondition(whereKey, exists)
        );
    }

    private createQueryResult(): CreateQuery {
        return {
            ...this.conditionFailureReturnQuery(() => this.createQueryResult()),
            toResult: this.toResult.bind(this),
            where: this.createWhereCondition.bind(this),
            returningAllOld: this.createReturningAllOld.bind(this),
            returnCapacity: (mode) => {
                this.returnCapacity(mode);
                return this.createQueryResult();
            },
            returnItemCollectionMetrics: () => {
                this.returnItemCollectionMetrics();
                return this.createQueryResult();
            },
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private deleteWhereCondition(whereKey: string): DeleteNotWhereQuery {
        return createConditionalQuery(
            () => this.deleteQueryResult(),
            (operator, value, negated) => this.addWhereExpression(whereKey, operator, value, negated, false),
            (values, negated) => this.addWhereInExpression(whereKey, values, negated, false),
            (exists) => this.expressions.addExistsCondition(whereKey, exists)
        );
    }

    private deleteQueryResult(): DeleteQuery {
        return {
            ...this.conditionFailureReturnQuery(() => this.deleteQueryResult()),
            toResult: this.toResult.bind(this),
            where: this.deleteWhereCondition.bind(this),
            returningAllOld: this.deleteReturningAllOld.bind(this),
            returningNone: this.deleteReturningNone.bind(this),
            returnCapacity: (mode) => {
                this.returnCapacity(mode);
                return this.deleteQueryResult();
            },
            returnItemCollectionMetrics: () => {
                this.returnItemCollectionMetrics();
                return this.deleteQueryResult();
            },
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private deleteReturningAllOld(): DeleteQuery {
        this.request.setDeleteReturnValues('ALL_OLD');
        return this.deleteQueryResult();
    }

    private createReturningAllOld(): CreateQuery {
        this.request.setPutReturnValues('ALL_OLD');
        return this.createQueryResult();
    }

    private deleteReturningNone(): DeleteQuery {
        this.request.setDeleteReturnValues('NONE');
        return this.deleteQueryResult();
    }

    private conditionCheckWhereCondition(whereKey: string): ConditionCheckNotWhereQuery {
        return createConditionalQuery(
            () => this.conditionCheckQueryResult(),
            (operator, value, negated) => this.addWhereExpression(whereKey, operator, value, negated, false),
            (values, negated) => this.addWhereInExpression(whereKey, values, negated, false),
            (exists) => this.expressions.addExistsCondition(whereKey, exists)
        );
    }

    private conditionCheckQueryResult(): ConditionCheckQuery {
        return {
            ...this.conditionFailureReturnQuery(() => this.conditionCheckQueryResult()),
            where: this.conditionCheckWhereCondition.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private updateWhereCondition(whereKey: string): UpdateNotWhereQuery {
        return createConditionalQuery(
            () => this.updateSubQuery(),
            (operator, value, negated) => this.addWhereExpression(whereKey, operator, value, negated, false),
            (values, negated) => this.addWhereInExpression(whereKey, values, negated, false),
            (exists) => this.expressions.addExistsCondition(whereKey, exists)
        );
    }

    private updateQuery(): UpdateQuery {
        return {
            with: this.with.bind(this),
            set: this.set_set.bind(this),
            remove: this.set_remove.bind(this),
            add: this.set_add.bind(this),
            delete: this.set_delete.bind(this)
        };
    }

    private updateReturningAllNew(): UpdateSubQuery {
        this.request.setUpdateReturnValues('ALL_NEW');
        return this.updateSubQuery();
    }

    private updateReturningAllOld(): UpdateSubQuery {
        this.request.setUpdateReturnValues('ALL_OLD');
        return this.updateSubQuery();
    }

    private updateReturningNone(): UpdateSubQuery {
        this.request.setUpdateReturnValues('NONE');
        return this.updateWithQuery();
    }

    private scanLimit(chunkSize: number, hardLimit: number | null = null): Scan {

        if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new Error("Invalid Chunk Size");
        }

        if (hardLimit !== null && (!Number.isInteger(hardLimit) || hardLimit < 1)) {
            throw new Error("Invalid Hard Limit");
        }

        this.request.setLimit(chunkSize);
        this._hardLimit = hardLimit;

        return this.scanResult();
    }

    private queryLimit(chunkSize: number, hardLimit: number | null = null): Query {

        if (!Number.isInteger(chunkSize) || chunkSize < 1) {
            throw new Error("Invalid Chunk Size");
        }

        if (hardLimit !== null && (!Number.isInteger(hardLimit) || hardLimit < 1)) {
            throw new Error("Invalid Hard Limit");
        }

        this.request.setLimit(chunkSize);
        this._hardLimit = hardLimit;

        return {
            limit: this.queryLimit.bind(this),
            consistent: this.queryConsistent.bind(this),
            ascending: this.queryAscending.bind(this),
            descending: this.queryDescending.bind(this),
            returnCapacity: this.queryReturnCapacity.bind(this),
            usingIndex: this.usingIndex.bind(this),
            sortKey: this.querySortKey.bind(this),
            where: this.queryAndScanWhere.bind(this),
            select: this.querySelect.bind(this),
            count: this.count.bind(this),
            page: this.page.bind(this),
            pages: this.pages.bind(this),
            items: this.items.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private querySelect(...attributes: string[]): Query {
        this.applyProjection(attributes);
        return this.queryResult();
    }

    private scanSelect(...attributes: string[]): Scan {
        this.applyProjection(attributes);
        return this.scanResult();
    }

    private scanResult(): Scan {
        return {
            limit: this.scanLimit.bind(this),
            consistent: this.scanConsistent.bind(this),
            parallel: this.scanParallel.bind(this),
            returnCapacity: this.scanReturnCapacity.bind(this),
            where: this.queryAndScanWhere.bind(this),
            select: this.scanSelect.bind(this),
            count: this.count.bind(this),
            page: this.page.bind(this),
            pages: this.pages.bind(this),
            items: this.items.bind(this),
            toPromise: this.toPromise.bind(this),
            toResponse: this.toResponse.bind(this)
        };
    }

    private subQuerySelect(...attributes: string[]): SubQuery {
        this.applyProjection(attributes);
        return this.subQuery();
    }

    private applyProjection(attributes: string[]): void {
        if (this._count) {
            throw new Error('Projection cannot be combined with count');
        }
        const unique = Array.from(new Set(attributes));
        if (unique.length === 0 || unique.some((attribute) => typeof attribute !== 'string' || attribute.length === 0)) {
            throw new Error('Projection requires at least one attribute');
        }
        unique.forEach((attribute) => this.addExpressionAttributeName(attribute));
        this._projection = unique;
        this.request.setProjection(unique);
    }

    private count(): CountFinal {
        if (this._projection !== null) {
            throw new Error('Count cannot be combined with projection');
        }
        this._count = true;
        this.request.setCount();
        return {toPromise: this.toPromise.bind(this), toResponse: this.toResponse.bind(this)};
    }

    private page<T>(options: PageOptions = {}): Promise<QueryPage<T>> {
        if (this._executed !== null) {
            if (this._executionMode !== 'page') {
                throw new Error('QueryBuilder operations can only be executed once');
            }
            return this._executed as Promise<QueryPage<T>>;
        }
        const cursor = this.applyPageOptions(options);
        this.assertExecutionAvailable('page');
        this._executed = this.createExecutor().executePage<T>(cursor);
        return this._executed;
    }

    private pages<T>(options: PageOptions = {}): AsyncIterable<QueryPage<T>> {
        const cursor = this.applyPageOptions(options);
        this.assertExecutionAvailable('iterator');
        return this.createExecutor().pages<T>(cursor);
    }

    private items<T>(options: PageOptions = {}): AsyncIterable<T> {
        const cursor = this.applyPageOptions(options);
        this.assertExecutionAvailable('iterator');
        return this.createExecutor().items<T>(cursor);
    }

    private applyPageOptions(options: PageOptions): QueryCursor | null {
        if (options.limit !== undefined) {
            if (!Number.isInteger(options.limit) || options.limit < 1) {
                throw new Error('Page limit must be a positive integer');
            }
            this.request.setLimit(options.limit);
        }
        if (options.cursor !== undefined && options.cursor !== null && (typeof options.cursor !== 'object' || Object.keys(options.cursor).length === 0)) {
            throw new Error('Page cursor must contain at least one key');
        }
        return options.cursor === undefined || options.cursor === null
            ? null
            : ValueUtils.clone(options.cursor);
    }

    private assertExecutionAvailable(mode: 'all' | 'page' | 'iterator'): void {
        if (this._executionMode !== null) {
            throw new Error('QueryBuilder operations can only be executed once');
        }
        this._executionMode = mode;
    }

    private createExecutor(): QueryExecutor {
        this.request.applyExpressions(this.expressions);
        const operation = this.request.getOperation();
        if (operation === null) {
            throw new Error('A query or scan operation must be configured');
        }
        return new QueryExecutor(
            this.dynamoDB,
            operation,
            this._docs,
            this._hardLimit,
            this._logger,
            this._rid,
            this.documentParser,
            this._projection
        );
    }

    /** Defines a schema-aware table with typed Zod-validated operations. */
    public static defineTable = defineTypedTable;

    /** Creates an on-demand table from a full definition or a simple string-key shorthand. */
    public static createTable(definition: DynamoDBTableDefinition, db: DynamoDBClient): Promise<TableDescription | null>;
    public static createTable(name: string, key: string, db: DynamoDBClient): Promise<TableDescription | null>;
    public static createTable(definitionOrName: DynamoDBTableDefinition | string, keyOrClient: string | DynamoDBClient, db?: DynamoDBClient): Promise<TableDescription | null> {
        return typeof definitionOrName === 'string'
            ? QueryTableAdmin.createTable(definitionOrName, keyOrClient as string, db!)
            : QueryTableAdmin.createTable(definitionOrName, keyOrClient as DynamoDBClient);
    }

    /** Deletes a table and returns the raw AWS table description when supplied. */
    public static deleteTable(name: string, db: DynamoDBClient): Promise<TableDescription | null | undefined> {
        return QueryTableAdmin.deleteTable(name, db);
    }

    /** Lists table names returned by DynamoDB. */
    public static listTables(db: DynamoDBClient): Promise<string[] | null> {
        return QueryTableAdmin.listTables(db);
    }

    /** Returns the raw AWS DescribeTable response, including operational metadata such as status and ARN. */
    public static describeTable(name: string, db: DynamoDBClient): Promise<TableDescription | null> {
        return QueryTableAdmin.describeTable(name, db);
    }

    /** Returns a validated, portable key/index definition derived from the raw AWS table description. */
    public static getTableDefinition(name: string, db: DynamoDBClient): Promise<DynamoDBTableDefinition | null> {
        return QueryTableAdmin.getTableDefinition(name, db);
    }

    /** Starts an atomic low-level transaction builder. */
    public static transactWrite(db: DynamoDBClient): TransactionWriteBuilder {
        return new TransactionWriteBuilder(db, (tableName) => new QueryBuilder(tableName, db));
    }

    /** Converts the configured operation into one transaction item. */
    public toTransactionItem(options: TransactionItemOptions = {}): TransactWriteItem {
        this.request.applyExpressions(this.expressions);
        const operation = this.request.getOperation();
        const returnValues = options.returnValuesOnConditionCheckFailure;

        if (operation === null) {
            throw new Error('A transaction operation must be configured');
        }

        switch (operation.kind) {
            case 'putItem':
                return {Put: {
                    TableName: operation.input.TableName,
                    Item: operation.input.Item,
                    ConditionExpression: operation.input.ConditionExpression,
                    ExpressionAttributeNames: operation.input.ExpressionAttributeNames,
                    ExpressionAttributeValues: operation.input.ExpressionAttributeValues,
                    ReturnValuesOnConditionCheckFailure: returnValues === undefined ? operation.input.ReturnValuesOnConditionCheckFailure : returnValues
                }};
            case 'deleteItem':
                return {Delete: {
                    TableName: operation.input.TableName,
                    Key: operation.input.Key,
                    ConditionExpression: operation.input.ConditionExpression,
                    ExpressionAttributeNames: operation.input.ExpressionAttributeNames,
                    ExpressionAttributeValues: operation.input.ExpressionAttributeValues,
                    ReturnValuesOnConditionCheckFailure: returnValues === undefined ? operation.input.ReturnValuesOnConditionCheckFailure : returnValues
                }};
            case 'updateItem':
                return {Update: {
                    TableName: operation.input.TableName,
                    Key: operation.input.Key,
                    UpdateExpression: operation.input.UpdateExpression,
                    ConditionExpression: operation.input.ConditionExpression,
                    ExpressionAttributeNames: operation.input.ExpressionAttributeNames,
                    ExpressionAttributeValues: operation.input.ExpressionAttributeValues,
                    ReturnValuesOnConditionCheckFailure: returnValues === undefined ? operation.input.ReturnValuesOnConditionCheckFailure : returnValues
                }};
            case 'conditionCheck':
                if (!operation.input.ConditionExpression) {
                    throw new Error('conditionCheck requires at least one condition');
                }
                return {ConditionCheck: {
                    ...operation.input,
                    ConditionExpression: operation.input.ConditionExpression,
                    ReturnValuesOnConditionCheckFailure: returnValues === undefined ? operation.input.ReturnValuesOnConditionCheckFailure : returnValues
                }};
            default:
                throw new Error('Transactions support only create, update, delete, and conditionCheck operations');
        }
    }

    /** Executes the configured operation once and caches its promise for repeated calls. */
    toPromise<T>(): Promise<T> {
        if (this._executed !== null) {
            if (this._executionMode !== 'all') {
                throw new Error('QueryBuilder operations can only be executed once');
            }
            return this._executed as Promise<T>;
        }

        this._executed = this.toResponse<T>().then((response) => response.value);
        return this._executed as Promise<T>;
    }

    /** Executes the configured operation and returns its value with DynamoDB metadata. */
    toResponse<T>(): Promise<DynamoResponse<T>> {
        if (this._response !== null) {
            return this._response as Promise<DynamoResponse<T>>;
        }
        this.assertExecutionAvailable('all');
        this.request.applyExpressions(this.expressions);
        const operation = this.request.getOperation();
        this._response = operation === null
            ? Promise.resolve({value: undefined, consumedCapacity: [], itemCollectionMetrics: []})
            : new QueryExecutor(
                this.dynamoDB,
                operation,
                this._docs,
                this._hardLimit,
                this._logger,
                this._rid,
                this.documentParser,
                this._projection
            ).executeResponse<T>() as Promise<DynamoResponse<any>>;
        return this._response as Promise<DynamoResponse<T>>;
    }

    private toResult<T, TPrevious = T>(): Promise<ConditionalWriteResult<T, TPrevious>> {
        if (this._result === null) {
            this._result = this.toPromise<T>().then(
                (value): ConditionalWriteResult<T, TPrevious> => ({applied: true, value}),
                (error): ConditionalWriteResult<T, TPrevious> => {
                    if (!(error instanceof ConditionalCheckFailedException)) {
                        throw error;
                    }
                    const previous = error.Item === undefined ? null : QuerySerializer.parseItem(error.Item) as TPrevious;
                    return {applied: false, previous};
                }
            );
        }
        return this._result as Promise<ConditionalWriteResult<T, TPrevious>>;
    }

    private toPromiseOrNull<T>(): Promise<T | null> {
        return this.toPromise<T>().catch((error) => {
            if (error instanceof ConditionalCheckFailedException) {
                return null;
            }

            throw error;
        });
    }
}

/** Defines a schema-aware table with typed Zod-validated operations. */
export const defineTable = defineTypedTable;
/** Creates an on-demand table from a full definition or string-key shorthand. */
export const createTable = QueryBuilder.createTable;
/** Deletes a DynamoDB table. */
export const deleteTable = QueryBuilder.deleteTable;
/** Returns raw AWS table metadata. Use getTableDefinition for a portable key/index definition. */
export const describeTable = QueryBuilder.describeTable;
/** Returns a validated key/index definition. Use describeTable for the full raw AWS response. */
export const getTableDefinition = QueryBuilder.getTableDefinition;
/** Lists DynamoDB table names. */
export const listTables = QueryBuilder.listTables;
/** Starts an atomic low-level transaction builder. */
export const transactWrite = QueryBuilder.transactWrite;
