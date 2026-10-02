import {CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand} from '@aws-sdk/client-dynamodb';
import {test} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {queryBuilderContract} from './query-builder.contract';
import {QueryBuilder} from '../src/query-builder';

const region = process.env['AWS_REGION'] ?? 'eu-west-2';
const dynamoDBClient = new DynamoDBClient({region, maxAttempts: process.env['ORM_AWS_PROBE'] ? 1 : 2});

async function probe(context: TestContext, mode: string, signal: AbortSignal, budget: number): Promise<void> {
	const name = `query-builder-probe-${mode}-${process.pid}-${Date.now()}`;
	const definition = {name, key: {partition: 'id'}, attributes: {id: 'S'}, indexes: {}} as const;
	await QueryBuilder.createTable(definition, dynamoDBClient, mode === 'throttling'
		? {billingMode: 'PROVISIONED', throughput: {read: 1, write: 1}, signal} : {signal});
	await QueryBuilder.waitForTable(name, dynamoDBClient, {signal});
	const records = () => new QueryBuilder(name, dynamoDBClient);
	if (mode === 'ttl') {
		await QueryBuilder.configureTimeToLive(name, 'expiresAt', true, dynamoDBClient, {signal});
		const future = Math.floor(Date.now() / 1000) + 7 * 86400;
		await records().create({id: 'expired', expiresAt: Math.floor(Date.now() / 1000) - 60}).toPromise({signal});
		await records().create({id: 'future', expiresAt: future}).toPromise({signal});
		for (let attempt = 0; attempt < budget; attempt++) {
			try {
				const item = await records().get({id: 'expired'}).consistent().toPromise({signal});
				if (item === null) {
					assert.notEqual(await records().get({id: 'future'}).consistent().toPromise({signal}), null);
					context.diagnostic('Observed asynchronous TTL deletion; future record remains present.');
					return;
				}
				await delay(10000, undefined, {signal});
			} catch (error) {
				if (!signal.aborted) throw error;
				break;
			}
		}
		context.skip('INCONCLUSIVE: TTL deletion was not observed within the time/request budget; service expiry can take days.');
		return;
	}
	await records().create({id: 'hot', count: 0}).toPromise({signal});
	let observed = 0, completed = 0, next = 0;
	const worker = async () => {
		while (!signal.aborted && next++ < budget) {
			try {
				if (mode === 'conflicts') await QueryBuilder.transactWrite(dynamoDBClient)
					.add(name, query => query.update({id: 'hot'}).add('count').eq(1)).toPromise({signal});
				else await records().update({id: 'hot'}).add('count').eq(1).returningNone().toPromise({signal});
				completed++;
			} catch (error) {
				if (signal.aborted) break;
				const failure = error as {name?: string; CancellationReasons?: {Code?: string}[]};
				const codes = failure.CancellationReasons?.map(reason => reason.Code) ?? [];
				const expected = mode === 'conflicts'
					? failure.name === 'TransactionConflictException' || codes.includes('TransactionConflict')
					: ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded'].includes(failure.name ?? '')
						|| codes.some(code => code === 'ProvisionedThroughputExceeded' || code === 'ThrottlingError');
				if (!expected) throw error;
				observed++;
			}
		}
	};
	const workers = await Promise.allSettled(Array.from({length: Math.min(8, budget)}, worker));
	const failed = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
	if (failed) throw failed.reason;
	context.diagnostic(`${mode}: ${completed} completed, ${observed} target service failures; budget ${budget}, concurrency <= 8, SDK retries disabled.`);
	if (observed === 0) context.skip('INCONCLUSIVE: the target service failure was not observed within the bounded workload.');
}

async function main(): Promise<void> {
	const seconds = Number(process.env['ORM_AWS_TIMEOUT_SECONDS'] ?? 600);
	const mode = process.env['ORM_AWS_PROBE'];
	if (mode !== undefined && !['conflicts', 'throttling', 'ttl'].includes(mode)) throw new Error('ORM_AWS_PROBE must be conflicts, throttling, or ttl');
	const maximum = mode === 'ttl' ? 259200 : 3600;
	if (!Number.isInteger(seconds) || seconds < 30 || seconds > maximum) throw new Error(`ORM_AWS_TIMEOUT_SECONDS must be between 30 and ${maximum}`);
	const budget = Number(process.env['ORM_AWS_MAX_REQUESTS'] ?? (mode === 'ttl' ? 60 : 100));
	if (!Number.isInteger(budget) || budget < 1 || budget > (mode === 'ttl' ? 25920 : 1000)) throw new Error('Invalid ORM_AWS_MAX_REQUESTS budget');
	const credentials = await dynamoDBClient.config.credentials();
	if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('AWS integration requires explicit working credentials');
	const workload = AbortSignal.timeout(seconds * 1000);
	await dynamoDBClient.send(new ListTablesCommand({Limit: 1}), {abortSignal: workload});
	console.log(`AWS credential preflight passed in ${region}; bounded workload: ${seconds}s. Temporary tables incur charges.`);
	const resources = new Set<string>();
	const send = dynamoDBClient.send.bind(dynamoDBClient);
	dynamoDBClient.send = (async (command: Parameters<typeof send>[0], options?: {abortSignal?: AbortSignal}) => {
		const name = command instanceof CreateTableCommand || command instanceof DeleteTableCommand ? command.input.TableName : undefined;
		if (command instanceof CreateTableCommand && name) resources.add(name);
		try {
			const result = await send(command, {abortSignal: options?.abortSignal ? AbortSignal.any([workload, options.abortSignal]) : workload});
			return result;
		} catch (error) {
			if (command instanceof CreateTableCommand && name && (error as {name?: string}).name === 'ResourceInUseException') resources.delete(name);
			throw error;
		}
	}) as typeof dynamoDBClient.send;
	const cleanup = async () => {
		const client = new DynamoDBClient({region, maxAttempts: 2});
		const signal = AbortSignal.timeout(120000);
		const failures: unknown[] = [];
		try {
			for (const name of resources) {
				try {
					await client.send(new DeleteTableCommand({TableName: name}), {abortSignal: signal});
					await QueryBuilder.waitForTableDeleted(name, client, {signal, maxWaitTime: 90});
				} catch (error) {
					if ((error as {name?: string}).name !== 'ResourceNotFoundException') {
						console.error(`AWS cleanup failed; possible orphan in ${region}: ${name}`);
						failures.push(error);
					}
				}
			}
		} finally { client.destroy(); dynamoDBClient.destroy(); }
		if (failures.length) throw new AggregateError(failures, 'AWS cleanup incomplete; inspect reported table names');
	};
	if (mode) test(`AWS ${mode} evidence probe`, {timeout: (seconds + 150) * 1000}, async context => {
		context.after(cleanup);
		await probe(context, mode, workload, budget);
	});
	else queryBuilderContract(`DynamoDB ${region}`, dynamoDBClient, cleanup, true);
}

void main().catch(error => {
	dynamoDBClient.destroy();
	test('AWS integration preflight', () => { throw error; });
});
