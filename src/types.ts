import type {ConsumedCapacity, ItemCollectionMetrics} from '@aws-sdk/client-dynamodb';

type Binary = Uint8Array;

export type SerialisedItem<T, A> = { L: SerialisedItem<T, any>[] } | { SS: T } | { M: A } | { NS: string[] } | { NULL: boolean } | { S: T } | { N: string } | { BOOL: T } | null
export type SerialisedMap<T> = { [key: string]: SerialisedItem<T, any> }
export type GenericDocument<T> = { [key: string]: T };
export type GetDocumentSelector = GenericDocument<string | number | Uint8Array>;
export type GetStringSelector = { S: string };
export type GetNumberSelector = { N: string };
export type GetBoolSelector = { BOOL: boolean };
export type GetNullSelector = { NULL: boolean };
export type GetStringSetSelector = { SS: string[] };
export type GetNumberSetSelector = { NS: string[] };
export type GetBinarySelector = { B: Uint8Array };
export type GetBinarySetSelector = { BS: Uint8Array[] };
export type GetMapSelector = { M: GenericDocument<GetSelector> };
export type GetSelector =
    GetStringSelector
    | GetNumberSelector
    | GetBoolSelector
    | GetNullSelector
    | GetMapSelector
    | GetStringSetSelector
    | GetNumberSetSelector
    | GetListSelector
    | GetBinarySelector
    | GetBinarySetSelector;
export type GetListSelector = { L: GetSelector[] };
export type QueryDocument = GenericDocument<string | number | Uint8Array>;
/** Opaque key document returned by DynamoDB for paginated reads. */
export type QueryCursor = GenericDocument<string | number | Uint8Array>;
export type IndexKind = 'global' | 'local';

/** Options for fetching one page or starting a paginated iterator. */
export interface PageOptions {
    limit?: number;
    cursor?: QueryCursor | null;
}

/** A page of records and the cursor for the next page, if one exists. */
export interface QueryPage<T> {
    items: T[];
    cursor: QueryCursor | null;
}

/** DynamoDB metadata returned alongside a fluent operation result. */
export interface DynamoResponse<T> {
    /** The operation's existing value result. */
    value: T;
    /** One capacity report for each SDK request, including pages and batch retries. */
    consumedCapacity: readonly ConsumedCapacity[];
    /** Item-collection size estimates returned by writes to tables with local secondary indexes. */
    itemCollectionMetrics: readonly ItemCollectionMetrics[];
}

/** DynamoDB's capacity-reporting modes. */
export type ReturnConsumedCapacity = 'NONE' | 'TOTAL' | 'INDEXES';

/** Controls the number of concurrent requests used by batch operations. */
export interface BatchOptions {
    concurrency?: number;
}
/** Batch read options in addition to chunk concurrency. */
export interface BatchGetOptions extends BatchOptions {
    consistentRead?: boolean;
    select?: string[];
    returnConsumedCapacity?: ReturnConsumedCapacity;
}
/** Batch write options in addition to chunk concurrency. */
export interface BatchWriteOptions extends BatchOptions {
    returnConsumedCapacity?: ReturnConsumedCapacity;
    returnItemCollectionMetrics?: 'NONE' | 'SIZE';
}
/** Primary-key document accepted by an update operation. */
export type UpdateDocumentSelector = GenericDocument<string | number | Uint8Array>;
export type UpdateDocumentWith = GenericDocument<any>;
export type CreateDocumentWith = GenericDocument<any>;
export type DeleteDocumentWith = GenericDocument<any>;
export type GetDocumentWith = GenericDocument<any>;
/** Promise returned by an untyped terminal operation. */
export type PromiseFinal<T> = Promise<T>
/** Successful update payload mode. */
export type UpdateReturnMode = 'all-new' | 'none';
/** Successful delete payload mode. */
export type DeleteReturnMode = 'all-old' | 'none';

/** Result of a conditional write, including the previous record on failure when requested. */
export type ConditionalWriteResult<T, TPrevious = T> =
    | {applied: true; value: T}
    | {applied: false; previous: TPrevious | null};

/** Terminal operation shared by conditional create, update, and delete chains. */
export interface ConditionalWriteFinal {
    /** Executes the write and returns whether its condition was applied. */
    toResult<T, TPrevious = T>(): Promise<ConditionalWriteResult<T, TPrevious>>;
}

/** Comparison methods available while building a create condition. */
export interface CreateWhereQuery {
    /** Requires the selected attribute to exist. */
    exists(): CreateQuery;
    /** Requires the selected attribute to equal the supplied value. */
    eq(val: any): CreateQuery;
    /** Requires the selected attribute not to equal the supplied value. */
    ne(val: any): CreateQuery;
    /** Requires the selected attribute to be greater than the supplied value. */
    gt(num: string | number | Binary): CreateQuery;
    /** Requires the selected attribute to be greater than or equal to the supplied value. */
    gte(num: string | number | Binary): CreateQuery;
    /** Requires the selected attribute to be less than the supplied value. */
    lt(num: string | number | Binary): CreateQuery;
    /** Requires the selected attribute to be less than or equal to the supplied value. */
    lte(num: string | number | Binary): CreateQuery;
    /** Requires the selected attribute to contain the supplied value. */
    contains(val: unknown): CreateQuery;
    /** Requires the selected attribute to match one of the supplied values. */
    in(val: unknown[]): CreateQuery;
}

/** Negation entry point for a create condition. */
export interface CreateNotWhereQuery extends CreateWhereQuery {
    /** Negates the next comparison. */
    not(): CreateWhereQuery;
}

/** Adds condition-failure return-value selection to a write chain. */
export interface ConditionFailureReturnQuery<T> {
    /** Selects whether DynamoDB should return the previous item on a failed condition. */
    onConditionFailure(): ConditionFailureReturnOptions<T>;
}

/** Return-value options for a failed conditional write. */
export interface ConditionFailureReturnOptions<T> {
    /** Requests the previous item in the conditional failure response. */
    returningAllOld(): T;
    /** Suppresses the previous item in the conditional failure response. */
    returningNone(): T;
}

/** Fluent result for an untyped create operation. */
export interface CreateQuery extends ConditionFailureReturnQuery<CreateQuery>, ConditionalWriteFinal {
    /** Adds a condition to the new item before it is created. */
    where(key: string): CreateNotWhereQuery;
    /** Returns the item replaced by a successful put, if any. */
    returningAllOld(): CreateQuery;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): CreateQuery;
    /** Requests local-secondary-index item-collection metrics in toResponse(). */
    returnItemCollectionMetrics(): CreateQuery;
    /** Executes the create and returns the SDK result payload. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the create and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Comparison methods available while building a delete condition. */
export interface DeleteWhereQuery {
    /** Requires the selected attribute to exist. */
    exists(): DeleteQuery;
    /** Requires the selected attribute to equal the supplied value. */
    eq(val: any): DeleteQuery;
    /** Requires the selected attribute not to equal the supplied value. */
    ne(val: any): DeleteQuery;
    /** Requires the selected attribute to be greater than the supplied value. */
    gt(num: string | number | Binary): DeleteQuery;
    /** Requires the selected attribute to be greater than or equal to the supplied value. */
    gte(num: string | number | Binary): DeleteQuery;
    /** Requires the selected attribute to be less than the supplied value. */
    lt(num: string | number | Binary): DeleteQuery;
    /** Requires the selected attribute to be less than or equal to the supplied value. */
    lte(num: string | number | Binary): DeleteQuery;
    /** Requires the selected attribute to contain the supplied value. */
    contains(val: unknown): DeleteQuery;
    /** Requires the selected attribute to match one of the supplied values. */
    in(val: unknown[]): DeleteQuery;
}

/** Negation entry point for a delete condition. */
export interface DeleteNotWhereQuery extends DeleteWhereQuery {
    /** Negates the next comparison. */
    not(): DeleteWhereQuery;
}

/** Fluent result for an untyped delete operation. */
export interface DeleteQuery extends ConditionFailureReturnQuery<DeleteQuery>, ConditionalWriteFinal {
    /** Adds a condition to the item before it is deleted. */
    where(key: string): DeleteNotWhereQuery;
    /** Returns the deleted item, when present, in the successful result. */
    returningAllOld(): DeleteQuery;
    /** Omits the deleted item from the successful result. */
    returningNone(): DeleteQuery;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): DeleteQuery;
    /** Requests local-secondary-index item-collection metrics in toResponse(). */
    returnItemCollectionMetrics(): DeleteQuery;
    /** Executes the delete and returns the SDK result payload. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the delete and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Comparison methods available while building a condition-check condition. */
export interface ConditionCheckWhereQuery {
    /** Requires the selected attribute to exist. */
    exists(): ConditionCheckQuery;
    /** Requires the selected attribute to equal the supplied value. */
    eq(val: any): ConditionCheckQuery;
    /** Requires the selected attribute not to equal the supplied value. */
    ne(val: any): ConditionCheckQuery;
    /** Requires the selected attribute to be greater than the supplied value. */
    gt(num: string | number | Binary): ConditionCheckQuery;
    /** Requires the selected attribute to be greater than or equal to the supplied value. */
    gte(num: string | number | Binary): ConditionCheckQuery;
    /** Requires the selected attribute to be less than the supplied value. */
    lt(num: string | number | Binary): ConditionCheckQuery;
    /** Requires the selected attribute to be less than or equal to the supplied value. */
    lte(num: string | number | Binary): ConditionCheckQuery;
    /** Requires the selected attribute to contain the supplied value. */
    contains(val: unknown): ConditionCheckQuery;
    /** Requires the selected attribute to match one of the supplied values. */
    in(val: unknown[]): ConditionCheckQuery;
}

/** Negation entry point for a condition-check condition. */
export interface ConditionCheckNotWhereQuery extends ConditionCheckWhereQuery {
    /** Negates the next comparison. */
    not(): ConditionCheckWhereQuery;
}

/** Fluent result for an untyped DynamoDB condition check. */
export interface ConditionCheckQuery extends ConditionFailureReturnQuery<ConditionCheckQuery> {
    /** Adds a condition that must hold for the transaction item. */
    where(key: string): ConditionCheckNotWhereQuery;
    /** Executes the condition check. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the condition check and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Fluent operations for a DynamoDB query. */
export interface Query {
    /** Sets the DynamoDB page size and optional all-page hard limit. */
    limit(chunkSize: number, hardLimit: number | null): Query;
    /** Requests a strongly consistent table or local-index read. */
    consistent(): Query;
    /** Returns query results in ascending sort-key order. */
    ascending(): Query;
    /** Returns query results in descending sort-key order. */
    descending(): Query;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): Query;
    /** Runs the query against a declared secondary index. */
    usingIndex(index: string, kind?: IndexKind): SubQuery;
    /** Adds a comparison against the table or index sort key. */
    sortKey(attribute: string): QuerySortKeyComparison;
    /** Adds a post-read filter. */
    where(attribute: string): QueryScanWhereSubQuery;
    /** Restricts returned records to the selected attributes. */
    select(...attributes: string[]): Query;
    /** Changes the operation to return only the matching-record count. */
    count(): CountFinal;
    /** Fetches one page and returns its continuation cursor. */
    page<T>(options?: PageOptions): Promise<QueryPage<T>>;
    /** Lazily iterates through result pages. */
    pages<T>(options?: PageOptions): AsyncIterable<QueryPage<T>>;
    /** Lazily iterates through result records across all pages. */
    items<T>(options?: PageOptions): AsyncIterable<T>;
    /** Executes the query and resolves all matching records. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the query and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Comparisons supported for a declared query sort key. */
export interface QuerySortKeyComparison {
    /** Matches an exact sort-key value. */
    eq(value: string | number | Binary): Query;
    /** Matches sort-key values greater than the supplied value. */
    gt(value: string | number | Binary): Query;
    /** Matches sort-key values greater than or equal to the supplied value. */
    gte(value: string | number | Binary): Query;
    /** Matches sort-key values less than the supplied value. */
    lt(value: string | number | Binary): Query;
    /** Matches sort-key values less than or equal to the supplied value. */
    lte(value: string | number | Binary): Query;
    /** Matches sort-key values in the inclusive range. */
    between(lower: string | number | Binary, upper: string | number | Binary): Query;
    /** Matches string or binary sort keys beginning with the supplied prefix. */
    beginsWith(value: string | Binary): Query;
}

/** Fluent operations available after selecting a secondary index. */
export interface SubQuery {
    /** Requests a strongly consistent local-index read. */
    consistent(): SubQuery;
    /** Returns query results in ascending sort-key order. */
    ascending(): SubQuery;
    /** Returns query results in descending sort-key order. */
    descending(): SubQuery;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): SubQuery;
    /** Adds a post-read filter. */
    where(attribute: string): QueryScanWhereSubQuery;
    /** Restricts returned records to the selected attributes. */
    select(...attributes: string[]): SubQuery;
    /** Changes the operation to return only the matching-record count. */
    count(): CountFinal;
    /** Fetches one page and returns its continuation cursor. */
    page<T>(options?: PageOptions): Promise<QueryPage<T>>;
    /** Lazily iterates through result pages. */
    pages<T>(options?: PageOptions): AsyncIterable<QueryPage<T>>;
    /** Lazily iterates through result records across all pages. */
    items<T>(options?: PageOptions): AsyncIterable<T>;
    /** Executes the indexed query and resolves all matching records. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the query and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Fluent operations for a DynamoDB scan. */
export interface Scan {
    /** Sets the DynamoDB page size and optional all-page hard limit. */
    limit(chunkSize: number, hardLimit: number | null): Scan;
    /** Requests a strongly consistent scan. */
    consistent(): Scan;
    /** Configures one segment of a parallel scan. */
    parallel(segment: number, totalSegments: number): Scan;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): Scan;
    /** Adds a post-read filter. */
    where(attribute: string): QueryScanWhereSubQuery;
    /** Restricts returned records to the selected attributes. */
    select(...attributes: string[]): Scan;
    /** Changes the operation to return only the matching-record count. */
    count(): CountFinal;
    /** Fetches one page and returns its continuation cursor. */
    page<T>(options?: PageOptions): Promise<QueryPage<T>>;
    /** Lazily iterates through result pages. */
    pages<T>(options?: PageOptions): AsyncIterable<QueryPage<T>>;
    /** Lazily iterates through result records across all pages. */
    items<T>(options?: PageOptions): AsyncIterable<T>;
    /** Executes the scan and resolves all matching records. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the scan and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Comparison methods available while building a query or scan filter. */
export interface QueryScanWhereNotSubQuery {
    /** Matches records where the selected attribute equals the supplied value. */
    eq(val: any): SubQuery;
    /** Matches records where the selected attribute differs from the supplied value. */
    ne(val: any): SubQuery;
    /** Matches records where the selected attribute is greater than the supplied value. */
    gt(num: string | number | Binary): SubQuery;
    /** Matches records where the selected attribute is greater than or equal to the supplied value. */
    gte(num: string | number | Binary): SubQuery;
    /** Matches records where the selected attribute is less than the supplied value. */
    lt(num: string | number | Binary): SubQuery;
    /** Matches records where the selected attribute is less than or equal to the supplied value. */
    lte(num: string | number | Binary): SubQuery;
    /** Matches records where the selected attribute contains the supplied value. */
    contains(val: unknown): SubQuery;
    /** Matches records where the selected attribute equals one supplied value. */
    in(val: unknown[]): SubQuery;
}

/** Negation entry point for a query or scan filter. */
export interface QueryScanWhereSubQuery extends QueryScanWhereNotSubQuery {
    /** Negates the next filter comparison. */
    not(): QueryScanWhereNotSubQuery;
}

/** Terminal operation for an untyped read. */
export interface Final {
    /** Executes the configured read or write operation. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the operation and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
}

/** Terminal operation for a count-only read. */
export interface CountFinal {
    /** Executes the count and returns the number of matching records. */
    toPromise(): PromiseFinal<number>;
    /** Executes the count and returns it with DynamoDB request metadata. */
    toResponse(): PromiseFinal<DynamoResponse<number>>;
}

/** Comparison methods available while building an update condition. */
export interface UpdateWhereQuery {
    /** Requires the selected attribute to exist. */
    exists(): UpdateSubQuery;
    /** Requires the selected attribute to equal the supplied value. */
    eq(val: any): UpdateSubQuery;
    /** Requires the selected attribute not to equal the supplied value. */
    ne(val: any): UpdateSubQuery;
    /** Requires the selected attribute to be greater than the supplied value. */
    gt(num: string | number | Binary): UpdateSubQuery;
    /** Requires the selected attribute to be greater than or equal to the supplied value. */
    gte(num: string | number | Binary): UpdateSubQuery;
    /** Requires the selected attribute to be less than the supplied value. */
    lt(num: string | number | Binary): UpdateSubQuery;
    /** Requires the selected attribute to be less than or equal to the supplied value. */
    lte(num: string | number | Binary): UpdateSubQuery;
    /** Requires the selected attribute to contain the supplied value. */
    contains(val: unknown): UpdateSubQuery;
    /** Requires the selected attribute to match one of the supplied values. */
    in(val: unknown[]): UpdateSubQuery;
}

/** Negation entry point for an update condition. */
export interface UpdateNotWhereQuery extends UpdateWhereQuery {
    /** Negates the next comparison. */
    not(): UpdateWhereQuery;
}

/** Fluent modifiers for an untyped update operation. */
export interface UpdateQuery {
    /** Sets multiple non-key attributes from a partial document. */
    with(doc: {}): UpdateWithQuery;
    /** Begins a single-attribute SET update. */
    set(attribute: string): UpdateEqQuery;
    /** Removes an attribute from the item. */
    remove(attribute: string): UpdateSubQuery;
    /** Begins a numeric or set-membership ADD update. */
    add(attribute: string): AddSubQuery;
    /** Begins a set-membership DELETE update. */
    delete(attribute: string): DeleteSubQuery;
}

/** Fluent continuation for an update after an update expression is selected. */
export interface UpdateSubQuery extends ConditionFailureReturnQuery<UpdateSubQuery>, ConditionalWriteFinal {
    /** Adds a condition to the item before it is updated. */
    where(key: string): UpdateNotWhereQuery;
    /** Returns the updated item in the successful result. */
    returningAllNew(): UpdateSubQuery;
    /** Returns the previous item in the successful result. */
    returningAllOld(): UpdateSubQuery;
    /** Omits the updated item from the successful result. */
    returningNone(): UpdateSubQuery;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): UpdateSubQuery;
    /** Requests local-secondary-index item-collection metrics in toResponse(). */
    returnItemCollectionMetrics(): UpdateSubQuery;
    /** Begins a single-attribute SET update. */
    set(attribute: string): UpdateEqQuery;
    /** Removes an attribute from the item. */
    remove(attribute: string): UpdateSubQuery;
    /** Begins a numeric or set-membership ADD update. */
    add(attribute: string): AddSubQuery;
    /** Begins a set-membership DELETE update. */
    delete(attribute: string): DeleteSubQuery;
    /** Executes the update and returns the SDK result payload. */
    toPromise<T>(): PromiseFinal<T>;
    /** Executes the update and returns its value with DynamoDB request metadata. */
    toResponse<T>(): PromiseFinal<DynamoResponse<T>>;
    /** Executes the update and converts a conditional failure into `null`. */
    toPromiseOrNull<T>(): PromiseFinal<T | null>;
}

export type UpdateWithQuery = UpdateSubQuery;

/** Supplies the value for a single-attribute SET update. */
export interface UpdateEqQuery {
    /** Applies the value and returns the update continuation. */
    eq(val: any): UpdateSubQuery;
}

/** Supplies the value for a single-attribute SET update. */
export interface SetSubQuery {
    /** Applies the value and returns the update continuation. */
    eq(val: any): UpdateSubQuery;
}

/** Supplies the value for a numeric or set-membership ADD update. */
export interface AddSubQuery {
    /** Applies the increment or set members and returns the update continuation. */
    eq(val: Set<string | number | Binary> | number): UpdateSubQuery;
}

/** Supplies the set members to remove with a DELETE update. */
export interface DeleteSubQuery {
    /** Applies the set members and returns the update continuation. */
    eq(val: Set<string | number | Binary>): UpdateSubQuery;
}

export enum UpdateExpressionType {
    SET = 'SET',
    REMOVE = 'REMOVE',
    ADD = 'ADD',
    DELETE = 'DELETE'
}

export type StreamItem = ({ s: (value: any) => any, f: (error: any) => any, work: () => Promise<any> });
export type Stream = StreamItem[];
