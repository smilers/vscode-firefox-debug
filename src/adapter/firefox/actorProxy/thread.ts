import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequest, PendingRequests } from '../../util/pendingRequests';
import { ActorProxy } from './interface';

let log = Log.create('ThreadActorProxy');

export interface IThreadActorProxy {
	name: string;
	resume(resumeLimitType?: 'next' | 'step' | 'finish' | 'restart', frameActorID?: string): Promise<void>;
	interrupt(immediately?: boolean): Promise<void>;
	fetchStackFrames(start?: number, count?: number): Promise<FirefoxDebugProtocol.Frame[]>;
	pauseOnExceptions(pauseOnExceptions: boolean, ignoreCaughtExceptions: boolean): Promise<void>;
	onExited(cb: () => void): void;
	onWrongState(cb: () => void): void;
	onNewGlobal(cb: () => void): void;
	dispose(): void;
}

/**
 * A ThreadActorProxy is a proxy for a "thread-like actor" (a Tab, Worker or Addon) in Firefox
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#interacting-with-thread-like-actors),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/thread.js))
 */
export class ThreadActorProxy extends EventEmitter implements ActorProxy, IThreadActorProxy {

	constructor(
		public readonly name: string,
		private connection: DebugConnection
	) {
		super();
		this.connection.register(this);
		log.debug(`Created thread ${this.name}`);
	}

	private pendingResumeRequest?: PendingRequest<void>;
	private resumePromise?: Promise<void>;
	private pendingInterruptRequest?: PendingRequest<void>;
	private interruptPromise?: Promise<void>;

	private pendingStackFramesRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();
	private pendingEmptyResponseRequests = new PendingRequests<void>();

	/**
	 * Resume the thread if it is paused
	 */
	public resume(resumeLimitType?: 'next' | 'step' | 'finish' | 'restart', frameActorID?: string): Promise<void> {
		if (resumeLimitType === 'restart' && !frameActorID) {
			throw new Error('Restart frame requested without a frameActor');
		}

		if (!this.resumePromise) {
			log.debug(`Resuming thread ${this.name}`);

			let resumeLimit = resumeLimitType ? { type: resumeLimitType } : undefined;

			this.resumePromise = new Promise<void>((resolve, reject) => {
				this.pendingResumeRequest = { resolve, reject };
				this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit, frameActorID });
			});
			this.interruptPromise = undefined;

		}

		return this.resumePromise;
	}

	/**
	 * Interrupt the thread if it is running
	 */
	public interrupt(immediately = true): Promise<void> {

		if (!this.interruptPromise) {
			log.debug(`Interrupting thread ${this.name}`);

			this.interruptPromise = new Promise<void>((resolve, reject) => {
				this.pendingInterruptRequest = { resolve, reject };
				this.connection.sendRequest({
					to: this.name, type: 'interrupt',
					when: immediately ? '' : 'onNext'
				});
			});
			this.resumePromise = undefined;

		}

		return this.interruptPromise;
	}

	public pauseOnExceptions(pauseOnExceptions: boolean, ignoreCaughtExceptions: boolean): Promise<void> {
		log.debug(`Setting pauseOnException=${pauseOnExceptions}, ignoreCaughtExceptions=${ignoreCaughtExceptions}`);

		return new Promise<void>((resolve, reject) => {
			this.pendingEmptyResponseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({
				to: this.name, type: 'pauseOnExceptions',
				pauseOnExceptions, ignoreCaughtExceptions
			});
		})
	}

	/**
	 * Fetch StackFrames. This can only be called while the thread is paused.
	 */
	public fetchStackFrames(start = 0, count = 1000): Promise<FirefoxDebugProtocol.Frame[]> {
		log.debug(`Fetching stackframes from thread ${this.name}`);

		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingStackFramesRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({
				to: this.name, type: 'frames',
				start, count
			});
		});
	}

	public dispose(): void {
		this.connection.unregister(this);
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['type'] === 'paused') {

			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			log.debug(`Received paused message of type ${pausedResponse.why.type}`);

			switch (pausedResponse.why.type) {
				case 'attached':
					break;

				case 'interrupted':
				case 'alreadyPaused':
					if (this.pendingInterruptRequest) {
						this.pendingInterruptRequest.resolve(undefined);
						this.pendingInterruptRequest = undefined;
					} else if (pausedResponse.why.type !== 'alreadyPaused') {
						log.warn(`Received ${pausedResponse.why.type} message without pending request`);
					}
					break;

				case 'resumeLimit':
				case 'breakpoint':
				case 'watchpoint':
				case 'getWatchpoint':
				case 'setWatchpoint':
				case 'exception':
				case 'debuggerStatement':
					if (this.pendingInterruptRequest) {
						this.pendingInterruptRequest.resolve(undefined);
						this.pendingInterruptRequest = undefined;
					} else {
						this.interruptPromise = Promise.resolve(undefined);
					}
					if (this.pendingResumeRequest) {
						this.pendingResumeRequest.reject(`Hit ${pausedResponse.why.type}`);
						this.pendingResumeRequest = undefined;
					}
					this.resumePromise = undefined;
					this.emit('paused', pausedResponse);
					break;

				case 'clientEvaluated':
					log.warn('Received clientEvaluated message without a request');
					break;

				default:
					log.warn(`Paused event with reason ${pausedResponse.why.type} not handled yet`);
					this.emit('paused', pausedResponse);
					break;
			}

		} else if (response['type'] === 'resumed') {

			if (this.pendingResumeRequest) {
				log.debug(`Received resumed event from ${this.name}`);
				this.pendingResumeRequest.resolve(undefined);
				this.pendingResumeRequest = undefined;
			} else {
				log.debug(`Received unexpected resumed event from ${this.name}`);
				this.interruptPromise = undefined;
				this.resumePromise = Promise.resolve(undefined);
				this.emit('resumed');
			}

		} else if (response['frames']) {

			let frames = <FirefoxDebugProtocol.Frame[]>(response['frames']);
			log.debug(`Received ${frames.length} frames from thread ${this.name}`);
			this.pendingStackFramesRequests.resolveOne(frames);

		} else if (response['type'] === 'newGlobal') {

			this.emit('newGlobal');

		} else if (response['type'] === 'exited') {

			log.debug(`Thread ${this.name} exited`);
			this.emit('exited');
			//TODO send release packet(?)

		} else if (response['error'] === 'wrongState') {

			log.warn(`Thread ${this.name} was in the wrong state for the last request`);
			//TODO reject last request!
			this.emit('wrongState');

		} else if (response['error'] === 'wrongOrder') {

			log.warn(`got wrongOrder error: ${response['message']}`);
			this.resumePromise = undefined;
			if (this.pendingResumeRequest) {
				this.pendingResumeRequest.reject(`You need to resume ${response['lastPausedUrl']} first`);
			}

		} else if (response['error'] === 'noSuchActor') {

			log.error(`No such actor ${JSON.stringify(this.name)}`);
			if (this.pendingInterruptRequest) {
				this.pendingInterruptRequest.reject('No such actor');
			}
			if (this.pendingResumeRequest) {
				this.pendingResumeRequest.reject('No such actor');
			}
			this.pendingStackFramesRequests.rejectAll('No such actor');

		} else if (response['error'] === 'unknownFrame') {

			let errorMsg = response['message']
			log.error(`Error evaluating expression: ${errorMsg}`);

		} else {

			let propertyCount = Object.keys(response).length;
			if (propertyCount === 1) {

				if (this.pendingEmptyResponseRequests.isEmpty()) {
					log.debug('Received unexpected response, this is probably due to Firefox bug #1577996');
				} else {
					log.debug('Received setBreakpoint or removeBreakpoint or pauseOnExceptions response');
					this.pendingEmptyResponseRequests.resolveOne(undefined);
				}

			} else if ((response['type'] === 'willInterrupt') || (response['type'] === 'interrupt')) {
				log.debug(`Received ${response['type']} event from ${this.name} (ignoring)`);
			} else {
				log.warn("Unknown message from ThreadActor: " + JSON.stringify(response));
			}

		}

	}
	
	public onExited(cb: () => void) {
		this.on('exited', cb);
	}

	public onWrongState(cb: () => void) {
		this.on('wrongState', cb);
	}

	public onNewGlobal(cb: () => void) {
		this.on('newGlobal', cb);
	}
}
