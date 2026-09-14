import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {queryBuilderContract} from './query-builder.contract';
import './query-builder.memory.test';

const dynamoDBClient = new DynamoDBClient({region: process.env.AWS_REGION ?? 'eu-west-2'});
queryBuilderContract('DynamoDB eu-west-2', dynamoDBClient, () => dynamoDBClient.destroy());
