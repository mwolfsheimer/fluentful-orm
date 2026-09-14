import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {QuerySerializer} from '../src/query-serializer';

describe('query - QuerySerializer', () => {
    test('round trips nested values, arrays, booleans, and nulls', () => {
        const document = {
            active: true,
            nullable: null,
            values: [1, 'two'],
            nested: {value: 3}
        };

        const result = QuerySerializer.parseItem(QuerySerializer.serialiseMap(document) as any);

        assert.deepEqual(result, document);
    });

    test('serialises lists, maps, binary values, and binary sets to attribute values', () => {
        const binary = new Uint8Array([1, 2, 3]);
        const binarySet = new Set([Buffer.from('one'), Buffer.from('two')]);
        const serialised = QuerySerializer.serialiseMap({
            list: [1, 'two', {enabled: true}, binary],
            map: {owner: {id: 'account-1'}, empty: {}},
            binary,
            binarySet
        });

        assert.deepEqual(serialised['list'], {
            L: [
                {N: '1'},
                {S: 'two'},
                {M: {enabled: {BOOL: true}}},
                {B: binary}
            ]
        });
        assert.deepEqual(serialised['map'], {
            M: {
                owner: {M: {id: {S: 'account-1'}}},
                empty: {M: {}}
            }
        });
        assert.deepEqual(serialised['binary'], {B: binary});
        assert.deepEqual(serialised['binarySet'], {BS: Array.from(binarySet)});
    });

    test('detaches binary attribute values from source buffers', () => {
        const binary = Buffer.from([1, 2]);
        const setBinary = Buffer.from([3, 4]);
        const serialised = QuerySerializer.serialiseMap({binary, binarySet: new Set([setBinary])}) as any;

        binary[0] = 9;
        setBinary[0] = 8;

        assert.deepEqual(Array.from(serialised.binary.B), [1, 2]);
        assert.deepEqual(Array.from(serialised.binarySet.BS[0]), [3, 4]);
    });

    test('round trips number and string sets', () => {
        const result = QuerySerializer.parseItem(QuerySerializer.serialiseMap({
            numbers: new Set([1, 2, 3]),
            strings: new Set(['one', 'two'])
        }) as any) as any;

        assert.deepEqual(result.numbers, new Set([1, 2, 3]));
        assert.deepEqual(result.strings, new Set(['one', 'two']));
    });

    test('round trips fractional number sets', () => {
        const serialised = QuerySerializer.serialiseMap({values: new Set([1.5, 2.25, -0.75])});
        const result = QuerySerializer.parseItem(serialised as any) as any;

        assert.ok(result.values instanceof Set);
        assert.deepEqual(Array.from(result.values), [1.5, 2.25, -0.75]);
    });

    test('round trips buffers and binary sets', () => {
        const result = QuerySerializer.parseItem(QuerySerializer.serialiseMap({
            value: Buffer.from('one'),
            values: new Set([Buffer.from('two'), Buffer.from('three')])
        }) as any) as any;

        assert.deepEqual(Buffer.from(result.value), Buffer.from('one'));
        assert.ok(result.values instanceof Set);
        assert.deepEqual(
            Array.from(result.values as Set<Uint8Array>).map((value) => Buffer.from(value).toString()).sort(),
            ['three', 'two']
        );
    });

    test('skips undefined properties in maps', () => {
        const serialised = QuerySerializer.serialiseMap({
            id: 'skip-undefined',
            missing: undefined,
            nested: {kept: 1, missing: undefined}
        });

        assert.deepEqual(Object.keys(serialised), ['id', 'nested']);
        assert.deepEqual(serialised['nested'], {M: {kept: {N: '1'}}});
    });

    test('rejects undefined and unsupported value types', () => {
        assert.throws(() => QuerySerializer.serialiseItem(undefined), /Cannot serialise value of type undefined/);
        assert.throws(() => QuerySerializer.serialiseItem(Symbol('unsupported')), /Cannot serialise value of type symbol/);
        assert.throws(() => QuerySerializer.serialiseItem(() => 1), /Cannot serialise value of type function/);
        assert.throws(() => QuerySerializer.serialiseMap({values: ['kept', undefined]}), /Cannot serialise value of type undefined/);
    });

    test('rejects non-finite numbers', () => {
        assert.throws(() => QuerySerializer.serialiseItem(NaN), /Cannot serialise non-finite number/);
        assert.throws(() => QuerySerializer.serialiseItem(Infinity), /Cannot serialise non-finite number/);
        assert.throws(() => QuerySerializer.serialiseMap({value: -Infinity}), /Cannot serialise non-finite number/);
        assert.throws(() => QuerySerializer.serialiseMap({values: new Set([1, NaN])}), /Cannot serialise non-finite number in Set/);
    });

    test('rejects empty sets', () => {
        assert.throws(() => QuerySerializer.serialiseItem(new Set()), /Cannot serialise an empty Set/);
        assert.throws(() => QuerySerializer.serialiseMap({values: new Set()}), /Cannot serialise an empty Set/);
    });

    test('serialises mixed-type and boolean sets as lists', () => {
        const result = QuerySerializer.parseItem(QuerySerializer.serialiseMap({
            mixed: new Set([1, 'two']),
            booleans: new Set([true, false])
        }) as any) as any;

        assert.deepEqual(result.mixed, [1, 'two']);
        assert.deepEqual(result.booleans, [true, false]);
    });

    test('round trips falsy and empty values', () => {
        const document = {
            emptyString: '',
            zero: 0,
            negativeZero: -0,
            disabled: false,
            nothing: null,
            emptyList: [],
            emptyMap: {}
        };

        const result = QuerySerializer.parseItem(QuerySerializer.serialiseMap(document) as any) as any;

        assert.equal(result.emptyString, '');
        assert.equal(result.zero, 0);
        assert.equal(result.negativeZero, 0);
        assert.equal(result.disabled, false);
        assert.equal(result.nothing, null);
        assert.deepEqual(result.emptyList, []);
        assert.deepEqual(result.emptyMap, {});
    });

    test('round trips deeply nested structures', () => {
        const document = {
            pages: [
                {title: 'first', tags: ['a', 'b'], meta: {order: 1, hidden: false}},
                {title: 'second', tags: [], meta: {order: 2, hidden: true, extras: [{depth: 3}]}}
            ]
        };

        const result = QuerySerializer.parseItem(QuerySerializer.serialiseMap(document) as any);

        assert.deepEqual(result, document);
    });

    test('serialises number edge cases with full precision', () => {
        const serialised = QuerySerializer.serialiseMap({
            large: Number.MAX_SAFE_INTEGER,
            small: Number.MIN_SAFE_INTEGER,
            fractional: 0.1,
            timestamp: 1787735873743
        });

        assert.deepEqual(serialised['large'], {N: '9007199254740991'});
        assert.deepEqual(serialised['small'], {N: '-9007199254740991'});
        assert.deepEqual(serialised['fractional'], {N: '0.1'});

        const result = QuerySerializer.parseItem(serialised as any) as any;
        assert.equal(result.large, Number.MAX_SAFE_INTEGER);
        assert.equal(result.small, Number.MIN_SAFE_INTEGER);
        assert.equal(result.fractional, 0.1);
        assert.equal(result.timestamp, 1787735873743);
    });

    test('parses numeric attribute strings including scientific notation', () => {
        assert.equal(QuerySerializer.parseField({N: '1e3'}), 1000);
        assert.equal(QuerySerializer.parseField({N: '-0.5'}), -0.5);
        assert.deepEqual(QuerySerializer.parseField({NS: ['1', '2.5', '-3']}), new Set([1, 2.5, -3]));
    });

    test('returns undefined for unknown attribute descriptors', () => {
        assert.equal(QuerySerializer.parseField({}), undefined);
        assert.equal(QuerySerializer.parseField({X: 'unsupported'}), undefined);
    });

    test('parses multiple items with parseItems', () => {
        const items = [
            {id: {S: 'first'}, value: {N: '1'}},
            {id: {S: 'second'}, value: {N: '2'}}
        ];

        assert.deepEqual(QuerySerializer.parseItems(items), [
            {id: 'first', value: 1},
            {id: 'second', value: 2}
        ]);
    });

    test('serialises sets of plain objects as lists', () => {
        const serialised = QuerySerializer.serialiseMap({
            objects: new Set([{value: 1}, {value: 2}]),
            mixedBinary: new Set([Buffer.from('one'), {value: 3}])
        });
        const result = QuerySerializer.parseItem(serialised as any) as any;

        assert.deepEqual(result.objects, [{value: 1}, {value: 2}]);
        assert.deepEqual(Buffer.from(result.mixedBinary[0]).toString(), 'one');
        assert.deepEqual(result.mixedBinary[1], {value: 3});
    });
});
