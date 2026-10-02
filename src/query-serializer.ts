import type {GenericDocument, GetListSelector, GetSelector, SerialisedMap} from "./types";
import {ValueUtils} from './value-utils';

/** Converts between JavaScript documents and DynamoDB AttributeValue maps. */
export class QuerySerializer {
    private static number(value: number): string {
        if (!Number.isFinite(value)) throw new Error(`Cannot serialise non-finite number: ${value}`);
        if (value !== 0 && (Math.abs(value) < 1e-130 || Math.abs(value) >= 1e126)) {
            throw new Error('Number is outside the DynamoDB range');
        }
        return value.toString();
    }

    private static parseNumber(value: unknown): number {
        if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
            throw new Error('Invalid DynamoDB number');
        }
        const normalize = (text: string): string => {
            const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
            const fraction = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
            let digits = mantissa.replace(/^[+-]/, '').replace('.', '').replace(/^0+/, '');
            if (digits.length === 0) return '0';
            const trimmed = digits.replace(/0+$/, '');
            const scale = BigInt(exponent) - BigInt(fraction) + BigInt(digits.length - trimmed.length);
            return `${mantissa.startsWith('-') ? '-' : ''}${trimmed}e${scale}`;
        };
        const parsed = Number(value);
        const encoded = this.number(parsed);
        if (normalize(value) !== normalize(encoded)) throw new Error('DynamoDB number cannot be represented losslessly as a JavaScript number');
        return parsed;
    }

    private static validateGraph(value: unknown, ancestors = new Set<object>(), depth = 0): void {
        if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return;
        if (ancestors.has(value)) throw new Error('Cannot serialise cyclic values');
        if (depth > 32) throw new Error('DynamoDB documents support at most 32 nesting levels');
        if (!Array.isArray(value) && !(value instanceof Set)
            && Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value).constructor !== Object) {
            throw new Error('Cannot serialise unsupported object instance');
        }
        ancestors.add(value);
        const children = value instanceof Set ? [...value] : Object.values(value);
        children.forEach(child => this.validateGraph(child, ancestors, depth + 1));
        ancestors.delete(value);
    }

    /** Decodes one DynamoDB AttributeValue into its JavaScript value. */
    static parseField(item: any): any {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid AttributeValue descriptor');
        const tags = ['S', 'N', 'B', 'BOOL', 'NULL', 'M', 'L', 'SS', 'NS', 'BS'].filter(tag => Object.prototype.hasOwnProperty.call(item, tag));
        if (tags.length === 0) return undefined;
        if (tags.length !== 1 || Object.keys(item).length !== 1) throw new Error('Invalid AttributeValue descriptor');
        const tag = tags[0];
        const value = item[tag];
        const valid = tag === 'S' || tag === 'N' ? typeof value === 'string'
            : tag === 'BOOL' ? typeof value === 'boolean'
            : tag === 'NULL' ? value === true
            : tag === 'B' ? value instanceof Uint8Array
            : tag === 'M' ? value !== null && typeof value === 'object' && !Array.isArray(value)
            : tag === 'L' ? Array.isArray(value)
            : Array.isArray(value) && value.length > 0 && value.every(entry => tag === 'BS' ? entry instanceof Uint8Array : typeof entry === 'string');
        if (!valid) throw new Error('Invalid AttributeValue descriptor');
        if (item.S !== undefined) {
            return item.S;
        } else if (item.N !== undefined) {
            return this.parseNumber(item.N);
        } else if (item.BOOL !== undefined) {
            return item.BOOL;
        } else if (item.NULL !== undefined) {
            return null;
        } else if (item.M !== undefined) {
            return this.parseItem(item.M);
        } else if (item.L !== undefined) {
            return item.L.map((child: any) => this.parseField(child));
        } else if (item.SS !== undefined) {
            return new Set(item.SS);
        } else if (item.NS !== undefined) {
            return new Set(item.NS.map((num: string) => this.parseNumber(num)));
        } else if (item.BS !== undefined) {
            return new Set(item.BS.map((value: Uint8Array) => ValueUtils.clone(value)));
        } else if (item.B !== undefined) {
            return ValueUtils.clone(item.B);
        } else {
            return undefined;
        }
    }

    /** Decodes one DynamoDB item into a JavaScript document. */
    static parseItem<A, T>(item: A): { [key: string]: T } {
        const parsed: { [key: string]: T } = {};

        for (const key of Object.keys(item as object)) {
            Object.defineProperty(parsed, key, {
                value: this.parseField((item as Record<string, unknown>)[key]),
                enumerable: true, configurable: true, writable: true
            });
        }

        return parsed;
    }

    /** Decodes every item in a DynamoDB result collection. */
    static parseItems<T>(items: any[]): SerialisedMap<T>[] {
        return items.map((item) => this.parseItem(item));
    }

    /** Encodes one JavaScript value as a DynamoDB AttributeValue. */
    static serialiseItem(val: unknown): GetSelector {
        this.validateGraph(val, new Set(), 1);
        switch (typeof val) {
            case 'string':
                return {S: val};
            case 'number':
                if (!Number.isFinite(val)) {
                    throw new Error(`Cannot serialise non-finite number: ${val}`);
                }

                return {N: this.number(val)};
            case 'boolean':
                return {BOOL: val};
            case 'object':
                if (val instanceof Uint8Array) {
                    return {B: ValueUtils.clone(val) as Uint8Array};
                } else {
                    return QuerySerializer.serialiseObject(val);
                }
            default:
                throw new Error(`Cannot serialise value of type ${typeof val}`);
        }
    }

    /** Encodes nested arrays, sets, maps, and binary values as a DynamoDB AttributeValue. */
    static serialiseObject(val: unknown): GetSelector {
        this.validateGraph(val, new Set(), 1);
        if (val === null) {
            return {NULL: true};
        }
        if (val instanceof Array) {
            return {L: val.map((item) => QuerySerializer.serialiseItem(item))};
        } else if (val instanceof Set) {

            if (val.size === 0) {
                throw new Error('Cannot serialise an empty Set');
            }

            const arr = Array.from(val)
            const types = new Set(arr.map(item => typeof item));

            if (types.size > 1) {
                return {L: arr.map((item) => QuerySerializer.serialiseItem(item))};
            } else {
                switch (typeof arr[0]) {
                    case 'string':
                        return {SS: arr};
                    case 'number':
                        return {NS: arr.map((num) => {
                            if (!Number.isFinite(num)) {
                                throw new Error(`Cannot serialise non-finite number in Set: ${num}`);
                            }

                            return this.number(num);
                        })};
                    case 'object':
                        if (arr.some((item) => !(item instanceof Uint8Array))) {
                            return QuerySerializer.serialiseList(arr);
                        } else {
                            const binaries = arr as Uint8Array[];
                            return {BS: binaries.filter((item, index) => !binaries.slice(0, index).some(previous =>
                                previous.length === item.length && previous.every((byte, offset) => byte === item[offset])))
                                .map(item => ValueUtils.clone(item))};
                        }
                    default:
                        return QuerySerializer.serialiseList(arr);
                }
            }
        } else {
            if (val instanceof Uint8Array) {
                return {B: ValueUtils.clone(val)};
            } else {
                return {M: QuerySerializer.serialiseMap(val as any)};
            }
        }
    }

    /** Encodes a JavaScript document, skipping fields whose values are `undefined`. */
    static serialiseMap(obj: GenericDocument<unknown>): GenericDocument<GetSelector> {
        QuerySerializer.validateGraph(obj);
        const out: GenericDocument<GetSelector> = {};

        for (const key of Object.keys(obj)) {
            if (obj[key] !== undefined) {
                Object.defineProperty(out, key, {
                    value: QuerySerializer.serialiseItem(obj[key]),
                    enumerable: true, configurable: true, writable: true
                });
            }
        }

        return out;
    }

    /** Encodes an array as a DynamoDB list AttributeValue. */
    static serialiseList(val: unknown[]): GetListSelector {
        return {L: val.map((item) => QuerySerializer.serialiseItem(item))};
    }
}