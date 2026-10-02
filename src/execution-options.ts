import type {ExecutionOptions} from './types';

export class ExecutionBinding {
    private bound = false;
    signal: AbortSignal | undefined;

    bind(options: ExecutionOptions = {}): void {
        if (this.bound && options.signal !== undefined && options.signal !== this.signal) {
            throw new Error('Execution options cannot change after execution starts');
        }
        if (!this.bound) {
            this.signal = options.signal;
            this.bound = true;
        }
    }
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        signal?.addEventListener('abort', onAbort, {once: true});
    });
}