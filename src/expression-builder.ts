import {QuerySerializer} from "./query-serializer";
import {UpdateExpressionType} from "./types";
import type {GenericDocument, GetSelector} from "./types";

/** Expression fields populated on an AWS DynamoDB request input. */
export interface ExpressionTarget {
    /** Compiled update expression. */
    UpdateExpression?: string;
    /** Compiled query key-condition expression. */
    KeyConditionExpression?: string;
    /** Values referenced by expression placeholders. */
    ExpressionAttributeValues?: GenericDocument<GetSelector>;
    /** Names referenced by expression placeholders. */
    ExpressionAttributeNames?: GenericDocument<string>;
    /** Compiled conditional-write expression. */
    ConditionExpression?: string;
    /** Compiled read-filter expression. */
    FilterExpression?: string;
}

/** Accumulates DynamoDB expressions and placeholder values for one operation. */
export class ExpressionBuilder {
    private updates: {type: UpdateExpressionType, name: string}[] = [];
    private attributeId = 0;
    private updateValueId = 0;
    private keyConditionExpression: string | undefined;
    private conditionExpression: string | undefined;
    private filterExpression: string | undefined;
    private attributeValues: GenericDocument<GetSelector> = {};
    private attributeNames: GenericDocument<string> = {};
    private updateValueKeys = new Map<string, string>();

    /** Adds an update action for an attribute. */
    addUpdate(type: UpdateExpressionType, name: string): void {
        this.updates.push({type: type, name: name});
    }

    /** Adds or replaces the value placeholder for an update attribute. */
    addValue(attribute: string, value: unknown): void {
        let valueKey = this.updateValueKeys.get(attribute);

        if (valueKey === undefined) {
            valueKey = attribute;
            while (this.attributeValues[`:${valueKey}`] !== undefined) {
                valueKey = `update${this.updateValueId++}`;
            }
            this.updateValueKeys.set(attribute, valueKey);
        }

        this.attributeValues[`:${valueKey}`] = QuerySerializer.serialiseItem(value);
    }

    /** Adds an update value only when that attribute has no value yet. */
    addValueIfAbsent(attribute: string, value: unknown): void {
        if (!this.updateValueKeys.has(attribute)) {
            this.addValue(attribute, value);
        }
    }

    /** Registers an attribute name for expression substitution. */
    addName(name: string): void {
        if (!this.attributeNames[`#${name}`]) {
            this.attributeNames[`#${name}`] = name;
        }
    }

    /** Adds an equality-style key condition. */
    addKeyCondition(name: string, operator: string): void {
        this.keyConditionExpression = this.append(this.keyConditionExpression, `#${name} ${operator} :${name}`);
    }

    /** Adds a comparison against a query sort key. */
    addKeyComparison(name: string, operator: string, value: unknown): void {
        const valueKey = this.addUniqueValue(value);
        this.addName(name);
        this.keyConditionExpression = this.append(this.keyConditionExpression, `#${name} ${operator} :${valueKey}`);
    }

    /** Adds an inclusive sort-key range condition. */
    addKeyBetween(name: string, lower: unknown, upper: unknown): void {
        const lowerKey = this.addUniqueValue(lower);
        const upperKey = this.addUniqueValue(upper);
        this.addName(name);
        this.keyConditionExpression = this.append(
            this.keyConditionExpression,
            `#${name} BETWEEN :${lowerKey} AND :${upperKey}`
        );
    }

    /** Adds a string or binary sort-key prefix condition. */
    addKeyBeginsWith(name: string, value: unknown): void {
        const valueKey = this.addUniqueValue(value);
        this.addName(name);
        this.keyConditionExpression = this.append(this.keyConditionExpression, `begins_with(#${name}, :${valueKey})`);
    }

    /** Adds an attribute-existence condition. */
    addExistsCondition(name: string, exists: boolean): void {
        this.addName(name);
        this.addCondition(`${exists ? 'attribute_exists' : 'attribute_not_exists'}(#${name})`);
    }

    /** Adds a scalar or collection comparison to a condition or filter. */
    addComparison(name: string, operator: string, value: unknown, negated: boolean, filter: boolean): void {
        const valueKey = this.addUniqueValue(value);
        const comparison = operator === 'contains'
            ? `contains (#${name}, :${valueKey})`
            : `#${name} ${operator} :${valueKey}`;

        this.addName(name);
        this.addExpression((negated ? 'NOT (' : '') + comparison + (negated ? ')' : ''), filter);
    }

    /** Adds an `IN` comparison to a condition or filter. */
    addInComparison(name: string, values: (string | number | Uint8Array)[], negated: boolean, filter: boolean): void {
        if (values.length === 0) {
            throw new Error(`IN comparison on ${name} requires at least one value`);
        }

        const valueKeys = values.map((value) => `:${this.addUniqueValue(value)}`);
        const comparison = `#${name} IN (${valueKeys.join(', ')})`;

        this.addName(name);
        this.addExpression((negated ? 'NOT (' : '') + comparison + (negated ? ')' : ''), filter);
    }

    /** Applies all accumulated expressions to a DynamoDB request input. */
    applyTo(target: ExpressionTarget): void {
        this.assignOrDelete(target, 'UpdateExpression', this.compileUpdateExpression());
        this.assignOrDelete(target, 'KeyConditionExpression', this.keyConditionExpression);
        this.assignOrDelete(target, 'ConditionExpression', this.conditionExpression);
        this.assignOrDelete(target, 'FilterExpression', this.filterExpression);
        this.assignOrDelete(target, 'ExpressionAttributeValues', Object.keys(this.attributeValues).length ? this.attributeValues : undefined);
        this.assignOrDelete(target, 'ExpressionAttributeNames', Object.keys(this.attributeNames).length ? this.attributeNames : undefined);
    }

    private addUniqueValue(value: unknown): string {
        let valueKey: string;

        do {
            valueKey = `condition${this.attributeId++}`;
        } while (this.attributeValues[`:${valueKey}`] !== undefined);

        this.attributeValues[`:${valueKey}`] = QuerySerializer.serialiseItem(value);
        return valueKey;
    }

    private addExpression(expression: string, filter: boolean): void {
        if (filter) {
            this.filterExpression = this.append(this.filterExpression, expression);
        } else {
            this.addCondition(expression);
        }
    }

    private addCondition(expression: string): void {
        this.conditionExpression = this.append(this.conditionExpression, expression);
    }

    private append(current: string | undefined, expression: string): string {
        return (current ? current + ' AND ' : '') + expression;
    }

    private compileUpdateExpression(): string | undefined {
        if (!this.updates.length) {
            return undefined;
        }

        // The last action per attribute wins; values from losing value-bearing actions are dropped.
        const winners = new Map<string, UpdateExpressionType>();

        for (const update of this.updates) {
            winners.set(update.name, update.type);
        }

        const groups = new Map<UpdateExpressionType, string[]>();

        winners.forEach((type, name) => {
            const valueKey = this.updateValueKeys.get(name) || name;

            if (type === UpdateExpressionType.REMOVE) {
                delete this.attributeValues[`:${valueKey}`];
            }

            const clause = type === UpdateExpressionType.SET
                ? `#${name} = :${valueKey}`
                : type === UpdateExpressionType.REMOVE
                    ? `#${name}`
                    : `#${name} :${valueKey}`;
            const group = groups.get(type);

            if (group) {
                group.push(clause);
            } else {
                groups.set(type, [clause]);
            }
        });

        return Array.from(groups.entries())
            .map(([type, clauses]) => `${type} ${clauses.join(', ')}`)
            .join(' ');
    }

    private assignOrDelete<TKey extends keyof ExpressionTarget>(target: ExpressionTarget, key: TKey, value: ExpressionTarget[TKey]): void {
        if (value === undefined) {
            delete target[key];
        } else {
            target[key] = value;
        }
    }
}
