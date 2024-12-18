import { Log } from '../../util/log';
import { DescriptorActorProxy } from './descriptor';
import { PreferenceActorProxy } from './preference';
import { AddonsActorProxy } from './addons';
import { DeviceActorProxy } from './device';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';
import { delay } from '../../../common/util';

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
export class RootActorProxy extends BaseActorProxy {

	private tabs = new Map<string, DescriptorActorProxy>();

	constructor(connection: DebugConnection) {
		super('root', connection, log);
	}

	isEvent(message: FirefoxDebugProtocol.Response): boolean {
		return !!(message.type || message.applicationType);
	}

	public async fetchRoot(): Promise<FetchRootResult> {
		const rootResponse: FirefoxDebugProtocol.RootResponse = await this.sendCachedRequest(
			'getRoot',
			{ type: 'getRoot' }
		);

		const preferenceActor = this.connection.getOrCreate(rootResponse.preferenceActor,
			() => new PreferenceActorProxy(rootResponse.preferenceActor, this.connection));

		let addonsActor: AddonsActorProxy | undefined;
		const addonsActorName = rootResponse.addonsActor;
		if (addonsActorName) {
			addonsActor = this.connection.getOrCreate(addonsActorName,
				() => new AddonsActorProxy(addonsActorName, this.connection));
		}

		const deviceActor = this.connection.getOrCreate(rootResponse.deviceActor,
			() => new DeviceActorProxy(rootResponse.deviceActor, this.connection));

		return { 
			preference: preferenceActor,
			addons: addonsActor,
			device: deviceActor
		};
	}

	public async fetchTabs(): Promise<Map<string, DescriptorActorProxy>> {
		let tabsResponse: FirefoxDebugProtocol.TabsResponse = await this.sendRequest({ type: 'listTabs' });
		while (tabsResponse.tabs.length === 0) {
			await delay(100);
			tabsResponse = await this.sendRequest({ type: 'listTabs' });
		}

		log.debug(`Received ${tabsResponse.tabs.length} tabs`);

		// convert the Tab array into a map of TabDescriptorActorProxies, re-using already 
		// existing proxies and emitting tabOpened events for new ones
		const currentTabs = new Map<string, DescriptorActorProxy>();
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

		return currentTabs;
	}

	public async fetchAddons(): Promise<FirefoxDebugProtocol.Addon[]> {
		const addonsResponse: FirefoxDebugProtocol.AddonsResponse = await this.sendRequest({ type: 'listAddons' });
		return addonsResponse.addons;
	}

	handleEvent(event: FirefoxDebugProtocol.Event): void {
		if (event.applicationType) {
			this.emit('init', event);
		} else if (['tabListChanged', 'addonListChanged'].includes(event.type)) {
			this.emit(event.type);
		} else if (event.type !== 'forwardingCancelled') {
			log.warn(`Unknown message: ${JSON.stringify(event)}`);
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
