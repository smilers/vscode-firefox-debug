import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

let log = Log.create('ObjectGripActorProxy');

/**
 * Proxy class for an object grip actor
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#objects),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/object.js))
 */
export class ObjectGripActorProxy extends BaseActorProxy {

	private _refCount = 0;

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public get refCount() {
		return this._refCount;
	}

	public increaseRefCount() {
		this._refCount++;
	}

	public decreaseRefCount() {
		this._refCount--;
		if (this._refCount === 0) {
			this.connection.unregister(this);
		}
	}

	public fetchPrototypeAndProperties(): Promise<FirefoxDebugProtocol.PrototypeAndPropertiesResponse> {
		return this.sendCachedRequest(
			'prototypeAndProperties',
			{ type: 'prototypeAndProperties' }
		);
	}

	public addWatchpoint(property: string, label: string, watchpointType: 'get' | 'set'): void {
		this.sendRequestWithoutResponse({ type: 'addWatchpoint', property, label, watchpointType });
	}

	public removeWatchpoint(property: string): void {
		this.sendRequestWithoutResponse({ type: 'removeWatchpoint', property });
	}

	public threadLifetime(): Promise<void> {
		return this.sendCachedRequest('threadGrip', { type: 'threadGrip' }, () => undefined);
	}
}
