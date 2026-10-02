import {DynamoDBClient} from '@aws-sdk/client-dynamodb';

export interface FakeDynamoDB {
    db: DynamoDBClient;
    inputs: any[];
    options: {abortSignal?: AbortSignal}[];
}

export function createFakeDynamoDB(respond: (command: any, attempt: number, options?: {abortSignal?: AbortSignal}) => any = () => ({})): FakeDynamoDB {
    const inputs: any[] = [];
    const options: {abortSignal?: AbortSignal}[] = [];
    let attempt = 0;
    const db = {
        send: async (command: any, requestOptions: {abortSignal?: AbortSignal} = {}) => {
            options.push(requestOptions);
            inputs.push(command.input);
            attempt++;
            return respond(command, attempt, requestOptions);
        }
    } as unknown as DynamoDBClient;

    return {db, inputs, options};
}