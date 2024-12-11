import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { ActorProxy } from './interface';
import { PendingRequests } from '../../util/pendingRequests';

export abstract class BaseActorProxy extends EventEmitter implements ActorProxy {

	private readonly pendingRequests = new PendingRequests<any>();
	private readonly cachedRequestPromises = new Map<string, Promise<any>>();

	constructor(
		public readonly name: string,
		private readonly responseTypes: string[],
		protected readonly connection: DebugConnection
	) {
		super();
		this.connection.register(this);
	}

	sendRequest<T extends Omit<FirefoxDebugProtocol.Request, 'to'>, S>(request: T): Promise<S> {
		return new Promise<S>((resolve, reject) => {
			this.pendingRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ ...request, to: this.name });
		});
	}

	sendCachedRequest<T extends Omit<FirefoxDebugProtocol.Request, 'to'>, R, S>(key: string, request: T, convert: (r: R) => S): Promise<S> {
		if (!this.cachedRequestPromises.has(key)) {
			this.cachedRequestPromises.set(key, (async () => convert(await this.sendRequest(request)))());
		}
		return this.cachedRequestPromises.get(key)!;
	}

	async getRequestTypes(): Promise<string[]> {
		return (await this.sendRequest<any, FirefoxDebugProtocol.RequestTypesResponse>(
			{ type: 'requestTypes' })
		).requestTypes;
	}

	abstract handleEvent(event: FirefoxDebugProtocol.Event): void;

	receiveResponse(message: FirefoxDebugProtocol.Response): void {
		if (message.error) {
			this.pendingRequests.rejectOne(message);
		} else if (message.type && !this.responseTypes.includes(message.type)) {
			this.handleEvent(message as FirefoxDebugProtocol.Event);
		} else {
			this.pendingRequests.resolveOne(message);
		}
	}

	dispose(): void {
		this.connection.unregister(this);
	}
}
