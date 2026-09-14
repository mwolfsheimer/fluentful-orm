import {createInMemoryDynamoDB} from '../src/in-memory-dynamodb';
import {queryBuilderContract} from './query-builder.contract';

const memory = createInMemoryDynamoDB();
queryBuilderContract('in-memory', memory.db, () => memory.close());
