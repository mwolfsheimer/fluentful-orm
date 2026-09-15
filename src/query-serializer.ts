import type {GenericDocument, GetListSelector, GetSelector, SerialisedMap} from "./types";
import {ValueUtils} from './value-utils';

/** Converts between JavaScript documents and DynamoDB AttributeValue maps. */
export class QuerySerializer {

    /** Decodes one DynamoDB AttributeValue into its JavaScript value. */
    static parseField(item: any): any {
        if (item.S !== undefined) {
            return item.S;
        } else if (item.N !== undefined) {
            return parseFloat(item.N);
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
            return new Set(item.NS.map((num: string) => parseFloat(num)));
        } else if (item.BS !== undefined) {
            return new Set(item.BS);
        } else if (item.B !== undefined) {
            return item.B;
        } else {
            return undefined;
        }
    }

    /** Decodes one DynamoDB item into a JavaScript document. */
    static parseItem<A, T>(item: A): { [key: string]: T } {
        const parsed: { [key: string]: T } = {};

        for (let key in item) {
            parsed[key] = this.parseField(item[key]);
        }

        return parsed;
    }

    /** Decodes every item in a DynamoDB result collection. */
    static parseItems<T>(items: any[]): SerialisedMap<T>[] {
        return items.map((item) => this.parseItem(item));
    }

    /** Encodes one JavaScript value as a DynamoDB AttributeValue. */
    static serialiseItem(val: unknown): GetSelector {
        switch (typeof val) {
            case 'string':
                return {S: val};
            case 'number':
                if (!Number.isFinite(val)) {
                    throw new Error(`Cannot serialise non-finite number: ${val}`);
                }

                return {N: val.toString()};
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

                            return num.toString();
                        })};
                    case 'object':
                        if (arr.some((item) => !(item instanceof Uint8Array))) {
                            return QuerySerializer.serialiseList(arr);
                        } else {
                            return {BS: arr.map((item) => ValueUtils.clone(item) as Uint8Array)};
                        }
                    default:
                        return QuerySerializer.serialiseList(arr);
                }
            }
        } else {
            if (val instanceof Uint8Array) {
                return {B: val as Uint8Array};
            } else {
                return {M: QuerySerializer.serialiseMap(val as any)};
            }
        }
    }

    /** Encodes a JavaScript document, skipping fields whose values are `undefined`. */
    static serialiseMap(obj: GenericDocument<unknown>): GenericDocument<GetSelector> {
        const out: GenericDocument<GetSelector> = {};

        for (let key in obj) {
            if (obj[key] !== undefined) {
                out[key] = QuerySerializer.serialiseItem(obj[key]);
            }
        }

        return out;
    }

    /** Encodes an array as a DynamoDB list AttributeValue. */
    static serialiseList(val: unknown[]): GetListSelector {
        return {L: val.map((item) => QuerySerializer.serialiseItem(item))};
    }
}