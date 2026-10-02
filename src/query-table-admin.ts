import {CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient, ListTablesCommand} from "@aws-sdk/client-dynamodb";
import {abortableDelay} from './execution-options';
import type {CreateTableCommandInput, KeySchemaElement, TableDescription} from "@aws-sdk/client-dynamodb";
import type {ExecutionOptions, IndexKind} from "./types";
import {UpdateTableCommand, UpdateTimeToLiveCommand, DescribeTimeToLiveCommand} from '@aws-sdk/client-dynamodb';
import type {UpdateTableCommandInput, TimeToLiveDescription, TimeToLiveSpecification} from '@aws-sdk/client-dynamodb';

export interface TableThroughput {read: number; write: number}
export interface TableCreateOptions extends ExecutionOptions {
    billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED';
    throughput?: TableThroughput;
    indexThroughput?: Record<string, TableThroughput>;
}
export interface TableUpdateOptions extends TableCreateOptions {
    createIndex?: {name: string; definition: Extract<DynamoDBIndexDefinition, {kind: 'global'}>; attributes: Record<string, DynamoDBAttributeType>; throughput?: TableThroughput};
    deleteIndex?: string;
}

function throughput(value: TableThroughput): {ReadCapacityUnits: number; WriteCapacityUnits: number} {
    if (!value || ![value.read, value.write].every(units => Number.isSafeInteger(units) && units > 0)) throw new Error('Throughput requires positive integer read and write units');
    return {ReadCapacityUnits: value.read, WriteCapacityUnits: value.write};
}

export interface TablePageOptions extends ExecutionOptions {
    limit?: number;
    cursor?: string;
}

export interface TablePage {
    names: string[];
    cursor: string | null;
}

export interface TableWaitOptions extends ExecutionOptions {
    /** Maximum wait in seconds, including polling delays. */
    maxWaitTime?: number;
    minDelay?: number;
    maxDelay?: number;
}

/** DynamoDB scalar type used by a table or index key attribute. */
export type DynamoDBAttributeType = 'S' | 'N' | 'B';

/** Names the partition key and optional sort key for a table or index. */
export interface DynamoDBKeyDefinition {
    /** Partition-key attribute name. */
    partition: string;
    /** Optional sort-key attribute name. */
    sort?: string;
}

/** Describes which attributes a secondary index projects. */
export type DynamoDBIndexProjection =
    | {type: 'ALL'}
    | {type: 'KEYS_ONLY'}
    | {type: 'INCLUDE'; nonKeyAttributes: string[]};

/** Describes a global or local secondary index. */
export type DynamoDBKeyComponents = string | readonly [string] | readonly [string, string]
    | readonly [string, string, string] | readonly [string, string, string, string];

export type DynamoDBIndexDefinition = (
    | {kind: 'global'; partition: DynamoDBKeyComponents; sort?: DynamoDBKeyComponents}
    | ({kind: 'local'} & DynamoDBKeyDefinition)
) & {projection?: DynamoDBIndexProjection};

export function keyComponents(value: DynamoDBKeyComponents | undefined): readonly string[] {
    return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

/** Portable table shape used to create or inspect DynamoDB key/index metadata. */
export interface DynamoDBTableDefinition {
    /** DynamoDB table name. */
    name: string;
    /** Primary table key definition. */
    key: DynamoDBKeyDefinition;
    /** Attribute types for every table and index key. */
    attributes: Record<string, DynamoDBAttributeType>;
    /** Secondary indexes keyed by index name. */
    indexes: Record<string, DynamoDBIndexDefinition>;
}

/** Low-level DynamoDB table administration helpers used by QueryBuilder. */
export class QueryTableAdmin {
    /** Creates an on-demand table from a full definition or string-key shorthand. */
    static createTable(definition: DynamoDBTableDefinition, db: DynamoDBClient, options?: TableCreateOptions): Promise<TableDescription | null>;
    static createTable(name: string, key: string, db: DynamoDBClient, options?: TableCreateOptions): Promise<TableDescription | null>;
    static createTable(definitionOrName: DynamoDBTableDefinition | string, keyOrClient: string | DynamoDBClient, client?: DynamoDBClient | TableCreateOptions, execution: TableCreateOptions = {}): Promise<TableDescription | null> {
        const definition: DynamoDBTableDefinition = typeof definitionOrName === 'string'
            ? {name: definitionOrName, key: {partition: keyOrClient as string}, attributes: {[keyOrClient as string]: 'S'}, indexes: {}}
            : definitionOrName;
        const db = (typeof definitionOrName === 'string' ? client! : keyOrClient) as DynamoDBClient;
        const options = typeof definitionOrName === 'string' ? execution : (client as TableCreateOptions | undefined) ?? {};
        const input = this.toCreateTableInput(definition);
        const billing = options.billingMode ?? 'PAY_PER_REQUEST';
        if (!['PAY_PER_REQUEST', 'PROVISIONED'].includes(billing)) throw new Error('Invalid billing mode');
        if (billing === 'PAY_PER_REQUEST' && (options.throughput || Object.keys(options.indexThroughput ?? {}).length)) throw new Error('On-demand tables cannot specify provisioned throughput');
        input.BillingMode = billing;
        if (billing === 'PROVISIONED') {
            input.ProvisionedThroughput = throughput(options.throughput!);
            input.GlobalSecondaryIndexes?.forEach(index => { index.ProvisionedThroughput = throughput(options.indexThroughput?.[index.IndexName!]!); });
        }
        if (Object.keys(options.indexThroughput ?? {}).some(name => definition.indexes[name]?.kind !== 'global')) throw new Error('Index throughput requires a declared global index');
        options.signal?.throwIfAborted();
        return db.send(new CreateTableCommand(input), {abortSignal: options.signal})
            .then((result) => result.TableDescription ? result.TableDescription : null);
    }

    /** Converts a portable table definition into a DynamoDB CreateTable input. */
    static toCreateTableInput(definition: DynamoDBTableDefinition): CreateTableCommandInput {
        if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
            throw new Error('Table definition requires a name');
        }
        const usedAttributes = new Set<string>();
        const keySchema = (key: {partition: DynamoDBKeyComponents; sort?: DynamoDBKeyComponents}, multiple = false): KeySchemaElement[] => {
            const partition = keyComponents(key?.partition), sort = keyComponents(key?.sort);
            if (!key || (!multiple && (typeof key.partition !== 'string' || (key.sort !== undefined && typeof key.sort !== 'string')))
                || !Array.isArray(partition) || !Array.isArray(sort) || partition.length < 1 || partition.length > (multiple ? 4 : 1)
                || sort.length > (multiple ? 4 : 1) || (key.sort !== undefined && sort.length === 0)
                || [...partition, ...sort].some(field => typeof field !== 'string' || field.length === 0)
                || new Set([...partition, ...sort]).size !== partition.length + sort.length) {
                throw new Error(`Invalid key definition for table ${definition.name}`);
            }
            const schema: KeySchemaElement[] = [
                ...partition.map(AttributeName => ({AttributeName, KeyType: 'HASH' as const})),
                ...sort.map(AttributeName => ({AttributeName, KeyType: 'RANGE' as const}))
            ];
            for (const element of schema) {
                const attribute = element.AttributeName!;
                if (!definition.attributes || !Object.prototype.hasOwnProperty.call(definition.attributes, attribute)
                    || !['S', 'N', 'B'].includes(definition.attributes[attribute])) {
                    throw new Error(`Missing or invalid attribute type for ${definition.name}.${attribute}`);
                }
                usedAttributes.add(attribute);
            }
            return schema;
        };
        const input: CreateTableCommandInput = {
            TableName: definition.name,
            KeySchema: keySchema(definition.key),
            BillingMode: 'PAY_PER_REQUEST'
        };
        if (!definition.indexes || typeof definition.indexes !== 'object' || Array.isArray(definition.indexes)) {
            throw new Error(`Table ${definition.name} requires an indexes map`);
        }
        let projectedAttributeCount = 0;
        for (const [name, index] of Object.entries(definition.indexes)) {
            if (!name || !index || (index.kind !== 'global' && index.kind !== 'local')) {
                throw new Error(`Invalid index definition for table ${definition.name}`);
            }
            if (index.kind === 'local' && (definition.key.sort === undefined || index.sort === undefined || index.partition !== definition.key.partition)) {
                throw new Error(`Local index ${name} requires the table partition key and table/index sort keys`);
            }
            const projection = this.getProjection(index, definition, name);
            projectedAttributeCount += projection.NonKeyAttributes ? projection.NonKeyAttributes.length : 0;
            if (projectedAttributeCount > 100) {
                throw new Error(`Table ${definition.name} indexes project more than 100 non-key attributes`);
            }
            const compiled = {IndexName: name, KeySchema: keySchema(index, index.kind === 'global'), Projection: projection};
            if (index.kind === 'global') {
                if (input.GlobalSecondaryIndexes === undefined) input.GlobalSecondaryIndexes = [];
                input.GlobalSecondaryIndexes.push(compiled);
            } else {
                if (input.LocalSecondaryIndexes === undefined) input.LocalSecondaryIndexes = [];
                input.LocalSecondaryIndexes.push(compiled);
            }
        }
        if (Object.keys(definition.attributes).some((attribute) => !usedAttributes.has(attribute))) {
            throw new Error(`Table ${definition.name} attribute types must describe only table and index keys`);
        }
        input.AttributeDefinitions = Array.from(usedAttributes).map((attribute) => ({
            AttributeName: attribute, AttributeType: definition.attributes[attribute]
        }));
        return input;
    }

    /** Deletes a table and returns the raw AWS table description when supplied. */
    static deleteTable(name: string, db: DynamoDBClient, options: ExecutionOptions = {}): Promise<TableDescription | null | undefined> {
        options.signal?.throwIfAborted();
        return db.send(new DeleteTableCommand({TableName: name}), {abortSignal: options.signal})
            .then((result) => result.TableDescription ? result.TableDescription : null);
    }

    /** Lists table names returned by DynamoDB. */
    static async listTables(db: DynamoDBClient, options: ExecutionOptions = {}): Promise<string[] | null> {
        let names: string[] | null = null;
        let cursor: string | undefined;
        do {
            options.signal?.throwIfAborted();
            const result = await db.send(new ListTablesCommand(cursor ? {ExclusiveStartTableName: cursor} : {}), {abortSignal: options.signal});
            if (result.TableNames) names = [...(names ?? []), ...result.TableNames];
            cursor = result.LastEvaluatedTableName;
        } while (cursor);
        return names;
    }

    static async listTablePage(db: DynamoDBClient, options: TablePageOptions = {}): Promise<TablePage> {
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error('Table page limit must be between 1 and 100');
        if (options.cursor !== undefined && (typeof options.cursor !== 'string' || !options.cursor)) throw new Error('Table cursor must be a nonempty name');
        options.signal?.throwIfAborted();
        const result = await db.send(new ListTablesCommand({Limit: options.limit, ExclusiveStartTableName: options.cursor}), {abortSignal: options.signal});
        return {names: [...(result.TableNames ?? [])], cursor: result.LastEvaluatedTableName ?? null};
    }

    static async waitForTable(name: string, db: DynamoDBClient, options: TableWaitOptions = {}, deleted = false): Promise<void> {
        const maxWaitTime = options.maxWaitTime ?? 120, minDelay = options.minDelay ?? 1, maxDelay = options.maxDelay ?? 5;
        if (![maxWaitTime, minDelay, maxDelay].every(value => Number.isFinite(value) && value > 0)
            || maxDelay < minDelay || maxWaitTime <= minDelay) throw new Error('Invalid table waiter timing');
        options.signal?.throwIfAborted();
        const controller = new AbortController();
        const aborted = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', aborted, {once: true});
        const timeout = new Error(`Timed out waiting for table ${name} to ${deleted ? 'be deleted' : 'become active'}`);
        timeout.name = 'TimeoutError';
        const timer = setTimeout(() => controller.abort(timeout), maxWaitTime * 1000);
        let delay = minDelay;
        try {
            while (true) {
                controller.signal.throwIfAborted();
                try {
                    const table = await this.describeTable(name, db, {signal: controller.signal});
                    controller.signal.throwIfAborted();
                    if (!deleted && table?.TableStatus === 'ACTIVE') return;
                } catch (error) {
                    if ((error as {name?: string}).name !== 'ResourceNotFoundException') throw error;
                    if (deleted) return;
                }
                await abortableDelay(delay * 1000, controller.signal);
                delay = Math.min(delay * 2, maxDelay);
            }
        } catch (error) {
            options.signal?.throwIfAborted();
            controller.signal.throwIfAborted();
            throw error;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', aborted);
        }
    }

    /** Fetches the complete raw table metadata returned by DynamoDB. */
    static describeTable(name: string, db: DynamoDBClient, options: ExecutionOptions = {}): Promise<TableDescription | null> {
        options.signal?.throwIfAborted();
        return db.send(new DescribeTableCommand({TableName: name}), {abortSignal: options.signal})
            .then((result) => result.Table ? result.Table : null);
    }

    /** Converts raw table metadata into the validated definition accepted by createTable. */
    static async getTableDefinition(name: string, db: DynamoDBClient, options: ExecutionOptions = {}): Promise<DynamoDBTableDefinition | null> {
        const tableDescription = await this.describeTable(name, db, options);

        if (tableDescription === null) {
            return null;
        }
        return this.definitionFromDescription(tableDescription, name);
    }

    private static definitionFromDescription(tableDescription: TableDescription, name: string): DynamoDBTableDefinition {
        const indexes: Record<string, DynamoDBIndexDefinition> = {};
        const addIndexes = (kind: IndexKind, definitions: typeof tableDescription.GlobalSecondaryIndexes): void => {
            (definitions || []).forEach((definition) => {
                if (!definition.IndexName) {
                    throw new Error(`DynamoDB table ${name} contains an index without a name`);
                }
                const projection = definition.Projection;
                if (!projection || !projection.ProjectionType) {
                    throw new Error(`DynamoDB table ${name} index ${definition.IndexName} does not define a projection`);
                }
                const label = `table ${name} index ${definition.IndexName}`;
                const index: DynamoDBIndexDefinition = kind === 'global'
                    ? {kind, ...this.getKeyDefinition(definition.KeySchema, label, true)}
                    : {kind, ...this.getKeyDefinition(definition.KeySchema, label)};
                if (projection.ProjectionType === 'KEYS_ONLY') {
                    index.projection = {type: 'KEYS_ONLY'};
                } else if (projection.ProjectionType === 'INCLUDE') {
                    index.projection = {
                        type: 'INCLUDE',
                        nonKeyAttributes: projection.NonKeyAttributes ? [...projection.NonKeyAttributes] : []
                    };
                } else if (projection.ProjectionType !== 'ALL') {
                    throw new Error(`DynamoDB table ${name} index ${definition.IndexName} has an invalid projection`);
                }
                indexes[definition.IndexName] = index;
            });
        };

        addIndexes('global', tableDescription.GlobalSecondaryIndexes);
        addIndexes('local', tableDescription.LocalSecondaryIndexes);

        const attributes: Record<string, DynamoDBAttributeType> = {};
        for (const attribute of tableDescription.AttributeDefinitions || []) {
            if (!attribute.AttributeName || !attribute.AttributeType || !['S', 'N', 'B'].includes(attribute.AttributeType)) {
                throw new Error(`Invalid attribute type metadata for table ${name}`);
            }
            Object.defineProperty(attributes, attribute.AttributeName, {value: attribute.AttributeType, enumerable: true});
        }
        const definition: DynamoDBTableDefinition = {
            name: tableDescription.TableName ? tableDescription.TableName : name,
            key: this.getKeyDefinition(tableDescription.KeySchema, `table ${name}`),
            attributes: attributes,
            indexes: indexes
        };
        this.toCreateTableInput(definition);
        return definition;
    }

    static async updateTable(name: string, db: DynamoDBClient, options: TableUpdateOptions): Promise<TableDescription | null> {
        const allowed = new Set(['signal', 'billingMode', 'throughput', 'indexThroughput', 'createIndex', 'deleteIndex']);
        if (Object.keys(options).some(key => !allowed.has(key))) throw new Error('Table updates cannot change immutable key definitions or unknown settings');
        if (options.createIndex && options.deleteIndex !== undefined) throw new Error('Only one index creation or deletion is supported per request');
        if (options.billingMode !== undefined && !['PAY_PER_REQUEST', 'PROVISIONED'].includes(options.billingMode)) throw new Error('Invalid billing mode');
        const description = await this.describeTable(name, db, options);
        if (!description) throw new Error('Table metadata is required for updates');
        const definition = this.definitionFromDescription(description, name);
        const billing = options.billingMode ?? description.BillingModeSummary?.BillingMode ?? (description.ProvisionedThroughput?.ReadCapacityUnits ? 'PROVISIONED' : 'PAY_PER_REQUEST');
        if (billing === 'PAY_PER_REQUEST' && (options.throughput || options.createIndex?.throughput || Object.keys(options.indexThroughput ?? {}).length)) throw new Error('On-demand tables cannot specify provisioned throughput');
        const input: UpdateTableCommandInput = {TableName: name};
        if (options.billingMode) input.BillingMode = options.billingMode;
        if (options.throughput) input.ProvisionedThroughput = throughput(options.throughput);
        if (options.billingMode === 'PROVISIONED' && !options.throughput) throw new Error('Provisioned billing requires table throughput');
        const updates: NonNullable<UpdateTableCommandInput['GlobalSecondaryIndexUpdates']> = [];
        if (options.createIndex) {
            const addition = options.createIndex;
            if (!addition.name || addition.definition.kind !== 'global' || Object.prototype.hasOwnProperty.call(definition.indexes, addition.name)) throw new Error('Index creation requires a new global index name');
            for (const [field, type] of Object.entries(addition.attributes)) {
                if (definition.attributes[field] !== undefined && definition.attributes[field] !== type) throw new Error('Existing key attribute types are immutable');
            }
            const compiled = this.toCreateTableInput({...definition, attributes: {...definition.attributes, ...addition.attributes},
                indexes: {...definition.indexes, [addition.name]: addition.definition}});
            const index = compiled.GlobalSecondaryIndexes!.find(index => index.IndexName === addition.name)!;
            if (billing === 'PROVISIONED') index.ProvisionedThroughput = throughput(addition.throughput!);
            updates.push({Create: index});
            input.AttributeDefinitions = compiled.AttributeDefinitions;
        }
        if (options.deleteIndex !== undefined) {
            if (definition.indexes[options.deleteIndex]?.kind !== 'global') throw new Error('Index deletion requires an existing global index');
            updates.push({Delete: {IndexName: options.deleteIndex}});
        }
        for (const [index, units] of Object.entries(options.indexThroughput ?? {})) {
            if (definition.indexes[index]?.kind !== 'global' || index === options.deleteIndex) throw new Error('Index throughput requires an existing global index');
            updates.push({Update: {IndexName: index, ProvisionedThroughput: throughput(units)}});
        }
        if (options.billingMode === 'PROVISIONED' && definition.indexes) {
            for (const [index, metadata] of Object.entries(definition.indexes)) {
                if (metadata.kind === 'global' && index !== options.deleteIndex && !options.indexThroughput?.[index]) throw new Error('Provisioned billing requires throughput for every global index');
            }
        }
        if (updates.length) input.GlobalSecondaryIndexUpdates = updates;
        if (Object.keys(input).length === 1) throw new Error('Table update requires an operational change');
        options.signal?.throwIfAborted();
        return (await db.send(new UpdateTableCommand(input), {abortSignal: options.signal})).TableDescription ?? null;
    }

    static async configureTimeToLive(name: string, attribute: string, enabled: boolean, db: DynamoDBClient, options: ExecutionOptions = {}): Promise<TimeToLiveSpecification | null> {
        if (typeof attribute !== 'string' || !attribute || typeof enabled !== 'boolean') throw new Error('TTL requires an attribute name and enabled flag');
        options.signal?.throwIfAborted();
        return (await db.send(new UpdateTimeToLiveCommand({TableName: name, TimeToLiveSpecification: {AttributeName: attribute, Enabled: enabled}}), {abortSignal: options.signal})).TimeToLiveSpecification ?? null;
    }

    static async describeTimeToLive(name: string, db: DynamoDBClient, options: ExecutionOptions = {}): Promise<TimeToLiveDescription | null> {
        options.signal?.throwIfAborted();
        return (await db.send(new DescribeTimeToLiveCommand({TableName: name}), {abortSignal: options.signal})).TimeToLiveDescription ?? null;
    }

    private static getProjection(
        index: DynamoDBIndexDefinition,
        definition: DynamoDBTableDefinition,
        indexName: string
    ): {ProjectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'; NonKeyAttributes?: string[]} {
        const projection = index.projection;
        if (projection === undefined || projection.type === 'ALL') {
            return {ProjectionType: 'ALL'};
        }
        if (projection.type === 'KEYS_ONLY') {
            return {ProjectionType: 'KEYS_ONLY'};
        }
        if (projection.type !== 'INCLUDE' || !Array.isArray(projection.nonKeyAttributes)
            || projection.nonKeyAttributes.length === 0 || projection.nonKeyAttributes.length > 20) {
            throw new Error(`Invalid projection for table ${definition.name} index ${indexName}`);
        }
        const attributes = new Set(projection.nonKeyAttributes);
        const keyAttributes = new Set([
            definition.key.partition,
            definition.key.sort,
            ...keyComponents(index.partition),
            ...keyComponents(index.sort)
        ].filter((attribute): attribute is string => attribute !== undefined));
        if (attributes.size !== projection.nonKeyAttributes.length
            || projection.nonKeyAttributes.some((attribute) => typeof attribute !== 'string' || attribute.length === 0 || keyAttributes.has(attribute))) {
            throw new Error(`Invalid projection for table ${definition.name} index ${indexName}`);
        }
        return {ProjectionType: 'INCLUDE', NonKeyAttributes: [...projection.nonKeyAttributes]};
    }

    private static getKeyDefinition(keySchema: readonly KeySchemaElement[] | undefined, label: string): DynamoDBKeyDefinition;
    private static getKeyDefinition(keySchema: readonly KeySchemaElement[] | undefined, label: string, multiple: true): {partition: DynamoDBKeyComponents; sort?: DynamoDBKeyComponents};
    private static getKeyDefinition(keySchema: readonly KeySchemaElement[] | undefined, label: string, multiple = false): {partition: DynamoDBKeyComponents; sort?: DynamoDBKeyComponents} {
        const partition = (keySchema || []).filter(element => element.KeyType === 'HASH').map(element => element.AttributeName!);
        const sort = (keySchema || []).filter(element => element.KeyType === 'RANGE').map(element => element.AttributeName!);
        if (!partition.length) {
            throw new Error(`DynamoDB ${label} does not define a partition key`);
        }
        if (partition.length > (multiple ? 4 : 1) || sort.length > (multiple ? 4 : 1)
            || partition.length + sort.length !== keySchema!.length
            || [...partition, ...sort].some(field => typeof field !== 'string' || !field)
            || new Set([...partition, ...sort]).size !== keySchema!.length) {
            throw new Error(`DynamoDB ${label} contains an invalid key schema`);
        }
        const components = (fields: string[]): DynamoDBKeyComponents => fields.length === 1 ? fields[0]
            : fields.length === 2 ? [fields[0], fields[1]]
                : fields.length === 3 ? [fields[0], fields[1], fields[2]]
                    : [fields[0], fields[1], fields[2], fields[3]];
        return {partition: components(partition), ...(sort.length ? {sort: components(sort)} : {})};
    }
}