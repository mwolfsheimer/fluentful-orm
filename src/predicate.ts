import {isAttributeReference, path, pathSegments} from './document-path';
import type {AttributePath, AttributeReference} from './document-path';
import {QuerySerializer} from './query-serializer';
import {ValueUtils} from './value-utils';

/** Stored DynamoDB types for expressions, separate from key-definition types. */
export type ExpressionAttributeType = 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'M' | 'L' | 'SS' | 'NS' | 'BS';
export type OrderedOperand = string | number | Uint8Array | AttributeReference;
export type Predicate =
    | {kind: 'group'; operator: 'AND' | 'OR' | 'NOT'; children: readonly Predicate[]}
    | {kind: 'comparison' | 'function' | 'in' | 'between'; attribute: AttributePath; operator: string; values: readonly unknown[]; negated: boolean; size: boolean};

export interface SizeComparison<TResult> {
    eq(value: number): TResult;
    ne(value: number): TResult;
    gt(value: number): TResult;
    gte(value: number): TResult;
    lt(value: number): TResult;
    lte(value: number): TResult;
    between(lower: number, upper: number): TResult;
    in(values: number[]): TResult;
    not(): SizeComparison<TResult>;
}

export interface PredicateComparison<TResult> {
    eq(value: unknown): TResult;
    ne(value: unknown): TResult;
    gt(value: OrderedOperand): TResult;
    gte(value: OrderedOperand): TResult;
    lt(value: OrderedOperand): TResult;
    lte(value: OrderedOperand): TResult;
    contains(value: unknown): TResult;
    in(values: unknown[]): TResult;
    between(lower: OrderedOperand, upper: OrderedOperand): TResult;
    beginsWith(value: string | Uint8Array): TResult;
    exists(): TResult;
    attributeType(type: ExpressionAttributeType): TResult;
    size(): SizeComparison<TResult>;
    not(): PredicateComparison<TResult>;
}

export interface PredicateGroups<TResult> {
    whereAny(callback: PredicateCallback): TResult;
    whereAll(callback: PredicateCallback): TResult;
    whereNot(callback: PredicateCallback): TResult;
}

export interface PredicateScope extends PredicateGroups<PredicateScope> {
    where(attribute: AttributePath): PredicateComparison<PredicateScope>;
}
export type PredicateCallback = (group: PredicateScope) => PredicateScope | void;

export function validatePredicate(predicate: Predicate): void {
    if (predicate.kind === 'group') {
        if (predicate.children.length === 0) throw new Error('Predicate groups must not be empty');
        predicate.children.forEach(validatePredicate);
        return;
    }
    pathSegments(predicate.attribute);
    if (predicate.kind === 'in' && (predicate.values.length === 0 || predicate.values.length > 100)) {
        throw new Error(`IN comparison on ${pathSegments(predicate.attribute).join('.')} ${predicate.values.length === 0 ? 'requires at least one value' : 'supports at most 100 values'}`);
    }
    for (const value of predicate.values) {
        if (predicate.size && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Size thresholds must be finite numbers');
        if (isAttributeReference(value)) {
            if (predicate.kind === 'function') throw new Error('Function arguments do not support stored references');
            path(...value.segments);
            if (JSON.stringify(value.segments) === JSON.stringify(pathSegments(predicate.attribute))) {
                throw new Error('The first operand must be distinct from the remaining stored operands');
            }
        } else {
            QuerySerializer.serialiseItem(value);
        }
    }
    if (predicate.operator === 'begins_with' && typeof predicate.values[0] !== 'string' && !(predicate.values[0] instanceof Uint8Array)) {
        throw new Error('Prefix requires a string or binary value');
    }
    if (predicate.operator === 'attribute_type' && !['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS'].includes(predicate.values[0] as string)) {
        throw new Error('Invalid expression attribute type');
    }
}

export function predicateComparison<TResult>(attribute: AttributePath, add: (predicate: Predicate) => void, next: () => TResult): PredicateComparison<TResult> {
    pathSegments(attribute);
    const create = (negated: boolean, size = false): PredicateComparison<TResult> => {
        const apply = (kind: Exclude<Predicate['kind'], 'group'>, operator: string, values: unknown[]): TResult => {
            const predicate: Predicate = {kind, attribute, operator, values: ValueUtils.clone(values), negated, size};
            validatePredicate(predicate);
            add(predicate);
            return next();
        };
        const comparisons: PredicateComparison<TResult> = {
            eq: value => apply('comparison', '=', [value]),
            ne: value => apply('comparison', '<>', [value]),
            gt: value => apply('comparison', '>', [value]),
            gte: value => apply('comparison', '>=', [value]),
            lt: value => apply('comparison', '<', [value]),
            lte: value => apply('comparison', '<=', [value]),
            contains: value => apply('function', 'contains', [value]),
            in: values => apply('in', 'IN', values),
            between: (lower, upper) => apply('between', 'BETWEEN', [lower, upper]),
            beginsWith: value => apply('function', 'begins_with', [value]),
            exists: () => apply('function', 'attribute_exists', []),
            attributeType: type => apply('function', 'attribute_type', [type]),
            size: () => create(negated, true) as SizeComparison<TResult>,
            not: () => create(!negated, size)
        };
        return size ? Object.fromEntries(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not']
            .map(method => [method, comparisons[method as keyof PredicateComparison<TResult>]])) as unknown as PredicateComparison<TResult> : comparisons;
    };
    return create(false);
}

export function collectPredicates(operator: 'AND' | 'OR' | 'NOT', callback: PredicateCallback): Predicate {
    const children: Predicate[] = [];
    let pending = 0;
    let active = true;
    const assertActive = () => { if (!active) throw new Error('Predicate callback scope has closed'); };
    const group = (nested: 'AND' | 'OR' | 'NOT', callback: PredicateCallback): PredicateScope => {
        assertActive();
        children.push(collectPredicates(nested, callback));
        return scope;
    };
    const scope: PredicateScope = {
        where: attribute => {
            assertActive();
            pending++;
            let completed = false;
            return predicateComparison(attribute, predicate => {
                assertActive();
                if (completed) throw new Error('A predicate subchain can only be completed once');
                children.push(predicate);
                completed = true;
                pending--;
            }, () => scope);
        },
        whereAny: callback => group('OR', callback),
        whereAll: callback => group('AND', callback),
        whereNot: callback => group('NOT', callback)
    };
    try {
        const result = callback(scope);
        if (result && typeof (result as unknown as {then?: unknown}).then === 'function') {
            Promise.resolve(result).catch(() => undefined);
            throw new Error('Predicate callbacks must be synchronous');
        }
        if (pending !== 0) throw new Error('Predicate callback contains an incomplete comparison');
        const predicate: Predicate = {kind: 'group', operator, children};
        validatePredicate(predicate);
        return predicate;
    } finally {
        active = false;
    }
}