import type {Stream} from "./types";

/** Small serial execution queue used to drain asynchronous work one item at a time. */
export class Quewe {
    private paused = false;
    private running = false;
    private stream: Stream = [];

    /** Adds work to the queue and resolves when that work completes. */
    push(work: () => any): Promise<any> {
        return new Promise((resolve, reject) => {
            this.stream.push({
                s: resolve,
                f: reject,
                work: work
            });
            this.run();
        });
    }

    /** Pauses starting queued work; the current item is allowed to finish. */
    stop(): Quewe {
        this.paused = true;
        return this;
    }

    /** Resumes queued work and starts the next item when the queue is idle. */
    start(): Quewe {
        this.paused = false;
        this.run();
        return this;
    }

    private run(): void {
        if (this.paused || this.running) {
            return;
        }

        const item = this.stream.shift();

        if (!item) {
            return;
        }

        this.running = true;
        Promise.resolve()
            .then(() => item.work())
            .then(item.s, item.f)
            .then(() => {
                this.running = false;
                this.run();
            });
    }
}