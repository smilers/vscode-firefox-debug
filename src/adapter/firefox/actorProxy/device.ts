import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

let log = Log.create('DeviceActorProxy');

/**
 * Proxy class for the device actor
 */
export class DeviceActorProxy extends BaseActorProxy {

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public getDescription(): Promise<FirefoxDebugProtocol.DeviceDescription> {
		return this.sendCachedRequest(
			'getDescription',
			{ type: 'getDescription' },
			(response: FirefoxDebugProtocol.DeviceDescriptionResponse) => response.value
		);
	}
}
