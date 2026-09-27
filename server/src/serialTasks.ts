/** Mutations for one resource run in order; failures release the next waiter. */
export class SerialTasks {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const settled = result.then(() => {}, () => {});
    this.tails.set(key, settled);
    void settled.then(() => { if (this.tails.get(key) === settled) this.tails.delete(key); });
    return result;
  }
}
