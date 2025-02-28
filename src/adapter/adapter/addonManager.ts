import { Log } from '../util/log';
import * as path from 'path';
import { ParsedAddonConfiguration } from '../configuration';
import { RootActorProxy } from '../firefox/actorProxy/root';
import { AddonsActorProxy } from '../firefox/actorProxy/addons';
import { PreferenceActorProxy } from '../firefox/actorProxy/preference';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { PopupAutohideEventBody } from '../../common/customEvents';
import { isWindowsPlatform } from '../../common/util';
import { DescriptorActorProxy } from '../firefox/actorProxy/descriptor';

const log = Log.create('AddonManager');

export const popupAutohidePreferenceKey = 'ui.popup.disable_autohide';

/**
 * When debugging a WebExtension, this class installs the WebExtension, attaches to it, reloads it
 * when desired and tells the [`PopupAutohideManager`](../../extension/popupAutohideManager.ts) the
 * initial state of the popup auto-hide flag by sending a custom event.
 */
export class AddonManager {

	private resolveAddonId!: (addonId: string) => void;
	public readonly addonId = new Promise<string>(resolve => this.resolveAddonId = resolve);

	private readonly config: ParsedAddonConfiguration;

	private descriptorActor: DescriptorActorProxy | undefined = undefined;

	constructor(
		private readonly debugSession: FirefoxDebugSession
	) {
		this.config = debugSession.config.addon!;
	}

	public async sessionStarted(
		rootActor: RootActorProxy,
		addonsActor: AddonsActorProxy,
		preferenceActor: PreferenceActorProxy
	): Promise<void> {

		const addonPath = isWindowsPlatform() ? path.normalize(this.config.path) : this.config.path;
		let result = await addonsActor.installAddon(addonPath);
		this.resolveAddonId(result.addon.id);

		await this.fetchDescriptor(rootActor);

		if (this.config.popupAutohideButton) {
			const popupAutohide = !(await preferenceActor.getBoolPref(popupAutohidePreferenceKey));
			this.debugSession.sendCustomEvent('popupAutohide', <PopupAutohideEventBody>{ popupAutohide });
		}
	}

	public async reloadAddon(): Promise<void> {
		if (!this.descriptorActor) {
			throw 'Addon isn\'t attached';
		}

		await this.descriptorActor.reload();
	}

	private async fetchDescriptor(rootActor: RootActorProxy): Promise<void> {

		const addons = await rootActor.fetchAddons();

		addons.forEach(async addon => {
			if (addon.id === await this.addonId) {
				this.descriptorActor = new DescriptorActorProxy(
					addon.actor,
					'webExtension',
					this.debugSession.firefoxDebugConnection
				);

				if (!this.debugSession.processDescriptorMode) {
					const adapter = await this.debugSession.attachDescriptor(this.descriptorActor);
					await adapter.watcherActor.watchResources(['console-message', 'error-message', 'source', 'thread-state']);
				}
			}
		});
	}
}
