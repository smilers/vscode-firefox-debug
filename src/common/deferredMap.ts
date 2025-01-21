export class DeferredMap<S, T> {
	private readonly pending = new Map<S, (t: T) => void>();
	private readonly existing = new Map<S, T>();
	private readonly promises = new Map<S, Promise<T>>();

	public get(key: S): Promise<T> {
		if (this.promises.has(key)) {
			return this.promises.get(key)!;
		}

		const promise = new Promise<T>(resolve => {
			this.pending.set(key, resolve);
		});
		this.promises.set(key, promise);

		return promise;
	}

	public getExisting(key: S): T | undefined {
		return this.existing.get(key);
	}

	public getAllExisting(): T[] {
		return [...this.existing.values()];
	}

	public set(key: S, value: T): void {
		if (this.pending.has(key)) {
			this.pending.get(key)!(value);
			this.pending.delete(key);
		}
		if (!this.promises.has(key)) {
			this.promises.set(key, Promise.resolve(value));
		}
		this.existing.set(key, value);
	}

	public delete(key: S) {
		this.pending.delete(key);
		this.existing.delete(key);
		this.promises.delete(key);
	}
}
