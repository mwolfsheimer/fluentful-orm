import {createEngine} from '../src/index';
import {queryBuilderContract} from './query-builder.contract';

const memory = createEngine.memory();
queryBuilderContract('in-memory', memory.db, () => memory.close());
