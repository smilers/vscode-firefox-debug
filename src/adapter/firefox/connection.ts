import { Log } from '../util/log';
import { Socket } from 'net';
import { DebugProtocolTransport } from './transport';
import { ActorProxy } from './actorProxy/interface';
import { RootActorProxy } from './actorProxy/root';
import { PathMapper } from '../util/pathMapper';
import { SourceMapsManager } from './sourceMaps/manager';
import { SourcesManager } from '../adapter/sourcesManager';

let log = Log.create('DebugConnection');

/**
 * Connects to a target supporting the Firefox Debugging Protocol and sends and receives messages
 */
export class DebugConnection {

	private transport: DebugProtocolTransport;
	private actors: Map<string, ActorProxy>;
	public readonly sourceMaps: SourceMapsManager;
	public readonly rootActor: RootActorProxy;

	constructor(pathMapper: PathMapper, sources: SourcesManager, socket: Socket) {

		this.actors = new Map<string, ActorProxy>();
		this.sourceMaps = new SourceMapsManager(pathMapper, sources, this);
		this.rootActor = new RootActorProxy(this);
		this.transport = new DebugProtocolTransport(socket);

		this.transport.on('message', (message: FirefoxDebugProtocol.Response) => {
			if (this.actors.has(message.from)) {
				if (log.isDebugEnabled()) {
					log.debug(`Received response/event ${JSON.stringify(message)}`);
				}
				this.actors.get(message.from)!.receiveMessage(message);
			} else {
				log.error('Unknown actor: ' + JSON.stringify(message));
			}
		});
	}

	public sendRequest<T extends FirefoxDebugProtocol.Request>(request: T) {
		if (log.isDebugEnabled()) {
			log.debug(`Sending request ${JSON.stringify(request)}`);
		}
		this.transport.sendMessage(request);
	}

	public register(actor: ActorProxy): void {
		this.actors.set(actor.name, actor);
	}

	public unregister(actor: ActorProxy): void {
		this.actors.delete(actor.name);
	}

	public has(actorName: string): boolean {
		return this.actors.has(actorName);
	}

	public getOrCreate<T extends ActorProxy>(actorName: string, createActor: () => T): T {
		if (this.actors.has(actorName)) {
			return <T>this.actors.get(actorName);
		} else {
			return createActor();
		}
	}
	
	public disconnect(): Promise<void> {
		return this.transport.disconnect();
	}
}
