import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {ValueUtils} from '../src/value-utils';

describe('query - ValueUtils', () => {
    test('clones nested values, maps, sets, binary data, and cycles', () => {
        const document: any = {
            map: new Map([['record', {values: new Set(['one', 'two'])}]]),
            binary: new Uint8Array([1, 2, 3])
        };
        document.self = document;

        const copy = ValueUtils.clone(document);
        assert.notEqual(copy, document);
        assert.notEqual(copy.map, document.map);
        assert.notEqual(copy.map.get('record'), document.map.get('record'));
        assert.notEqual(copy.binary, document.binary);
        assert.equal(copy.self, copy);
        assert.deepEqual(copy.map.get('record').values, new Set(['one', 'two']));
        assert.deepEqual(copy.binary, new Uint8Array([1, 2, 3]));

        copy.map.get('record').values.add('three');
        copy.binary[0] = 9;
        assert.equal(document.map.get('record').values.has('three'), false);
        assert.equal(document.binary[0], 1);
    });

    test('clones typed arrays and preserves shared backing buffers', () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        const document = {
            buffer: bytes.buffer,
            view: new Uint16Array(bytes.buffer),
            dataView: new DataView(bytes.buffer),
            nodeBuffer: Buffer.from(bytes)
        };

        const copy = ValueUtils.clone(document);
        assert.ok(copy.view instanceof Uint16Array);
        assert.ok(copy.dataView instanceof DataView);
        assert.ok(Buffer.isBuffer(copy.nodeBuffer));
        assert.notEqual(copy.buffer, document.buffer);
        assert.equal(copy.view.buffer, copy.buffer);
        assert.equal(copy.dataView.buffer, copy.buffer);
        assert.deepEqual(Array.from(copy.view), Array.from(document.view));
        assert.deepEqual(Array.from(copy.nodeBuffer), Array.from(document.nodeBuffer));
        assert.equal(copy.dataView.getUint8(0), 1);
    });

    test('materialises accessor values and preserves enumerable array metadata', () => {
        const state = {count: 1};
        const source = Object.assign([1], {
            get state() {
                return state;
            }
        });

        const copy: any = ValueUtils.clone(source);
        copy.state.count = 2;
        copy.label = 'copied';
        assert.equal(state.count, 1);
        assert.equal(copy.state.count, 2);
        assert.equal(copy.label, 'copied');
    });

    test('compares supported values with strict deep semantics', () => {
        assert.equal(ValueUtils.equals({a: [1, {b: 2}], c: true}, {c: true, a: [1, {b: 2}]}), true);
        assert.equal(ValueUtils.equals(new Set([{id: 1}, {id: 2}]), new Set([{id: 2}, {id: 1}])), true);
        assert.equal(ValueUtils.equals(new Map([['first', {value: 1}], ['second', {value: 2}]]), new Map([['second', {value: 2}], ['first', {value: 1}]])), true);
        assert.equal(ValueUtils.equals(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
        assert.equal(ValueUtils.equals(NaN, NaN), true);
        assert.equal(ValueUtils.equals(0, -0), false);
        assert.equal(ValueUtils.equals(new Set([1]), new Set([2])), false);
        assert.equal(ValueUtils.equals([1], {0: 1, length: 1}), false);

        const left: any = {};
        const right: any = {};
        left.self = left;
        right.self = right;
        assert.equal(ValueUtils.equals(left, right), true);

        const twoNodeCycle: any = {};
        const secondNode: any = {};
        twoNodeCycle.self = secondNode;
        secondNode.self = twoNodeCycle;
        assert.equal(ValueUtils.equals(left, twoNodeCycle), false);
    });

    test('compares shared references symmetrically without requiring identical graph sharing', () => {
        const shared = {value: 1};
        const left = {first: shared, second: shared};
        const right = {first: {value: 1}, second: {value: 1}};

        assert.equal(ValueUtils.equals(left, right), true);
        assert.equal(ValueUtils.equals(right, left), true);
    });

    test('distinguishes built-in values and enumerable metadata', () => {
        assert.equal(ValueUtils.equals(new Number(1), new Number(2)), false);
        assert.equal(ValueUtils.equals(
            new DataView(new Uint8Array([1]).buffer),
            new DataView(new Uint8Array([2]).buffer)
        ), false);
        assert.equal(ValueUtils.equals(new Error('first'), new Error('second')), false);
        assert.equal(ValueUtils.equals(
            Object.assign([1], {label: 'first'}),
            Object.assign([1], {label: 'second'})
        ), false);
        assert.equal(ValueUtils.equals(
            Object.assign(new Set([1]), {label: 'first'}),
            Object.assign(new Set([1]), {label: 'second'})
        ), false);
    });

    test('diff is the inverse of equals', () => {
        const value = {items: new Set(['one', 'two'])};
        assert.equal(ValueUtils.diff(value, ValueUtils.clone(value)), false);
        assert.equal(ValueUtils.diff(value, {items: new Set(['one'])}), true);
    });
});
