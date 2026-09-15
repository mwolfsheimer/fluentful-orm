import type {DynamoDBClient, TransactWriteItemsCommandOutput} from '@aws-sdk/client-dynamodb';
import {z} from 'zod';
import {QueryBuilder} from './query-builder';
import type {BatchOptions, ConditionalWriteResult, ConditionFailureReturnOptions, IndexKind, PageOptions, QueryPage} from './types';
import {TransactionWriteBuilder} from './transaction-write-builder';
import type {TransactionItemOptions} from './transaction-write-builder';

type Buffer = Uint8Array;
type AnyRecord = Record<string, any>;
type RecordSchema = z.ZodObject<z.ZodRawShape>;
type RecordOf<TSchema extends RecordSchema> = z.output<TSchema>;
type InputOf<TSchema extends RecordSchema> = z.input<TSchema>;
type RecordKey<TRecord> = Extract<keyof TRecord, string>;
type DynamoKeyValue = string | number | Buffer;
type DynamoKeyField<TRecord> = {[TKey in RecordKey<TRecord>]: TRecord[TKey] extends DynamoKeyValue ? TKey : never}[RecordKey<TRecord>];

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
type ComparisonValue<T> = T extends Set<infer TValue>
    ? TValue
    : T extends readonly (infer TValue)[]
        ? TValue
        : T;

export interface TypedFinal<TResult> {
    /** Executes the typed operation and validates its result against the table schema. */
    toPromise(): Promise<TResult>;
}

/** Adds typed conditional-write result handling to a write chain. */
export interface TypedWriteFinal<TRecord, TResult> extends TypedFinal<TResult> {
    /** Returns whether the condition was applied and validates any previous record. */
    toResult(): Promise<ConditionalWriteResult<TResult, TRecord>>;
}

/** Fluent chain for creating a typed record. */
export interface TypedCreateChain<TRecord> extends TypedWriteFinal<TRecord, TRecord> {
    /** Adds a schema-validated condition to the new record. */
    where<TKey extends RecordKey<TRecord>>(key: TKey): TypedConditionalComparison<TRecord[TKey], TypedCreateChain<TRecord>>;
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedCreateChain<TRecord>>;
}

/** Type-safe comparison operators for a record field. */
export interface TypedComparison<TValue, TNext> {
    /** Matches the exact value. */
    eq(value: TValue): TNext;
    /** Matches values different from the supplied value. */
    ne(value: TValue): TNext;
    /** Matches values greater than the supplied value. */
    gt(value: TValue): TNext;
    /** Matches values greater than or equal to the supplied value. */
    gte(value: TValue): TNext;
    /** Matches values less than the supplied value. */
    lt(value: TValue): TNext;
    /** Matches values less than or equal to the supplied value. */
    lte(value: TValue): TNext;
    /** Matches strings or collections containing the supplied value. */
    contains(value: ComparisonValue<TValue>): TNext;
    /** Matches values equal to one of the supplied values. */
    in(values: TValue[]): TNext;
}

/** Type-safe comparisons that can also test field existence or negate a comparison. */
export interface TypedConditionalComparison<TValue, TNext> extends TypedComparison<TValue, TNext> {
    /** Requires the field to exist. */
    exists(): TNext;
    /** Negates the next comparison. */
    not(): TypedComparison<TValue, TNext> & {exists(): TNext};
}

/** Type-safe comparisons available for read filters. */
export interface TypedFilterComparison<TValue, TNext> extends TypedComparison<TValue, TNext> {
    /** Negates the next filter comparison. */
    not(): TypedComparison<TValue, TNext>;
}

/** Fluent chain for a typed condition check. */
export interface TypedConditionChain<TRecord, TResult> extends TypedFinal<TResult> {
    /** Adds a schema-validated condition to the item. */
    where<TKey extends RecordKey<TRecord>>(key: TKey): TypedConditionalComparison<TRecord[TKey], TypedConditionChain<TRecord, TResult>>;
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedConditionChain<TRecord, TResult>>;
}

/** Shared typed read modifiers and terminal operations. */
export interface TypedReadChain<TRecord, TResult = TRecord, TSelectable = TResult> extends TypedFinal<TResult[]> {
    /** Adds a schema-validated post-read filter. */
    where<TKey extends RecordKey<TRecord>>(key: TKey): TypedFilterComparison<TRecord[TKey], TypedReadChain<TRecord, TResult, TSelectable>>;
    /** Projects and type-checks only the selected fields. */
    select<TKey extends RecordKey<TSelectable>>(...attributes: TKey[]): TypedReadChain<TRecord, Pick<TSelectable, TKey>, Pick<TSelectable, TKey>>;
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
    /** Projects and type-checks only the selected fields. */
    select<TKey extends RecordKey<TSelectable>>(...attributes: TKey[]): TypedQueryChain<TRecord, Pick<TSelectable, TKey>, Pick<TSelectable, TKey>>;
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
    beginsWith(value: TValue extends string | Buffer ? TValue : never): TypedQueryChain<TRecord, TResult, TSelectable>;
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
    /** Queries the index partition key and optionally requests a consistent read. */
    query(document: PartitionKeyDocument<TRecord, TKey>, consistentRead?: boolean): TypedKeyQueryChain<TRecord, TKey>;
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
    /** Queries the index partition key with projection-aware result types. */
    query(
        document: PartitionKeyDocument<TRecord, TIndex>,
        consistentRead?: boolean
    ): TypedProjectedIndexQueryChain<TRecord, TTableKey, TIndex>;
}

/** Typed scan modifiers. */
export interface TypedScanChain<TRecord, TResult = TRecord> extends TypedReadChain<TRecord, TResult> {
    /** Sets the DynamoDB page size and optional all-page hard limit. */
    limit(chunkSize: number, hardLimit?: number | null): TypedScanChain<TRecord, TResult>;
    /** Projects and type-checks only the selected fields. */
    select<TKey extends RecordKey<TResult>>(...attributes: TKey[]): TypedScanChain<TRecord, Pick<TResult, TKey>>;
}

/** Fluent chain for deleting a typed record. */
export interface TypedDeleteChain<TRecord, TResult = TRecord | null> extends TypedWriteFinal<TRecord, TResult> {
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedDeleteChain<TRecord, TResult>>;
    /** Adds a schema-validated condition to the item. */
    where<TKey extends RecordKey<TRecord>>(key: TKey): TypedConditionalComparison<TRecord[TKey], TypedDeleteChain<TRecord, TResult>>;
    /** Returns the deleted record in the successful result. */
    returningAllOld(): TypedDeleteChain<TRecord, TRecord | null>;
    /** Omits the deleted record from the successful result. */
    returningNone(): TypedDeleteChain<TRecord, void>;
}

/** Fluent chain for updating a typed record. */
export interface TypedUpdateChain<TRecord, TResult = TRecord | null> extends TypedWriteFinal<TRecord, TResult> {
    /** Chooses whether a failed condition returns the previous record. */
    onConditionFailure(): ConditionFailureReturnOptions<TypedUpdateChain<TRecord, TResult>>;
    /** Adds a schema-validated condition to the item. */
    where<TKey extends RecordKey<TRecord>>(key: TKey): TypedConditionalComparison<TRecord[TKey], TypedUpdateChain<TRecord, TResult>>;
    /** Returns the updated record in the successful result. */
    returningAllNew(): TypedUpdateChain<TRecord, TRecord | null>;
    /** Omits the updated record from the successful result. */
    returningNone(): TypedUpdateChain<TRecord, void>;
    /** Begins a type-checked SET update. */
    set<TKey extends RecordKey<TRecord>>(attribute: TKey): {eq(value: TRecord[TKey]): TypedUpdateChain<TRecord, TResult>};
    /** Removes an attribute from the record. */
    remove(attribute: RecordKey<TRecord>): TypedUpdateChain<TRecord, TResult>;
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
    set<TKey extends RecordKey<TRecord>>(attribute: TKey): {eq(value: TRecord[TKey]): TypedUpdateChain<TRecord>};
    /** Removes an attribute from the record. */
    remove(attribute: RecordKey<TRecord>): TypedUpdateChain<TRecord>;
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
    private projectionSchemas = new Map<string, z.ZodObject<any>>();

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

    /** Binds this table definition to a DynamoDB client. */
    using(dynamoDB: DynamoDBClient): TypedTableQuery<TSchema, TKey, TIndexes> {
        return new TypedTableQuery(this, dynamoDB);
    }

    /** Validates and returns a complete record. */
    parse(document: unknown): RecordOf<TSchema> {
        return this.schema.parse(document) as RecordOf<TSchema>;
    }

    /** Validates and returns only the fields selected by a projected read. */
    parseProjection(document: unknown, fields: readonly string[]): Partial<RecordOf<TSchema>> {
        const cacheKey = JSON.stringify(fields);
        let schema = this.projectionSchemas.get(cacheKey);
        if (schema === undefined) {
            const shape: Record<string, z.ZodType> = {};
            fields.forEach((field) => {
                shape[field] = this.fieldSchema(field);
            });
            schema = z.object(shape).strict();
            this.projectionSchemas.set(cacheKey, schema);
        }
        return schema.parse(document) as Partial<RecordOf<TSchema>>;
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
    parseField<TKey extends RecordKey<RecordOf<TSchema>>>(key: TKey, value: unknown): RecordOf<TSchema>[TKey] {
        return this.fieldSchema(key).parse(value) as RecordOf<TSchema>[TKey];
    }

    /** Validates a value for a `contains` comparison, including set and array element types. */
    parseContainsValue<TKey extends RecordKey<RecordOf<TSchema>>>(key: TKey, value: unknown): unknown {
        let schema = this.fieldSchema(key);

        while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
            schema = schema.unwrap() as z.ZodType;
        }

        if (schema instanceof z.ZodSet) {
            return Array.from(schema.parse(new Set([value])))[0];
        }

        if (schema instanceof z.ZodArray) {
            return schema.parse([value])[0];
        }

        return schema.parse(value);
    }

    /** Throws if a field is not present in the table schema. */
    assertField(field: string): void {
        this.fieldSchema(field);
    }

    /** Validates an exact primary key document. */
    parseKey(document: unknown): KeyDocument<RecordOf<TSchema>, TKey> {
        return this.parseExactKey(document, this.keyFields(this.key), `Typed table ${this.name} key`) as KeyDocument<RecordOf<TSchema>, TKey>;
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

    private parseExactKey(document: unknown, expected: readonly string[], label: string): AnyRecord {
        const value = document as AnyRecord;
        const actualKeys = value && typeof value === 'object' ? Object.keys(value) : [];
        const expectedKeys = new Set<string>(expected);

        if (actualKeys.length !== expected.length || actualKeys.some((key) => !expectedKeys.has(key))) {
            throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
        }

        return this.parseFields(value, expected);
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

    /** Creates and validates a record. */
    create(document: InputOf<TSchema>): TypedCreateChain<RecordOf<TSchema>> {
        return this.createChain(this.builder().create(document as AnyRecord));
    }

    /** Creates records in bounded batches and validates the returned records. */
    createBatch(documents: InputOf<TSchema>[], options: BatchOptions | boolean = {}): Promise<RecordOf<TSchema>[]> {
        return this.builder().createBatch<RecordOf<TSchema>>(documents as AnyRecord[], options);
    }

    /** Reads one record by its complete primary key. */
    get(key: KeyDocument<RecordOf<TSchema>, TKey>, consistentRead = false): TypedFinal<RecordOf<TSchema> | null> {
        return this.final(this.builder().get(this.table.parseKey(key) as AnyRecord, consistentRead));
    }

    /** Reads records by primary key in bounded batches. */
    getBatch(keys: KeyDocument<RecordOf<TSchema>, TKey>[], options: BatchOptions | boolean = {}, consistentRead = false): Promise<RecordOf<TSchema>[]> {
        const parsedKeys = keys.map((key) => this.table.parseKey(key));
        return this.builder().getBatch<RecordOf<TSchema>>(parsedKeys, options, consistentRead);
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
    deleteBatch(keys: KeyDocument<RecordOf<TSchema>, TKey>[], options: BatchOptions | boolean = {}): Promise<void> {
        const parsedKeys = keys.map((key) => this.table.parseKey(key));
        return this.builder().deleteBatch(parsedKeys, options);
    }

    /** Starts a schema-validated update for one record. */
    update(key: KeyDocument<RecordOf<TSchema>, TKey>): TypedUpdateStart<RecordOf<TSchema>, InputOf<TSchema>> {
        return this.updateStart(this.builder().update(this.table.parseKey(key) as AnyRecord));
    }

    /** Queries the table partition key and exposes typed sort-key comparisons when declared. */
    query(document: PartitionKeyDocument<RecordOf<TSchema>, TKey>, consistentRead = false): TypedKeyQueryChain<RecordOf<TSchema>, TKey> {
        const query = this.builder().query(this.table.parsePartitionKey(document) as AnyRecord, consistentRead);
        return this.keyQueryChain(query, this.table.key) as TypedKeyQueryChain<RecordOf<TSchema>, TKey>;
    }

    /** Selects a declared index and exposes its projection-aware query result type. */
    index<TName extends Extract<keyof TIndexes, string>>(
        index: TName
    ): TypedProjectedIndexQuery<RecordOf<TSchema>, TKey, TIndexes[TName]> {
        return {
            query: (document, consistentRead = false) => {
                const definition = this.table.indexes[index];
                const query = this.builder(index).query(this.table.parseIndexKey(index, document) as AnyRecord, consistentRead);
                query.usingIndex(index, definition.kind);
                return this.keyQueryChain(query, definition) as any;
            }
        };
    }

    /** Scans the table with schema validation and typed projections. */
    scan(consistentRead = false): TypedScanChain<RecordOf<TSchema>> {
        return this.scanChain(this.builder().scan(consistentRead));
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
        return {toPromise: () => query.toPromise() as Promise<TResult>};
    }

    private writeFinal<TResult>(query: any): TypedWriteFinal<RecordOf<TSchema>, TResult> {
        return {
            ...this.final<TResult>(query),
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
            where: (key) => this.conditionalComparison(query.where(key), key, (next) => this.createChain(next)),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.createChain(next))
        };
    }

    private conditionChain<TResult>(query: any): TypedConditionChain<RecordOf<TSchema>, TResult> {
        return {
            where: (key) => this.conditionalComparison(query.where(key), key, (next) => this.conditionChain(next)),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.conditionChain<TResult>(next)),
            toPromise: () => query.toPromise() as Promise<TResult>
        };
    }

    private deleteChain<TResult = RecordOf<TSchema> | null>(query: any): TypedDeleteChain<RecordOf<TSchema>, TResult> {
        return {
            ...this.writeFinal<TResult>(query),
            onConditionFailure: () => this.conditionFailureOptions(query, (next) => this.deleteChain<TResult>(next)),
            where: (key) => this.conditionalComparison(query.where(key), key, (next) => this.deleteChain<TResult>(next)),
            returningAllOld: () => this.deleteChain<RecordOf<TSchema> | null>(query.returningAllOld()),
            returningNone: () => this.deleteChain<void>(query.returningNone())
        };
    }

    private readChain<
        TResult = RecordOf<TSchema>,
        TSelectable = TResult
    >(query: any): TypedReadChain<RecordOf<TSchema>, TResult, TSelectable> {
        return {
            where: (key) => this.filterComparison(query.where(key), key, (next) => this.readChain<TResult, TSelectable>(next)),
            select: (...attributes) => {
                attributes.forEach((attribute) => this.table.assertField(attribute));
                return this.readChain<Pick<TSelectable, typeof attributes[number]>, Pick<TSelectable, typeof attributes[number]>>(query.select(...attributes));
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
    >(query: any): TypedQueryChain<RecordOf<TSchema>, TResult, TSelectable> {
        return {
            limit: (chunkSize, hardLimit = null) => this.queryChain<TResult, TSelectable>(query.limit(chunkSize, hardLimit)),
            where: (key) => this.filterComparison(query.where(key), key, (next) => this.readChain<TResult, TSelectable>(next)),
            select: (...attributes) => {
                attributes.forEach((attribute) => this.table.assertField(attribute));
                return this.queryChain<Pick<TSelectable, typeof attributes[number]>, Pick<TSelectable, typeof attributes[number]>>(query.select(...attributes));
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
        definition: TKeyDefinition
    ): TypedKeyQueryChain<RecordOf<TSchema>, TKeyDefinition> {
        const chain: TypedQueryChain<RecordOf<TSchema>> & {sortKey?: () => TypedSortKeyComparison<unknown, RecordOf<TSchema>>} = this.queryChain(query);
        if (definition.sort !== undefined) {
            chain.sortKey = () => this.sortKeyComparison(query, definition);
        }
        return chain as TypedKeyQueryChain<RecordOf<TSchema>, TKeyDefinition>;
    }

    private sortKeyComparison<TKeyDefinition extends KeyDefinition<RecordOf<TSchema>>>(
        query: any,
        definition: TKeyDefinition
    ): TypedSortKeyComparison<unknown, RecordOf<TSchema>> {
        const compare = (method: string, value: unknown) => {
            const parsed = this.table.parseSortKey(definition, value);
            return this.queryChain(query.sortKey(definition.sort)[method](parsed));
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
                return this.queryChain(query.sortKey(definition.sort).between(parsedLower, parsedUpper));
            },
            beginsWith: (value: never) => compare('beginsWith', value)
        };
    }

    private scanChain<TResult = RecordOf<TSchema>>(query: any): TypedScanChain<RecordOf<TSchema>, TResult> {
        return {
            limit: (chunkSize, hardLimit = null) => this.scanChain<TResult>(query.limit(chunkSize, hardLimit)),
            where: (key) => this.filterComparison(query.where(key), key, (next) => this.readChain<TResult>(next)),
            select: (...attributes) => {
                attributes.forEach((attribute) => this.table.assertField(attribute));
                return this.scanChain<Pick<TResult, typeof attributes[number]>>(query.select(...attributes));
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
            with: (document) => this.updateChain(query.with(this.table.schema.partial().parse(document))),
            set: (attribute) => ({eq: (value) => this.updateChain(query.set(attribute).eq(this.table.parseField(attribute, value)))}),
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
            where: (key) => this.conditionalComparison(query.where(key), key, (next) => this.updateChain<TResult>(next)),
            returningAllNew: () => this.updateChain<RecordOf<TSchema> | null>(query.returningAllNew()),
            returningNone: () => this.updateChain<void>(query.returningNone()),
            set: (attribute) => ({eq: (value) => this.updateChain<TResult>(query.set(attribute).eq(this.table.parseField(attribute, value)))}),
            remove: (attribute) => {
                this.table.assertField(attribute);
                return this.updateChain<TResult>(query.remove(attribute));
            },
            add: (attribute) => ({eq: (value) => this.updateChain<TResult>(query.add(attribute).eq(this.table.parseField(attribute, value)))}),
            delete: (attribute) => ({eq: (value) => this.updateChain<TResult>(query.delete(attribute).eq(this.table.parseField(attribute, value)))}),
            toPromiseOrNull: () => query.toPromiseOrNull() as Promise<TResult | null>
        };
    }

    private conditionalComparison<TValue, TNext>(query: any, key: string, next: (query: any) => TNext): TypedConditionalComparison<TValue, TNext> {
        this.table.assertField(key);
        const comparison = this.comparison<TValue, TNext>(query, key, next);
        return {
            ...comparison,
            exists: () => next(query.exists()),
            not: () => ({...this.comparison<TValue, TNext>(query.not(), key, next), exists: () => next(query.not().exists())})
        };
    }

    private filterComparison<TValue, TNext>(query: any, key: string, next: (query: any) => TNext): TypedFilterComparison<TValue, TNext> {
        this.table.assertField(key);
        return {
            ...this.comparison<TValue, TNext>(query, key, next),
            not: () => this.comparison<TValue, TNext>(query.not(), key, next)
        };
    }

    private comparison<TValue, TNext>(query: any, key: string, next: (query: any) => TNext): TypedComparison<TValue, TNext> {
        const parse = (value: unknown) => this.table.parseField(key as RecordKey<RecordOf<TSchema>>, value);
        return {
            eq: (value) => next(query.eq(parse(value))),
            ne: (value) => next(query.ne(parse(value))),
            gt: (value) => next(query.gt(parse(value))),
            gte: (value) => next(query.gte(parse(value))),
            lt: (value) => next(query.lt(parse(value))),
            lte: (value) => next(query.lte(parse(value))),
            contains: (value) => next(query.contains(this.table.parseContainsValue(key as RecordKey<RecordOf<TSchema>>, value))),
            in: (values) => next(query.in(values.map(parse)))
        };
    }
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
