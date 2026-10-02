import {CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DynamoDBClient, ListTablesCommand} from "@aws-sdk/client-dynamodb";
import type {CreateTableCommandInput, KeySchemaElement, TableDescription} from "@aws-sdk/client-dynamodb";
import type {IndexKind} from "./types";

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
export interface DynamoDBIndexDefinition extends DynamoDBKeyDefinition {
    /** Whether the index is global or local to the table. */
    kind: IndexKind;
    /** Optional projection mode; omitted means all attributes. */
    projection?: DynamoDBIndexProjection;
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
    static createTable(definition: DynamoDBTableDefinition, db: DynamoDBClient): Promise<TableDescription | null>;
    static createTable(name: string, key: string, db: DynamoDBClient): Promise<TableDescription | null>;
    static createTable(definitionOrName: DynamoDBTableDefinition | string, keyOrClient: string | DynamoDBClient, client?: DynamoDBClient): Promise<TableDescription | null> {
        const definition: DynamoDBTableDefinition = typeof definitionOrName === 'string'
            ? {name: definitionOrName, key: {partition: keyOrClient as string}, attributes: {[keyOrClient as string]: 'S'}, indexes: {}}
            : definitionOrName;
        const db = typeof definitionOrName === 'string' ? client! : keyOrClient as DynamoDBClient;
        return db.send(new CreateTableCommand(this.toCreateTableInput(definition)))
            .then((result) => result.TableDescription ? result.TableDescription : null);
    }

    /** Converts a portable table definition into a DynamoDB CreateTable input. */
    static toCreateTableInput(definition: DynamoDBTableDefinition): CreateTableCommandInput {
        if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
            throw new Error('Table definition requires a name');
        }
        const usedAttributes = new Set<string>();
        const keySchema = (key: DynamoDBKeyDefinition): KeySchemaElement[] => {
            if (!key || typeof key.partition !== 'string' || key.partition.length === 0
                || (key.sort !== undefined && (typeof key.sort !== 'string' || key.sort.length === 0 || key.sort === key.partition))) {
                throw new Error(`Invalid key definition for table ${definition.name}`);
            }
            const schema: KeySchemaElement[] = [{AttributeName: key.partition, KeyType: 'HASH'}];
            if (key.sort !== undefined) {
                schema.push({AttributeName: key.sort, KeyType: 'RANGE'});
            }
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
            const compiled = {IndexName: name, KeySchema: keySchema(index), Projection: projection};
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
    static deleteTable(name: string, db: DynamoDBClient): Promise<TableDescription | null | undefined> {
        return db.send(new DeleteTableCommand({TableName: name}))
            .then((result) => result.TableDescription ? result.TableDescription : null);
    }

    /** Lists table names returned by DynamoDB. */
    static async listTables(db: DynamoDBClient): Promise<string[] | null> {
        let names: string[] | null = null;
        let cursor: string | undefined;
        do {
            const result = await db.send(new ListTablesCommand(cursor ? {ExclusiveStartTableName: cursor} : {}));
            if (result.TableNames) names = [...(names ?? []), ...result.TableNames];
            cursor = result.LastEvaluatedTableName;
        } while (cursor);
        return names;
    }

    /** Fetches the complete raw table metadata returned by DynamoDB. */
    static describeTable(name: string, db: DynamoDBClient): Promise<TableDescription | null> {
        return db.send(new DescribeTableCommand({TableName: name}))
            .then((result) => result.Table ? result.Table : null);
    }

    /** Converts raw table metadata into the validated definition accepted by createTable. */
    static async getTableDefinition(name: string, db: DynamoDBClient): Promise<DynamoDBTableDefinition | null> {
        const tableDescription = await this.describeTable(name, db);

        if (tableDescription === null) {
            return null;
        }

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
                const index: DynamoDBIndexDefinition = {
                    kind: kind,
                    ...this.getKeyDefinition(definition.KeySchema, `table ${name} index ${definition.IndexName}`)
                };
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
            index.partition,
            index.sort
        ].filter((attribute): attribute is string => attribute !== undefined));
        if (attributes.size !== projection.nonKeyAttributes.length
            || projection.nonKeyAttributes.some((attribute) => typeof attribute !== 'string' || attribute.length === 0 || keyAttributes.has(attribute))) {
            throw new Error(`Invalid projection for table ${definition.name} index ${indexName}`);
        }
        return {ProjectionType: 'INCLUDE', NonKeyAttributes: [...projection.nonKeyAttributes]};
    }

    private static getKeyDefinition(keySchema: readonly KeySchemaElement[] | undefined, label: string): DynamoDBKeyDefinition {
        const partitionElement = (keySchema || []).find((element) => element.KeyType === 'HASH');
        const sortElement = (keySchema || []).find((element) => element.KeyType === 'RANGE');

        if (!partitionElement || !partitionElement.AttributeName) {
            throw new Error(`DynamoDB ${label} does not define a partition key`);
        }

        if (sortElement && sortElement.AttributeName) {
            return {partition: partitionElement.AttributeName, sort: sortElement.AttributeName};
        }

        return {partition: partitionElement.AttributeName};
    }
}