import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';
import { ISourceActorProxy, SourceActorProxy } from './source';

const log = Log.create('TargetActorProxy');

export class TargetActorProxy extends BaseActorProxy {

	constructor(
		public readonly target: FirefoxDebugProtocol.TargetAvailableEvent['target'],
		connection: DebugConnection
	) {
		super(target.actor, connection, log);
	}

	public onConsoleMessages(cb: (consoleMessages: FirefoxDebugProtocol.ConsoleMessage[]) => void) {
		this.on('console-message', cb);
	}

	public onErrorMessages(cb: (errorMessages: { pageError: FirefoxDebugProtocol.PageError }[]) => void) {
		this.on('error-message', cb);
	}

	public onSources(cb: (sources: ISourceActorProxy[]) => void) {
		this.on('source', async underlyingSources => {
			let allMappedSources: ISourceActorProxy[] = [];
			for (let underlyingSource of underlyingSources) {
				let info = await this.connection.sourceMaps.getOrCreateSourceMappingInfo(underlyingSource.source);
				allMappedSources.push(...info.sources);
				if (!info.sources.some(actor => actor === underlyingSource)) {
					allMappedSources.push(underlyingSource);
				}
			}
			cb(allMappedSources);
		});
	}

	public onThreadState(cb: (threadState: FirefoxDebugProtocol.ThreadState) => void) {
		this.on('thread-state', cb);
	}

	handleEvent(event: FirefoxDebugProtocol.ResourcesAvailableEvent | FirefoxDebugProtocol.ResourceAvailableForm | FirefoxDebugProtocol.FrameUpdateEvent): void {
		if (event.type === 'resources-available-array') {
			for (const resource of event.array) {
				if (resource[0] === 'source') {
					this.emit('source', resource[1].map(source => new SourceActorProxy(source, this.connection)));
				} else if (resource[0] === 'thread-state') {
					for (let state of resource[1]) {
						this.emit('thread-state', state);
					}
				} else {
					this.emit(resource[0], resource[1]);
				}
			}
		} else if (event.type === 'resource-available-form') {
			for (const resource of event.resources) {
				switch (resource.resourceType) {
					case 'source': {
						this.emit('source', [new SourceActorProxy(resource, this.connection)]);
						break;
					}
					case 'thread-state': {
						this.emit('thread-state', resource);
						break;						
					}
					case 'console-message': {
						this.emit('console-message', [resource.message]);
						break;
					}
					case 'error-message': {
						this.emit('error-message', [resource]);
						break;
					}
				}
			}			
		} else if (event.type === 'frameUpdate') {
			log.debug("frameUpdate from TargetActor: " + JSON.stringify(event));
		} else {
			log.warn(`Unknown message: ${JSON.stringify(event)}`);
		}
	}
}
