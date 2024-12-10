import { Log } from '../util/log';
import * as path from 'path';
import { ParsedAddonConfiguration } from '../configuration';
import { RootActorProxy } from '../firefox/actorProxy/root';
import { AddonsActorProxy } from '../firefox/actorProxy/addons';
import { PreferenceActorProxy } from '../firefox/actorProxy/preference';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { PopupAutohideEventBody } from '../../common/customEvents';
import { isWindowsPlatform } from '../../common/util';
import { TargetActorProxy } from '../firefox/actorProxy/target';
import { DescriptorActorProxy } from '../firefox/actorProxy/descriptor';

const log = Log.create('AddonManager');

export const popupAutohidePreferenceKey = 'ui.popup.disable_autohide';

/**
 * When debugging a WebExtension, this class installs the WebExtension, attaches to it, reloads it
 * when desired and tells the [`PopupAutohideManager`](../../extension/popupAutohideManager.ts) the
 * initial state of the popup auto-hide flag by sending a custom event.
 */
export class AddonManager {

	private readonly config: ParsedAddonConfiguration;

	private addonAttached = false;
	private descriptorActor: DescriptorActorProxy | undefined = undefined;
	private targetActor: TargetActorProxy | undefined = undefined;

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
		if (!this.config.id) {
			this.config.id = result.addon.id;
		}

		this.fetchAddonsAndAttach(rootActor);

		if (this.config.popupAutohideButton) {
			const popupAutohide = !(await preferenceActor.getBoolPref(popupAutohidePreferenceKey));
			this.debugSession.sendCustomEvent('popupAutohide', <PopupAutohideEventBody>{ popupAutohide });
		}
	}

	public async reloadAddon(): Promise<void> {
		if (!this.targetActor) {
			throw 'Addon isn\'t attached';
		}

		await this.descriptorActor?.reload();
	}

	private async fetchAddonsAndAttach(rootActor: RootActorProxy): Promise<void> {

		if (this.addonAttached) return;

		let addons = await rootActor.fetchAddons();

		if (this.addonAttached) return;

		addons.forEach((addon) => {
			if (addon.id === this.config.id) {
				(async () => {

					this.descriptorActor = new DescriptorActorProxy(
						addon.actor,
						this.debugSession.firefoxDebugConnection
					);

					await this.debugSession.attachDescriptor(this.descriptorActor, false);

					this.addonAttached = true;
				})();
			}
		});
	}
}
