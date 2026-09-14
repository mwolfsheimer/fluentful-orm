/** Splits documents into chunks and processes them with bounded concurrency. */
export async function runBatchChunks<TDocument, TResult>(
    documents: TDocument[],
    chunkSize: number,
    concurrency: number,
    worker: (chunk: TDocument[]) => Promise<TResult>
): Promise<TResult[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('Batch concurrency must be a positive integer');
    }

    const chunks: TDocument[][] = [];
    for (let chunkIndex = 0; chunkIndex < documents.length; chunkIndex += chunkSize) {
        chunks.push(documents.slice(chunkIndex, chunkIndex + chunkSize));
    }

    const results = new Array<TResult>(chunks.length);
    let nextChunk = 0;
    let failed = false;
    const runWorker = async () => {
        while (!failed) {
            const chunkIndex = nextChunk++;
            if (chunkIndex >= chunks.length) {
                return;
            }
            try {
                results[chunkIndex] = await worker(chunks[chunkIndex]);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    };

    const workers: Promise<void>[] = [];
    const workerCount = Math.min(concurrency, chunks.length);
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
        workers.push(runWorker());
    }

    const settled = await Promise.allSettled(workers);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
        throw failure.reason;
    }
    return results;
}