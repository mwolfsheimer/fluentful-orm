import {isAttributeReference, path} from './document-path';
import type {AttributePath, AttributeReference} from './document-path';
import {QuerySerializer} from './query-serializer';
import {ValueUtils} from './value-utils';

const updateBrand = Symbol('updateExpression');
export interface UpdateExpression<T = unknown> {
    readonly [updateBrand]: true;
    readonly kind: 'literal' | 'if_not_exists' | 'list_append' | '+' | '-';
    readonly operands: readonly unknown[];
    readonly valueType?: T;
}
export type SetOperand<T = unknown> = AttributeReference<T> | UpdateExpression<T>;

function expression<T>(kind: UpdateExpression['kind'], operands: readonly unknown[]): UpdateExpression<T> {
    const snapshot = (value: unknown): unknown => isUpdateExpression(value) ? value : ValueUtils.clone(value);
    const stored = operands.map(snapshot);
    return Object.freeze({[updateBrand]: true as const, kind,
        get operands() { return Object.freeze(stored.map(snapshot)); }});
}

export function literal<T>(value: T): UpdateExpression<T> {
    QuerySerializer.serialiseItem(value);
    return expression('literal', [value]);
}

export function ifNotExists<T>(field: AttributeReference<T>, fallback: NoInfer<T> | SetOperand<NoInfer<T>>): UpdateExpression<T> {
    if (!isAttributeReference(field)) throw new Error('ifNotExists requires a stored attribute reference');
    return expression('if_not_exists', [field, fallback]);
}

export function listAppend<T>(left: readonly T[] | SetOperand<readonly T[]>, right: readonly T[] | SetOperand<readonly T[]>): UpdateExpression<T[]> {
    return expression('list_append', [left, right]);
}

export function plus(left: number | SetOperand<number>, right: number | SetOperand<number>): UpdateExpression<number> {
    return expression('+', [left, right]);
}

export function minus(left: number | SetOperand<number>, right: number | SetOperand<number>): UpdateExpression<number> {
    return expression('-', [left, right]);
}

export function isUpdateExpression(value: unknown): value is UpdateExpression {
    return value !== null && typeof value === 'object' && (value as UpdateExpression)[updateBrand] === true;
}

function assertOperandType(value: unknown, expected: 'number' | 'list'): void {
    if (isAttributeReference(value)) return;
    if (isUpdateExpression(value)) {
        const operands = value.operands;
        if (value.kind === 'literal') {
            const data = operands[0];
            if (expected === 'number' ? typeof data === 'number' && Number.isFinite(data) : Array.isArray(data)) return;
            throw new Error(expected === 'number' ? 'SET arithmetic requires numeric operands' : 'listAppend requires list operands');
        }
        if (value.kind === 'if_not_exists') return assertOperandType(operands[1], expected);
        if (expected === 'number' ? value.kind === '+' || value.kind === '-' : value.kind === 'list_append') return;
    } else if (expected === 'number' ? typeof value === 'number' && Number.isFinite(value) : Array.isArray(value)) return;
    throw new Error(expected === 'number' ? 'SET arithmetic requires numeric operands' : 'listAppend requires list operands');
}

export function compileSetOperand(value: unknown, name: (attribute: AttributePath) => string,
    literalValue: (value: unknown) => string, arithmetic = true): string {
    if (isAttributeReference(value)) return name(path(...value.segments));
    if (!isUpdateExpression(value)) return literalValue(value);
    const operands = value.operands;
    if (value.kind === 'literal') return literalValue(operands[0]);
    if (value.kind === '+' || value.kind === '-') {
        if (!arithmetic) throw new Error('Nested arithmetic is not supported by SET');
        operands.forEach(operand => assertOperandType(operand, 'number'));
        return operands.map(operand => compileSetOperand(operand, name, literalValue, false)).join(` ${value.kind} `);
    }
    if (value.kind === 'list_append') {
        operands.forEach(operand => assertOperandType(operand, 'list'));
    }
    return `${value.kind}(${operands.map(operand => compileSetOperand(operand, name, literalValue, false)).join(', ')})`;
}