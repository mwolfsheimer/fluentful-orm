import {DynamoDBClient} from '@aws-sdk/client-dynamodb';

export interface FakeDynamoDB {
    db: DynamoDBClient;
    inputs: any[];
}

export function createFakeDynamoDB(respond: (command: any, attempt: number) => any = () => ({})): FakeDynamoDB {
    const inputs: any[] = [];
    let attempt = 0;
    const db = {
        send: async (command: any) => {
            inputs.push(command.input);
            attempt++;
            return respond(command, attempt);
        }
    } as unknown as DynamoDBClient;

    return {db, inputs};
}