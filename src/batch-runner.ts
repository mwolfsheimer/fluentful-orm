/** Splits documents into chunks and processes them with bounded concurrency. */
export async function runBatchChunks<TDocument, TResult>(
    documents: TDocument[],
    chunkSize: number,
    concurrency: number,
    worker: (chunk: TDocument[]) => Promise<TResult>,
    signal?: AbortSignal
): Promise<TResult[]> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('Batch concurrency must be a positive integer');
    }

    signal?.throwIfAborted();

    const chunks: TDocument[][] = [];
    const workers: Promise<void>[] = [];
    let nextChunkIndex = 0;
    let hasFailed = false;

    for (let chunkIndex = 0; chunkIndex < documents.length; chunkIndex += chunkSize) {
        chunks.push(documents.slice(chunkIndex, chunkIndex + chunkSize));
    }

    const results = new Array<TResult>(chunks.length);
    const runWorker = async () => {
        while (!hasFailed) {
            if (signal?.aborted) {
                hasFailed = true;
                throw signal.reason;
            }

            // Claim the index before awaiting so workers never submit the same chunk.
            const chunkIndex = nextChunkIndex++;
            if (chunkIndex >= chunks.length) {
                return;
            }

            try {
                results[chunkIndex] = await worker(chunks[chunkIndex]);
            } catch (error) {
                hasFailed = true;
                throw error;
            }
        }
    };

    const workerCount = Math.min(concurrency, chunks.length);
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
        workers.push(runWorker());
    }

    // Let in-flight work settle before reporting failure so recovery includes its outcome.
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) {
        throw failure.reason;
    }

    return results;
}
