import { Log } from '../../util/log';
import { EventEmitter } from 'events';
import { PendingRequests, PendingRequest } from '../../util/pendingRequests';
import { ActorProxy } from './interface';
import { DescriptorActorProxy } from './descriptor';
import { PreferenceActorProxy } from './preference';
import { AddonsActorProxy } from './addons';
import { DeviceActorProxy } from './device';
import { DebugConnection } from '../connection';

let log = Log.create('RootActorProxy');

export interface FetchRootResult {
	preference: PreferenceActorProxy,
	addons: AddonsActorProxy | undefined,
	device: DeviceActorProxy
}

/**
 * Proxy class for a root actor
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#the-root-actor),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/root.js))
 */
export class RootActorProxy extends EventEmitter implements ActorProxy {

	private tabs = new Map<string, DescriptorActorProxy>();
	private pendingRootRequest?: PendingRequest<FetchRootResult>;
	private rootPromise?: Promise<FetchRootResult>;
	private pendingTabsRequests = new PendingRequests<Map<string, DescriptorActorProxy>>();
	private pendingAddonsRequests = new PendingRequests<FirefoxDebugProtocol.Addon[]>();

	constructor(
		private readonly enableCRAWorkaround: boolean,
		private readonly connection: DebugConnection
	) {
		super();
		this.connection.register(this);
	}

	public get name() {
		return 'root';
	}

	public fetchRoot(): Promise<FetchRootResult> {
		if (!this.rootPromise) {

			log.debug('Fetching root');

			this.rootPromise = new Promise<FetchRootResult>((resolve, reject) => {
				this.pendingRootRequest = { resolve, reject };
				this.connection.sendRequest({ to: this.name, type: 'getRoot' });
			});
		}

		return this.rootPromise;
	}

	public fetchTabs(): Promise<Map<string, DescriptorActorProxy>> {

		log.debug('Fetching tabs');

		return new Promise<Map<string, DescriptorActorProxy>>((resolve, reject) => {
			this.pendingTabsRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'listTabs' });
		})
	}

	public fetchAddons(): Promise<FirefoxDebugProtocol.Addon[]> {

		log.debug('Fetching addons');

		return new Promise<FirefoxDebugProtocol.Addon[]>((resolve, reject) => {
			this.pendingAddonsRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'listAddons' });
		})
	}

	public receiveResponse(response: FirefoxDebugProtocol.Response): void {

		if (response['applicationType']) {

			this.emit('init', response);

		} else if (response['tabs']) {

			let tabsResponse = <FirefoxDebugProtocol.TabsResponse>response;
			let currentTabs = new Map<string, DescriptorActorProxy>();

			// sometimes Firefox returns 0 tabs if the listTabs request was sent 
			// shortly after launching it
			if (tabsResponse.tabs.length === 0) {
				log.info('Received 0 tabs - will retry in 100ms');

				setTimeout(() => {
					this.connection.sendRequest({ to: this.name, type: 'listTabs' });
				}, 100);

				return;
			}

			log.debug(`Received ${tabsResponse.tabs.length} tabs`);

			// convert the Tab array into a map of TabDescriptorActorProxies, re-using already 
			// existing proxies and emitting tabOpened events for new ones
			for (const tab of tabsResponse.tabs) {
				let tabDescriptorActor: DescriptorActorProxy;
				if (this.tabs.has(tab.actor)) {

					tabDescriptorActor = this.tabs.get(tab.actor)!;

				} else {

					log.debug(`Tab ${tab.actor} opened`);

					tabDescriptorActor = new DescriptorActorProxy(tab.actor, this.connection);

					this.emit('tabOpened', tabDescriptorActor);
				}

				currentTabs.set(tab.actor, tabDescriptorActor);
			}

			// emit tabClosed events for tabs that have disappeared
			this.tabs.forEach((actorsForTab, tabActorName) => {
				if (!currentTabs.has(tabActorName)) {
					log.debug(`Tab ${tabActorName} closed`);
					this.emit('tabClosed', actorsForTab);
				}
			});

			this.tabs = currentTabs;
	
			this.pendingTabsRequests.resolveOne(currentTabs);

		} else if (response['preferenceActor']) {

			log.debug('Received root response');

			let rootResponse = <FirefoxDebugProtocol.RootResponse>response;
			if (this.pendingRootRequest) {

				let preferenceActor = this.connection.getOrCreate(rootResponse.preferenceActor,
					() => new PreferenceActorProxy(rootResponse.preferenceActor, this.connection));
	
				let addonsActor: AddonsActorProxy | undefined;
				const addonsActorName = rootResponse.addonsActor;
				if (addonsActorName) {
					addonsActor = this.connection.getOrCreate(addonsActorName,
						() => new AddonsActorProxy(addonsActorName, this.connection));
				}

				const deviceActor = this.connection.getOrCreate(rootResponse.deviceActor,
					() => new DeviceActorProxy(rootResponse.deviceActor, this.connection));

				this.pendingRootRequest.resolve({ 
					preference: preferenceActor,
					addons: addonsActor,
					device: deviceActor
				});
				this.pendingRootRequest = undefined;

			} else {
				log.warn('Received root response without a corresponding request');
			}

		} else if (response['type'] === 'tabListChanged') {

			log.debug('Received tabListChanged event');
			
			this.emit('tabListChanged');

		} else if (response['addons']) {

			let addonsResponse = <FirefoxDebugProtocol.AddonsResponse>response;
			log.debug(`Received ${addonsResponse.addons.length} addons`);
			this.pendingAddonsRequests.resolveOne(addonsResponse.addons);

		} else if (response['type'] === 'addonListChanged') {

			log.debug('Received addonListChanged event');
			
			this.emit('addonListChanged');

		} else {

			if (response['type'] === 'forwardingCancelled') {
				log.debug(`Received forwardingCancelled event from ${this.name} (ignoring)`);
			} else {
				log.warn("Unknown message from RootActor: " + JSON.stringify(response));
			}

		}
	}

	public onInit(cb: (response: FirefoxDebugProtocol.InitialResponse) => void) {
		this.on('init', cb);
	}

	public onTabOpened(cb: (actorsForTab: DescriptorActorProxy) => void) {
		this.on('tabOpened', cb);
	}

	public onTabClosed(cb: (actorsForTab: DescriptorActorProxy) => void) {
		this.on('tabClosed', cb);
	}

	public onTabListChanged(cb: () => void) {
		this.on('tabListChanged', cb);
	}

	public onAddonListChanged(cb: () => void) {
		this.on('addonListChanged', cb);
	}
}
