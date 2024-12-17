import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

let log = Log.create('FrameActorProxy');

/**
 * Proxy class for a frame actor
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#listing-stack-frames),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/frame.js))
 */
export class FrameActorProxy extends BaseActorProxy {

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	isEvent(message: FirefoxDebugProtocol.Response): boolean {
		return false;
	}

	public getEnvironment(): Promise<FirefoxDebugProtocol.Environment> {
		return this.sendCachedRequest('getEnvironment', { type: 'getEnvironment' });
	}
}
