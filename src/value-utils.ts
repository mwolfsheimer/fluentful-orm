type ObjectKey = string | symbol;
type BufferLike = ArrayBuffer | SharedArrayBuffer;

function enumerableKeys(value: object): ObjectKey[] {
    return [
        ...Object.keys(value),
        ...Object.getOwnPropertySymbols(value).filter((key) => {
            return Object.prototype.propertyIsEnumerable.call(value, key);
        })
    ];
}

function isArrayIndex(key: ObjectKey): boolean {
    if (typeof key !== 'string') {
        return false;
    }

    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key;
}

function objectTag(value: object): string {
    return Object.prototype.toString.call(value);
}

function isSharedArrayBuffer(value: object): value is SharedArrayBuffer {
    return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function cloneEnumerableProperties(
    source: object,
    target: object,
    seen: WeakMap<object, unknown>,
    skip: (key: ObjectKey) => boolean = () => false
): void {
    for (const key of enumerableKeys(source)) {
        if (skip(key)) {
            continue;
        }

        const value = cloneValue(Reflect.get(source, key), seen);
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            value: value,
            writable: true
        });
    }
}

function cloneError<Value extends Error>(value: Value, seen: WeakMap<object, unknown>): Value {
    const result = new Error(value.message);
    Object.setPrototypeOf(result, Object.getPrototypeOf(value));
    seen.set(value, result);

    if (Object.prototype.hasOwnProperty.call(value, 'cause')) {
        Object.defineProperty(result, 'cause', {
            configurable: true,
            enumerable: false,
            value: cloneValue((value as Error & {cause?: unknown}).cause, seen),
            writable: true
        });
    }

    cloneEnumerableProperties(value, result, seen);
    return result as Value;
}

function cloneTypedArray<Value extends ArrayBufferView>(value: Value, seen: WeakMap<object, unknown>): Value {
    const source = value as unknown as object;
    const buffer = cloneValue(value.buffer as BufferLike, seen) as BufferLike;
    const constructor = (value as unknown as {
        constructor: {
            new(buffer: BufferLike, byteOffset: number, length: number): Value;
            from?: (...args: unknown[]) => Value;
            name?: string;
        };
    }).constructor;
    let result: Value;

    if (constructor.name === 'Buffer' && typeof constructor.from === 'function') {
        result = constructor.from(buffer, value.byteOffset, value.byteLength);
    } else {
        result = new constructor(buffer, value.byteOffset, (value as unknown as {length: number}).length);
    }

    seen.set(source, result);
    cloneEnumerableProperties(value, result, seen, isArrayIndex);
    return result;
}

function cloneValue<Value>(value: Value, seen: WeakMap<object, unknown>): Value {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return value;
    }

    const source = value as unknown as object;
    const existing = seen.get(source);
    if (existing !== undefined) {
        return existing as Value;
    }

    if (value instanceof Date) {
        const result = new Date(value.getTime());
        seen.set(source, result);
        cloneEnumerableProperties(value, result, seen);
        return result as Value;
    }

    if (value instanceof RegExp) {
        const result = new RegExp(value.source, value.flags);
        result.lastIndex = value.lastIndex;
        seen.set(source, result);
        cloneEnumerableProperties(value, result, seen);
        return result as Value;
    }

    if (value instanceof Error) {
        return cloneError(value, seen);
    }

    if (value instanceof ArrayBuffer || isSharedArrayBuffer(value)) {
        const result = value.slice(0) as BufferLike;
        seen.set(source, result);
        cloneEnumerableProperties(value, result, seen);
        return result as Value;
    }

    if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
            const buffer = cloneValue(value.buffer as BufferLike, seen) as BufferLike;
            const result = new DataView(buffer, value.byteOffset, value.byteLength);
            seen.set(source, result);
            cloneEnumerableProperties(value, result, seen);
            return result as Value;
        }
        return cloneTypedArray(value, seen) as Value;
    }

    if (Array.isArray(value)) {
        const result: unknown[] = new Array(value.length);
        seen.set(source, result);
        for (let index = 0; index < value.length; index++) {
            if (Object.prototype.hasOwnProperty.call(value, index)) {
                result[index] = cloneValue(value[index], seen);
            }
        }
        cloneEnumerableProperties(value, result, seen, isArrayIndex);
        return result as Value;
    }

    if (value instanceof Set) {
        const result = new Set<unknown>();
        seen.set(source, result);
        value.forEach((entry) => result.add(cloneValue(entry, seen)));
        cloneEnumerableProperties(value, result, seen);
        return result as Value;
    }

    if (value instanceof Map) {
        const result = new Map<unknown, unknown>();
        seen.set(source, result);
        value.forEach((entry, key) => {
            result.set(cloneValue(key, seen), cloneValue(entry, seen));
        });
        cloneEnumerableProperties(value, result, seen);
        return result as Value;
    }

    const tag = objectTag(source);
    if (tag !== '[object Object]') {
        throw new TypeError(`Cannot clone unsupported object type: ${tag}`);
    }

    const result = Object.create(Object.getPrototypeOf(value)) as object;
    seen.set(source, result);
    cloneEnumerableProperties(value, result, seen);
    return result as Value;
}

class ActivePairs {
    private leftToRight = new Map<object, Set<object>>();
    private rightToLeft = new Map<object, Set<object>>();

    status(left: object, right: object): 'active' | 'conflict' | 'new' {
        const rights = this.leftToRight.get(left);
        if (rights !== undefined && rights.has(right)) {
            return 'active';
        }
        if ((rights !== undefined && rights.size > 0) || this.rightToLeft.has(right)) {
            return 'conflict';
        }
        return 'new';
    }

    add(left: object, right: object): void {
        let rights = this.leftToRight.get(left);
        if (rights === undefined) {
            rights = new Set<object>();
            this.leftToRight.set(left, rights);
        }
        rights.add(right);

        let lefts = this.rightToLeft.get(right);
        if (lefts === undefined) {
            lefts = new Set<object>();
            this.rightToLeft.set(right, lefts);
        }
        lefts.add(left);
    }

    remove(left: object, right: object): void {
        const rights = this.leftToRight.get(left);
        if (rights === undefined) {
            return;
        }
        rights.delete(right);
        if (rights.size === 0) {
            this.leftToRight.delete(left);
        }

        const lefts = this.rightToLeft.get(right);
        if (lefts === undefined) {
            return;
        }
        lefts.delete(left);
        if (lefts.size === 0) {
            this.rightToLeft.delete(right);
        }
    }
}

function equalsEnumerableProperties(left: object, right: object, pairs: ActivePairs, skip: (key: ObjectKey) => boolean = () => false): boolean {
    const leftKeys = enumerableKeys(left).filter((key) => !skip(key));
    const rightKeys = enumerableKeys(right).filter((key) => !skip(key));
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    for (const key of leftKeys) {
        if (!rightKeys.some((rightKey) => rightKey === key)
            || !equalsValue(Reflect.get(left, key), Reflect.get(right, key), pairs)) {
            return false;
        }
    }
    return true;
}

function equalsUnordered<Value>(
    left: readonly Value[],
    right: readonly Value[],
    pairs: ActivePairs,
    compare: (left: Value, right: Value, pairs: ActivePairs) => boolean
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    const matched = new Set<number>();
    for (const leftValue of left) {
        let found = false;
        for (let index = 0; index < right.length; index++) {
            if (matched.has(index)) {
                continue;
            }
            if (compare(leftValue, right[index], pairs)) {
                matched.add(index);
                found = true;
                break;
            }
        }
        if (!found) {
            return false;
        }
    }
    return true;
}

function equalsBytes(left: ArrayBufferLike, right: ArrayBufferLike): boolean {
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    if (leftBytes.length !== rightBytes.length) {
        return false;
    }
    return leftBytes.every((value, index) => value === rightBytes[index]);
}

function isBoxedPrimitive(value: object): boolean {
    return ['[object Boolean]', '[object BigInt]', '[object Number]', '[object String]', '[object Symbol]']
        .includes(objectTag(value));
}

function equalsValue(left: unknown, right: unknown, pairs: ActivePairs): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }

    const leftObject = left as object;
    const rightObject = right as object;
    const pairStatus = pairs.status(leftObject, rightObject);
    if (pairStatus === 'active') {
        return true;
    }
    if (pairStatus === 'conflict') {
        return false;
    }
    pairs.add(leftObject, rightObject);

    try {
        if (left instanceof Uint8Array || right instanceof Uint8Array) {
            if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)
                || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
                || left.length !== right.length
                || !left.every((value, index) => value === right[index])) {
                return false;
            }
            return equalsEnumerableProperties(left, right, pairs, isArrayIndex);
        }

        if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
            if (!(ArrayBuffer.isView(left) && ArrayBuffer.isView(right))
                || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
                return false;
            }
            if (left instanceof DataView && right instanceof DataView) {
                return left.byteLength === right.byteLength
                    && equalsBytes(left.buffer.slice(left.byteOffset, left.byteOffset + left.byteLength), right.buffer.slice(right.byteOffset, right.byteOffset + right.byteLength))
                    && equalsEnumerableProperties(left, right, pairs);
            }
            if (left instanceof DataView || right instanceof DataView) {
                return false;
            }
            const leftTyped = left as unknown as {length: number; [index: number]: unknown};
            const rightTyped = right as unknown as {length: number; [index: number]: unknown};
            return leftTyped.length === rightTyped.length
                && Array.from({length: leftTyped.length}, (_, index) => index)
                    .every((index) => Object.is(leftTyped[index], rightTyped[index]))
                && equalsEnumerableProperties(left, right, pairs, isArrayIndex);
        }

        if (left instanceof ArrayBuffer || isSharedArrayBuffer(left)
            || right instanceof ArrayBuffer || isSharedArrayBuffer(right)) {
            return (left instanceof ArrayBuffer) === (right instanceof ArrayBuffer)
                && isSharedArrayBuffer(left) === isSharedArrayBuffer(right)
                && equalsBytes(left as ArrayBufferLike, right as ArrayBufferLike)
                && equalsEnumerableProperties(left, right, pairs);
        }

        if (left instanceof Date || right instanceof Date) {
            return left instanceof Date
                && right instanceof Date
                && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)
                && Object.is(left.getTime(), right.getTime())
                && equalsEnumerableProperties(left, right, pairs);
        }

        if (left instanceof RegExp || right instanceof RegExp) {
            return left instanceof RegExp
                && right instanceof RegExp
                && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)
                && left.source === right.source
                && left.flags === right.flags
                && left.lastIndex === right.lastIndex
                && equalsEnumerableProperties(left, right, pairs);
        }

        if (left instanceof Error || right instanceof Error) {
            if (!(left instanceof Error) || !(right instanceof Error)
                || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
                || left.name !== right.name
                || left.message !== right.message) {
                return false;
            }
            const leftHasCause = Object.prototype.hasOwnProperty.call(left, 'cause');
            const rightHasCause = Object.prototype.hasOwnProperty.call(right, 'cause');
            return leftHasCause === rightHasCause
                && (!leftHasCause || equalsValue((left as Error & {cause?: unknown}).cause, (right as Error & {cause?: unknown}).cause, pairs))
                && equalsEnumerableProperties(left, right, pairs);
        }

        if (isBoxedPrimitive(left) || isBoxedPrimitive(right)) {
            return isBoxedPrimitive(left)
                && isBoxedPrimitive(right)
                && objectTag(left) === objectTag(right)
                && Object.is(left.valueOf(), right.valueOf())
                && equalsEnumerableProperties(left, right, pairs);
        }

        if (left instanceof Set || right instanceof Set) {
            return left instanceof Set
                && right instanceof Set
                && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)
                && equalsUnordered(Array.from(left), Array.from(right), pairs, (a, b, state) => {
                    return equalsValue(a, b, state);
                })
                && equalsEnumerableProperties(left, right, pairs);
        }

        if (left instanceof Map || right instanceof Map) {
            if (!(left instanceof Map) || !(right instanceof Map)
                || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
                || left.size !== right.size) {
                return false;
            }

            const leftEntries = Array.from(left.entries());
            const rightEntries = Array.from(right.entries());
            const matched = new Set<number>();
            for (const [leftKey, leftValue] of leftEntries) {
                let found = false;
                for (let index = 0; index < rightEntries.length; index++) {
                    if (matched.has(index)) {
                        continue;
                    }
                    const [rightKey, rightValue] = rightEntries[index];
                    if (equalsValue(leftKey, rightKey, pairs) && equalsValue(leftValue, rightValue, pairs)) {
                        matched.add(index);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    return false;
                }
            }
            return equalsEnumerableProperties(left, right, pairs);
        }

        if (Array.isArray(left) || Array.isArray(right)) {
            if (!Array.isArray(left) || !Array.isArray(right)
                || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)
                || left.length !== right.length) {
                return false;
            }
            for (let index = 0; index < left.length; index++) {
                const leftHasValue = Object.prototype.hasOwnProperty.call(left, index);
                const rightHasValue = Object.prototype.hasOwnProperty.call(right, index);
                if (leftHasValue !== rightHasValue || (leftHasValue && !equalsValue(left[index], right[index], pairs))) {
                    return false;
                }
            }
            return equalsEnumerableProperties(left, right, pairs, isArrayIndex);
        }

        if (objectTag(left) !== '[object Object]' || objectTag(right) !== '[object Object]'
            || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) {
            return false;
        }
        return equalsEnumerableProperties(left, right, pairs);
    } finally {
        pairs.remove(leftObject, rightObject);
    }
}

/** Platform-neutral deep value operations used by QueryBuilder backends. */
export class ValueUtils {
    /** Creates an independent deep copy of supported JavaScript values. */
    static clone<Value>(value: Value): Value {
        return cloneValue(value, new WeakMap());
    }

    /** Compares supported JavaScript values using strict deep semantics. */
    static equals(left: unknown, right: unknown): boolean {
        return equalsValue(left, right, new ActivePairs());
    }

    /** Returns true when two supported JavaScript values differ. */
    static diff(left: unknown, right: unknown): boolean {
        return !this.equals(left, right);
    }
}