import type {AttributeValue, BatchGetItemCommandInput, BatchWriteItemCommandInput} from "@aws-sdk/client-dynamodb";
import type {ExpressionBuilder, ExpressionTarget} from "./expression-builder";
import type {QueryOperation} from "./query-operation";
import type {IndexKind, ReturnConsumedCapacity} from "./types";

type AttributeMap = Record<string, AttributeValue>;
type BatchGetRequestItems = NonNullable<BatchGetItemCommandInput['RequestItems']>;
type BatchWriteRequestItems = NonNullable<BatchWriteItemCommandInput['RequestItems']>;

/** Tracks the DynamoDB operation and request modifiers assembled by QueryBuilder. */
export class QueryRequestState {
    private operation: QueryOperation | null = null;
    private conditionFailureReturnValues: 'ALL_OLD' | 'NONE' | null = null;
    private indexKind: IndexKind | null = null;

    /** Sets the payload returned when a conditional write fails. */
    setReturnValuesOnConditionCheckFailure(value: 'ALL_OLD' | 'NONE'): void {
        if (value !== 'ALL_OLD' && value !== 'NONE') {
            throw new Error('Invalid condition failure return values');
        }
        this.conditionFailureReturnValues = value;
    }

    /** Starts a PutItem operation. */
    startPut(tableName: string, item: AttributeMap): void {
        this.operation = {
            kind: 'putItem',
            input: {ReturnConsumedCapacity: 'INDEXES', TableName: tableName, Item: item}
        };
    }

    /** Configures the capacity metadata requested from DynamoDB. */
    setReturnConsumedCapacity(value: ReturnConsumedCapacity): void {
        if (this.operation === null || this.operation.kind === 'conditionCheck') {
            throw new Error('Consumed capacity requires an executable DynamoDB operation');
        }
        this.operation.input.ReturnConsumedCapacity = value;
    }

    /** Requests approximate item-collection size estimates for a write operation. */
    setReturnItemCollectionMetrics(value: 'NONE' | 'SIZE'): void {
        if (this.operation === null || (this.operation.kind !== 'putItem' && this.operation.kind !== 'updateItem'
            && this.operation.kind !== 'deleteItem' && this.operation.kind !== 'batchWriteItem')) {
            throw new Error('Item collection metrics require a write operation');
        }
        this.operation.input.ReturnItemCollectionMetrics = value;
    }

    /** Starts a BatchWriteItem operation. */
    startBatchWrite(requestItems: BatchWriteRequestItems): void {
        this.operation = {
            kind: 'batchWriteItem',
            input: {ReturnConsumedCapacity: 'INDEXES', RequestItems: requestItems}
        };
    }

    /** Starts a DeleteItem operation. */
    startDelete(tableName: string, key: AttributeMap): void {
        this.operation = {
            kind: 'deleteItem',
            input: {ReturnConsumedCapacity: 'INDEXES', TableName: tableName, ReturnValues: 'ALL_OLD', Key: key}
        };
    }

    /** Starts a condition-check operation. */
    startConditionCheck(tableName: string, key: AttributeMap): void {
        this.operation = {
            kind: 'conditionCheck',
            input: {TableName: tableName, Key: key}
        };
    }

    /** Starts an UpdateItem operation. */
    startUpdate(tableName: string, key: AttributeMap): void {
        this.operation = {
            kind: 'updateItem',
            input: {ReturnConsumedCapacity: 'INDEXES', TableName: tableName, ReturnValues: 'ALL_NEW', Key: key}
        };
    }

    /** Starts a GetItem operation. */
    startGet(tableName: string, key: AttributeMap, consistentRead: boolean): void {
        this.operation = {
            kind: 'getItem',
            input: {ReturnConsumedCapacity: 'INDEXES', TableName: tableName, Key: key, ConsistentRead: consistentRead}
        };
    }

    /** Starts a BatchGetItem operation. */
    startBatchGet(requestItems: BatchGetRequestItems): void {
        this.operation = {
            kind: 'batchGetItem',
            input: {ReturnConsumedCapacity: 'INDEXES', RequestItems: requestItems}
        };
    }

    /** Starts a Scan operation. */
    startScan(tableName: string, consistentRead: boolean): void {
        this.operation = {
            kind: 'scan',
            input: {ReturnConsumedCapacity: 'INDEXES', TableName: tableName, ConsistentRead: consistentRead}
        };
    }

    /** Starts a Query operation. */
    startQuery(tableName: string, consistentRead: boolean): void {
        this.operation = {
            kind: 'query',
            input: {
                ReturnConsumedCapacity: 'INDEXES',
                TableName: tableName,
                ScanIndexForward: true,
                ConsistentRead: consistentRead
            }
        };
    }

    /** Reports whether a primary-key field is already configured. */
    hasKey(name: string): boolean {
        if (this.operation === null || (this.operation.kind !== 'updateItem' && this.operation.kind !== 'getItem' && this.operation.kind !== 'deleteItem' && this.operation.kind !== 'conditionCheck')) {
            return false;
        }

        return this.operation.input.Key !== undefined && this.operation.input.Key[name] !== undefined;
    }

    /** Selects a secondary index and validates global-index consistency rules. */
    setIndex(indexName: string, kind: IndexKind): void {
        if (this.operation !== null && this.operation.kind === 'query') {
            if (kind === 'global' && this.operation.input.ConsistentRead === true) {
                throw new Error(`Global secondary index ${indexName} does not support consistent reads`);
            }
            this.operation.input.IndexName = indexName;
            this.indexKind = kind;
        }
    }

    /** Requests strongly consistent reads where DynamoDB supports them. */
    setConsistentRead(): void {
        if (this.operation === null || (this.operation.kind !== 'getItem' && this.operation.kind !== 'query' && this.operation.kind !== 'scan')) {
            throw new Error('Consistent reads require a get, query, or scan operation');
        }
        if (this.operation.kind === 'query' && this.indexKind === 'global') {
            throw new Error(`Global secondary index ${this.operation.input.IndexName} does not support consistent reads`);
        }
        this.operation.input.ConsistentRead = true;
    }

    /** Changes query sort-key traversal direction. */
    setScanIndexForward(value: boolean): void {
        if (this.operation === null || this.operation.kind !== 'query') {
            throw new Error('Query ordering requires a query operation');
        }
        this.operation.input.ScanIndexForward = value;
    }

    /** Configures one segment of a DynamoDB parallel scan. */
    setParallelScan(segment: number, totalSegments: number): void {
        if (this.operation === null || this.operation.kind !== 'scan') {
            throw new Error('Parallel scans require a scan operation');
        }
        if (!Number.isInteger(totalSegments) || totalSegments < 1 || !Number.isInteger(segment) || segment < 0 || segment >= totalSegments) {
            throw new Error('Parallel scan segment must be a non-negative integer less than totalSegments');
        }
        this.operation.input.Segment = segment;
        this.operation.input.TotalSegments = totalSegments;
    }

    /** Sets the DynamoDB page size for a query or scan. */
    setLimit(limit: number): void {
        if (this.operation !== null && (this.operation.kind === 'query' || this.operation.kind === 'scan')) {
            this.operation.input.Limit = limit;
        }
    }

    /** Sets the projected attributes for a query or scan. */
    setProjection(attributes: string[]): void {
        if (this.operation !== null && (this.operation.kind === 'query' || this.operation.kind === 'scan' || this.operation.kind === 'getItem')) {
            this.operation.input.ProjectionExpression = attributes.map((attribute) => `#${attribute}`).join(', ');
        }
    }

    /** Changes a query or scan to return only a count. */
    setCount(): void {
        if (this.operation !== null && (this.operation.kind === 'query' || this.operation.kind === 'scan')) {
            this.operation.input.Select = 'COUNT';
        }
    }

    /** Sets the successful return payload mode for an update. */
    setUpdateReturnValues(value: 'ALL_NEW' | 'ALL_OLD' | 'NONE'): void {
        if (this.operation === null || this.operation.kind !== 'updateItem') {
            throw new Error('Update return values require an update operation');
        }
        this.operation.input.ReturnValues = value;
    }

    /** Sets the successful return payload mode for a put. */
    setPutReturnValues(value: 'ALL_OLD' | 'NONE'): void {
        if (this.operation === null || this.operation.kind !== 'putItem') {
            throw new Error('Put return values require a create operation');
        }
        this.operation.input.ReturnValues = value;
    }

    /** Sets the successful return payload mode for a delete. */
    setDeleteReturnValues(value: 'ALL_OLD' | 'NONE'): void {
        if (this.operation === null || this.operation.kind !== 'deleteItem') {
            throw new Error('Delete return values require a delete operation');
        }
        this.operation.input.ReturnValues = value;
    }

    /** Applies accumulated expressions to the current operation. */
    applyExpressions(expressions: ExpressionBuilder): void {
        if (this.operation !== null) {
            expressions.applyTo(this.operation.input as ExpressionTarget);
        }
    }

    /** Returns the assembled operation, validating incompatible modifiers. */
    getOperation(): QueryOperation | null {
        if (this.conditionFailureReturnValues !== null && this.operation !== null) {
            if (this.operation.kind !== 'putItem' && this.operation.kind !== 'updateItem'
                && this.operation.kind !== 'deleteItem' && this.operation.kind !== 'conditionCheck') {
                throw new Error('Condition failure return values require a single-item write');
            }
            this.operation.input.ReturnValuesOnConditionCheckFailure = this.conditionFailureReturnValues;
        }
        return this.operation;
    }
}