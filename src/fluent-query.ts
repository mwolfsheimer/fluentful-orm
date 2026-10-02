export type ComparisonValue = string | number | Uint8Array;
export type ComparisonOperator = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'contains';

/** Fluent comparison methods used by query and scan filters. */
export interface ComparisonQuery<TResult> {
    /** Matches an exact value. */
    eq(value: any): TResult;
    /** Matches values different from the supplied value. */
    ne(value: unknown): TResult;
    /** Matches values greater than the supplied value. */
    gt(value: ComparisonValue): TResult;
    /** Matches values greater than or equal to the supplied value. */
    gte(value: ComparisonValue): TResult;
    /** Matches values less than the supplied value. */
    lt(value: ComparisonValue): TResult;
    /** Matches values less than or equal to the supplied value. */
    lte(value: ComparisonValue): TResult;
    /** Matches strings or collections containing the supplied value. */
    contains(value: unknown): TResult;
    /** Matches values equal to one of the supplied values. */
    in(value: unknown[]): TResult;
}

/** Adds a negation entry point to comparison methods. */
export interface NotComparisonQuery<TResult> extends ComparisonQuery<TResult> {
    /** Negates the next comparison. */
    not(): ComparisonQuery<TResult>;
}

/** Adds an existence check to comparison methods. */
export interface ConditionalQuery<TResult> extends ComparisonQuery<TResult> {
    /** Requires the selected attribute to exist or not exist according to negation state. */
    exists(): TResult;
}

/** Adds both negation and existence checks to comparison methods. */
export interface NotConditionalQuery<TResult> extends ConditionalQuery<TResult> {
    /** Negates the next comparison or existence check. */
    not(): ConditionalQuery<TResult>;
}

type ComparisonHandler = (operator: ComparisonOperator, value: unknown, negated: boolean) => void;
type InHandler = (values: unknown[], negated: boolean) => void;

function createComparisons<TResult>(
    next: () => TResult,
    addComparison: ComparisonHandler,
    addInComparison: InHandler,
    negated: boolean
): ComparisonQuery<TResult> {
    const apply = (operator: ComparisonOperator, value: unknown, negated: boolean): TResult => {
        addComparison(operator, value, negated);
        return next();
    };

    return {
        eq: (value: any): TResult => apply('=', value, negated),
        ne: (value: unknown): TResult => apply('<>', value, negated),
        gt: (value: ComparisonValue): TResult => apply('>', value, negated),
        gte: (value: ComparisonValue): TResult => apply('>=', value, negated),
        lt: (value: ComparisonValue): TResult => apply('<', value, negated),
        lte: (value: ComparisonValue): TResult => apply('<=', value, negated),
        contains: (value: unknown): TResult => apply('contains', value, negated),
        in: (values: unknown[]): TResult => {
            addInComparison(values, negated);
            return next();
        }
    };
}

/** Creates the comparison chain used by query and scan filters. */
export function createComparisonQuery<TResult>(
    next: () => TResult,
    addComparison: ComparisonHandler,
    addInComparison: InHandler
): NotComparisonQuery<TResult> {
    return {
        ...createComparisons(next, addComparison, addInComparison, false),
        not: (): ComparisonQuery<TResult> => createComparisons(next, addComparison, addInComparison, true)
    };
}

/** Creates the comparison chain used by conditional writes and condition checks. */
export function createConditionalQuery<TResult>(
    next: () => TResult,
    addComparison: ComparisonHandler,
    addInComparison: InHandler,
    addExistsCondition: (exists: boolean) => void
): NotConditionalQuery<TResult> {
    const create = (negated: boolean): ConditionalQuery<TResult> => ({
        ...createComparisons(next, addComparison, addInComparison, negated),
        exists: (): TResult => {
            addExistsCondition(!negated);
            return next();
        }
    });

    return {
        ...create(false),
        not: (): ConditionalQuery<TResult> => create(true)
    };
}
