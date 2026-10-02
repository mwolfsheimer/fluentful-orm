import type {DynamoDBClient, TransactWriteItemsCommandOutput} from '@aws-sdk/client-dynamodb';
import {z} from 'zod';
import {QueryBuilder} from './query-builder';
import {assertDynamoKeyValue} from './dynamodb-values';
import {isAttributeReference, path, ref, pathSegments, uniquePaths} from './document-path';
import type {AttributePath, AttributeReference, DocumentPath, PathSegment} from './document-path';
import type {ExpressionAttributeType, PredicateScope, SizeComparison} from './predicate';
import type {BatchGetOptions, BatchWriteOptions, ConditionalWriteResult, ConditionFailureReturnOptions, DynamoResponse, IndexKind, PageOptions, QueryPage, ReturnConsumedCapacity} from './types';
import {TransactionWriteBuilder} from './transaction-write-builder';
import type {TransactionItemOptions} from './transaction-write-builder';

type AnyRecord = Record<string, any>;
type RecordSchema = z.ZodObject<z.ZodRawShape>;
type RecordOf<TSchema extends RecordSchema> = z.output<TSchema>;
type InputOf<TSchema extends RecordSchema> = z.input<TSchema>;
type RecordKey<TRecord> = Extract<keyof TRecord, string>;
type DynamoKeyValue = string | number | Uint8Array;
type DynamoKeyField<TRecord> = {[TKey in RecordKey<TRecord>]: TRecord[TKey] extends DynamoKeyValue ? TKey : never}[RecordKey<TRecord>];

export type PathValue<TRecord, TSegments extends readonly PathSegment[]> = TRecord extends unknown
    ? TSegments extends readonly [infer THead, ...infer TTail extends PathSegment[]]
        ? NonNullable<TRecord> extends Uint8Array | ReadonlySet<unknown> | Date ? never
            : THead extends number ? NonNullable<TRecord> extends readonly (infer TItem)[] ? PathValue<TItem, TTail> : never
                : THead extends keyof NonNullable<TRecord> ? PathValue<NonNullable<TRecord>[THead], TTail> : never
        : TRecord
    : never;
type TypedAttribute<TRecord> = RecordKey<TRecord> | DocumentPath<unknown, readonly [RecordKey<TRecord>, ...PathSegment[]]>;
type AttributeValue<TRecord, TAttribute> = TAttribute extends keyof TRecord ? TRecord[TAttribute]
    : TAttribute extends DocumentPath<unknown, infer TSegments> ? PathValue<TRecord, TSegments> : never;
type PartialProjection<TValue> = TValue extends Uint8Array | ReadonlySet<unknown> | Date ? TValue
    : TValue extends readonly (infer TItem)[] ? PartialProjection<TItem>[]
        : TValue extends object ? {[TField in keyof TValue]?: PartialProjection<TValue[TField]>} : TValue;
type ProjectedPath<TRecord, TSegments extends readonly PathSegment[]> = TRecord extends unknown
    ? TSegments extends readonly [infer THead, ...infer TTail extends PathSegment[]]
        ? THead extends number ? NonNullable<TRecord> extends readonly (infer TItem)[] ? PartialProjection<ProjectedPath<TItem, TTail>>[] : never
            : THead extends keyof NonNullable<TRecord> ? {[TField in THead]?: ProjectedPath<NonNullable<TRecord>[TField], TTail>} : never
        : TRecord
    : never;
type PathProjection<TRecord, TAttribute> = TAttribute extends DocumentPath<unknown, infer TSegments> ? ProjectedPath<TRecord, TSegments> : never;
type UnionIntersection<TValue> = (TValue extends unknown ? (value: TValue) => void : never) extends (value: infer TResult) => void ? TResult : never;
export type ProjectedRecord<TRecord, TAttribute> = Pick<TRecord, Extract<TAttribute, keyof TRecord>>
    & ([Extract<TAttribute, DocumentPath>] extends [never] ? unknown : UnionIntersection<PathProjection<TRecord, Extract<TAttribute, DocumentPath>>>);

export interface TypedPredicateGroups<TRecord, TNext> {
    whereAny(callback: (group: TypedPredicateScope<TRecord>) => TypedPredicateScope<TRecord> | void): TNext;
    whereAll(callback: (group: TypedPredicateScope<TRecord>) => TypedPredicateScope<TRecord> | void): TNext;
    whereNot(callback: (group: TypedPredicateScope<TRecord>) => TypedPredicateScope<TRecord> | void): TNext;
}

export interface TypedPredicateScope<TRecord> extends TypedPredicateGroups<TRecord, TypedPredicateScope<TRecord>> {
    where<TAttribute extends TypedAttribute<TRecord>>(attribute: TAttribute): TypedConditionalComparison<AttributeValue<TRecord, TAttribute>, TypedPredicateScope<TRecord>>;
}

/** Declares the partition key and optional sort key for a typed table or index. */
export type KeyDefinition<TRecord> = {readonly partition: DynamoKeyField<TRecord>, readonly sort?: DynamoKeyField<TRecord>};

/** Controls which fields a typed secondary index returns. */
export type IndexProjection<TRecord> =
    | {readonly type: 'ALL'}
    | {readonly type: 'KEYS_ONLY'}
    | {readonly type: 'INCLUDE'; readonly nonKeyAttributes: readonly RecordKey<TRecord>[]};

/** Declares a typed global or local secondary index and its projection. */
export type IndexDefinition<TRecord> = KeyDefinition<TRecord> & {
    readonly kind: IndexKind;
    readonly projection?: IndexProjection<TRecord>;
};
type IndexDefinitions<TRecord> = Record<string, IndexDefinition<TRecord>>;
type KeyField<TRecord, TKey extends KeyDefinition<TRecord>> = TKey['partition'] | (TKey extends {readonly sort: infer TSort extends RecordKey<TRecord>} ? TSort : never);
type IndexProjectionField<TRecord, TTableKey extends KeyDefinition<TRecord>, TIndex extends IndexDefinition<TRecord>> =
    TIndex extends {readonly projection: {readonly type: 'KEYS_ONLY'}}
        ? KeyField<TRecord, TTableKey> | KeyField<TRecord, TIndex>
        : TIndex extends {readonly projection: {readonly type: 'INCLUDE'; readonly nonKeyAttributes: readonly (infer TAttribute)[]}}
            ? KeyField<TRecord, TTableKey> | KeyField<TRecord, TIndex> | Extract<TAttribute, RecordKey<TRecord>>
            : RecordKey<TRecord>;
type IndexProjectedRecord<TRecord, TTableKey extends KeyDefinition<TRecord>, TIndex extends IndexDefinition<TRecord>> =
    Pick<TRecord, IndexProjectionField<TRecord, TTableKey, TIndex>>;
type IndexAvailableRecord<TRecord, TTableKey extends KeyDefinition<TRecord>, TIndex extends IndexDefinition<TRecord>> =
    TIndex['kind'] extends 'local' ? TRecord : IndexProjectedRecord<TRecord, TTableKey, TIndex>;
type KeyDocument<TRecord, TKey extends KeyDefinition<TRecord>> = Pick<TRecord, KeyField<TRecord, TKey>>;
type PartitionKeyDocument<TRecord, TKey extends KeyDefinition<TRecord>> = Pick<TRecord, TKey['partition']>;
type ComparisonValue<T> = T extends string ? string : T extends ReadonlySet<infer TValue>
    ? TValue
    : T extends readonly (infer TValue)[]
        ? TValue
        : T;

export interface TypedFinal<TResult> {
    /** Executes the typed operation and validates its result against the table schema. */
    toPromise(): Promise<TResult>;
    /** Executes the typed operation and returns DynamoDB response metadata. */
    toResponse(): Promise<DynamoResponse<TResult>>;
    
}

/** Fluent modifiers available for a typed point read. */
export interface TypedGetChain<TRecord, TResult = TRecord | null> extends TypedFinal<TResult> {
    /** Requests a strongly consistent read. */
    consistent(): TypedGetChain<TRecord, TResult>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedGetChain<TRecord, TResult>;
    /** Projects and validates selected fields. */
    select<const TAttributes extends readonly TypedAttribute<TRecord>[]>(...attributes: TAttributes): TypedGetChain<TRecord, ProjectedRecord<TRecord, TAttributes[number]> | null>;
}

/** Adds typed conditional-write result handling to a write chain. */
export interface TypedWriteFinal<TRecord, TResult> extends TypedFinal<TResult> {
    /** Returns whether the condition was applied and validates any previous record. */
    toResult(): Promise<ConditionalWriteResult<TResult, TRecord>>;
}

/** Fluent chain for creating a typed record. */
export interface TypedCreateChain<TRecord> extends TypedWriteFinal<TRecord, TRecord>, TypedPredicateGroups<TRecord, TypedCreateChain<TRecord>> {
    /** Adds a schema-validated condition to the new record. */
    where<TAttribute extends TypedAttribute<TRecord>>(key: TAttribute): TypedConditionalComparison<AttributeValue<TRecord, TAttribute>, TypedCreateChain<TRecord>>;
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedCreateChain<TRecord>>;
    /** Returns the item replaced by a successful put, if present. */
    returningAllOld(): TypedCreateChain<TRecord>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedCreateChain<TRecord>;
    /** Requests local-secondary-index item-collection metrics in toResponse(). */
    returnItemCollectionMetrics(): TypedCreateChain<TRecord>;
}

/** Type-safe comparison operators for a record field. */
export interface TypedComparison<TValue, TNext> {
    eq(value: TValue | AttributeReference<TValue>): TNext;
    ne(value: TValue | AttributeReference<TValue>): TNext;
    gt(value: TValue | AttributeReference<TValue>): TNext;
    gte(value: TValue | AttributeReference<TValue>): TNext;
    lt(value: TValue | AttributeReference<TValue>): TNext;
    lte(value: TValue | AttributeReference<TValue>): TNext;
    contains(value: ComparisonValue<TValue>): TNext;
    in(values: (TValue | AttributeReference<TValue>)[]): TNext;
    between(lower: TValue | AttributeReference<TValue>, upper: TValue | AttributeReference<TValue>): TNext;
    beginsWith(value: NonNullable<TValue> extends string ? string : NonNullable<TValue> extends Uint8Array ? Uint8Array : never): TNext;
    exists(): TNext;
    attributeType(type: ExpressionAttributeType): TNext;
    size(): SizeComparison<TNext>;
    not(): TypedComparison<TValue, TNext>;
}

export interface TypedConditionalComparison<TValue, TNext> extends TypedComparison<TValue, TNext> {}
export interface TypedFilterComparison<TValue, TNext> extends TypedComparison<TValue, TNext> {}

/** Fluent chain for a typed condition check. */
export interface TypedConditionChain<TRecord, TResult> extends TypedFinal<TResult>, TypedPredicateGroups<TRecord, TypedConditionChain<TRecord, TResult>> {
    /** Adds a schema-validated condition to the item. */
    where<TAttribute extends TypedAttribute<TRecord>>(key: TAttribute): TypedConditionalComparison<AttributeValue<TRecord, TAttribute>, TypedConditionChain<TRecord, TResult>>;
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedConditionChain<TRecord, TResult>>;
}

/** Shared typed read modifiers and terminal operations. */
export interface TypedReadChain<TRecord, TResult = TRecord, TSelectable = TResult> extends TypedFinal<TResult[]>, TypedPredicateGroups<TRecord, TypedReadChain<TRecord, TResult, TSelectable>> {
    /** Requests a strongly consistent table or local-index read. */
    consistent(): TypedReadChain<TRecord, TResult, TSelectable>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedReadChain<TRecord, TResult, TSelectable>;
    /** Adds a schema-validated post-read filter. */
    where<TAttribute extends TypedAttribute<TRecord>>(key: TAttribute): TypedFilterComparison<AttributeValue<TRecord, TAttribute>, TypedReadChain<TRecord, TResult, TSelectable>>;
    /** Projects and type-checks only the selected fields. */
    select<const TAttributes extends readonly TypedAttribute<TSelectable>[]>(...attributes: TAttributes): TypedReadChain<TRecord, ProjectedRecord<TSelectable, TAttributes[number]>, ProjectedRecord<TSelectable, TAttributes[number]>>;
    /** Changes the read to return the number of matching records. */
    count(): TypedFinal<number>;
    /** Fetches one typed page and its continuation cursor. */
    page(options?: PageOptions): Promise<QueryPage<TResult>>;
    /** Lazily iterates through typed pages. */
    pages(options?: PageOptions): AsyncIterable<QueryPage<TResult>>;
    /** Lazily iterates through typed records. */
    items(options?: PageOptions): AsyncIterable<TResult>;
}

/** Typed query modifiers, including page-size and hard-limit controls. */
export interface TypedQueryChain<TRecord, TResult = TRecord, TSelectable = TResult> extends TypedReadChain<TRecord, TResult, TSelectable> {
    /** Sets the DynamoDB page size and optional all-page hard limit. */
    limit(chunkSize: number, hardLimit?: number | null): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Requests a strongly consistent table or local-index read. */
    consistent(): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Returns results in ascending sort-key order. */
    ascending(): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Returns results in descending sort-key order. */
    descending(): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Projects and type-checks only the selected fields. */
    select<const TAttributes extends readonly TypedAttribute<TSelectable>[]>(...attributes: TAttributes): TypedQueryChain<TRecord, ProjectedRecord<TSelectable, TAttributes[number]>, ProjectedRecord<TSelectable, TAttributes[number]>>;
}

/** Comparisons supported by a typed table or index sort key. */
export interface TypedSortKeyComparison<TValue, TRecord, TResult = TRecord, TSelectable = TResult> {
    /** Matches an exact sort-key value. */
    eq(value: TValue): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Matches sort-key values greater than the supplied value. */
    gt(value: TValue): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Matches sort-key values greater than or equal to the supplied value. */
    gte(value: TValue): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Matches sort-key values less than the supplied value. */
    lt(value: TValue): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Matches sort-key values less than or equal to the supplied value. */
    lte(value: TValue): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Matches sort-key values in the inclusive range. */
    between(lower: TValue, upper: TValue): TypedQueryChain<TRecord, TResult, TSelectable>;
    /** Matches string or binary sort keys beginning with the supplied prefix. */
    beginsWith(value: TValue extends string ? string : TValue extends Uint8Array ? Uint8Array : never): TypedQueryChain<TRecord, TResult, TSelectable>;
}

/** Typed query chain for a composite key with a sort-key comparison entry point. */
export interface TypedCompositeQueryChain<TRecord, TSortValue> extends TypedQueryChain<TRecord> {
    /** Starts a comparison against the declared sort key. */
    sortKey(): TypedSortKeyComparison<TSortValue, TRecord>;
}

type TypedKeyQueryChain<TRecord, TKey extends KeyDefinition<TRecord>> = TKey extends {readonly sort: infer TSort extends RecordKey<TRecord>}
    ? TypedCompositeQueryChain<TRecord, TRecord[TSort]>
    : TypedQueryChain<TRecord>;

export interface TypedIndexQuery<TRecord, TKey extends KeyDefinition<TRecord>> {
    scan(): TypedScanChain<TRecord>;
    /** Queries the index partition key. */
    query(document: PartitionKeyDocument<TRecord, TKey>): TypedKeyQueryChain<TRecord, TKey>;
}

type TypedProjectedIndexQueryChain<
    TRecord,
    TTableKey extends KeyDefinition<TRecord>,
    TIndex extends IndexDefinition<TRecord>,
    TProjected = IndexProjectedRecord<TRecord, TTableKey, TIndex>,
    TAvailable = IndexAvailableRecord<TRecord, TTableKey, TIndex>
> = TIndex extends {readonly sort: infer TSort extends RecordKey<TRecord>}
    ? TypedQueryChain<TProjected, TProjected, TAvailable> & {
        sortKey(): TypedSortKeyComparison<TRecord[TSort], TProjected, TProjected, TAvailable>;
    }
    : TypedQueryChain<TProjected, TProjected, TAvailable>;

export interface TypedProjectedIndexQuery<
    TRecord,
    TTableKey extends KeyDefinition<TRecord>,
    TIndex extends IndexDefinition<TRecord>
> {
    scan(): TypedScanChain<IndexProjectedRecord<TRecord, TTableKey, TIndex>, IndexProjectedRecord<TRecord, TTableKey, TIndex>, IndexAvailableRecord<TRecord, TTableKey, TIndex>>;
    /** Queries the index partition key with projection-aware result types. */
    query(document: PartitionKeyDocument<TRecord, TIndex>): TypedProjectedIndexQueryChain<TRecord, TTableKey, TIndex>;
}

/** Typed scan modifiers. */
export interface TypedScanChain<TRecord, TResult = TRecord, TSelectable = TResult> extends TypedReadChain<TRecord, TResult, TSelectable> {
    where<TAttribute extends TypedAttribute<TRecord>>(key: TAttribute): TypedFilterComparison<AttributeValue<TRecord, TAttribute>, TypedScanChain<TRecord, TResult, TSelectable>>;
    whereAny(callback: (group: TypedPredicateScope<TRecord>) => TypedPredicateScope<TRecord> | void): TypedScanChain<TRecord, TResult, TSelectable>;
    whereAll(callback: (group: TypedPredicateScope<TRecord>) => TypedPredicateScope<TRecord> | void): TypedScanChain<TRecord, TResult, TSelectable>;
    whereNot(callback: (group: TypedPredicateScope<TRecord>) => TypedPredicateScope<TRecord> | void): TypedScanChain<TRecord, TResult, TSelectable>;
    /** Sets the DynamoDB page size and optional all-page hard limit. */
    limit(chunkSize: number, hardLimit?: number | null): TypedScanChain<TRecord, TResult, TSelectable>;
    /** Requests a strongly consistent scan. */
    consistent(): TypedScanChain<TRecord, TResult, TSelectable>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedScanChain<TRecord, TResult, TSelectable>;
    /** Configures one segment of a parallel scan. */
    parallel(segment: number, totalSegments: number): TypedScanChain<TRecord, TResult, TSelectable>;
    /** Projects and type-checks only the selected fields. */
    select<const TAttributes extends readonly TypedAttribute<TSelectable>[]>(...attributes: TAttributes): TypedScanChain<TRecord, ProjectedRecord<TSelectable, TAttributes[number]>, ProjectedRecord<TSelectable, TAttributes[number]>>;
}

/** Fluent chain for deleting a typed record. */
export interface TypedDeleteChain<TRecord, TResult = TRecord | null> extends TypedWriteFinal<TRecord, TResult>, TypedPredicateGroups<TRecord, TypedDeleteChain<TRecord, TResult>> {
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedDeleteChain<TRecord, TResult>>;
    /** Adds a schema-validated condition to the item. */
    where<TAttribute extends TypedAttribute<TRecord>>(key: TAttribute): TypedConditionalComparison<AttributeValue<TRecord, TAttribute>, TypedDeleteChain<TRecord, TResult>>;
    /** Returns the deleted record in the successful result. */
    returningAllOld(): TypedDeleteChain<TRecord, TRecord | null>;
    /** Omits the deleted record from the successful result. */
    returningNone(): TypedDeleteChain<TRecord, void>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedDeleteChain<TRecord, TResult>;
    /** Requests local-secondary-index item-collection metrics in toResponse(). */
    returnItemCollectionMetrics(): TypedDeleteChain<TRecord, TResult>;
}

/** Fluent chain for updating a typed record. */
export interface TypedUpdateChain<TRecord, TResult = TRecord | null> extends TypedWriteFinal<TRecord, TResult>, TypedPredicateGroups<TRecord, TypedUpdateChain<TRecord, TResult>> {
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedUpdateChain<TRecord, TResult>>;
    /** Adds a schema-validated condition to the item. */
    where<TAttribute extends TypedAttribute<TRecord>>(key: TAttribute): TypedConditionalComparison<AttributeValue<TRecord, TAttribute>, TypedUpdateChain<TRecord, TResult>>;
    /** Returns the updated record in the successful result. */
    returningAllNew(): TypedUpdateChain<TRecord, TRecord | null>;
    /** Returns the previous item in the successful result. */
    returningAllOld(): TypedUpdateChain<TRecord, TRecord | null>;
    /** Omits the updated record from the successful result. */
    returningNone(): TypedUpdateChain<TRecord, void>;
    /** Requests consumed-capacity metadata in toResponse(). */
    returnCapacity(mode?: ReturnConsumedCapacity): TypedUpdateChain<TRecord, TResult>;
    /** Requests local-secondary-index item-collection metrics in toResponse(). */
    returnItemCollectionMetrics(): TypedUpdateChain<TRecord, TResult>;
    /** Begins a type-checked SET update. */
    set<TAttribute extends TypedAttribute<TRecord>>(attribute: TAttribute): {eq(value: AttributeValue<TRecord, TAttribute>): TypedUpdateChain<TRecord, TResult>};
    /** Removes an attribute from the record. */
    remove(attribute: TypedAttribute<TRecord>): TypedUpdateChain<TRecord, TResult>;
    /** Begins a type-checked numeric or set-membership ADD update. */
    add<TKey extends RecordKey<TRecord>>(attribute: TKey): {eq(value: TRecord[TKey] extends number ? number : TRecord[TKey]): TypedUpdateChain<TRecord, TResult>};
    /** Begins a type-checked set-membership DELETE update. */
    delete<TKey extends RecordKey<TRecord>>(attribute: TKey): {eq(value: TRecord[TKey]): TypedUpdateChain<TRecord, TResult>};
    /** Executes the update and converts a conditional failure into `null`. */
    toPromiseOrNull(): Promise<TResult | null>;
}

/** Starts the type-checked modifiers for a typed update. */
export interface TypedUpdateStart<TRecord, TInput extends AnyRecord> {
    /** Sets several fields from a partial input document. */
    with(document: Partial<TInput>): TypedUpdateChain<TRecord>;
    /** Begins a type-checked SET update. */
    set<TAttribute extends TypedAttribute<TRecord>>(attribute: TAttribute): {eq(value: AttributeValue<TRecord, TAttribute>): TypedUpdateChain<TRecord>};
    /** Removes an attribute from the record. */
    remove(attribute: TypedAttribute<TRecord>): TypedUpdateChain<TRecord>;
    /** Begins a type-checked numeric or set-membership ADD update. */
    add<TKey extends RecordKey<TRecord>>(attribute: TKey): {eq(value: TRecord[TKey] extends number ? number : TRecord[TKey]): TypedUpdateChain<TRecord>};
    /** Begins a type-checked set-membership DELETE update. */
    delete<TKey extends RecordKey<TRecord>>(attribute: TKey): {eq(value: TRecord[TKey]): TypedUpdateChain<TRecord>};
}

/** Operations that can be added to a typed transaction item. */
export interface TypedTransactionTableQuery<TRecord, TInput extends AnyRecord, TKey extends KeyDefinition<TRecord>> {
    /** Adds a typed create operation to the transaction item. */
    create(document: TInput): TypedCreateChain<TRecord>;
    /** Adds a typed update operation to the transaction item. */
    update(key: KeyDocument<TRecord, TKey>): TypedUpdateStart<TRecord, TInput>;
    /** Adds a typed delete operation to the transaction item. */
    delete(key: KeyDocument<TRecord, TKey>): TypedDeleteChain<TRecord>;
    /** Adds a typed condition check to the transaction item. */
    conditionCheck(key: KeyDocument<TRecord, TKey>): TypedConditionChain<TRecord, void>;
}

export interface TableDefinitionOptions<
    TSchema extends RecordSchema,
    TKey extends KeyDefinition<RecordOf<TSchema>>,
    TIndexes extends IndexDefinitions<RecordOf<TSchema>>
> {
    /** DynamoDB table name. */
    name: string;
    /** Zod object schema used for input and output validation. */
    schema: TSchema;
    /** Primary key fields declared in the schema. */
    key: TKey;
    /** Optional typed secondary-index definitions. */
    indexes?: TIndexes;
    /** Adds `createdAt` and `modifiedAt` timestamps to writes. */
    timestamps?: boolean;
}

/** Schema-aware table definition that produces typed operation builders. */
export class TypedTable<
    TSchema extends RecordSchema,
    TKey extends KeyDefinition<RecordOf<TSchema>>,
    TIndexes extends IndexDefinitions<RecordOf<TSchema>>
> {
    readonly name: string;
    readonly schema: TSchema;
    readonly key: TKey;
    readonly indexes: TIndexes;
    readonly timestamps: boolean;

    /** Validates the table key and index definitions and stores the schema configuration. */
    constructor(options: TableDefinitionOptions<TSchema, TKey, TIndexes>) {
        this.name = options.name;
        this.schema = options.schema;
        this.key = options.key;
        this.indexes = (options.indexes || {}) as TIndexes;
        this.timestamps = options.timestamps === true;

        this.assertKeyDefinition(this.key, 'key');
        Object.entries(this.indexes).forEach(([indexName, definition]) => {
            if (definition.kind !== 'global' && definition.kind !== 'local') {
                throw new Error(`Typed table ${this.name} index ${indexName} requires a global or local kind`);
            }
            this.assertKeyDefinition(definition, `index ${indexName}`);
            this.assertIndexProjection(definition, indexName);
        });
    }

    /** Creates a schema-aware explicit document path. */
    path<const TSegments extends readonly [RecordKey<RecordOf<TSchema>>, ...PathSegment[]]>(
        ...segments: TSegments & (PathValue<RecordOf<TSchema>, TSegments> extends never ? never : unknown)
    ): DocumentPath<PathValue<RecordOf<TSchema>, TSegments>, TSegments> {
        const descriptor = path(...segments);
        this.assertField(descriptor);
        return descriptor as unknown as DocumentPath<PathValue<RecordOf<TSchema>, TSegments>, TSegments>;
    }

    /** Creates a schema-aware stored-field reference. */
    ref<const TSegments extends readonly [RecordKey<RecordOf<TSchema>>, ...PathSegment[]]>(
        ...segments: TSegments & (PathValue<RecordOf<TSchema>, TSegments> extends never ? never : unknown)
    ): AttributeReference<PathValue<RecordOf<TSchema>, TSegments>> {
        this.assertField(path(...segments));
        return ref(...segments) as AttributeReference<PathValue<RecordOf<TSchema>, TSegments>>;
    }

    /** Binds this table definition to a DynamoDB client. */
    using(dynamoDB: DynamoDBClient): TypedTableQuery<TSchema, TKey, TIndexes> {
        return new TypedTableQuery(this, dynamoDB);
    }

    /** Validates and returns a complete record. */
    parse(document: unknown): RecordOf<TSchema> {
        const parsed = this.schema.parse(document) as RecordOf<TSchema>;
        this.assertKeyValues(parsed);
        return parsed;
    }

    /** Validates partial write fields, including any present table/index key values. */
    parseUpdate(document: unknown): Partial<RecordOf<TSchema>> {
        const parsed = this.schema.partial().parse(document) as Partial<RecordOf<TSchema>>;
        this.assertKeyValues(parsed);
        return parsed;
    }

    /** Validates one SET operand and the constraints of any declared key using that field. */
    parseUpdateField<TField extends RecordKey<RecordOf<TSchema>>>(key: TField, value: unknown): RecordOf<TSchema>[TField];
    parseUpdateField(key: AttributePath, value: unknown): unknown;
    parseUpdateField(key: AttributePath, value: unknown): unknown {
        if (isAttributeReference(value)) throw new Error('Stored references are not supported in update assignments');
        const parsed = this.parseField(key, value);
        if (pathSegments(key).length === 1) this.assertKeyValues({[pathSegments(key)[0] as string]: parsed});
        return parsed;
    }

    private assertKeyValues(document: AnyRecord): void {
        for (const definition of [this.key, ...Object.values(this.indexes)]) {
            for (const field of this.keyFields(definition)) {
                if (Object.prototype.hasOwnProperty.call(document, field) && document[field] !== undefined) {
                    assertDynamoKeyValue(document[field], field === definition.sort);
                }
            }
        }
    }

    /** Validates and returns only the fields selected by a projected read. */
    parseProjection(document: unknown, fields: readonly AttributePath[]): Partial<RecordOf<TSchema>> {
        const selections = uniquePaths(fields).map(field => pathSegments(field));
        fields.forEach(field => this.assertField(field));
        return this.parseProjected(this.schema, document, selections) as Partial<RecordOf<TSchema>>;
    }

    private unwrapSchema(schema: z.ZodType): z.ZodType {
        if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault
            || schema instanceof z.ZodReadonly || schema instanceof z.ZodCatch || schema instanceof z.ZodNonOptional
            || schema instanceof z.ZodPrefault) return this.unwrapSchema(schema.unwrap() as z.ZodType);
        if (schema instanceof z.ZodPipe) return this.unwrapSchema(schema.in as z.ZodType);
        return schema;
    }

    private childSchema(schema: z.ZodType, segment: PathSegment): z.ZodType {
        schema = this.unwrapSchema(schema);
        if (schema instanceof z.ZodUnion) {
            const options: z.ZodType[] = [];
            for (const option of schema.options) {
                try { options.push(this.childSchema(option as z.ZodType, segment)); } catch {}
            }
            if (options.length === 1) return options[0];
            if (options.length > 1) return z.union(options);
        }
        if (typeof segment === 'number') {
            if (schema instanceof z.ZodArray) return schema.element as z.ZodType;
            if (schema instanceof z.ZodTuple) {
                const item = schema.def.items[segment] || schema.def.rest;
                if (item) return item as z.ZodType;
            }
        } else {
            if (schema instanceof z.ZodObject && schema.shape[segment]) return schema.shape[segment] as z.ZodType;
            if (schema instanceof z.ZodRecord) {
                (schema.keyType as z.ZodType).parse(segment);
                return schema.valueType as z.ZodType;
            }
        }
        throw new Error(`Typed table ${this.name} references unknown field or invalid path segment ${segment}`);
    }

    private pathSchema(attribute: AttributePath): z.ZodType {
        return pathSegments(attribute).reduce<z.ZodType>((schema, segment) => this.childSchema(schema, segment), this.schema);
    }

    private parseProjected(schema: z.ZodType, value: unknown, selections: readonly (readonly PathSegment[])[], partialWhole = false): unknown {
        if (selections.some(segments => segments.length === 0)) {
            if (!partialWhole) return schema.parse(value);
            const unwrapped = this.unwrapSchema(schema);
            if (unwrapped instanceof z.ZodObject || unwrapped instanceof z.ZodRecord) {
                const document = z.object({}).passthrough().parse(value);
                return Object.fromEntries(Object.entries(document).map(([field, item]) =>
                    [field, this.parseProjected(this.childSchema(unwrapped, field), item, [[]], true)]));
            }
            if (unwrapped instanceof z.ZodArray) return z.array(z.unknown()).parse(value)
                .map(item => this.parseProjected(unwrapped.element as z.ZodType, item, [[]], true));
            if (!(unwrapped instanceof z.ZodUnion)) return schema.parse(value);
        }
        schema = this.unwrapSchema(schema);
        if (schema instanceof z.ZodUnion) {
            let error: unknown;
            for (const option of schema.options) {
                try { return this.parseProjected(option as z.ZodType, value, selections, partialWhole); } catch (failure) { error = failure; }
            }
            throw error;
        }
        if (schema instanceof z.ZodArray) {
            const tails = selections.map(segments => segments.slice(1));
            const mixed = tails.some(segments => segments.length === 0) && tails.some(segments => segments.length > 0);
            return z.array(z.unknown()).parse(value).map(item =>
                this.parseProjected(schema.element as z.ZodType, item, tails, mixed));
        }
        if (schema instanceof z.ZodTuple) {
            const list = z.array(z.unknown()).parse(value);
            const positions = [...new Set(selections.map(segments => segments[0] as number))].sort((left, right) => left - right);
            return list.map(item => {
                let error: unknown;
                for (const position of positions) {
                    try {
                        return this.parseProjected(this.childSchema(schema, position), item,
                            selections.filter(segments => segments[0] === position).map(segments => segments.slice(1)));
                    } catch (failure) { error = failure; }
                }
                throw error;
            });
        }
        const document = z.object({}).passthrough().parse(value);
        const result: AnyRecord = {};
        for (const field of new Set(selections.map(segments => segments[0] as string))) {
            if (!Object.prototype.hasOwnProperty.call(document, field)) continue;
            Object.defineProperty(result, field, {
                value: this.parseProjected(this.childSchema(schema, field), document[field],
                    selections.filter(segments => segments[0] === field).map(segments => segments.slice(1))),
                enumerable: true, writable: true, configurable: true
            });
        }
        return result;
    }

    /** Checks an attribute against the consuming index's available fields. */
    assertIndexField(index: Extract<keyof TIndexes, string> | null, attribute: AttributePath, projection = false): void {
        this.assertField(attribute);
        if (index === null) return;
        const definition = this.indexes[index];
        if (!definition) throw new Error(`Typed table ${this.name} does not define index ${index}`);
        if (projection && definition.kind === 'local') return;
        if (definition.projection === undefined || definition.projection.type === 'ALL') return;
        if (!this.indexProjectionFields(definition).includes(pathSegments(attribute)[0] as string)) {
            throw new Error('Index expressions require projected fields');
        }
    }

    /** Validates an index result according to its projection. */
    parseIndexProjection<TName extends Extract<keyof TIndexes, string>>(index: TName, document: unknown): unknown {
        const definition = this.indexes[index];
        if (definition.projection === undefined || definition.projection.type === 'ALL') {
            return this.parse(document);
        }
        return this.parseProjection(document, this.indexProjectionFields(definition));
    }

    /** Validates one field value using the field's schema. */
    parseField<TField extends RecordKey<RecordOf<TSchema>>>(key: TField, value: unknown): RecordOf<TSchema>[TField];
    parseField(key: AttributePath, value: unknown): unknown;
    parseField(key: AttributePath, value: unknown): unknown {
        return this.pathSchema(key).parse(value);
    }

    /** Validates a value for a `contains` comparison, including set and array element types. */
    parseContainsValue(key: AttributePath, value: unknown): unknown {
        if (isAttributeReference(value)) throw new Error('Function arguments do not support stored references');
        return this.operandSchema(this.pathSchema(key), true).parse(value);
    }

    /** Validates a partial string/binary prefix, not a complete stored key. */
    parsePrefixValue(key: AttributePath, value: unknown): unknown {
        if (isAttributeReference(value)) throw new Error('Function arguments do not support stored references');
        const parsed = this.operandSchema(this.pathSchema(key), false).parse(value);
        if (typeof parsed !== 'string' && !(parsed instanceof Uint8Array)) {
            throw new Error('Sort-key prefix requires a string or binary value');
        }
        return parsed;
    }

    private operandSchema(schema: z.ZodType, membership: boolean): z.ZodType {
        if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault
            || schema instanceof z.ZodReadonly || schema instanceof z.ZodCatch || schema instanceof z.ZodNonOptional
            || schema instanceof z.ZodPrefault) {
            return this.operandSchema(schema.unwrap() as z.ZodType, membership);
        }
        if (schema instanceof z.ZodPipe) {
            return this.operandSchema(schema.in as z.ZodType, membership);
        }
        if (schema instanceof z.ZodUnion) {
            return z.union(schema.options.map((option) => this.operandSchema(option as z.ZodType, membership)));
        }
        if (schema instanceof z.ZodString
            || (schema instanceof z.ZodLiteral && Array.from(schema.values).every((value) => typeof value === 'string'))
            || (schema instanceof z.ZodEnum && schema.options.every((value) => typeof value === 'string'))) return z.string();
        if (!membership && schema instanceof z.ZodCustom) return schema.clone({...schema.def, checks: []});
        if (membership && schema instanceof z.ZodSet) return schema.def.valueType as z.ZodType;
        if (membership && schema instanceof z.ZodArray) return schema.element as z.ZodType;
        return schema;
    }

    /** Throws if a field is not present in the table schema. */
    assertField(field: AttributePath): void {
        this.pathSchema(field);
    }

    /** Validates an exact primary key document. */
    parseKey(document: unknown): KeyDocument<RecordOf<TSchema>, TKey> {
        return this.parseExactKey(document, this.keyFields(this.key), `Typed table ${this.name} key`, this.key.sort) as KeyDocument<RecordOf<TSchema>, TKey>;
    }

    /** Validates a primary partition-key document without requiring a sort key. */
    parsePartitionKey(document: unknown): PartitionKeyDocument<RecordOf<TSchema>, TKey> {
        return this.parseExactKey(document, [this.key.partition], `Typed table ${this.name} partition key`) as PartitionKeyDocument<RecordOf<TSchema>, TKey>;
    }

    /** Validates an index partition-key document. */
    parseIndexKey<TName extends Extract<keyof TIndexes, string>>(
        index: TName,
        document: PartitionKeyDocument<RecordOf<TSchema>, TIndexes[TName]>
    ): PartitionKeyDocument<RecordOf<TSchema>, TIndexes[TName]> {
        const indexDefinition = this.indexes[index];

        if (!indexDefinition) {
            throw new Error(`Typed table ${this.name} does not define index ${index}`);
        }

        return this.parseExactKey(document, [indexDefinition.partition], `Typed table ${this.name} index ${index} partition key`) as PartitionKeyDocument<RecordOf<TSchema>, TIndexes[TName]>;
    }

    /** Validates a value against a declared table or index sort key. */
    parseSortKey<TKeyDefinition extends KeyDefinition<RecordOf<TSchema>>>(definition: TKeyDefinition, value: unknown): unknown {
        if (definition.sort === undefined) {
            throw new Error(`Typed table ${this.name} key does not define a sort key`);
        }
        return this.parseField(definition.sort, value);
    }

    private parseFields(document: AnyRecord, fields: readonly string[]): AnyRecord {
        const parsed: AnyRecord = {};
        fields.forEach((field) => {
            parsed[field] = this.fieldSchema(field).parse(document[field]);
        });
        return parsed;
    }

    private assertDefinedFields(fields: readonly string[], label: string): void {
        fields.forEach((field) => {
            if (!this.schema.shape[field]) {
                throw new Error(`Typed table ${this.name} ${label} references unknown field ${field}`);
            }
        });
    }

    private assertKeyDefinition(definition: KeyDefinition<RecordOf<TSchema>>, label: string): void {
        if (!definition || typeof definition.partition !== 'string') {
            throw new Error(`Typed table ${this.name} ${label} requires a partition key`);
        }
        const fields = this.keyFields(definition);
        if (fields.length === 2 && fields[0] === fields[1]) {
            throw new Error(`Typed table ${this.name} ${label} partition and sort keys must be different`);
        }
        this.assertDefinedFields(fields, label);
    }

    private assertIndexProjection(definition: IndexDefinition<RecordOf<TSchema>>, indexName: string): void {
        const projection = definition.projection;
        if (projection === undefined || projection.type === 'ALL' || projection.type === 'KEYS_ONLY') {
            return;
        }
        if (projection.type !== 'INCLUDE' || !Array.isArray(projection.nonKeyAttributes)
            || projection.nonKeyAttributes.length === 0 || projection.nonKeyAttributes.length > 20
            || new Set(projection.nonKeyAttributes).size !== projection.nonKeyAttributes.length) {
            throw new Error(`Typed table ${this.name} index ${indexName} has an invalid projection`);
        }
        this.assertDefinedFields(projection.nonKeyAttributes, `index ${indexName} projection`);
        const keyFields = new Set([...this.keyFields(this.key), ...this.keyFields(definition)]);
        if (projection.nonKeyAttributes.some((attribute) => keyFields.has(attribute))) {
            throw new Error(`Typed table ${this.name} index ${indexName} projection must contain only non-key attributes`);
        }
    }

    private indexProjectionFields(definition: IndexDefinition<RecordOf<TSchema>>): string[] {
        const fields = new Set([...this.keyFields(this.key), ...this.keyFields(definition)]);
        if (definition.projection !== undefined && definition.projection.type === 'INCLUDE') {
            definition.projection.nonKeyAttributes.forEach((attribute) => fields.add(attribute));
        }
        return Array.from(fields);
    }

    private keyFields(definition: KeyDefinition<RecordOf<TSchema>>): string[] {
        return definition.sort === undefined ? [definition.partition] : [definition.partition, definition.sort];
    }

    private parseExactKey(document: unknown, expected: readonly string[], label: string, sort?: string): AnyRecord {
        const value = document as AnyRecord;
        const actualKeys = value && typeof value === 'object' ? Object.keys(value) : [];
        const expectedKeys = new Set<string>(expected);

        if (actualKeys.length !== expected.length || actualKeys.some((key) => !expectedKeys.has(key))) {
            throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
        }

        const parsed = this.parseFields(value, expected);
        expected.forEach((field) => assertDynamoKeyValue(parsed[field], field === sort));
        return parsed;
    }

    private fieldSchema(field: string): z.ZodType {
        const schema = this.schema.shape[field] as z.ZodType | undefined;

        if (!schema) {
            throw new Error(`Typed table ${this.name} references unknown field ${field}`);
        }

        return schema;
    }
}

/** Typed CRUD, query, scan, and batch operations for a table bound to a client. */
export class TypedTableQuery<
    TSchema extends RecordSchema,
    TKey extends KeyDefinition<RecordOf<TSchema>>,
    TIndexes extends IndexDefinitions<RecordOf<TSchema>>
> {
    private resultPromises = new WeakMap<Promise<unknown>, Promise<ConditionalWriteResult<unknown, RecordOf<TSchema>>>>();

    /** Creates a typed operation wrapper for a table and client. */
    constructor(
        private table: TypedTable<TSchema, TKey, TIndexes>,
        private dynamoDB: DynamoDBClient,
        private transactionBuilder: QueryBuilder | null = null
    ) {}

    /** Creates a schema-aware explicit document path. */
    path<const TSegments extends readonly [RecordKey<RecordOf<TSchema>>, ...PathSegment[]]>(
        ...segments: TSegments & (PathValue<RecordOf<TSchema>, TSegments> extends never ? never : unknown)
    ): DocumentPath<PathValue<RecordOf<TSchema>, TSegments>, TSegments> {
        const descriptor = path(...segments);
        this.table.assertField(descriptor);
        return descriptor as unknown as DocumentPath<PathValue<RecordOf<TSchema>, TSegments>, TSegments>;
    }

    /** Creates a schema-aware stored-field reference. */
    ref<const TSegments extends readonly [RecordKey<RecordOf<TSchema>>, ...PathSegment[]]>(
        ...segments: TSegments & (PathValue<RecordOf<TSchema>, TSegments> extends never ? never : unknown)
    ): AttributeReference<PathValue<RecordOf<TSchema>, TSegments>> {
        this.table.assertField(path(...segments));
        return ref(...segments) as AttributeReference<PathValue<RecordOf<TSchema>, TSegments>>;
    }

    /** Creates and validates a record. */
    create(document: InputOf<TSchema>): TypedCreateChain<RecordOf<TSchema>> {
        return this.createChain(this.builder().create(document as AnyRecord));
    }

    /** Creates records in bounded batches and validates the returned records. */
    createBatch(documents: InputOf<TSchema>[], options: BatchWriteOptions | boolean = {}): Promise<RecordOf<TSchema>[]> {
        return this.builder().createBatch<RecordOf<TSchema>>(documents as AnyRecord[], options);
    }

    /** Reads one record by its complete primary key. */
    get(key: KeyDocument<RecordOf<TSchema>, TKey>): TypedGetChain<RecordOf<TSchema>> {
        return this.getChain(this.builder().get(this.table.parseKey(key) as AnyRecord));
    }

    /** Reads records by primary key in bounded batches. */
    getBatch<TAttribute extends TypedAttribute<RecordOf<TSchema>>>(
        keys: KeyDocument<RecordOf<TSchema>, TKey>[],
        options: Omit<BatchGetOptions, 'select'> & {select: TAttribute[]}
    ): Promise<ProjectedRecord<RecordOf<TSchema>, TAttribute>[]>;
    getBatch(keys: KeyDocument<RecordOf<TSchema>, TKey>[], options?: BatchGetOptions | boolean): Promise<RecordOf<TSchema>[]>;
    getBatch(keys: KeyDocument<RecordOf<TSchema>, TKey>[], options: BatchGetOptions | boolean = {}): Promise<unknown[]> {
        const parsedKeys = keys.map(key => this.table.parseKey(key));
        if (typeof options !== 'boolean' && options.select) options.select.forEach(attribute => this.table.assertField(attribute));
        return this.builder().getBatch(parsedKeys, options);
    }

    /** Deletes one record by its complete primary key. */
    delete(key: KeyDocument<RecordOf<TSchema>, TKey>): TypedDeleteChain<RecordOf<TSchema>> {
        return this.deleteChain(this.builder().delete(this.table.parseKey(key) as AnyRecord));
    }

    /** Adds a condition-only operation for a primary key. */
    conditionCheck(key: KeyDocument<RecordOf<TSchema>, TKey>): TypedConditionChain<RecordOf<TSchema>, void> {
        return this.conditionChain(this.builder().conditionCheck(this.table.parseKey(key) as AnyRecord));
    }

    /** Deletes records by primary key in bounded batches. */
    deleteBatch(keys: KeyDocument<RecordOf<TSchema>, TKey>[], options: BatchWriteOptions | boolean = {}): Promise<void> {
        const parsedKeys = keys.map((key) => this.table.parseKey(key));
        return this.builder().deleteBatch(parsedKeys, options);
    }

    /** Starts a schema-validated update for one record. */
    update(key: KeyDocument<RecordOf<TSchema>, TKey>): TypedUpdateStart<RecordOf<TSchema>, InputOf<TSchema>> {
        return this.updateStart(this.builder().update(this.table.parseKey(key) as AnyRecord));
    }

    /** Queries the table partition key and exposes typed sort-key comparisons when declared. */
    query(document: PartitionKeyDocument<RecordOf<TSchema>, TKey>): TypedKeyQueryChain<RecordOf<TSchema>, TKey> {
        const query = this.builder().query(this.table.parsePartitionKey(document) as AnyRecord);
        return this.keyQueryChain(query, this.table.key) as TypedKeyQueryChain<RecordOf<TSchema>, TKey>;
    }

    /** Selects a declared index and exposes its projection-aware query result type. */
    index<TName extends Extract<keyof TIndexes, string>>(
        index: TName
    ): TypedProjectedIndexQuery<RecordOf<TSchema>, TKey, TIndexes[TName]> {
        const selected = this.table.indexes[index];
        if (!selected) throw new Error(`Typed table ${this.table.name} does not define index ${index}`);
        return {
            scan: () => this.scanChain(this.builder(index).scan().usingIndex(index, selected.kind), index) as any,
            query: (document) => {
                const definition = this.table.indexes[index];
                const query = this.builder(index).query(this.table.parseIndexKey(index, document) as AnyRecord);
                query.usingIndex(index, definition.kind);
                return this.keyQueryChain(query, definition, index) as any;
            }
        };
    }

    /** Scans the table with schema validation and typed projections. */
    scan(): TypedScanChain<RecordOf<TSchema>> {
        return this.scanChain(this.builder().scan());
    }

    private builder(index: Extract<keyof TIndexes, string> | null = null): QueryBuilder {
        if (this.transactionBuilder !== null) {
            return this.transactionBuilder;
        }

        return new QueryBuilder(this.table.name, this.dynamoDB, (document, projection) => {
            if (projection) {
                return this.table.parseProjection(document, projection);
            }
            return index === null ? this.table.parse(document) : this.table.parseIndexProjection(index, document) as AnyRecord;
        })
            .timestamps(this.table.timestamps);
    }

    private final<TResult>(query: any): TypedFinal<TResult> {
        return {
            toPromise: () => query.toPromise() as Promise<TResult>,
            toResponse: () => query.toResponse() as Promise<DynamoResponse<TResult>>
        };
    }

    private getChain<TResult = RecordOf<TSchema> | null>(query: any): TypedGetChain<RecordOf<TSchema>, TResult> {
        return {
            ...this.final<TResult>(query),
            consistent: () => this.getChain<TResult>(query.consistent()),
            returnCapacity: (mode) => this.getChain<TResult>(query.returnCapacity(mode)),
            select: (...attributes) => {
                attributes.forEach((attribute) => this.table.assertField(attribute));
                return this.getChain<ProjectedRecord<RecordOf<TSchema>, typeof attributes[number]> | null>(query.select(...attributes));
            }
        };
    }

    private writeFinal<TResult>(query: any): TypedWriteFinal<RecordOf<TSchema>, TResult> {
        return {
            ...this.final<TResult>(query),
            toResponse: () => query.toResponse() as Promise<DynamoResponse<TResult>>,
            toResult: () => {
                if (this.transactionBuilder !== null) {
                    throw new Error('Execute typed transactions through the transaction builder');
                }
                const raw: Promise<ConditionalWriteResult<TResult, unknown>> = query.toResult();
                let parsed = this.resultPromises.get(raw);
                if (parsed === undefined) {
                    parsed = raw.then((result) => result.applied === true
                        ? result
                        : {applied: false, previous: result.previous === null ? null : this.table.parse(result.previous)});
                    this.resultPromises.set(raw, parsed);
                }
                return parsed as Promise<ConditionalWriteResult<TResult, RecordOf<TSchema>>>;
            }
        };
    }

    private conditionFailureOptions<TNext>(query: any, next: (query: any) => TNext): ConditionFailureReturnOptions<TNext> {
        return {
            returningAllOld: () => next(query.onConditionFailure().returningAllOld()),
            returningNone: () => next(query.onConditionFailure().returningNone())
        };
    }

    private createChain(query: any): TypedCreateChain<RecordOf<TSchema>> {
        return {
            ...this.writeFinal<RecordOf<TSchema>>(query),
            ...this.typedPredicates(query, next => this.createChain(next)),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.createChain(next)),
            returningAllOld: () => this.createChain(query.returningAllOld()),
            returnCapacity: (mode) => this.createChain(query.returnCapacity(mode)),
            returnItemCollectionMetrics: () => this.createChain(query.returnItemCollectionMetrics())
        };
    }

    private conditionChain<TResult>(query: any): TypedConditionChain<RecordOf<TSchema>, TResult> {
        return {
            ...this.final<TResult>(query),
            ...this.typedPredicates(query, next => this.conditionChain<TResult>(next)),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.conditionChain<TResult>(next))
        };
    }

    private deleteChain<TResult = RecordOf<TSchema> | null>(query: any): TypedDeleteChain<RecordOf<TSchema>, TResult> {
        return {
            ...this.writeFinal<TResult>(query),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.deleteChain<TResult>(next)),
            ...this.typedPredicates(query, next => this.deleteChain<TResult>(next)),
            returningAllOld: () => this.deleteChain<RecordOf<TSchema> | null>(query.returningAllOld()),
            returningNone: () => this.deleteChain<void>(query.returningNone()),
            returnCapacity: (mode) => this.deleteChain<TResult>(query.returnCapacity(mode)),
            returnItemCollectionMetrics: () => this.deleteChain<TResult>(query.returnItemCollectionMetrics())
        };
    }

    private readChain<
        TResult = RecordOf<TSchema>,
        TSelectable = TResult
    >(query: any, definition: KeyDefinition<RecordOf<TSchema>> | null = null, index: Extract<keyof TIndexes, string> | null = null): TypedReadChain<RecordOf<TSchema>, TResult, TSelectable> {
        return {
            ...this.final<TResult[]>(query),
            consistent: () => this.readChain<TResult, TSelectable>(query.consistent(), definition, index),
            returnCapacity: (mode) => this.readChain<TResult, TSelectable>(query.returnCapacity(mode), definition, index),
            ...this.typedPredicates(query, next => this.readChain<TResult, TSelectable>(next, definition, index), definition, index),
            select: (...attributes) => {
                attributes.forEach(attribute => this.table.assertIndexField(index, attribute, true));
                return this.readChain<ProjectedRecord<TSelectable, typeof attributes[number]>>(query.select(...attributes), definition, index);
            },
            count: () => this.final<number>(query.count()),
            page: (options) => query.page(options) as Promise<QueryPage<TResult>>,
            pages: (options) => query.pages(options) as AsyncIterable<QueryPage<TResult>>,
            items: (options) => query.items(options) as AsyncIterable<TResult>,
            toPromise: () => query.toPromise() as Promise<TResult[]>
        };
    }

    private queryChain<
        TResult = RecordOf<TSchema>,
        TSelectable = TResult
    >(query: any, definition: KeyDefinition<RecordOf<TSchema>> = this.table.key, index: Extract<keyof TIndexes, string> | null = null): TypedQueryChain<RecordOf<TSchema>, TResult, TSelectable> {
        return {
            ...this.final<TResult[]>(query),
            limit: (chunkSize, hardLimit = null) => this.queryChain<TResult, TSelectable>(query.limit(chunkSize, hardLimit), definition, index),
            consistent: () => this.queryChain<TResult, TSelectable>(query.consistent(), definition, index),
            returnCapacity: (mode) => this.queryChain<TResult, TSelectable>(query.returnCapacity(mode), definition, index),
            ascending: () => this.queryChain<TResult, TSelectable>(query.ascending(), definition, index),
            descending: () => this.queryChain<TResult, TSelectable>(query.descending(), definition, index),
            ...this.typedPredicates(query, next => this.queryChain<TResult, TSelectable>(next, definition, index), definition, index),
            select: (...attributes) => {
                attributes.forEach(attribute => this.table.assertIndexField(index, attribute, true));
                return this.queryChain<ProjectedRecord<TSelectable, typeof attributes[number]>>(query.select(...attributes), definition, index);
            },
            count: () => this.final<number>(query.count()),
            page: (options) => query.page(options) as Promise<QueryPage<TResult>>,
            pages: (options) => query.pages(options) as AsyncIterable<QueryPage<TResult>>,
            items: (options) => query.items(options) as AsyncIterable<TResult>,
            toPromise: () => query.toPromise() as Promise<TResult[]>
        };
    }

    private keyQueryChain<TKeyDefinition extends KeyDefinition<RecordOf<TSchema>>>(
        query: any,
        definition: TKeyDefinition,
        index: Extract<keyof TIndexes, string> | null = null
    ): TypedKeyQueryChain<RecordOf<TSchema>, TKeyDefinition> {
        const chain: TypedQueryChain<RecordOf<TSchema>> & {sortKey?: () => TypedSortKeyComparison<unknown, RecordOf<TSchema>>} = this.queryChain(query, definition, index);
        if (definition.sort !== undefined) {
            chain.sortKey = () => this.sortKeyComparison(query, definition, index);
        }
        return chain as TypedKeyQueryChain<RecordOf<TSchema>, TKeyDefinition>;
    }

    private sortKeyComparison<TKeyDefinition extends KeyDefinition<RecordOf<TSchema>>>(
        query: any,
        definition: TKeyDefinition,
        index: Extract<keyof TIndexes, string> | null = null
    ): TypedSortKeyComparison<unknown, RecordOf<TSchema>> {
        const compare = (method: string, value: unknown) => {
            const parsed = this.table.parseSortKey(definition, value);
            return this.queryChain(query.sortKey(definition.sort)[method](parsed), definition, index);
        };
        return {
            eq: (value) => compare('eq', value),
            gt: (value) => compare('gt', value),
            gte: (value) => compare('gte', value),
            lt: (value) => compare('lt', value),
            lte: (value) => compare('lte', value),
            between: (lower, upper) => {
                const parsedLower = this.table.parseSortKey(definition, lower);
                const parsedUpper = this.table.parseSortKey(definition, upper);
                return this.queryChain(query.sortKey(definition.sort).between(parsedLower, parsedUpper), definition, index);
            },
            beginsWith: (value: never) => this.queryChain(query.sortKey(definition.sort).beginsWith(
                this.table.parsePrefixValue(definition.sort!, value)), definition, index)
        };
    }

    private scanChain<TResult = RecordOf<TSchema>, TSelectable = TResult>(query: any, index: Extract<keyof TIndexes, string> | null = null): TypedScanChain<RecordOf<TSchema>, TResult, TSelectable> {
        return {
            ...this.final<TResult[]>(query),
            limit: (chunkSize, hardLimit = null) => this.scanChain<TResult, TSelectable>(query.limit(chunkSize, hardLimit), index),
            consistent: () => this.scanChain<TResult, TSelectable>(query.consistent(), index),
            returnCapacity: (mode) => this.scanChain<TResult, TSelectable>(query.returnCapacity(mode), index),
            parallel: (segment, totalSegments) => this.scanChain<TResult, TSelectable>(query.parallel(segment, totalSegments), index),
            ...this.typedPredicates(query, next => this.scanChain<TResult, TSelectable>(next, index), null, index),
            select: (...attributes) => {
                attributes.forEach(attribute => this.table.assertIndexField(index, attribute, true));
                return this.scanChain<ProjectedRecord<TSelectable, typeof attributes[number]>, ProjectedRecord<TSelectable, typeof attributes[number]>>(query.select(...attributes), index);
            },
            count: () => this.final<number>(query.count()),
            page: (options) => query.page(options) as Promise<QueryPage<TResult>>,
            pages: (options) => query.pages(options) as AsyncIterable<QueryPage<TResult>>,
            items: (options) => query.items(options) as AsyncIterable<TResult>,
            toPromise: () => query.toPromise() as Promise<TResult[]>
        };
    }

    private updateStart(query: any): TypedUpdateStart<RecordOf<TSchema>, InputOf<TSchema>> {
        return {
            with: (document) => this.updateChain(query.with(this.table.parseUpdate(document))),
            set: (attribute) => ({eq: (value) => this.updateChain(query.set(attribute).eq(this.table.parseUpdateField(attribute, value)))}),
            remove: (attribute) => {
                this.table.assertField(attribute);
                return this.updateChain(query.remove(attribute));
            },
            add: (attribute) => ({eq: (value) => this.updateChain(query.add(attribute).eq(this.table.parseField(attribute, value)))}),
            delete: (attribute) => ({eq: (value) => this.updateChain(query.delete(attribute).eq(this.table.parseField(attribute, value)))})
        };
    }

    private updateChain<TResult = RecordOf<TSchema> | null>(query: any): TypedUpdateChain<RecordOf<TSchema>, TResult> {
        return {
            ...this.writeFinal<TResult>(query),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.updateChain<TResult>(next)),
            ...this.typedPredicates(query, next => this.updateChain<TResult>(next)),
            returningAllNew: () => this.updateChain<RecordOf<TSchema> | null>(query.returningAllNew()),
            returningAllOld: () => this.updateChain<RecordOf<TSchema> | null>(query.returningAllOld()),
            returningNone: () => this.updateChain<void>(query.returningNone()),
            returnCapacity: (mode) => this.updateChain<TResult>(query.returnCapacity(mode)),
            returnItemCollectionMetrics: () => this.updateChain<TResult>(query.returnItemCollectionMetrics()),
            set: (attribute) => ({eq: (value) => this.updateChain<TResult>(query.set(attribute).eq(this.table.parseUpdateField(attribute, value)))}),
            remove: (attribute) => {
                this.table.assertField(attribute);
                return this.updateChain<TResult>(query.remove(attribute));
            },
            add: (attribute) => ({eq: (value) => this.updateChain<TResult>(query.add(attribute).eq(this.table.parseField(attribute, value)))}),
            delete: (attribute) => ({eq: (value) => this.updateChain<TResult>(query.delete(attribute).eq(this.table.parseField(attribute, value)))}),
            toPromiseOrNull: () => query.toPromiseOrNull() as Promise<TResult | null>
        };
    }

    private typedPredicates<TNext>(
        query: any, next: (query: any) => TNext,
        definition: KeyDefinition<RecordOf<TSchema>> | null = null,
        index: Extract<keyof TIndexes, string> | null = null
    ): TypedPredicateGroups<RecordOf<TSchema>, TNext> & {where<TAttribute extends TypedAttribute<RecordOf<TSchema>>>(key: TAttribute): TypedConditionalComparison<AttributeValue<RecordOf<TSchema>, TAttribute>, TNext>} {
        const wrapScope = (scope: PredicateScope): TypedPredicateScope<RecordOf<TSchema>> =>
            this.typedPredicates(scope, () => wrapScope(scope), definition, index);
        const group = (method: string, callback: (scope: TypedPredicateScope<RecordOf<TSchema>>) => TypedPredicateScope<RecordOf<TSchema>> | void): TNext =>
            next(query[method]((scope: PredicateScope) => callback(wrapScope(scope))));
        return {
            where: key => this.comparison(query.where(key), key, next, definition, index),
            whereAny: callback => group('whereAny', callback),
            whereAll: callback => group('whereAll', callback),
            whereNot: callback => group('whereNot', callback)
        };
    }

    private comparison<TValue, TNext>(
        query: any, key: AttributePath, next: (query: any) => TNext,
        definition: KeyDefinition<RecordOf<TSchema>> | null = null,
        index: Extract<keyof TIndexes, string> | null = null
    ): TypedConditionalComparison<TValue, TNext> {
        const assert = (attribute: AttributePath) => {
            this.table.assertIndexField(index, attribute);
            const root = pathSegments(attribute)[0];
            if (definition !== null && (root === definition.partition || root === definition.sort)) {
                throw new Error('Query filters cannot reference active key attributes; use key conditions');
            }
        };
        assert(key);
        const parse = (value: unknown) => {
            if (isAttributeReference(value)) {
                assert(path(...value.segments));
                return value;
            }
            return this.table.parseField(key, value);
        };
        const wrapSize = (size: any): SizeComparison<TNext> => ({
            eq: value => next(size.eq(value)), ne: value => next(size.ne(value)),
            gt: value => next(size.gt(value)), gte: value => next(size.gte(value)),
            lt: value => next(size.lt(value)), lte: value => next(size.lte(value)),
            between: (lower, upper) => next(size.between(lower, upper)),
            in: values => next(size.in(values)), not: () => wrapSize(size.not())
        });
        return {
            eq: value => next(query.eq(parse(value))),
            ne: value => next(query.ne(parse(value))),
            gt: value => next(query.gt(parse(value))),
            gte: value => next(query.gte(parse(value))),
            lt: value => next(query.lt(parse(value))),
            lte: value => next(query.lte(parse(value))),
            contains: value => next(query.contains(this.table.parseContainsValue(key, value))),
            in: values => next(query.in(values.map(parse))),
            between: (lower, upper) => next(query.between(parse(lower), parse(upper))),
            beginsWith: value => next(query.beginsWith(this.table.parsePrefixValue(key, value))),
            exists: () => next(query.exists()),
            attributeType: type => next(query.attributeType(type)),
            size: () => wrapSize(query.size()),
            not: () => this.comparison(query.not(), key, next, definition, index)
        };
    }

}

export interface TypedTableQuery<
    TSchema extends RecordSchema,
    TKey extends KeyDefinition<RecordOf<TSchema>>,
    TIndexes extends IndexDefinitions<RecordOf<TSchema>>
> {
    get(key: KeyDocument<RecordOf<TSchema>, TKey>, consistentRead?: boolean): TypedGetChain<RecordOf<TSchema>, RecordOf<TSchema> | null>;
}

/** Schema-aware transaction builder for atomic operations across typed tables. */
export class TypedTransactionWriteBuilder {
    private transaction: TransactionWriteBuilder;

    /** Creates an empty transaction bound to a DynamoDB client. */
    constructor(private dynamoDB: DynamoDBClient) {
        this.transaction = QueryBuilder.transactWrite(dynamoDB);
    }

    /** Adds one typed create, update, delete, or condition-check item. */
    add<
        TSchema extends RecordSchema,
        TKey extends KeyDefinition<RecordOf<TSchema>>,
        TIndexes extends IndexDefinitions<RecordOf<TSchema>>
    >(
        table: TypedTable<TSchema, TKey, TIndexes>,
        configure: (query: TypedTransactionTableQuery<RecordOf<TSchema>, InputOf<TSchema>, TKey>) => unknown,
        options: TransactionItemOptions = {}
    ): TypedTransactionWriteBuilder {
        const builder = new QueryBuilder(table.name, this.dynamoDB, (document) => table.parse(document))
            .timestamps(table.timestamps);
        const query = new TypedTableQuery(table, this.dynamoDB, builder);
        configure(query);
        this.transaction.addBuilder(builder, options);
        return this;
    }

    /** Sets the DynamoDB idempotency token for the transaction. */
    clientRequestToken(token: string): TypedTransactionWriteBuilder {
        this.transaction.clientRequestToken(token);
        return this;
    }

    /** Enables or disables request logging for the transaction. */
    logger(logger: null | ((message: any) => void) = null): TypedTransactionWriteBuilder {
        this.transaction.logger(logger);
        return this;
    }

    /** Requests consumed-capacity metadata in the transaction response. */
    returnCapacity(mode: ReturnConsumedCapacity = 'INDEXES'): TypedTransactionWriteBuilder {
        this.transaction.returnCapacity(mode);
        return this;
    }

    /** Requests local-secondary-index item-collection metrics in the transaction response. */
    returnItemCollectionMetrics(): TypedTransactionWriteBuilder {
        this.transaction.returnItemCollectionMetrics();
        return this;
    }

    /** Executes the transaction and returns the DynamoDB response. */
    toPromise(): Promise<TransactWriteItemsCommandOutput> {
        return this.transaction.toPromise();
    }
}

/** Defines a schema-aware table whose operations validate inputs and outputs with Zod. */
export function defineTable<
    TSchema extends RecordSchema,
    const TKey extends KeyDefinition<RecordOf<TSchema>>,
    const TIndexes extends IndexDefinitions<RecordOf<TSchema>> = {}
>(options: TableDefinitionOptions<TSchema, TKey, TIndexes>): TypedTable<TSchema, TKey, TIndexes> {
    return new TypedTable(options);
}

/** Starts an atomic transaction using typed table definitions. */
export function typedTransaction(dynamoDB: DynamoDBClient): TypedTransactionWriteBuilder {
    return new TypedTransactionWriteBuilder(dynamoDB);
}
