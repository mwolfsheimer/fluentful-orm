import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {queryBuilderContract} from './query-builder.contract';
import './query-builder.memory.test';

const region = process.env['AWS_REGION'] ?? 'eu-west-2';
const dynamoDBClient = new DynamoDBClient({region});
queryBuilderContract(`DynamoDB ${region}`, dynamoDBClient, () => dynamoDBClient.destroy());
