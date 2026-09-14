import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {QueryBuilder} from '../src/query-builder';
import {createFakeDynamoDB} from './fake-dynamodb';

describe('query - QueryBuilder transactions', () => {
    test('inherits builder failure return values and lets transaction options override them', async () => {
        const fake = createFakeDynamoDB();
        await QueryBuilder.transactWrite(fake.db)
            .add('test', (query) => query.create({id: 'put'}).where('id').not().exists()
                .onConditionFailure().returningAllOld())
            .add('test', (query) => query.update({id: 'update'}).add('count').eq(1).where('count').lt(10)
                .onConditionFailure().returningAllOld(), {returnValuesOnConditionCheckFailure: 'NONE'})
            .add('test', (query) => query.delete({id: 'delete'}).where('id').exists()
                .onConditionFailure().returningAllOld())
            .add('test', (query) => query.conditionCheck({id: 'check'}).where('id').exists()
                .onConditionFailure().returningAllOld())
            .toPromise();
        const items = fake.inputs[0].TransactItems;
        assert.equal(items[0].Put.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(items[1].Update.ReturnValuesOnConditionCheckFailure, 'NONE');
        assert.equal(items[2].Delete.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(items[3].ConditionCheck.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
    });

    test('executes a standalone condition check through TransactWriteItems', async () => {
        const fake = createFakeDynamoDB();

        await new QueryBuilder('accounts', fake.db)
            .conditionCheck({id: 'account-1'})
            .where('credits').gte(1)
            .where('state').eq('active')
            .toPromise();

        assert.deepEqual(fake.inputs[0], {
            ReturnConsumedCapacity: 'INDEXES',
            TransactItems: [{
                ConditionCheck: {
                    TableName: 'accounts',
                    Key: {id: {S: 'account-1'}},
                    ConditionExpression: '#credits >= :condition0 AND #state = :condition1',
                    ExpressionAttributeNames: {
                        '#credits': 'credits',
                        '#state': 'state'
                    },
                    ExpressionAttributeValues: {
                        ':condition0': {N: '1'},
                        ':condition1': {S: 'active'}
                    }
                }
            }]
        });
    });

    test('compiles mixed writes and condition checks into one transaction', async () => {
        const fake = createFakeDynamoDB();

        await QueryBuilder.transactWrite(fake.db)
            .clientRequestToken('transaction-request-1')
            .add('accounts', (query) => query
                .conditionCheck({id: 'transaction-guard'})
                .where('credits').gte(1), {returnValuesOnConditionCheckFailure: 'ALL_OLD'})
            .add('cards', (query) => query
                .timestamps()
                .create({id: 'card-1', recipient: 'Alex'})
                .where('id').not().exists())
            .add('accounts', (query) => query
                .update({id: 'account-1'})
                .add('credits').eq(-1)
                .where('credits').gte(1))
            .add('drafts', (query) => query
                .delete({id: 'draft-1'})
                .where('id').exists())
            .toPromise();

        const input = fake.inputs[0];
        assert.equal(input.ClientRequestToken, 'transaction-request-1');
        assert.equal(input.ReturnConsumedCapacity, 'INDEXES');
        assert.equal(input.TransactItems.length, 4);
        assert.equal(input.TransactItems[0].ConditionCheck.TableName, 'accounts');
        assert.equal(input.TransactItems[0].ConditionCheck.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
        assert.equal(input.TransactItems[1].Put.TableName, 'cards');
        assert.equal(typeof input.TransactItems[1].Put.Item.createdAt.N, 'string');
        assert.equal(input.TransactItems[1].Put.ConditionExpression, 'attribute_not_exists(#id)');
        assert.equal(input.TransactItems[2].Update.UpdateExpression, 'ADD #credits :credits');
        assert.equal(input.TransactItems[2].Update.ConditionExpression, '#credits >= :condition0');
        assert.equal(input.TransactItems[3].Delete.ConditionExpression, 'attribute_exists(#id)');
    });

    test('submits a transaction only once', async () => {
        const fake = createFakeDynamoDB();
        const transaction = QueryBuilder.transactWrite(fake.db)
            .add('test', (query) => query.create({id: 'single-send'}));

        const first = transaction.toPromise();
        const second = transaction.toPromise();

        assert.strictEqual(first, second);
        await first;
        assert.equal(fake.inputs.length, 1);
    });

    test('accumulates transaction items in a loop before executing once', async () => {
        const fake = createFakeDynamoDB();
        const transaction = QueryBuilder.transactWrite(fake.db);
        const documents = Array.from({length: 10}, (_, index) => ({
            id: `loop-item-${index}`,
            value: index
        }));

        for (const document of documents) {
            transaction.add('test', (query) => query.create(document));
        }

        assert.equal(fake.inputs.length, 0);
        await transaction.toPromise();

        assert.equal(fake.inputs.length, 1);
        assert.equal(fake.inputs[0].TransactItems.length, documents.length);
        assert.deepEqual(
            fake.inputs[0].TransactItems.map((item: any) => ({
                id: item.Put.Item.id.S,
                value: Number(item.Put.Item.value.N)
            })),
            documents
        );
    });

    test('preserves and caches transaction service failures', async () => {
        const serviceError = new Error('transaction cancelled');
        serviceError.name = 'TransactionCanceledException';
        const fake = createFakeDynamoDB(() => {
            throw serviceError;
        });
        const transaction = QueryBuilder.transactWrite(fake.db)
            .add('test', (query) => query.create({id: 'rejected'}));

        const first = transaction.toPromise();
        const second = transaction.toPromise();

        assert.strictEqual(first, second);
        await assert.rejects(first, (error) => error === serviceError);
        assert.equal(fake.inputs.length, 1);
    });

    test('preserves standalone condition-check service failures', async () => {
        const serviceError = new Error('condition failed');
        serviceError.name = 'TransactionCanceledException';
        const fake = createFakeDynamoDB(() => {
            throw serviceError;
        });

        await assert.rejects(
            new QueryBuilder('test', fake.db)
                .conditionCheck({id: 'missing'})
                .where('id').exists()
                .toPromise(),
            (error) => error === serviceError
        );
        assert.equal(fake.inputs.length, 1);
    });

    test('does not retain an operation when its configure callback fails', async () => {
        const fake = createFakeDynamoDB();
        const transaction = QueryBuilder.transactWrite(fake.db);

        assert.throws(() => transaction.add('test', () => {
            throw new Error('configuration failed');
        }), /configuration failed/);

        await transaction
            .add('test', (query) => query.create({id: 'configured'}))
            .toPromise();
        assert.equal(fake.inputs[0].TransactItems.length, 1);
        assert.equal(fake.inputs[0].TransactItems[0].Put.Item.id.S, 'configured');
    });

    test('rejects additions after transaction execution starts', async () => {
        const fake = createFakeDynamoDB();
        const transaction = QueryBuilder.transactWrite(fake.db)
            .add('test', (query) => query.create({id: 'started'}));

        const result = transaction.toPromise();
        assert.throws(
            () => transaction.add('test', (query) => query.create({id: 'too-late'})),
            /after a transaction has executed/
        );
        await result;
    });

    test('rejects empty, unconfigured, read, conditionless, and oversized transactions', async () => {
        const fake = createFakeDynamoDB();

        assert.throws(() => QueryBuilder.transactWrite(fake.db).toPromise(), /at least one operation/);
        assert.throws(
            () => QueryBuilder.transactWrite(fake.db).add('test', () => undefined),
            /must be configured/
        );
        assert.throws(
            () => QueryBuilder.transactWrite(fake.db).add('test', (query) => query.get({id: 'read'})),
            /support only create, update, delete, and conditionCheck/
        );
        assert.throws(
            () => QueryBuilder.transactWrite(fake.db).add('test', (query) => query.conditionCheck({id: 'unchecked'})),
            /requires at least one condition/
        );
        await assert.rejects(
            new QueryBuilder('test', fake.db).conditionCheck({id: 'unchecked'}).toPromise(),
            /requires at least one condition/
        );

        const transaction = QueryBuilder.transactWrite(fake.db);
        for (let index = 0; index < 100; index++) {
            transaction.add('test', (query) => query.create({id: `item-${index}`}));
        }
        assert.throws(
            () => transaction.add('test', (query) => query.create({id: 'item-101'})),
            /at most 100 operations/
        );
    });
});
