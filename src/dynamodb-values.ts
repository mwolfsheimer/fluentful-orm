const encoder = new TextEncoder();

/** Compares DynamoDB scalar values, independently of JavaScript binary prototypes. */
export function compareDynamoValues(left: unknown, right: unknown): number | null {
    if (typeof left === 'number' && typeof right === 'number') {
        return left < right ? -1 : left > right ? 1 : 0;
    }
    if (typeof left === 'string' && typeof right === 'string') {
        return compareDynamoValues(encoder.encode(left), encoder.encode(right));
    }
    if (left instanceof Uint8Array && right instanceof Uint8Array) {
        for (let index = 0; index < Math.min(left.length, right.length); index++) {
            if (left[index] !== right[index]) return left[index] - right[index];
        }
        return left.length - right.length;
    }
    return null;
}

/** Compares decoded DynamoDB values; list order matters, map/set order does not. */
export function equalDynamoValues(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (left instanceof Uint8Array || right instanceof Uint8Array) {
        return left instanceof Uint8Array && right instanceof Uint8Array
            && compareDynamoValues(left, right) === 0;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length
            && left.every((value, index) => equalDynamoValues(value, right[index]));
    }
    if (left instanceof Set || right instanceof Set) {
        if (!(left instanceof Set && right instanceof Set)) return false;
        const unique = (values: Set<unknown>) => Array.from(values).filter((value, index, entries) =>
            !entries.slice(0, index).some((entry) => equalDynamoValues(entry, value)));
        const a = unique(left);
        const b = unique(right);
        return a.length === b.length && a.every((value) => b.some((entry) => equalDynamoValues(value, entry)));
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) =>
        Object.prototype.hasOwnProperty.call(right, key)
        && equalDynamoValues(Reflect.get(left, key), Reflect.get(right, key)));
}

/** Validates a key operand without requiring table metadata. */
export function assertDynamoKeyValue(value: unknown, sort = false): void {
    const length = typeof value === 'string' ? encoder.encode(value).length
        : value instanceof Uint8Array ? value.length : null;
    if (length !== null ? length === 0 || length > (sort ? 1024 : 2048)
        : typeof value !== 'number' || !Number.isFinite(value)
            || (value !== 0 && (Math.abs(value) < 1e-130 || Math.abs(value) >= 1e126))) {
        throw new Error('DynamoDB key must be a non-empty string/binary or a finite DynamoDB number within key size limits');
    }
}
