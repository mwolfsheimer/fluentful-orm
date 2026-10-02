import {
    BatchGetItemCommand,
    BatchWriteItemCommand,
    ConditionalCheckFailedException,
    CreateTableCommand,
    DeleteItemCommand,
    DeleteTableCommand,
    DescribeTableCommand,
    DynamoDBClient,
    DynamoDBServiceException,
    GetItemCommand,
    ListTablesCommand,
    PutItemCommand,
    QueryCommand,
    ResourceNotFoundException,
    ScanCommand,
    TransactionCanceledException,
    TransactWriteItemsCommand,
    TransactGetItemsCommand,
    UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import {UpdateTableCommand} from '@aws-sdk/client-dynamodb';
import type {
    AttributeValue,
    ItemCollectionMetrics,
    ConditionCheck,
    CreateTableCommandInput,
    DeleteItemCommandInput,
    KeySchemaElement,
    PutItemCommandInput,
    QueryCommandInput,
    ScanCommandInput,
    TableDescription,
    TransactWriteItemsCommandInput,
    UpdateItemCommandInput
} from '@aws-sdk/client-dynamodb';
import {QuerySerializer} from './query-serializer';
import {QueryTableAdmin} from './query-table-admin';
import type {DynamoDBTableDefinition} from './query-table-admin';
import {ValueUtils} from './value-utils';
import {assertDynamoKeyValue, compareDynamoValues as compare, equalDynamoValues} from './dynamodb-values';

// The memory backend executes SDK command objects directly, so query code can
// be tested without a running DynamoDB service.
type Document = Record<string, unknown>;
type AttributeMap = Record<string, AttributeValue>;
type WriteInput = Pick<PutItemCommandInput, 'TableName'>
    & Partial<PutItemCommandInput & UpdateItemCommandInput & DeleteItemCommandInput>;
type InitialTables = readonly (DynamoDBTableDefinition | CreateTableCommandInput)[];
type MemoryCommand =
    | CreateTableCommand
    | DeleteTableCommand
    | DescribeTableCommand
    | ListTablesCommand
    | PutItemCommand
    | GetItemCommand
    | UpdateItemCommand
    | DeleteItemCommand
    | QueryCommand
    | ScanCommand
    | BatchGetItemCommand
    | BatchWriteItemCommand
    | TransactWriteItemsCommand
    | TransactGetItemsCommand;
type AdministrationCommand = UpdateTableCommand;

interface MemoryTable {
    description: TableDescription;
    items: Map<string, Document>;
}

interface MemorySnapshot {
    version: 1;
    revision?: number;
    tokens?: Array<[string, {input: TransactWriteItemsCommandInput; expires: number}]>;
    tables: Array<{
        description: TableDescription;
        items: AttributeMap[];
    }>;
}

interface MemoryPersistence {
    load(): Promise<MemorySnapshot | undefined>;
    save(snapshot: MemorySnapshot): Promise<void>;
    close?(): Promise<void>;
}

function validation(message: string): never {
    throw new DynamoDBServiceException({
        name: 'ValidationException',
        message: message,
        $fault: 'client',
        $metadata: {}
    });
}

type MemoryPath = readonly (string | number)[];
interface MemoryProjection {
    whole: boolean;
    children: Map<string | number, MemoryProjection>;
}

function memoryPath(expression: string, names: Record<string, string>): MemoryPath {
    if (!/^#[A-Za-z0-9_]+(?:\.#[A-Za-z0-9_]+|\[\d+\])*$/.test(expression)) validation('Unsupported in-memory document path expression');
    const segments = [...expression.matchAll(/#[A-Za-z0-9_]+|\[(\d+)\]/g)].map(match => {
        if (match[1] !== undefined) {
            const index = Number(match[1]);
            if (!Number.isSafeInteger(index)) validation('Invalid list path position');
            return index;
        }
        const name = names[match[0]];
        if (name === undefined || name.length === 0) validation('Unknown in-memory expression attribute');
        return name;
    });
    if (segments.length > 33) validation('Document paths support at most 32 dereferences');
    return segments;
}

function memoryValue(item: unknown, path: MemoryPath): unknown {
    let value = item;
    for (const segment of path) {
        if (typeof segment === 'number' ? !Array.isArray(value)
            : value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array || value instanceof Set) return undefined;
        if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
        value = (value as Document)[segment];
    }
    return value;
}

function projectionTree(expression: string, names: Record<string, string>): MemoryProjection {
    const root: MemoryProjection = {whole: false, children: new Map()};
    for (const attribute of expression.split(',')) {
        const path = memoryPath(attribute.trim(), names);
        let node = root;
        for (const segment of path) {
            if (node.whole) validation('Overlapping projection paths');
            let child = node.children.get(segment);
            if (child === undefined) {
                child = {whole: false, children: new Map()};
                node.children.set(segment, child);
            }
            node = child;
        }
        if (node.whole || node.children.size) validation('Overlapping projection paths');
        node.whole = true;
    }
    return root;
}

function projectMemoryValue(value: unknown, node: MemoryProjection): unknown {
    if (node.whole) return value;
    if (Array.isArray(value)) {
        const list: unknown[] = [];
        for (const [segment, child] of [...node.children.entries()].sort(([left], [right]) => Number(left) - Number(right))) {
            if (typeof segment !== 'number' || !Object.prototype.hasOwnProperty.call(value, segment)) continue;
            const projected = projectMemoryValue(value[segment], child);
            if (projected !== undefined) list.push(projected);
        }
        return list.length ? list : undefined;
    }
    if (value === null || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Set) return undefined;
    const entries: [string, unknown][] = [];
    for (const [segment, child] of node.children) {
        if (typeof segment !== 'string' || !Object.prototype.hasOwnProperty.call(value, segment)) continue;
        const projected = projectMemoryValue((value as Document)[segment], child);
        if (projected !== undefined) entries.push([segment, projected]);
    }
    return entries.length ? Object.fromEntries(entries) : undefined;
}

function splitUpdateOperands(expression: string): string[] {
    let depth = 0, start = 0;
    const parts: string[] = [];
    for (let index = 0; index < expression.length; index++) {
        if (expression[index] === '(') depth++;
        if (expression[index] === ')') depth--;
        if (depth < 0) validation('Unbalanced update expression');
        if (expression[index] === ',' && depth === 0) {
            parts.push(expression.slice(start, index).trim());
            start = index + 1;
        }
    }
    if (depth !== 0) validation('Unbalanced update expression');
    parts.push(expression.slice(start).trim());
    return parts;
}

function updateOperand(expression: string, item: Document, names: Record<string, string>, values: AttributeMap): unknown {
    const parse = (source: string, arithmetic: boolean): (() => unknown) => {
        source = source.trim();
        let depth = 0;
        for (let index = 0; index < source.length; index++) {
            if (source[index] === '(') depth++;
            if (source[index] === ')') depth--;
            if (depth === 0 && (source[index] === '+' || source[index] === '-')) {
                if (!arithmetic) validation('Nested arithmetic is not supported by SET');
                const left = parse(source.slice(0, index), false), right = parse(source.slice(index + 1), false);
                const operator = source[index];
                return () => {
                    const first = left(), second = right();
                    if (typeof first !== 'number' || typeof second !== 'number') validation('SET arithmetic requires numbers');
                    const result = operator === '+' ? first + second : first - second;
                    if (!Number.isFinite(result)) validation('SET arithmetic result is not finite');
                    return result;
                };
            }
        }
        const call = /^(if_not_exists|list_append)\((.*)\)$/.exec(source);
        if (call) {
            const operands = splitUpdateOperands(call[2]);
            if (operands.length !== 2) validation('Update functions require two operands');
            if (call[1] === 'if_not_exists') {
                const field = memoryPath(operands[0], names), fallback = parse(operands[1], false);
                return () => {
                    const value = memoryValue(item, field);
                    return value === undefined ? fallback() : ValueUtils.clone(value);
                };
            }
            const left = parse(operands[0], false), right = parse(operands[1], false);
            return () => {
                const first = left(), second = right();
                if (!Array.isArray(first) || !Array.isArray(second)) validation('list_append requires lists');
                return [...first, ...second];
            };
        }
        if (/^:[A-Za-z0-9_]+$/.test(source)) {
            if (!Object.prototype.hasOwnProperty.call(values, source)) validation('Unknown update value');
            return () => QuerySerializer.parseField(values[source]);
        }
        const field = memoryPath(source, names);
        return () => {
            const value = memoryValue(item, field);
            if (value === undefined) validation('The provided expression refers to an attribute that does not exist');
            return ValueUtils.clone(value);
        };
    };
    return parse(expression, true)();
}

/** Evaluates the expression subset generated by QueryBuilder. */
class MemoryExpression {
    private position = 0;
    private tokens: string[];
    private operandPath: string | null = null;
    readonly roots = new Set<string>();

    constructor(
        private expression: string,
        private item: Document,
        private names: Record<string, string>,
        private values: AttributeMap
    ) {
        this.tokens = expression.match(/#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|<>|<=|>=|[=<>(),.\[\]]|\d+|[A-Za-z_]+/g) || [];
        if (this.tokens.join('') !== expression.replace(/\s/g, '')) {
            validation(`Unsupported in-memory expression: ${expression}`);
        }
    }

    evaluate(): boolean {
        const result = this.disjunction();
        if (this.position !== this.tokens.length) {
            validation(`Unsupported in-memory expression: ${this.expression}`);
        }
        return result;
    }

    private take(expected?: string): string {
        const token = this.tokens[this.position++];
        if (token === undefined || (expected !== undefined && token !== expected)) {
            validation(`Invalid in-memory expression: ${this.expression}`);
        }
        return token;
    }

    private disjunction(): boolean {
        let result = this.conjunction();
        while (this.tokens[this.position] === 'OR') {
            this.take('OR');
            const alternative = this.conjunction();
            result = result || alternative;
        }
        return result;
    }

    private conjunction(): boolean {
        let result = this.predicate();
        while (this.tokens[this.position] === 'AND') {
            this.take('AND');
            const next = this.predicate();
            result = result && next;
        }
        return result;
    }

    private operand(): unknown {
        this.operandPath = null;
        const token = this.take();
        if (token === 'size') {
            this.take('(');
            const value = this.operand();
            this.take(')');
            if (typeof value === 'string' || value instanceof Uint8Array || Array.isArray(value)) return value.length;
            if (value instanceof Set) return value.size;
            if (value !== null && typeof value === 'object') return Object.keys(value).length;
            return undefined;
        }
        if (token.startsWith('#')) {
            let expression = token;
            while (this.tokens[this.position] === '.' || this.tokens[this.position] === '[') {
                if (this.tokens[this.position] === '.') expression += this.take('.') + this.take();
                else expression += this.take('[') + this.take() + this.take(']');
            }
            const path = memoryPath(expression, this.names);
            this.roots.add(path[0] as string);
            this.operandPath = JSON.stringify(path);
            return memoryValue(this.item, path);
        }
        if (token.startsWith(':') && Object.prototype.hasOwnProperty.call(this.values, token)) {
            return QuerySerializer.parseField(this.values[token]);
        }
        return validation(`Unknown in-memory expression operand: ${token}`);
    }

    private predicate(): boolean {
        const token = this.tokens[this.position];
        if (token === 'NOT') {
            this.take();
            return !this.predicate();
        }
        if (token === '(') {
            this.take();
            const result = this.disjunction();
            this.take(')');
            return result;
        }
        if (['attribute_exists', 'attribute_not_exists', 'contains', 'begins_with', 'attribute_type'].includes(token)) {
            this.take();
            this.take('(');
            const left = this.operand();
            if (token === 'attribute_exists' || token === 'attribute_not_exists') {
                this.take(')');
                return token === 'attribute_exists'
                    ? left !== undefined
                    : left === undefined;
            }
            this.take(',');
            const right = this.operand();
            this.take(')');
            if (token === 'attribute_type') {
                if (typeof right !== 'string' || !['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS'].includes(right)) validation('Invalid expression attribute type');
                return left !== undefined && Object.keys(QuerySerializer.serialiseItem(left))[0] === right;
            }
            if (token === 'begins_with' && typeof right !== 'string' && !(right instanceof Uint8Array)) validation('Prefix requires a string or binary operand');
            if (typeof left === 'string' && typeof right === 'string') {
                return token === 'contains' ? left.includes(right) : left.startsWith(right);
            }
            if (token === 'begins_with' && left instanceof Uint8Array && right instanceof Uint8Array) {
                return equalDynamoValues(left.subarray(0, right.length), right);
            }
            return token === 'contains'
                && (Array.isArray(left) || left instanceof Set)
                && Array.from(left).some((entry) => equalDynamoValues(entry, right));
        }
        const left = this.operand();
        const leftPath = this.operandPath;
        const rightOperand = () => {
            const value = this.operand();
            if (leftPath !== null && leftPath === this.operandPath) validation('The first operand must be distinct from the remaining stored operands');
            return value;
        };
        const operator = this.take();
        if (operator === 'IN') {
            this.take('(');
            const candidates = [rightOperand()];
            while (this.tokens[this.position] === ',') {
                this.take();
                candidates.push(rightOperand());
            }
            this.take(')');
            if (candidates.length > 100) validation('IN supports at most 100 values');
            return left !== undefined && candidates.some((candidate) => equalDynamoValues(left, candidate));
        }
        const right = rightOperand();
        const order = compare(left, right);
        if (operator === 'BETWEEN') {
            this.take('AND');
            const upperOrder = compare(left, rightOperand());
            return order !== null && upperOrder !== null && order >= 0 && upperOrder <= 0;
        }
        switch (operator) {
            case '=': return left !== undefined && equalDynamoValues(left, right);
            case '<>': return left === undefined || right === undefined || !equalDynamoValues(left, right);
            case '<': return order !== null && order < 0;
            case '<=': return order !== null && order <= 0;
            case '>': return order !== null && order > 0;
            case '>=': return order !== null && order >= 0;
            default: return validation(`Unsupported in-memory operator: ${operator}`);
        }
    }
}

/** In-memory implementation of the DynamoDB operations used by QueryBuilder. */
class InMemoryDynamoDB {
    /** DynamoDB-compatible client passed to QueryBuilder and typed tables. */
    readonly db: DynamoDBClient;
    private tables = new Map<string, MemoryTable>();
    private tokens = new Map<string, {input: TransactWriteItemsCommandInput; expires: number}>();
    private closed = false;
    private closing: Promise<void> | null = null;
    private operation: Promise<void> = Promise.resolve();
    private readonly ready: Promise<void>;

    /** Creates an isolated in-memory backend and optionally seeds its table definitions. */
    constructor(tables: InitialTables = [], private readonly persistence?: MemoryPersistence) {
        this.db = new DynamoDBClient({
            region: 'us-east-1',
            credentials: {accessKeyId: 'in-memory', secretAccessKey: 'in-memory'}
        });
        this.db.send = (async (command: MemoryCommand | AdministrationCommand, options?: {abortSignal?: AbortSignal}) => {
            if (this.closed) throw new Error('In-memory DynamoDB backend is closed');
            options?.abortSignal?.throwIfAborted();
            return this.enqueue(async () => {
                await this.ready;
                options?.abortSignal?.throwIfAborted();
                const response = this.mutates(command)
                    ? await this.persistMutation(() => this.execute(command))
                    : this.execute(command);
                return ValueUtils.clone(response);
            });
        }) as typeof this.db.send;
        for (const table of tables) {
            this.execute(new CreateTableCommand('name' in table ? QueryTableAdmin.toCreateTableInput(table) : table));
        }
        this.ready = this.load().catch(async error => {
            await this.persistence?.close?.();
            throw error;
        });
        void this.ready.catch(() => undefined);
    }

    /** Removes all records and transaction tokens while retaining table definitions. */
    async reset(): Promise<void> {
        if (this.closed) throw new Error('In-memory DynamoDB backend is closed');
        await this.enqueue(async () => {
            await this.ready;
            await this.persistMutation(() => {
                for (const table of this.tables.values()) table.items.clear();
                this.tokens.clear();
            });
        });
    }

    /** Closes the client, removes table definitions, and rejects future requests. */
    close(): Promise<void> {
        if (this.closing !== null) return this.closing;
        this.closed = true;
        this.closing = (async () => {
            await this.ready.catch(() => undefined);
            await this.operation;
            this.tables.clear();
            this.tokens.clear();
            try { await this.persistence?.close?.(); } finally { this.db.destroy(); }
        })();
        return this.closing;
    }

    private async persistMutation<Result>(action: () => Result): Promise<Result> {
        if (!this.persistence) return action();
        const tables = ValueUtils.clone(this.tables);
        const tokens = ValueUtils.clone(this.tokens);
        try {
            const result = action();
            await this.persistence.save(this.snapshot());
            return result;
        } catch (error) {
            this.tables = tables;
            this.tokens = tokens;
            throw error;
        }
    }

    private enqueue<Result>(action: () => Promise<Result>): Promise<Result> {
        const result = this.operation.then(action);
        this.operation = result.then(() => undefined, () => undefined);
        return result;
    }

    private async load(): Promise<void> {
        const snapshot = await this.persistence?.load();
        if (snapshot === undefined) {
            await this.persistence?.save(this.snapshot());
            return;
        }
        if (snapshot === null || snapshot.version !== 1 || !Array.isArray(snapshot.tables)) {
            throw new Error('Unsupported in-memory DynamoDB persistence format');
        }
        this.tables.clear();
        for (const persistedTable of snapshot.tables) {
            if (!persistedTable?.description?.TableName || !Array.isArray(persistedTable.items)) {
                throw new Error('Invalid in-memory DynamoDB snapshot table');
            }
            this.execute(new CreateTableCommand(persistedTable.description as CreateTableCommandInput));
            const table = this.table(persistedTable.description.TableName);
            table.description = ValueUtils.clone(persistedTable.description);
            for (const persistedItem of persistedTable.items) {
                const item = QuerySerializer.parseItem<AttributeMap, unknown>(persistedItem);
                const key = this.key(table, item);
                this.validateIndexKeys(table, item);
                if (table.items.has(key)) throw new Error('Duplicate key in persisted snapshot');
                table.items.set(key, item);
            }
            this.tables.set(table.description.TableName!, table);
        }
        this.tokens = new Map((snapshot.tokens || []).filter(([, token]) => token.expires > Date.now()));
    }

    private snapshot(): MemorySnapshot {
        return {
            version: 1,
            tokens: Array.from(this.tokens).filter(([, token]) => token.expires > Date.now()),
            tables: Array.from(this.tables.values(), (table) => ({
                description: ValueUtils.clone(table.description),
                items: Array.from(table.items.values(), (item) => QuerySerializer.serialiseMap(item))
            }))
        };
    }

    private mutates(command: MemoryCommand | AdministrationCommand): boolean {
        return command instanceof CreateTableCommand
            || command instanceof UpdateTableCommand
            || command instanceof DeleteTableCommand
            || command instanceof PutItemCommand
            || command instanceof UpdateItemCommand
            || command instanceof DeleteItemCommand
            || command instanceof BatchWriteItemCommand
            || command instanceof TransactWriteItemsCommand;
    }

    private table(name: string | undefined): MemoryTable {
        const table = name === undefined ? undefined : this.tables.get(name);
        if (table === undefined) {
            throw new ResourceNotFoundException({message: `Table not found: ${name}`, $metadata: {}});
        }
        return table;
    }

    private key(table: MemoryTable, item: Document, exact = false): string {
        const schema = table.description.KeySchema || [];
        if (exact && Object.keys(item).length !== schema.length) {
            validation('The provided key does not match the table schema');
        }
        return JSON.stringify(schema.map((element) => {
            const name = element.AttributeName!;
            const value = item[name];
            this.validateKeyAttribute(table, element, value);
            const type = typeof value === 'string' ? 'S' : typeof value === 'number' ? 'N' : 'B';
            return [
                name,
                type,
                value instanceof Uint8Array ? Array.from(value) : value
            ];
        }));
    }

    private validateKeyAttribute(table: MemoryTable, key: KeySchemaElement, value: unknown): void {
        const definition = (table.description.AttributeDefinitions || [])
            .find((entry) => entry.AttributeName === key.AttributeName);
        const type = typeof value === 'string' ? 'S' : typeof value === 'number' ? 'N'
            : value instanceof Uint8Array ? 'B' : null;
        if (definition === undefined || type !== definition.AttributeType) {
            validation(`Invalid key attribute: ${key.AttributeName}`);
        }
        try {
            assertDynamoKeyValue(value, key.KeyType === 'RANGE');
        } catch {
            validation(`Invalid key attribute: ${key.AttributeName}`);
        }
    }

    private validateIndexKeys(table: MemoryTable, item: Document): void {
        const indexes = [...(table.description.GlobalSecondaryIndexes || []), ...(table.description.LocalSecondaryIndexes || [])];
        for (const index of indexes) {
            for (const key of index.KeySchema || []) {
                if (Object.prototype.hasOwnProperty.call(item, key.AttributeName!)) {
                    this.validateKeyAttribute(table, key, item[key.AttributeName!]);
                }
            }
        }
    }

    private validateQuery(table: MemoryTable, schema: KeySchemaElement[], input: QueryCommandInput, cursor?: Document): void {
        const expression = (input.KeyConditionExpression || '').trim().replace(/\s+/g, ' ');
        const predicates = Array.from(expression.matchAll(
            /begins_with\s*\((#[A-Za-z0-9_]+),\s*(:[A-Za-z0-9_]+)\)|(#[A-Za-z0-9_]+) (=|<=|>=|<|>|BETWEEN) (:[A-Za-z0-9_]+)(?: AND (:[A-Za-z0-9_]+))?/g
        ));
        let end = 0;
        const seen = new Set<string>();
        const sortFields = schema.filter(key => key.KeyType === 'RANGE');
        let sortPosition = 0, rangeAdded = false;
        for (const predicate of predicates) {
            if (expression.slice(end, predicate.index) !== (end === 0 ? '' : ' AND ')) {
                validation('Unsupported query key condition');
            }
            end = predicate.index! + predicate[0].length;
            const name = (input.ExpressionAttributeNames || {})[predicate[1] || predicate[3]];
            const key = schema.find((entry) => entry.AttributeName === name);
            const operator = predicate[1] ? 'begins_with' : predicate[4];
            if (key === undefined || seen.has(name) || (key.KeyType === 'HASH' && operator !== '=')) {
                validation('Query requires partition-key equality and at most one sort-key predicate');
            }
            seen.add(name);
            if (key.KeyType === 'RANGE') {
                if (rangeAdded || sortFields[sortPosition]?.AttributeName !== name) validation('Sort conditions require a contiguous prefix with any range last');
                sortPosition++;
                rangeAdded = operator !== '=';
            }
            const aliases = [predicate[2] || predicate[5], predicate[6]].filter(Boolean);
            if ((operator === 'BETWEEN') !== (aliases.length === 2)) validation('Invalid sort-key range');
            const values = aliases.map((alias) => {
                const encoded = (input.ExpressionAttributeValues || {})[alias];
                if (encoded === undefined) validation('Missing query key operand');
                const value: unknown = QuerySerializer.parseField(encoded);
                this.validateKeyAttribute(table, key, value);
                return value;
            });
            if (operator === 'begins_with' && typeof values[0] !== 'string' && !(values[0] instanceof Uint8Array)) {
                validation('Sort-key prefix requires a string or binary value');
            }
            if (cursor !== undefined && key.KeyType === 'HASH' && !equalDynamoValues(cursor[name], values[0])) validation('Cursor must belong to the queried partition');
            if (operator === 'BETWEEN' && (compare(values[0], values[1]) ?? 1) > 0) {
                validation('Sort-key range requires matching types and ordered bounds');
            }
        }
        if (end !== expression.length || !schema.filter(key => key.KeyType === 'HASH').every(key => seen.has(key.AttributeName!))) {
            validation('Query requires partition-key equality and only declared key attributes');
        }
    }

    private matches(expression: string | undefined, item: Document, input: QueryCommandInput): boolean {
        return expression === undefined || new MemoryExpression(
            expression,
            item,
            input.ExpressionAttributeNames || {},
            input.ExpressionAttributeValues || {}
        ).evaluate();
    }

    private condition(input: ConditionCheck | WriteInput, item: Document | undefined): void {
        if (!this.matches(input.ConditionExpression, item === undefined ? {} : item, input)) {
            throw new ConditionalCheckFailedException({
                message: 'The conditional request failed',
                $metadata: {},
                Item: input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD' && item !== undefined
                    ? QuerySerializer.serialiseMap(item)
                    : undefined
            });
        }
    }

    private metadata(input: {TableName?: string; ReturnConsumedCapacity?: string}): object {
        if (input.ReturnConsumedCapacity === undefined || input.ReturnConsumedCapacity === 'NONE') {
            return {};
        }
        return {ConsumedCapacity: {TableName: input.TableName, CapacityUnits: 1}};
    }

    private itemCollectionMetrics(input: WriteInput, table: MemoryTable, item: Document): {ItemCollectionMetrics?: ItemCollectionMetrics} {
        if (input.ReturnItemCollectionMetrics !== 'SIZE' || (table.description.LocalSecondaryIndexes || []).length === 0) {
            return {};
        }
        const partition = (table.description.KeySchema || []).find((key) => key.KeyType === 'HASH');
        if (partition === undefined || item[partition.AttributeName!] === undefined) {
            return {};
        }
        return {ItemCollectionMetrics: {
            ItemCollectionKey: QuerySerializer.serialiseMap({[partition.AttributeName!]: item[partition.AttributeName!]}),
            SizeEstimateRangeGB: [0, 0]
        }};
    }

    private groupedMetadata(input: {ReturnConsumedCapacity?: string; ReturnItemCollectionMetrics?: string}, names: string[], metrics: Record<string, ItemCollectionMetrics[]> = {}): object {
        return {
            ...(input.ReturnConsumedCapacity && input.ReturnConsumedCapacity !== 'NONE'
                ? {ConsumedCapacity: [...new Set(names)].map(TableName => ({TableName, CapacityUnits: 1}))} : {}),
            ...(input.ReturnItemCollectionMetrics === 'SIZE' && Object.keys(metrics).length > 0 ? {ItemCollectionMetrics: metrics} : {})
        };
    }

    private project(item: Document, expression: string | undefined, names: Record<string, string> | undefined): Document {
        if (expression === undefined) return item;
        return (projectMemoryValue(item, projectionTree(expression, names || {})) || {}) as Document;
    }

    private write(kind: 'put' | 'update' | 'delete' | 'check', input: WriteInput): object {
        const table = this.table(input.TableName);
        const selector = QuerySerializer.parseItem<AttributeMap, unknown>(
            kind === 'put' ? input.Item! : input.Key!
        );
        const key = this.key(table, selector, kind !== 'put');
        const previous = table.items.get(key);
        this.condition(input, previous);
        if (kind === 'check') {
            return {};
        }
        let next = ValueUtils.clone(previous === undefined ? selector : previous);
        let updatedPaths: {old: string[]; next: Document} = {old: [], next: {}};
        if (kind === 'put') {
            next = selector;
        } else if (kind === 'update') {
            updatedPaths = this.update(next, input, table.description.KeySchema || []);
        }
        if (kind === 'delete') {
            table.items.delete(key);
        } else {
            this.validateIndexKeys(table, next);
            QuerySerializer.serialiseMap(next);
            table.items.set(key, ValueUtils.clone(next));
        }
        let returned = input.ReturnValues === 'ALL_OLD'
            ? previous
            : input.ReturnValues === 'ALL_NEW'
                ? next
                : undefined;
        if (input.ReturnValues === 'UPDATED_OLD' || input.ReturnValues === 'UPDATED_NEW') {
            returned = input.ReturnValues === 'UPDATED_NEW' ? updatedPaths.next
                : previous === undefined || updatedPaths.old.length === 0 ? undefined
                    : this.project(previous, updatedPaths.old.join(', '), input.ExpressionAttributeNames);
            if (returned && Object.keys(returned).length === 0) returned = undefined;
        }
        return {
            ...(returned === undefined ? {} : {Attributes: QuerySerializer.serialiseMap(returned)}),
            ...this.metadata(input),
            ...this.itemCollectionMetrics(input, table, next)
        };
    }

    private update(item: Document, input: WriteInput, keys: KeySchemaElement[]): {old: string[]; next: Document} {
        const expression = input.UpdateExpression || '';
        const groups = [...expression.matchAll(/\b(SET|REMOVE|ADD|DELETE)\s+(.+?)(?=\s+(?:SET|REMOVE|ADD|DELETE)\s|$)/g)];
        if (groups.length === 0 || groups.map(group => group[0]).join(' ') !== expression
            || new Set(groups.map(group => group[1])).size !== groups.length) validation(`Unsupported in-memory update: ${expression}`);
        const actions: {type: string; path: MemoryPath; expression: string; nextExpression: string; value?: unknown; encoded?: AttributeValue}[] = [];
        for (const group of groups) {
            for (const clause of splitUpdateOperands(group[2])) {
                const match = /^(\S+)(?:\s*=\s*(.+)|\s+(:[A-Za-z0-9_]+))?$/.exec(clause);
                if (match === null) validation(`Unsupported in-memory update clause: ${clause}`);
                const path = memoryPath(match[1], input.ExpressionAttributeNames || {});
                if (keys.some(key => key.AttributeName === path[0])) validation('Primary key attributes cannot be updated');
                if ((group[1] === 'ADD' || group[1] === 'DELETE') && path.length !== 1) validation('ADD and DELETE support top-level attributes only');
                if (actions.some(action => action.path.slice(0, Math.min(action.path.length, path.length)).every((segment, index) => segment === path[index]))) validation('Overlapping update paths');
                const alias = match[2] || match[3];
                const value = group[1] === 'SET' && match[2] !== undefined
                    ? updateOperand(match[2], item, input.ExpressionAttributeNames || {}, input.ExpressionAttributeValues || {})
                    : alias === undefined ? undefined : QuerySerializer.parseField(input.ExpressionAttributeValues?.[alias]!);
                const encoded = value === undefined ? undefined : QuerySerializer.serialiseItem(value);
                if (group[1] === 'REMOVE' ? alias !== undefined : encoded === undefined || (group[1] === 'SET') !== (match[2] !== undefined)) validation('Invalid update action operand');
                actions.push({type: group[1], path, expression: match[1], nextExpression: match[1], encoded, value});
            }
        }
        const parent = (path: MemoryPath): Document | unknown[] => {
            const value = memoryValue(item, path.slice(0, -1));
            const leaf = path[path.length - 1];
            if (typeof leaf === 'number' ? !Array.isArray(value)
                : value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Set || value instanceof Uint8Array) validation('The document path provided in the update expression is invalid');
            return value as Document | unknown[];
        };
        const targets = new Map(actions.map(action => [action, parent(action.path)]));
        const absentRemovals = new Set(actions.filter(action => action.type === 'REMOVE'
            && !Object.prototype.hasOwnProperty.call(targets.get(action), action.path.at(-1)!)));
        const nonRemovals = actions.filter(action => action.type !== 'REMOVE').sort((left, right) => {
            const parentOrder = JSON.stringify(left.path.slice(0, -1)).localeCompare(JSON.stringify(right.path.slice(0, -1)));
            return parentOrder || (typeof left.path.at(-1) === 'number' && typeof right.path.at(-1) === 'number'
                ? Number(left.path.at(-1)) - Number(right.path.at(-1)) : 0);
        });
        for (const action of nonRemovals) {
            const target = targets.get(action)!, leaf = action.path.at(-1)!;
            const previous = memoryValue(item, action.path);
            const set = (value: unknown) => {
                if (Array.isArray(target)) {
                    const position = Math.min(leaf as number, target.length);
                    action.nextExpression = action.expression.replace(/\[\d+\]$/, `[${position}]`);
                    target[position] = value;
                }
                else Object.defineProperty(target, leaf, {value, enumerable: true, writable: true, configurable: true});
            };
            if (action.type === 'SET') set(action.value);
            else if (action.type === 'ADD' && typeof action.value === 'number' && (previous === undefined || typeof previous === 'number')) {
                set((typeof previous === 'number' ? previous : 0) + action.value);
            } else if (action.value instanceof Set && (previous === undefined || previous instanceof Set)) {
                if (previous !== undefined && Object.keys(QuerySerializer.serialiseItem(previous))[0] !== Object.keys(action.encoded!)[0]) validation('Set types must match');
                const entries: unknown[] = previous instanceof Set ? [...previous] : [];
                if (action.type === 'ADD') {
                    for (const entry of action.value) if (!entries.some(existing => equalDynamoValues(existing, entry))) entries.push(entry);
                    set(new Set(entries));
                } else {
                    const remaining = entries.filter(entry => ![...action.value as Set<unknown>].some(removed => equalDynamoValues(entry, removed)));
                    if (remaining.length) set(new Set(remaining));
                    else delete (target as Document)[leaf];
                }
            } else validation(`Invalid ${action.type} value for ${String(leaf)}`);
        }
        const removals = actions.filter(action => action.type === 'REMOVE').sort((left, right) =>
            right.path.length - left.path.length || (typeof left.path.at(-1) === 'number' && typeof right.path.at(-1) === 'number'
                ? Number(right.path.at(-1)) - Number(left.path.at(-1)) : 0));
        for (const action of removals) {
            if (absentRemovals.has(action)) continue;
            const leaf = action.path.at(-1)!;
            const target = targets.get(action)!;
            if (Array.isArray(target)) {
                if ((leaf as number) < target.length) target.splice(leaf as number, 1);
            } else delete target[leaf as string];
        }
        const updatedPaths = new Map(actions.map(action => [
            JSON.stringify(memoryPath(action.nextExpression, input.ExpressionAttributeNames || {})), action.nextExpression
        ]));
        return {old: actions.map(action => action.expression), next: this.project(item,
            [...updatedPaths.values()].join(', '), input.ExpressionAttributeNames)};
    }

    // Query and scan execution.
    private read(input: QueryCommandInput | ScanCommandInput, query: boolean): object {
        const table = this.table(input.TableName);
        const queryInput = input as QueryCommandInput;
        let schema = table.description.KeySchema || [];
        let projectedAttributes: Set<string> | null = null;
        let globalIndex = false;
        const indexRequest = input.IndexName !== undefined;
        if (input.IndexName !== undefined) {
            const global = (table.description.GlobalSecondaryIndexes || [])
                .find((index) => index.IndexName === input.IndexName);
            const local = (table.description.LocalSecondaryIndexes || [])
                .find((index) => index.IndexName === input.IndexName);
            const index = global === undefined ? local : global;
            if (index === undefined || (global !== undefined && input.ConsistentRead === true)) {
                validation(`Invalid index request: ${input.IndexName}`);
            }
            if (index.Projection === undefined) {
                validation('In-memory index does not define a projection');
            }
            schema = index.KeySchema || [];
            globalIndex = global !== undefined;
            if (index.Projection.ProjectionType !== 'ALL') {
                projectedAttributes = new Set(
                    [...(table.description.KeySchema || []), ...schema]
                        .map((key) => key.AttributeName!)
                );
                for (const attribute of index.Projection.NonKeyAttributes || []) {
                    projectedAttributes.add(attribute);
                }
            }
        }
        if (query && queryInput.KeyConditionExpression === undefined) {
            validation('Query requires a key condition');
        }
        this.matches(query ? queryInput.KeyConditionExpression : undefined, {}, input as QueryCommandInput);
        this.matches(input.FilterExpression, {}, input);
        const filterRoots = new Set<string>();
        if (input.FilterExpression !== undefined) {
            const expression = new MemoryExpression(input.FilterExpression, {}, input.ExpressionAttributeNames || {}, input.ExpressionAttributeValues || {});
            expression.evaluate();
            expression.roots.forEach(root => filterRoots.add(root));
        }
        if (query) {
            this.validateQuery(table, schema, queryInput);
            if ([...filterRoots].some(name => schema.some(key => key.AttributeName === name))) validation('Query filters cannot reference key attributes');
        }
        if (query && indexRequest && projectedAttributes !== null && [...filterRoots].some(name => !projectedAttributes!.has(name))) validation('Secondary index filters require projected attributes');
        if (input.ProjectionExpression !== undefined && input.Select !== undefined && input.Select !== 'SPECIFIC_ATTRIBUTES') {
            validation('ProjectionExpression requires SPECIFIC_ATTRIBUTES when Select is provided');
        }
        if (input.Select === 'SPECIFIC_ATTRIBUTES' && input.ProjectionExpression === undefined) {
            validation('SPECIFIC_ATTRIBUTES requires ProjectionExpression');
        }
        if (input.Select === 'ALL_PROJECTED_ATTRIBUTES' && !indexRequest) {
            validation('ALL_PROJECTED_ATTRIBUTES requires an index');
        }
        if (input.Select === 'ALL_ATTRIBUTES' && globalIndex && projectedAttributes !== null) {
            validation('Global secondary index cannot return all table attributes');
        }
        const requestedAttributes = input.ProjectionExpression === undefined ? null
            : [...projectionTree(input.ProjectionExpression, input.ExpressionAttributeNames || {}).children.keys()] as string[];
        if (globalIndex && projectedAttributes !== null && requestedAttributes !== null
            && requestedAttributes.some(attribute => !projectedAttributes!.has(attribute))) validation('Global secondary index query requested a non-projected attribute');
        let items = Array.from(table.items.values()).filter(
            (item) => schema.every((key) => item[key.AttributeName!] !== undefined)
                && (!query || this.matches(queryInput.KeyConditionExpression, item, queryInput))
        );
        // A total key order makes continuation independent of the cursor record's lifetime.
        // Scan order and index tie-breaking are deterministic here, not AWS ordering guarantees.
        const tableSchema = table.description.KeySchema || [];
        const orderedKeys = [...new Set([
            ...(!query ? schema.filter(key => key.KeyType === 'HASH') : []),
            ...schema.filter(key => key.KeyType === 'RANGE'),
            ...tableSchema.filter(key => key.KeyType === 'HASH'),
            ...tableSchema.filter(key => key.KeyType === 'RANGE')
        ].map(key => key.AttributeName!))];
        const comparePosition = (left: Document, right: Document): number => {
            for (const name of orderedKeys) {
                const order = compare(left[name], right[name]) || 0;
                if (order) return query && queryInput.ScanIndexForward === false ? -order : order;
            }
            return 0;
        };
        items.sort(comparePosition);
        const segmentFor = (item: Document, total: number): number => {
            const key = this.key(table, item);
            let hash = 0;
            for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
            return hash % total;
        };
        if (!query) {
            const scan = input as ScanCommandInput;
            if ((scan.Segment === undefined) !== (scan.TotalSegments === undefined)
                || (scan.TotalSegments !== undefined && (!Number.isInteger(scan.TotalSegments)
                    || scan.TotalSegments < 1 || scan.TotalSegments > 1000000
                    || !Number.isInteger(scan.Segment) || scan.Segment! < 0 || scan.Segment! >= scan.TotalSegments))) {
                validation('Invalid parallel scan segment');
            }
            if (scan.Segment !== undefined) {
                items = items.filter(item => segmentFor(item, scan.TotalSegments!) === scan.Segment);
            }
        }
        if (input.ExclusiveStartKey !== undefined) {
            const cursor: Document = QuerySerializer.parseItem(input.ExclusiveStartKey);
            const cursorSchema = new Map([...(table.description.KeySchema || []), ...schema]
                .map((key) => [key.AttributeName!, key]));
            if (Object.keys(cursor).length !== cursorSchema.size) validation('Cursor must contain all table and index keys');
            cursorSchema.forEach((key) => this.validateKeyAttribute(table, key, cursor[key.AttributeName!]));
            if (query) this.validateQuery(table, schema, queryInput, cursor);
            const scan = input as ScanCommandInput;
            if (!query && scan.Segment !== undefined && segmentFor(cursor, scan.TotalSegments!) !== scan.Segment) {
                validation('Scan cursor must belong to the requested segment');
            }
            items = items.filter(item => comparePosition(item, cursor) > 0);
        }
        const limit = input.Limit === undefined ? items.length : input.Limit;
        if (input.Limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
            validation('Limit must be a positive integer');
        }
        const evaluated = items.slice(0, limit);
        const filtered = evaluated.filter(item => {
            const fetchesTable = !globalIndex && (input.Select === 'ALL_ATTRIBUTES'
                || requestedAttributes?.some(name => !projectedAttributes?.has(name)));
            const available = !query && projectedAttributes !== null && !fetchesTable
                ? Object.fromEntries([...projectedAttributes].filter(name => Object.prototype.hasOwnProperty.call(item, name)).map(name => [name, item[name]]))
                : item;
            return this.matches(input.FilterExpression, available, input);
        });
        let lastKey: AttributeMap | undefined;
        if (evaluated.length < items.length && evaluated.length > 0) {
            const last = evaluated[evaluated.length - 1];
            lastKey = QuerySerializer.serialiseMap(
                Object.fromEntries(
                    [...(table.description.KeySchema || []), ...schema]
                        .map((key) => [key.AttributeName!, last[key.AttributeName!]])
                )
            );
        }
        return {
            ...this.metadata(input),
            Items: input.Select === 'COUNT'
                ? undefined
                : filtered.map((item) => {
                    if (input.ProjectionExpression !== undefined) return QuerySerializer.serialiseMap(this.project(item, input.ProjectionExpression, input.ExpressionAttributeNames));
                    if (input.Select === 'ALL_ATTRIBUTES' || projectedAttributes === null) return QuerySerializer.serialiseMap(item);
                    return QuerySerializer.serialiseMap(Object.fromEntries([...projectedAttributes]
                        .filter(name => Object.prototype.hasOwnProperty.call(item, name)).map(name => [name, item[name]])));
                }),
            Count: filtered.length,
            ScannedCount: evaluated.length,
            LastEvaluatedKey: lastKey
        };
    }

    // Transactions validate and apply all writes against an isolated snapshot.
    private transaction(input: TransactWriteItemsCommandInput): object {
        const writes = input.TransactItems || [];
        if (writes.length === 0 || writes.length > 100) {
            validation('Transactions require between 1 and 100 operations');
        }
        const token = input.ClientRequestToken;
        if (token !== undefined) {
            if (token.length < 1 || token.length > 36) {
                validation('Invalid transaction request token');
            }
            const previous = this.tokens.get(token);
            if (previous !== undefined && previous.expires > Date.now()) {
                if (!ValueUtils.equals(previous.input, input)) {
                    throw new DynamoDBServiceException({
                        name: 'IdempotentParameterMismatchException',
                        message: 'Request token reused with different input',
                        $fault: 'client',
                        $metadata: {}
                    });
                }
                return this.groupedMetadata(input, writes.map(entry => (entry.Put || entry.Update || entry.Delete || entry.ConditionCheck)!.TableName!));
            }
        }
        const snapshot = ValueUtils.clone(this.tables);
        const targets = new Set<string>();
        const metrics: Record<string, ItemCollectionMetrics[]> = {};
        let position = 0;
        try {
            for (const entry of writes) {
                const write = entry.Put || entry.Update || entry.Delete || entry.ConditionCheck;
                if (write === undefined || Object.keys(entry).length !== 1) {
                    validation('Invalid transaction item');
                }
                const kind = entry.Put !== undefined
                    ? 'put'
                    : entry.Update !== undefined
                        ? 'update'
                        : entry.Delete !== undefined
                            ? 'delete'
                            : 'check';
                const selector = QuerySerializer.parseItem(
                    entry.Put !== undefined ? entry.Put.Item! : (write as ConditionCheck).Key!
                );
                const target = JSON.stringify([
                    write.TableName,
                    this.key(this.table(write.TableName), selector, kind !== 'put')
                ]);
                if (targets.has(target)) {
                    validation('Transaction cannot target the same item twice');
                }
                targets.add(target);
                this.write(kind, write);
                if (kind !== 'check') {
                    const metric = this.itemCollectionMetrics({...write, ReturnItemCollectionMetrics: input.ReturnItemCollectionMetrics}, this.table(write.TableName), selector).ItemCollectionMetrics;
                    if (metric) (metrics[write.TableName!] ??= []).push(metric);
                }
                position++;
            }
        } catch (error) {
            this.tables = snapshot;
            if (error instanceof ConditionalCheckFailedException) {
                throw new TransactionCanceledException({
                    message: 'Transaction cancelled',
                    $metadata: {},
                    CancellationReasons: writes.map((entry, index) => index === position
                        ? {Code: 'ConditionalCheckFailed', Message: error.message, Item: error.Item}
                        : {Code: 'None'})
                });
            }
            throw error;
        }
        if (token !== undefined) {
            this.tokens.set(token, {input: ValueUtils.clone(input), expires: Date.now() + 600000});
        }
        return this.groupedMetadata(input, writes.map(entry => (entry.Put || entry.Update || entry.Delete || entry.ConditionCheck)!.TableName!), metrics);
    }

    // Translate each supported SDK command into an in-memory operation.
    private execute(command: MemoryCommand | AdministrationCommand): object {
        const commandName = command.constructor.name;
        if (command instanceof UpdateTableCommand) {
            const input = command.input;
            if (input.BillingMode !== undefined || input.ProvisionedThroughput !== undefined
                || input.GlobalSecondaryIndexUpdates?.some(update => update.Update || update.Create?.ProvisionedThroughput)
                || Object.keys(input).some(field => !['TableName', 'AttributeDefinitions', 'GlobalSecondaryIndexUpdates'].includes(field))) {
                throw new Error('In-memory table updates support GSI creation and deletion only; throughput is not simulated');
            }
            const table = this.table(input.TableName);
            const candidate = ValueUtils.clone(table.description) as CreateTableCommandInput;
            const changes = input.GlobalSecondaryIndexUpdates ?? [];
            if (changes.length !== 1) validation('Table update requires one index creation or deletion');
            for (const change of changes) {
                if (Number(change.Create !== undefined) + Number(change.Delete !== undefined) !== 1) validation('Unsupported index update');
                if (change.Create) {
                    if ([...(candidate.GlobalSecondaryIndexes ?? []), ...(candidate.LocalSecondaryIndexes ?? [])].some(index => index.IndexName === change.Create!.IndexName)) validation('Index already exists');
                    candidate.GlobalSecondaryIndexes = [...(candidate.GlobalSecondaryIndexes ?? []), change.Create];
                } else {
                    if (!candidate.GlobalSecondaryIndexes?.some(index => index.IndexName === change.Delete!.IndexName)) validation('Global index does not exist');
                    candidate.GlobalSecondaryIndexes = candidate.GlobalSecondaryIndexes.filter(index => index.IndexName !== change.Delete!.IndexName);
                }
            }
            const attributes = new Map((candidate.AttributeDefinitions ?? []).map(attribute => [attribute.AttributeName, attribute]));
            for (const attribute of input.AttributeDefinitions ?? []) {
                if (attributes.has(attribute.AttributeName) && attributes.get(attribute.AttributeName)!.AttributeType !== attribute.AttributeType) validation('Existing key types are immutable');
                attributes.set(attribute.AttributeName, attribute);
            }
            const fields = new Set([...(candidate.KeySchema ?? []),
                ...[...(candidate.GlobalSecondaryIndexes ?? []), ...(candidate.LocalSecondaryIndexes ?? [])].flatMap(index => index.KeySchema ?? [])].map(key => key.AttributeName));
            candidate.AttributeDefinitions = [...attributes.values()].filter(attribute => fields.has(attribute.AttributeName));
            this.tables.delete(input.TableName!);
            let updated: MemoryTable;
            try {
                this.execute(new CreateTableCommand(candidate));
                updated = this.table(input.TableName);
                for (const item of table.items.values()) this.validateIndexKeys(updated, item);
            } finally {
                this.tables.set(input.TableName!, table);
            }
            table.description = updated.description;
            return {TableDescription: table.description};
        }
        if (command instanceof CreateTableCommand) {
            const input = ValueUtils.clone(command.input);
            if (input.BillingMode === 'PROVISIONED' || input.ProvisionedThroughput || input.GlobalSecondaryIndexes?.some(index => index.ProvisionedThroughput)) {
                throw new Error('In-memory provisioned throughput is not simulated');
            }
            const name = input.TableName;
            const keys = input.KeySchema || [];
            const validKeys = (schema: KeySchemaElement[], multiple = false) =>
                schema.filter((key) => key.KeyType === 'HASH').length >= 1
                && schema.filter((key) => key.KeyType === 'HASH').length <= (multiple ? 4 : 1)
                && schema.filter((key) => key.KeyType === 'RANGE').length <= (multiple ? 4 : 1)
                && schema.length >= 1
                && schema.length <= (multiple ? 8 : 2)
                && new Set(schema.map((key) => key.AttributeName)).size === schema.length
                && schema.every((key) => (key.KeyType === 'HASH' || key.KeyType === 'RANGE')
                    && (input.AttributeDefinitions || []).some((attribute) =>
                        attribute.AttributeName === key.AttributeName
                        && ['S', 'N', 'B'].includes(attribute.AttributeType!)));
            if (!name || !validKeys(keys)) {
                validation('Table requires a name and valid key definitions');
            }
            const indexes = [...(input.GlobalSecondaryIndexes || []), ...(input.LocalSecondaryIndexes || [])];
            const validProjection = (index: typeof indexes[number]): boolean => {
                const projection = index.Projection;
                if (projection === undefined || !['ALL', 'KEYS_ONLY', 'INCLUDE'].includes(projection.ProjectionType!)) {
                    return false;
                }
                if (projection.ProjectionType !== 'INCLUDE') {
                    return projection.NonKeyAttributes === undefined || projection.NonKeyAttributes.length === 0;
                }
                const attributes = projection.NonKeyAttributes || [];
                const projectedKeys = new Set(
                    [...keys, ...(index.KeySchema || [])].map((key) => key.AttributeName)
                );
                return attributes.length > 0 && attributes.length <= 20
                    && new Set(attributes).size === attributes.length
                    && attributes.every((attribute) => attribute.length > 0 && !projectedKeys.has(attribute));
            };
            if (
                new Set(indexes.map((index) => index.IndexName)).size !== indexes.length
                || indexes.some((index) => !index.IndexName
                    || !validKeys(index.KeySchema || [], (input.GlobalSecondaryIndexes || []).includes(index))
                    || !validProjection(index))
            ) {
                validation('In-memory indexes require unique names, valid keys and projections');
            }
            const projectedAttributeCount = indexes.reduce(
                (total, index) => total + (index.Projection?.NonKeyAttributes || []).length,
                0
            );
            if (projectedAttributeCount > 100) {
                validation('In-memory indexes project more than 100 non-key attributes');
            }
            const partition = keys.find((key) => key.KeyType === 'HASH')!;
            if ((input.LocalSecondaryIndexes || []).some((index) =>
                keys.length !== 2
                || (index.KeySchema || []).length !== 2
                || !(index.KeySchema || []).some((key) =>
                    key.KeyType === 'HASH' && key.AttributeName === partition.AttributeName))) {
                validation('Local indexes require the table partition key and a sort key');
            }
            if (this.tables.has(name)) {
                throw new DynamoDBServiceException({
                    name: 'ResourceInUseException',
                    message: `Table already exists: ${name}`,
                    $fault: 'client',
                    $metadata: {}
                });
            }
            const description: TableDescription = {...input, TableStatus: 'ACTIVE'};
            this.tables.set(name, {description: description, items: new Map()});
            return {TableDescription: description};
        }
        if (command instanceof ListTablesCommand) {
            const {Limit, ExclusiveStartTableName} = command.input;
            if (Limit !== undefined && (!Number.isInteger(Limit) || Limit < 1 || Limit > 100)) validation('Invalid table page limit');
            const names = Array.from(this.tables.keys()).sort().filter(name => ExclusiveStartTableName === undefined || name > ExclusiveStartTableName);
            const page = names.slice(0, Limit ?? 100);
            return {TableNames: page, ...(page.length < names.length ? {LastEvaluatedTableName: page.at(-1)} : {})};
        }
        if (command instanceof DescribeTableCommand || command instanceof DeleteTableCommand) {
            const table = this.table(command.input.TableName);
            if (command instanceof DeleteTableCommand) {
                this.tables.delete(command.input.TableName!);
                return {TableDescription: table.description};
            }
            return {Table: {...table.description, ItemCount: table.items.size}};
        }
        if (command instanceof GetItemCommand) {
            const table = this.table(command.input.TableName);
            const item = table.items.get(
                this.key(table, QuerySerializer.parseItem(command.input.Key!), true)
            );
            return {
                ...this.metadata(command.input),
                ...(item === undefined ? {} : {Item: QuerySerializer.serialiseMap(this.project(
                    item,
                    command.input.ProjectionExpression,
                    command.input.ExpressionAttributeNames
                ))})
            };
        }
        if (command instanceof PutItemCommand) {
            return this.write('put', command.input);
        }
        if (command instanceof UpdateItemCommand) {
            return this.write('update', command.input);
        }
        if (command instanceof DeleteItemCommand) {
            return this.write('delete', command.input);
        }
        if (command instanceof QueryCommand) {
            return this.read(command.input, true);
        }
        if (command instanceof ScanCommand) {
            return this.read(command.input, false);
        }
        if (command instanceof TransactGetItemsCommand) {
            const requests = command.input.TransactItems ?? [];
            if (requests.length < 1 || requests.length > 100) validation('Transaction reads require between 1 and 100 operations');
            const targets = new Set<string>();
            const responses = requests.map(request => {
                if (!request.Get) validation('Transaction reads require Get operations');
                const table = this.table(request.Get.TableName);
                const key = this.key(table, QuerySerializer.parseItem(request.Get.Key!), true);
                const target = JSON.stringify([request.Get.TableName, key]);
                if (targets.has(target)) validation('Transaction request cannot include multiple operations on one item');
                targets.add(target);
                const item = table.items.get(key);
                const projected = item === undefined ? {} : this.project(item,
                    request.Get.ProjectionExpression, request.Get.ExpressionAttributeNames);
                return Object.keys(projected).length === 0 ? {} : {Item: QuerySerializer.serialiseMap(projected)};
            });
            return {Responses: responses, ...this.groupedMetadata(command.input, requests.map(request => request.Get!.TableName!), {})};
        }
        if (command instanceof TransactWriteItemsCommand) {
            return this.transaction(command.input);
        }
        if (command instanceof BatchWriteItemCommand) {
            const metrics: Record<string, ItemCollectionMetrics[]> = {};
            const requests = Object.values(command.input.RequestItems || {}).flat();
            if (requests.length < 1 || requests.length > 25) validation('Batch writes require between 1 and 25 operations');
            // Invalid key data rejects the request before any of its writes are applied.
            for (const [name, writes] of Object.entries(command.input.RequestItems || {})) {
                const table = this.table(name);
                const targets = new Set<string>();
                for (const write of writes) {
                    if (Number(write.PutRequest !== undefined) + Number(write.DeleteRequest !== undefined) !== 1) validation('Invalid batch write');
                    const encoded = write.PutRequest?.Item ?? write.DeleteRequest?.Key;
                    if (encoded === undefined) validation('Unsupported batch write');
                    const item: Document = QuerySerializer.parseItem(encoded);
                    const target = this.key(table, item, write.PutRequest === undefined);
                    if (targets.has(target)) validation('Batch write cannot target the same item twice');
                    targets.add(target);
                    if (write.PutRequest !== undefined) this.validateIndexKeys(table, item);
                }
            }
            for (const [name, writes] of Object.entries(command.input.RequestItems || {})) {
                for (const write of writes) {
                    if (write.PutRequest !== undefined) {
                        this.write('put', {TableName: name, Item: write.PutRequest.Item});
                    } else if (write.DeleteRequest !== undefined) {
                        this.write('delete', {TableName: name, Key: write.DeleteRequest.Key});
                    } else {
                        validation('Unsupported batch write');
                    }
                    const selector = QuerySerializer.parseItem(write.PutRequest?.Item ?? write.DeleteRequest!.Key!);
                    const metric = this.itemCollectionMetrics({TableName: name, ReturnItemCollectionMetrics: command.input.ReturnItemCollectionMetrics}, this.table(name), selector).ItemCollectionMetrics;
                    if (metric) (metrics[name] ??= []).push(metric);
                }
            }
            return {
                ...this.groupedMetadata(command.input, Object.keys(command.input.RequestItems || {}), metrics),
                UnprocessedItems: {}
            };
        }
        if (command instanceof BatchGetItemCommand) {
            const count = Object.values(command.input.RequestItems || {}).reduce((total, request) => total + (request.Keys?.length || 0), 0);
            if (count < 1 || count > 100) validation('Batch reads require between 1 and 100 keys');
            const responses: Record<string, AttributeMap[]> = {};
            for (const [name, request] of Object.entries(command.input.RequestItems || {})) {
                const table = this.table(name);
                const keys = (request.Keys || []).map(key => this.key(table, QuerySerializer.parseItem(key), true));
                if (new Set(keys).size !== keys.length) validation('Batch read cannot target the same item twice');
                responses[name] = (request.Keys || []).flatMap((key) => {
                    const item = table.items.get(
                        this.key(table, QuerySerializer.parseItem(key), true)
                    );
                    return item === undefined ? [] : [QuerySerializer.serialiseMap(this.project(
                        item,
                        request.ProjectionExpression,
                        request.ExpressionAttributeNames
                    ))];
                });
            }
            return {
                ...this.groupedMetadata(command.input, Object.keys(command.input.RequestItems || {})),
                Responses: responses,
                UnprocessedKeys: {}
            };
        }
        throw new Error(`Unsupported in-memory DynamoDB command: ${commandName}`);
    }
}

class FilePersistence implements MemoryPersistence {
    private lock?: import('node:fs/promises').FileHandle;
    constructor(private readonly path: string) {}

    async load(): Promise<MemorySnapshot | undefined> {
        const fileSystem = await nodeFileSystem();
        await fileSystem.mkdir(directoryOf(this.path), {recursive: true});
        try {
            this.lock = await fileSystem.open(`${this.path}.lock`, 'wx');
        } catch (error) {
            if ((error as {code?: string}).code === 'EEXIST') throw new Error('File engine already has a writer; close it before reopening');
            throw error;
        }
        try {
            return JSON.parse(await fileSystem.readFile(this.path, 'utf8'), reviveBinary) as MemorySnapshot;
        } catch (error) {
            if (isMissingFile(error)) {
                return undefined;
            }
            throw error;
        }
    }

    async save(snapshot: MemorySnapshot): Promise<void> {
        const fileSystem = await nodeFileSystem();
        await fileSystem.mkdir(directoryOf(this.path), {recursive: true});
        const temporaryPath = `${this.path}.tmp`;
        try {
            await fileSystem.writeFile(temporaryPath, JSON.stringify(snapshot, replaceBinary), 'utf8');
            await fileSystem.rename(temporaryPath, this.path);
        } finally {
            await fileSystem.rm(temporaryPath, {force: true}).catch(() => undefined);
        }
    }

    async close(): Promise<void> {
        if (!this.lock) return;
        const lock = this.lock;
        this.lock = undefined;
        try { await lock.close(); } finally { await (await nodeFileSystem()).rm(`${this.path}.lock`, {force: true}); }
    }
}

class IndexedDBPersistence implements MemoryPersistence {
    private database?: Promise<IDBDatabase>;
    private revision = 0;

    constructor(private readonly name: string) {}

    async load(): Promise<MemorySnapshot | undefined> {
        const database = await this.open();
        const snapshot = await this.request(database.transaction('fluentful-orm', 'readonly').objectStore('fluentful-orm').get('state'));
        this.revision = snapshot?.revision ?? 0;
        return snapshot;
    }

    async save(snapshot: MemorySnapshot): Promise<void> {
        await this.transaction(await this.open(), snapshot);
    }

    async close(): Promise<void> {
        (await this.database?.catch(() => undefined))?.close();
    }

    private open(): Promise<IDBDatabase> {
        if (this.database === undefined) {
            if (typeof indexedDB === 'undefined') {
                throw new Error('IndexedDB is not available in this environment');
            }
            this.database = new Promise((resolve, reject) => {
                const request = indexedDB.open(this.name, 1);
                let blocked = false;
                request.onupgradeneeded = () => {
                    request.result.createObjectStore('fluentful-orm');
                };
                request.onblocked = () => {
                    blocked = true;
                    reject(new Error('IndexedDB open is blocked by another connection'));
                };
                request.onsuccess = () => {
                    if (blocked) { request.result.close(); return; }
                    request.result.onversionchange = () => request.result.close();
                    resolve(request.result);
                };
                request.onerror = () => reject(request.error);
            });
        }
        return this.database;
    }

    private request(request: IDBRequest<MemorySnapshot | undefined>): Promise<MemorySnapshot | undefined> {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    private transaction(database: IDBDatabase, snapshot: MemorySnapshot): Promise<void> {
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('fluentful-orm', 'readwrite');
            const store = transaction.objectStore('fluentful-orm');
            const current = store.get('state');
            let failure: unknown;
            const revision = this.revision + 1;
            current.onsuccess = () => {
                try {
                    if ((current.result?.revision ?? 0) !== this.revision) {
                        throw new Error('IndexedDB snapshot changed in another engine; close and reopen before writing');
                    }
                    store.put({...snapshot, revision}, 'state');
                } catch (error) {
                    failure = error;
                    transaction.abort();
                }
            };
            transaction.oncomplete = () => { this.revision = revision; resolve(); };
            transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('IndexedDB transaction failed'));
            transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('IndexedDB transaction aborted'));
        });
    }
}

function replaceBinary(this: Record<string, unknown>, key: string, value: unknown): unknown {
    const original = this[key];
    return original instanceof Uint8Array ? {fluentfulBinary: Array.from(original)} : value;
}

function reviveBinary(_key: string, value: unknown): unknown {
    if (
        value !== null
        && typeof value === 'object'
        && Object.keys(value).length === 1
        && Array.isArray((value as {fluentfulBinary?: unknown}).fluentfulBinary)
    ) {
        if (!(value as {fluentfulBinary: unknown[]}).fluentfulBinary.every(byte =>
            typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            throw new Error('Invalid binary in persisted snapshot');
        }
        return new Uint8Array((value as {fluentfulBinary: number[]}).fluentfulBinary);
    }
    return value;
}

function isMissingFile(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && (error as {code?: unknown}).code === 'ENOENT';
}

function directoryOf(path: string): string {
    const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return separator < 0 ? '.' : path.slice(0, separator + 1);
}

async function nodeFileSystem(): Promise<typeof import('node:fs/promises')> {
    if (typeof process === 'undefined' || process.versions?.node === undefined) {
        throw new Error('File persistence is only available in Node.js');
    }
    return Function('specifier', 'return import(specifier)')('node:fs/promises') as Promise<typeof import('node:fs/promises')>;
}

/** Creates memory-backed DynamoDB-compatible engines for memory, browser, and file storage. */
export const createEngine = {
    memory(tables: InitialTables = []): InMemoryDynamoDB {
        return new InMemoryDynamoDB(tables);
    },
    browser(name = 'fluentful-orm', tables: InitialTables = []): InMemoryDynamoDB {
        return new InMemoryDynamoDB(tables, new IndexedDBPersistence(name));
    },
    file(path: string, tables: InitialTables = []): InMemoryDynamoDB {
        return new InMemoryDynamoDB(tables, new FilePersistence(path));
    }
};
