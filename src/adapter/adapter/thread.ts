import { EventEmitter } from 'events';
import { IThreadActorProxy } from '../firefox/actorProxy/thread';
import { ConsoleActorProxy } from '../firefox/actorProxy/console';
import { FrameAdapter } from './frame';
import { ScopeAdapter } from './scope';
import { ObjectGripAdapter } from './objectGrip';
import { VariablesProvider } from './variablesProvider';
import { VariableAdapter } from './variable';
import { Variable } from '@vscode/debugadapter';
import { Log } from '../util/log';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { TargetActorProxy } from '../firefox/actorProxy/target';
import { ISourceActorProxy } from '../firefox/actorProxy/source';

let log = Log.create('ThreadAdapter');

export type TargetType = 'tab' | 'iframe' | 'worker' | 'backgroundScript' | 'contentScript';

/**
 * Adapter class for a thread
 */
export class ThreadAdapter extends EventEmitter {

	public id: number;
	public get actorName() {
		return this.actor.name;
	}
	public get url(): string | undefined {
		return this.targetActor.target.url;
	}

	/**
	 * All `SourceAdapter`s for this thread. They will be disposed when this `ThreadAdapter` is disposed.
	 */
	public readonly sourceActors = new Set<ISourceActorProxy>();

	/**
	 * When the thread is paused, this is set to a Promise that resolves to the `FrameAdapter`s for
	 * the stacktrace for the current thread pause. At the end of the thread pause, these are disposed.
	 */
	private framesPromise: Promise<FrameAdapter[]> | undefined = undefined;

	/**
	 * All `ScopeAdapter`s that have been created for the current thread pause. They will be disposed
	 * at the end of the thread pause.
	 */
	private scopes: ScopeAdapter[] = [];

	/**
	 * All `ObjectGripAdapter`s that should be disposed at the end of the current thread pause
	 */
	private pauseLifetimeObjects: ObjectGripAdapter[] = [];

	/**
	 * All `ObjectGripAdapter`s that should be disposed when this `ThreadAdapter` is disposed
	 */
	private threadLifetimeObjects: ObjectGripAdapter[] = [];

	public threadPausedReason?: FirefoxDebugProtocol.ThreadPausedReason;

	public constructor(
		public readonly type: TargetType,
		public readonly name: string,
		public readonly actor: IThreadActorProxy,
		public readonly targetActor: TargetActorProxy,
		private readonly consoleActor: ConsoleActorProxy,
		public readonly debugSession: FirefoxDebugSession
	) {
		super();
		this.id = debugSession.threads.register(this);
	}

	public registerScopeAdapter(scopeAdapter: ScopeAdapter) {
		this.scopes.push(scopeAdapter);
	}

	public registerObjectGripAdapter(objectGripAdapter: ObjectGripAdapter) {
		if (objectGripAdapter.threadLifetime) {
			this.threadLifetimeObjects.push(objectGripAdapter);
		} else {
			this.pauseLifetimeObjects.push(objectGripAdapter);
		}
	}

	/**
	 * extend the given adapter's lifetime to threadLifetime (if it isn't already)
	 */
	public threadLifetime(objectGripAdapter: ObjectGripAdapter): void {

		if (!objectGripAdapter.threadLifetime) {

			const index = this.pauseLifetimeObjects.indexOf(objectGripAdapter);
			if (index >= 0) {
				this.pauseLifetimeObjects.splice(index, 1);
			}

			this.threadLifetimeObjects.push(objectGripAdapter);
			objectGripAdapter.threadLifetime = true;
		}
	}

	public interrupt(): Promise<void> {
		return this.actor.interrupt();
	}

	public resume(): Promise<void> {
		return this.actor.resume();
	}

	public stepOver(): Promise<void> {
		return this.actor.resume('next');
	}

	public stepIn(): Promise<void> {
		return this.actor.resume('step');
	}

	public stepOut(): Promise<void> {
		return this.actor.resume('finish');
	}

	public restartFrame(frameActor: string): Promise<void> {
		return this.actor.resume('restart', frameActor);
	}

	public fetchAllStackFrames(): Promise<FrameAdapter[]> {

		if (!this.framesPromise) {
			this.framesPromise = (async () => {

				let frames = await this.actor.fetchStackFrames();

				let frameAdapters = frames.map((frame) =>
					new FrameAdapter(this.debugSession.frames, frame, this));

				let threadPausedReason = this.threadPausedReason;
				if ((threadPausedReason !== undefined) && (frameAdapters.length > 0)) {

					const scopeAdapters = await frameAdapters[0].getScopeAdapters();

					if (threadPausedReason.frameFinished !== undefined) {

						if (threadPausedReason.frameFinished.return !== undefined) {

							scopeAdapters[0].addReturnValue(
								threadPausedReason.frameFinished.return);

						} else if (threadPausedReason.frameFinished.throw !== undefined) {

							scopeAdapters.unshift(ScopeAdapter.fromGrip(
								'Exception', threadPausedReason.frameFinished.throw, frameAdapters[0]));
						}

					} else if (threadPausedReason.exception !== undefined) {

						scopeAdapters.unshift(ScopeAdapter.fromGrip(
							'Exception', threadPausedReason.exception, frameAdapters[0]));
					}
				}

				return frameAdapters;
			})();
		}

		return this.framesPromise;
	}

	public async fetchStackFrames(start: number, count: number): Promise<[FrameAdapter[], number]> {

		let frameAdapters = await this.fetchAllStackFrames();

		let requestedFrames = (count > 0) ? frameAdapters.slice(start, start + count) : frameAdapters.slice(start);

		return [requestedFrames, frameAdapters.length];
	}

	/** this will cause VS Code to reload the current stackframes from this adapter */
	public triggerStackframeRefresh(): void {
		this.debugSession.sendStoppedEvent(this, this.threadPausedReason);
	}

	public async fetchVariables(variablesProvider: VariablesProvider): Promise<Variable[]> {

		let variableAdapters = await variablesProvider.getVariables();

		return variableAdapters.map((variableAdapter) => variableAdapter.getVariable());
	}

	public evaluateRaw(expr: string, skipBreakpoints: boolean, frameActorName?: string): Promise<FirefoxDebugProtocol.Grip> {
		return this.consoleActor.evaluate(expr, skipBreakpoints, frameActorName);
	}

	public async evaluate(expr: string, skipBreakpoints: boolean, frameActorName?: string): Promise<Variable> {
		let grip = await this.consoleActor.evaluate(expr, skipBreakpoints, frameActorName);
		let variableAdapter = this.variableFromGrip(grip, true);
		return variableAdapter.getVariable();
	}

	public async autoComplete(text: string, column: number, frameActorName?: string): Promise<string[]> {
		return await this.consoleActor.autoComplete(text, column, frameActorName);
	}

	private variableFromGrip(grip: FirefoxDebugProtocol.Grip | undefined, threadLifetime: boolean): VariableAdapter {
		if (grip !== undefined) {
			return VariableAdapter.fromGrip('', undefined, undefined, grip, threadLifetime, this);
		} else {
			return new VariableAdapter('', undefined, undefined, 'undefined', this);
		}
	}

	/**
	 * Called by the `ThreadCoordinator` before resuming the thread
	 */
	public async disposePauseLifetimeAdapters(): Promise<void> {

		if (this.framesPromise) {
			let frames = await this.framesPromise;
			frames.forEach((frameAdapter) => {
				frameAdapter.dispose();
			});
			this.framesPromise = undefined;
		}

		this.scopes.forEach((scopeAdapter) => {
			scopeAdapter.dispose();
		});
		this.scopes = [];

		this.pauseLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
		});

		this.pauseLifetimeObjects = [];
	}

	public async dispose(): Promise<void> {

		await this.disposePauseLifetimeAdapters();

		this.threadLifetimeObjects.forEach((objectGripAdapter) => {
			objectGripAdapter.dispose();
		});

		for (const sourceActor of this.sourceActors) {
			this.debugSession.sources.removeActor(sourceActor);
			sourceActor.dispose();
		}

		this.actor.dispose();
		this.targetActor.dispose();
		this.consoleActor.dispose();

		this.debugSession.threads.unregister(this.id);
	}
}
