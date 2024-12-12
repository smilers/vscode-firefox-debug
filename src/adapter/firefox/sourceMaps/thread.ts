import { EventEmitter } from 'events';
import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { IThreadActorProxy } from '../actorProxy/thread';

let log = Log.create('SourceMappingThreadActorProxy');

export class SourceMappingThreadActorProxy extends EventEmitter implements IThreadActorProxy {

	public constructor(
		private readonly underlyingActorProxy: IThreadActorProxy,
		private readonly connection: DebugConnection
	) {
		super();
	}

	public get name(): string {
		return this.underlyingActorProxy.name;
	}

	public async fetchStackFrames(
		start?: number,
		count?: number
	): Promise<FirefoxDebugProtocol.Frame[]> {

		let stackFrames = await this.underlyingActorProxy.fetchStackFrames(start, count);

		await Promise.all(stackFrames.map((frame) => this.connection.sourceMaps.applySourceMapToFrame(frame)));

		return stackFrames;
	}

	public pauseOnExceptions(pauseOnExceptions: boolean, ignoreCaughtExceptions: boolean): Promise<void> {
		return this.underlyingActorProxy.pauseOnExceptions(pauseOnExceptions, ignoreCaughtExceptions);
	}

	public resume(resumeLimitType?: 'next' | 'step' | 'finish' | 'restart', frameActorID?: string): Promise<void> {
		return this.underlyingActorProxy.resume(resumeLimitType, frameActorID);
	}

	public interrupt(immediately: boolean = true): Promise<void> {
		return this.underlyingActorProxy.interrupt(immediately);
	}

	public onExited(cb: () => void): void {
		this.underlyingActorProxy.onExited(cb);
	}

	public onWrongState(cb: () => void): void {
		this.underlyingActorProxy.onWrongState(cb);
	}

	public onNewGlobal(cb: () => void): void {
		this.underlyingActorProxy.onNewGlobal(cb);
	}

	public dispose(): void {
		this.underlyingActorProxy.dispose();
	}
}
