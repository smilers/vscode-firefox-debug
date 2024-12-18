import * as path from 'path';
import * as fs from 'fs-extra';
import { Socket } from 'net';
import { ChildProcess } from 'child_process';
import * as chokidar from 'chokidar';
import debounce from 'debounce';
import isAbsoluteUrl from 'is-absolute-url';
import { DebugProtocol } from 'vscode-debugprotocol';
import { InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, ThreadEvent, ContinuedEvent, Event } from 'vscode-debugadapter';
import { Log } from './util/log';
import { AddonManager } from './adapter/addonManager';
import { launchFirefox, openNewTab } from './firefox/launch';
import { DebugConnection } from './firefox/connection';
import { ObjectGripActorProxy } from './firefox/actorProxy/objectGrip';
import { LongStringGripActorProxy } from './firefox/actorProxy/longString';
import { AddonsActorProxy } from './firefox/actorProxy/addons';
import { IThreadActorProxy } from './firefox/actorProxy/thread';
import { ConsoleActorProxy } from './firefox/actorProxy/console';
import { ISourceActorProxy } from './firefox/actorProxy/source';
import { FrameAdapter } from './adapter/frame';
import { SourceAdapter } from './adapter/source';
import { VariablesProvider } from './adapter/variablesProvider';
import { VariableAdapter } from './adapter/variable';
import { Registry } from './adapter/registry';
import { ThreadAdapter } from './adapter/thread';
import { ConsoleAPICallAdapter } from './adapter/consoleAPICall';
import { BreakpointsManager } from './adapter/breakpointsManager';
import { DataBreakpointsManager } from './adapter/dataBreakpointsManager';
import { SkipFilesManager } from './adapter/skipFilesManager';
import { ParsedConfiguration } from './configuration';
import { PathMapper } from './util/pathMapper';
import { isWindowsPlatform as detectWindowsPlatform, delay } from '../common/util';
import { connect, waitForSocket } from './util/net';
import { NewSourceEventBody, ThreadStartedEventBody, ThreadExitedEventBody, RemoveSourcesEventBody } from '../common/customEvents';
import { PreferenceActorProxy } from './firefox/actorProxy/preference';
import { DeviceActorProxy } from './firefox/actorProxy/device';
import { TargetActorProxy } from './firefox/actorProxy/target';
import { BreakpointListActorProxy } from './firefox/actorProxy/breakpointList';
import { SourceMapsManager } from './firefox/sourceMaps/manager';
import { SourcesManager } from './adapter/sourcesManager';
import { ThreadConfigurationActorProxy } from './firefox/actorProxy/threadConfiguration';
import { DescriptorAdapter } from './adapter/descriptor';
import { DescriptorActorProxy } from './firefox/actorProxy/descriptor';

let log = Log.create('FirefoxDebugSession');
let consoleActorLog = Log.create('ConsoleActor');

export type ThreadConfiguration = Pick<
	FirefoxDebugProtocol.ThreadConfiguration,
	'pauseOnExceptions' | 'ignoreCaughtExceptions' | 'shouldPauseOnDebuggerStatement'
>;

export class FirefoxDebugSession {

	public readonly isWindowsPlatform = detectWindowsPlatform();
	public readonly pathMapper: PathMapper;
	public readonly sources: SourcesManager;
	public sourceMaps!: SourceMapsManager;
	public readonly breakpointsManager: BreakpointsManager;
	public readonly dataBreakpointsManager: DataBreakpointsManager;
	public readonly skipFilesManager: SkipFilesManager;
	public readonly addonManager?: AddonManager;
	private reloadWatcher?: chokidar.FSWatcher;

	private firefoxProc?: ChildProcess;
	private firefoxClosedPromise?: Promise<void>;
	public firefoxDebugConnection!: DebugConnection;
	private firefoxDebugSocketClosed = false;
	private firefoxDebugSocketClosedPromise?: Promise<void>;

	public preferenceActor!: PreferenceActorProxy;
	public addonsActor?: AddonsActorProxy;
	public deviceActor!: DeviceActorProxy;

	public readonly descriptors = new Registry<DescriptorAdapter>();
	public readonly threads = new Registry<ThreadAdapter>();
	public readonly frames = new Registry<FrameAdapter>();
	public readonly variablesProviders = new Registry<VariablesProvider>();
	public readonly breakpointLists = new Registry<BreakpointListActorProxy>();
	public readonly threadConfigurators = new Registry<ThreadConfigurationActorProxy>();
	private readonly threadsByTargetActorName = new Map<string, ThreadAdapter>();

	public threadConfiguration: ThreadConfiguration = {
		pauseOnExceptions: true,
		ignoreCaughtExceptions: true,
		shouldPauseOnDebuggerStatement: true,
	};

	private reloadTabs = false;

	/**
	 * The ID of the last thread that the user interacted with. This thread will be used when the
	 * user wants to evaluate an expression in VS Code's debug console.
	 */
	private lastActiveThreadId: number = 0;

	public constructor(
		public readonly config: ParsedConfiguration,
		public readonly sendEvent: (ev: DebugProtocol.Event) => void
	) {
		this.pathMapper = new PathMapper(this.config.pathMappings, this.config.addon);
		this.sources = new SourcesManager(this.pathMapper);
		this.breakpointsManager = new BreakpointsManager(this);
		this.dataBreakpointsManager = new DataBreakpointsManager(this.variablesProviders);
		this.skipFilesManager = new SkipFilesManager(this.config.filesToSkip, this.sources, this.threads);
		if (this.config.addon) {
			this.addonManager = new AddonManager(this);
		}
	}

	/**
	 * Connect to Firefox and start the debug session. Returns a Promise that is resolved when the
	 * initial response from Firefox was processed.
	 */
	public start(): Promise<void> {
		return new Promise<void>(async (resolve, reject) => {

			let socket: Socket;
			try {
				socket = await this.connectToFirefox();
			} catch(err: any) {
				if (!err?.message && this.config.attach) {
					reject(new Error(`Couldn't connect to Firefox - please ensure it is running and listening on port ${this.config.attach.port} for debugger connections`));
				} else {
					reject(err);
				}
				return;
			}

			this.firefoxDebugSocketClosedPromise = new Promise(resolve => {
				socket.once('close', () => {
					log.info('Connection to Firefox closed - terminating debug session');
					this.firefoxDebugSocketClosed = true;
					resolve();
					this.sendEvent(new TerminatedEvent());
				});
			});
			this.firefoxDebugConnection = new DebugConnection(this.pathMapper, socket);
			this.sourceMaps = this.firefoxDebugConnection.sourceMaps;
			let rootActor = this.firefoxDebugConnection.rootActor;

			// attach to all tabs, register the corresponding threads and inform VSCode about them
			rootActor.onTabOpened(async (tabDescriptorActor) => {

				if (this.reloadTabs) {
					await tabDescriptorActor.reload();
				}

				await this.attachDescriptor(tabDescriptorActor);
			});

			rootActor.onTabListChanged(() => {
				rootActor.fetchTabs();
			});

			rootActor.onInit(async (initialResponse) => {

				if (initialResponse.traits.webExtensionAddonConnect &&
					!initialResponse.traits.nativeLogpoints) {
					reject('Your version of Firefox is not supported anymore - please upgrade to Firefox 68 or later');
					return;
				}

				const actors = await rootActor.fetchRoot();

				this.preferenceActor = actors.preference;
				this.addonsActor = actors.addons;
				this.deviceActor = actors.device;

				if (this.addonManager) {
					if (actors.addons) {
						this.addonManager.sessionStarted(rootActor, actors.addons, actors.preference);
					} else {
						reject('No AddonsActor received from Firefox');
					}
				}

				await rootActor.fetchTabs();

				this.reloadTabs = false;

				if (this.config.attach && (this.threads.count === 0)) {
					if (!await openNewTab(this.config.attach, await this.deviceActor.getDescription())) {
						reject('None of the tabs opened in Firefox match the given URL. If you specify the path to Firefox by setting "firefoxExecutable" in your attach configuration, a new tab for the given URL will be opened automatically.');
						return;
					}
				}

				resolve();
			});

			if (this.config.reloadOnChange) {

				this.reloadWatcher = chokidar.watch(this.config.reloadOnChange.watch, {
					ignored: this.config.reloadOnChange.ignore,
					ignoreInitial: true
				});

				let reload: () => void;
				if (this.config.addon) {

					reload = () => {
						if (this.addonManager) {
							log.debug('Reloading add-on');

							this.addonManager.reloadAddon();
						}
					}

				} else {

					reload = () => {
						log.debug('Reloading tabs');

						for (let [, descriptor] of this.descriptors) {
							descriptor.descriptorActor.reload();
						}
					}
				}

				if (this.config.reloadOnChange.debounce > 0) {
					reload = debounce(reload, this.config.reloadOnChange.debounce);
				}

				this.reloadWatcher.on('add', reload);
				this.reloadWatcher.on('change', reload);
				this.reloadWatcher.on('unlink', reload);
			}

			// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
			this.sendEvent(new InitializedEvent());
		});
	}

	/**
	 * Terminate the debug session
	 */
	public async stop(): Promise<void> {
		await this.disconnectFirefoxAndCleanup();
	}

	public setThreadConfiguration(threadConfiguration: ThreadConfiguration) {

		this.threadConfiguration = threadConfiguration;

		for (let [, threadConfigurator] of this.threadConfigurators) {
			threadConfigurator.updateConfiguration(this.threadConfiguration);
		}
	}

	public setActiveThread(threadAdapter: ThreadAdapter): void {
		this.lastActiveThreadId = threadAdapter.id;
	}

	public getActiveThread(): ThreadAdapter | undefined {

		let threadAdapter = this.threads.find(this.lastActiveThreadId);
		if (threadAdapter !== undefined) {
			return threadAdapter;
		}

		// last active thread not found -> we return the first thread we get from the registry
		for (let [, threadAdapter] of this.threads) {
			this.setActiveThread(threadAdapter);
			return threadAdapter;
		}

		return undefined;
	}

	public getOrCreateObjectGripActorProxy(objectGrip: FirefoxDebugProtocol.ObjectGrip): ObjectGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(objectGrip.actor, () =>
			new ObjectGripActorProxy(objectGrip.actor, this.firefoxDebugConnection));
	}

	public getOrCreateLongStringGripActorProxy(longStringGrip: FirefoxDebugProtocol.LongStringGrip): LongStringGripActorProxy {
		return this.firefoxDebugConnection.getOrCreate(longStringGrip.actor, () =>
			new LongStringGripActorProxy(longStringGrip, this.firefoxDebugConnection));
	}

	private async connectToFirefox(): Promise<Socket> {

		let socket: Socket | undefined = undefined;

		if (this.config.attach) {
			try {

				socket = await connect(this.config.attach.port, this.config.attach.host);

				this.reloadTabs = this.config.attach.reloadTabs;

			} catch(err) {
				if (!this.config.launch) {
					throw err;
				}
			}
		}

		if (socket === undefined) {

			const firefoxProc = await launchFirefox(this.config.launch!);

			if (firefoxProc && !this.config.launch!.detached) {

				// set everything up so that Firefox can be terminated at the end of this debug session
				this.firefoxProc = firefoxProc;

				// firefoxProc may be a short-lived startup process - we remove the reference to it
				// when it exits so that we don't try to kill it with a SIGTERM signal (which may
				// end up killing an unrelated process) at the end of this debug session
				this.firefoxProc.once('exit', () => { this.firefoxProc = undefined; });

				// the `close` event from firefoxProc seems to be the only reliable notification
				// that Firefox is exiting
				this.firefoxClosedPromise = new Promise<void>(resolve => {
					this.firefoxProc!.once('close', resolve);
				});
			}

			socket = await waitForSocket(this.config.launch!.port, this.config.launch!.timeout);
		}

		return socket;
	}

	private async disconnectFirefoxAndCleanup(): Promise<void> {

		if (this.reloadWatcher !== undefined) {
			this.reloadWatcher.close();
			this.reloadWatcher = undefined;
		}

		if (!this.config.terminate) {
			await this.firefoxDebugConnection.disconnect();
			return;
		}

		if (this.firefoxProc) {

			log.debug('Trying to kill Firefox using a SIGTERM signal');
			this.firefoxProc.kill('SIGTERM');
			await Promise.race([ this.firefoxClosedPromise, delay(1000) ]);

		} else if (!this.firefoxDebugSocketClosed && this.addonsActor) {

			log.debug('Trying to close Firefox using the Terminator WebExtension');
			const terminatorPath = path.join(__dirname, 'terminator');
			await this.addonsActor.installAddon(terminatorPath);
			await Promise.race([ this.firefoxDebugSocketClosedPromise, delay(1000) ]);

		}

		if (!this.firefoxDebugSocketClosed) {
			log.warn("Couldn't terminate Firefox");
			await this.firefoxDebugConnection.disconnect();
			return;
		}

		if (this.config.launch && (this.config.launch.tmpDirs.length > 0)) {

			// after closing all connections to this debug adapter Firefox will still be using
			// the temporary profile directory for a short while before exiting
			await delay(500);

			log.debug("Removing " + this.config.launch.tmpDirs.join(" , "));
			try {
				await Promise.all(this.config.launch.tmpDirs.map(
					(tmpDir) => fs.remove(tmpDir)));
			} catch (err) {
				log.warn(`Failed to remove temporary directory: ${err}`);
			}
		}
	}

	public async attachDescriptor(descriptorActor: DescriptorActorProxy, isTab = true) {
		const watcherActor = await descriptorActor.getWatcher();
		const [configurator, breakpointList] = await Promise.all([
			watcherActor.getThreadConfiguration(),
			watcherActor.getBreakpointList()
		]);

		const adapter = new DescriptorAdapter(
			this.descriptors, this.threadConfigurators, this.breakpointLists,
			descriptorActor, watcherActor, configurator, breakpointList
		);

		if (isTab) {
			log.info(`Tab ${adapter.id} opened`);
		}

		descriptorActor.onDestroyed(() => {
			for (const threadAdapter of adapter.threads) {
				this.sendThreadExitedEvent(threadAdapter);
				this.threadsByTargetActorName.delete(threadAdapter.targetActor.name);
			}
			adapter.dispose();
		});

		watcherActor.onTargetAvailable(async ([targetActor, threadActor, consoleActor, url]) => {
			if (isTab &&
				(!this.config.tabFilter.include.some(tabFilter => tabFilter.test(url)) ||
				 this.config.tabFilter.exclude.some(tabFilter => tabFilter.test(url)))) {
				log.info('Not attaching to this thread');
				return;
			}

			const threadAdapter = await this.attachThread(targetActor, threadActor, consoleActor, `Tab ${adapter.id}`, url);
			adapter.threads.add(threadAdapter);
		});

		watcherActor.onTargetDestroyed(targetActorName => {
			const threadAdapter = this.threadsByTargetActorName.get(targetActorName);
			if (!threadAdapter) {
				log.debug(`Unknown target actor ${targetActorName} (already destroyed?)`);
				return;
			}
	
			this.sendThreadExitedEvent(threadAdapter);
			this.threadsByTargetActorName.delete(targetActorName);
			adapter.threads.delete(threadAdapter);
			threadAdapter.dispose();
		});

		await Promise.all([
			watcherActor.watchTargets('frame'),
			watcherActor.watchTargets('worker'),
			watcherActor.watchResources(['console-message', 'error-message', 'source', 'thread-state']),
			configurator.updateConfiguration(this.threadConfiguration)
		]);
	}

	private async attachThread(
		targetActor: TargetActorProxy,
		threadActor: IThreadActorProxy,
		consoleActor: ConsoleActorProxy,
		name: string,
		url: string
	) {
		const threadAdapter = new ThreadAdapter(threadActor, targetActor, consoleActor, name, url, this);
		this.threadsByTargetActorName.set(targetActor.name, threadAdapter);

		this.sendThreadStartedEvent(threadAdapter);

		targetActor.onConsoleMessages(async messages => {
			for (const message of messages) {
				await this.sendConsoleMessage(message, threadAdapter);
			}
		});

		targetActor.onErrorMessages(async messages => {
			for (const { pageError } of messages) {
				consoleActorLog.debug(`Page Error: ${JSON.stringify(pageError)}`);

				if (pageError.category === 'content javascript') {
	
					let category = pageError.exception ? 'stderr' : 'stdout';
					let outputEvent = new OutputEvent(pageError.errorMessage + '\n', category);
					await this.addLocation(outputEvent, pageError.sourceName, pageError.lineNumber, pageError.columnNumber);
	
					this.sendEvent(outputEvent);
				}
			}
		});

		targetActor.onSources(sources => {
			for (const source of sources) {
				this.attachSource(source, threadAdapter);
			}
		});

		targetActor.onThreadState(async event => {
			if (event.state === 'paused') {

				await this.sourceMaps.applySourceMapToFrame(event.frame!);
				const sourceLocation = event.frame!.where;

				try {
	
					const sourceAdapter = await this.sources.getAdapterForActor(sourceLocation.actor);

					if (sourceAdapter.isBlackBoxed) {
	
						// skipping (or blackboxing) source files is usually done by Firefox itself,
						// but when the debugger hits an exception in a source that was just loaded and
						// should be skipped, we may not have been able to tell Firefox that we want
						// to skip this file, so we have to do it here
						threadAdapter.resume();
						return;
	
					}
	
					if ((event.why?.type === 'breakpoint') &&
						event.why.actors && (event.why.actors.length > 0) &&
						sourceAdapter.path
					) {
	
						const breakpointInfo = this.breakpointsManager.getBreakpoints(sourceAdapter.path)?.find(bpInfo =>
							bpInfo.actualLocation && bpInfo.actualLocation.line === sourceLocation.line && bpInfo.actualLocation.column === sourceLocation.column
						);
	
						if (breakpointInfo?.hitLimit) {
	
							// Firefox doesn't have breakpoints with hit counts, so we have to
							// implement this here
							breakpointInfo.hitCount++;
							if (breakpointInfo.hitCount < breakpointInfo.hitLimit) {
	
								threadAdapter.resume();
								return;
	
							}
						}
					}
				} catch(err) {
					log.warn(String(err));
				}
	
				if (event.why?.type === 'exception') {
	
					let frames = await threadAdapter.fetchAllStackFrames();
					// TODO use the frame from the paused event?
					let startFrame = (frames.length > 0) ? frames[frames.length - 1] : undefined;
					if (startFrame) {
						try {
	
							const sourceAdapter = await this.sources.getAdapterForActor(startFrame.frame.where.actor);
	
							if (sourceAdapter.introductionType === 'debugger eval') {
	
								// skip exceptions triggered by debugger eval code
								threadAdapter.resume();
								return;
		
							}
						} catch(err) {
							log.warn(String(err));
						}
					}
				}
	
				threadAdapter.threadPausedReason = event.why;
				// pre-fetch the stackframes, we're going to need them later
				threadAdapter.fetchAllStackFrames();

				log.info(`Thread ${threadActor.name} paused , reason: ${event.why?.type}`);
				this.sendStoppedEvent(threadAdapter, event.why);
			}
			if (event.state === 'resumed') {
				log.info(`Thread ${threadActor.name} resumed`);
				// TODO we really want to do this synchronously,
				// otherwise we may process the next pause before this has finished
				await threadAdapter.disposePauseLifetimeAdapters();
				this.sendEvent(new ContinuedEvent(threadAdapter.id));
			}
		});

		return threadAdapter;
	}

	private attachSource(sourceActor: ISourceActorProxy, threadAdapter: ThreadAdapter): void {

		const sourceAdapter = this.sources.addActor(sourceActor);

		// check if this source should be skipped
		const source = sourceActor.source;
		let skipThisSource: boolean | undefined = undefined;
		if (sourceAdapter.path !== undefined) {
			skipThisSource = this.skipFilesManager.shouldSkip(sourceAdapter.path);
		} else if (source.generatedUrl && (!source.url || !isAbsoluteUrl(source.url))) {
			skipThisSource = this.skipFilesManager.shouldSkip(this.pathMapper.removeQueryString(source.generatedUrl));
		} else if (source.url) {
			skipThisSource = this.skipFilesManager.shouldSkip(this.pathMapper.removeQueryString(source.url));
		}

		if (skipThisSource !== undefined) {
			if (skipThisSource !== sourceAdapter.isBlackBoxed) {
				sourceAdapter.setBlackBoxed(skipThisSource);
			} else if (skipThisSource) {
				sourceActor.setBlackbox(skipThisSource);
			}
		}

		threadAdapter.sourceActors.add(sourceActor);

		this.sendNewSourceEvent(threadAdapter, sourceAdapter);
	}

	private async sendConsoleMessage(message: FirefoxDebugProtocol.ConsoleMessage, threadAdapter: ThreadAdapter) {
		consoleActorLog.debug(`Console API: ${JSON.stringify(message)}`);

		if (message.level === 'clear') {
			this.sendEvent(new OutputEvent('\x1b[2J'));
			return;
		}

		if (message.level === 'time' && !message.timer?.error) {
			// Match what is done in Firefox console and don't show anything when the timer starts
			return;
		}

		let category = (message.level === 'error') ? 'stderr' :
			(message.level === 'warn') ? 'console' : 'stdout';

		let outputEvent: DebugProtocol.OutputEvent;

		if (message.level === 'time' && message.timer?.error === "timerAlreadyExists") {
			outputEvent = new OutputEvent(`Timer “${message.timer.name}” already exists`, 'console');
		} else if (
			(message.level === 'timeLog' || message.level === 'timeEnd') &&
			message.timer?.error === "timerDoesntExist"
		) {
			outputEvent = new OutputEvent(`Timer “${message.timer.name}” doesn't exist`, 'console');
		} else if (message.level === 'timeLog' && message.timer?.duration !== undefined) {
			const args = message.arguments.map((grip, index) => {
				// The first argument is the timer name
				if (index === 0) {
					return new VariableAdapter(
						String(index),
						undefined,
						undefined,
						`${message.timer.name}: ${message.timer.duration}ms`,
						threadAdapter
					);
				}

				if (typeof grip !== 'object') {
					return new VariableAdapter(String(index), undefined, undefined, String(grip), threadAdapter);
				}

				return VariableAdapter.fromGrip(String(index), undefined, undefined, grip, true, threadAdapter);
			});

			let { variablesProviderId } = new ConsoleAPICallAdapter(args, threadAdapter);
			outputEvent = new OutputEvent('', 'stdout');
			outputEvent.body.variablesReference = variablesProviderId;
		} else if (message.level === 'timeEnd' && message.timer?.duration !== undefined) {
			outputEvent = new OutputEvent(`${message.timer.name}: ${message.timer.duration}ms - timer ended`, 'stdout');
		} else if ((message.arguments.length === 1) && (typeof message.arguments[0] !== 'object')) {

			let msg = String(message.arguments[0]);
			if (this.config.showConsoleCallLocation) {
				let filename = this.pathMapper.convertFirefoxUrlToPath(message.filename);
				msg += ` (${filename}:${message.lineNumber}:${message.columnNumber})`;
			}

			outputEvent = new OutputEvent(msg + '\n', category);

		} else {

			let args = message.arguments.map((grip, index) => {
				if (typeof grip !== 'object') {
					return new VariableAdapter(String(index), undefined, undefined, String(grip), threadAdapter);
				} else {
					return VariableAdapter.fromGrip(String(index), undefined, undefined, grip, true, threadAdapter);
				}
			});

			if ((message.level === 'logPoint') && (args[args.length - 1].displayValue === '')) {
				args.pop();
			}

			if (this.config.showConsoleCallLocation) {
				let filename = this.pathMapper.convertFirefoxUrlToPath(message.filename);
				let locationVar = new VariableAdapter(
					'location', undefined, undefined,
					`(${filename}:${message.lineNumber}:${message.columnNumber})`,
					threadAdapter);
				args.push(locationVar);
			}

			let argsAdapter = new ConsoleAPICallAdapter(args, threadAdapter);

			outputEvent = new OutputEvent('', category);
			outputEvent.body.variablesReference = argsAdapter.variablesProviderId;
		}

		await this.addLocation(outputEvent, message.filename, message.lineNumber, message.columnNumber);

		this.sendEvent(outputEvent);
	}

	private async addLocation(
		outputEvent: DebugProtocol.OutputEvent,
		url: string,
		line: number,
		column: number
	) {

		for (let [, thread] of this.threads) {
			let originalSourceLocation = await thread.findOriginalSourceLocation(url, line, column);
			if (originalSourceLocation) {
				const sourceAdapter = originalSourceLocation.source;
				outputEvent.body.source = sourceAdapter.source;
				outputEvent.body.line = originalSourceLocation.line;
				outputEvent.body.column = originalSourceLocation.column;
				return;
			}
		}
	}

	public sendStoppedEvent(
		threadAdapter: ThreadAdapter,
		reason?: FirefoxDebugProtocol.ThreadPausedReason
	): void {

		let pauseType = reason ? reason.type : 'interrupt';
		let stoppedEvent: DebugProtocol.StoppedEvent = new StoppedEvent(pauseType, threadAdapter.id);
		stoppedEvent.body.allThreadsStopped = false;

		if (reason && reason.exception) {

			if (typeof reason.exception === 'string') {

				stoppedEvent.body.text = reason.exception;

			} else if ((typeof reason.exception === 'object') && (reason.exception.type === 'object')) {

				let exceptionGrip = <FirefoxDebugProtocol.ObjectGrip>reason.exception;
				if (exceptionGrip.preview && (exceptionGrip.preview.kind === 'Error')) {
					stoppedEvent.body.text = `${exceptionGrip.class}: ${exceptionGrip.preview.message}`;
				} else {
					stoppedEvent.body.text = exceptionGrip.class;
				}
			}
		}

		this.sendEvent(stoppedEvent);
	}

	/** tell VS Code and the [Loaded Scripts Explorer](../extension/loadedScripts) about a new thread */
	private sendThreadStartedEvent(threadAdapter: ThreadAdapter): void {
		this.sendEvent(new ThreadEvent('started', threadAdapter.id));
		this.sendEvent(new Event('threadStarted', <ThreadStartedEventBody>{
			name: threadAdapter.name,
			id: threadAdapter.id
		}));
	}

	/** tell VS Code and the [Loaded Scripts Explorer](../extension/loadedScripts) to remove a thread */
	private sendThreadExitedEvent(threadAdapter: ThreadAdapter): void {
		this.sendEvent(new ThreadEvent('exited', threadAdapter.id));
		this.sendEvent(new Event('threadExited', <ThreadExitedEventBody>{
			id: threadAdapter.id
		}));
	}

	/** tell the [Loaded Scripts Explorer](../extension/loadedScripts) about a new source */
	private sendNewSourceEvent(threadAdapter: ThreadAdapter, sourceAdapter: SourceAdapter): void {

		const sourceUrl = sourceAdapter.url;

		if (sourceUrl && !sourceUrl.startsWith('javascript:')) {
			this.sendEvent(new Event('newSource', <NewSourceEventBody>{
				threadId: threadAdapter.id,
				sourceId: sourceAdapter.id,
				url: sourceUrl,
				path: sourceAdapter.path
			}));
		}
	}

	public sendCustomEvent(event: string, eventBody: any): void {
		this.sendEvent(new Event(event, eventBody));
	}
}
