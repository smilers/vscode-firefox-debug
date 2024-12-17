import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

let log = Log.create('AddonsActorProxy');

/**
 * Proxy class for an addons actor
 * ([spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/addon/addons.js))
 */
export class AddonsActorProxy extends BaseActorProxy {

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public installAddon(addonPath: string): Promise<FirefoxDebugProtocol.InstallAddonResponse> {
		return this.sendCachedRequest(
			`installTemporaryAddon:${addonPath}`,
			{ type: 'installTemporaryAddon', addonPath }
		);
	}
}
