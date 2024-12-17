import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { ActorProxy } from './interface';
import { PendingRequests } from '../../util/pendingRequests';
import { Log } from '../../util/log';

export abstract class BaseActorProxy extends EventEmitter implements ActorProxy {

	private readonly pendingRequests = new PendingRequests<any>();
	private readonly cachedRequestPromises = new Map<string, Promise<any>>();

	constructor(
		public readonly name: string,
		protected readonly connection: DebugConnection,
		private readonly log: Log
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

	sendCachedRequest<T extends Omit<FirefoxDebugProtocol.Request, 'to'>, R, S>(key: string, request: T, convert?: (r: R) => S): Promise<S> {
		if (!this.cachedRequestPromises.has(key)) {
			this.cachedRequestPromises.set(key, (async () => {
				const response: R = await this.sendRequest(request);
				return convert ? convert(response) : response;
			})());
		}
		return this.cachedRequestPromises.get(key)!;
	}

	sendRequestWithoutResponse<T extends Omit<FirefoxDebugProtocol.Request, 'to'>>(request: T): void {
		this.connection.sendRequest({ ...request, to: this.name });
	}

	async getRequestTypes(): Promise<string[]> {
		return (await this.sendRequest<any, FirefoxDebugProtocol.RequestTypesResponse>(
			{ type: 'requestTypes' })
		).requestTypes;
	}

	isEvent(message: FirefoxDebugProtocol.Response): boolean {
		return !!message.type;
	}

	handleEvent(event: FirefoxDebugProtocol.Event): void {
		this.log.warn(`Unknown message: ${JSON.stringify(event)}`);
	}

	receiveMessage(message: FirefoxDebugProtocol.Response): void {
		if (message.error) {
			this.pendingRequests.rejectOne(message);
		} else if (this.isEvent(message)) {
			this.handleEvent(message as FirefoxDebugProtocol.Event);
		} else {
			this.pendingRequests.resolveOne(message);
		}
	}

	dispose(): void {
		this.connection.unregister(this);
	}
}
