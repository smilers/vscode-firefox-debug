import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

let log = Log.create('LongStringGripActorProxy');

/**
 * Proxy class for a long string grip actor
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#long-strings),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/string.js))
 */
export class LongStringGripActorProxy extends BaseActorProxy {

	constructor(private grip: FirefoxDebugProtocol.LongStringGrip, connection: DebugConnection) {
		super(grip.actor, connection, log);
	}

	public fetchContent(): Promise<string> {
		return this.sendCachedRequest(
			'content',
			{ type: 'substring', start: 0, end: this.grip.length },
			(response: { substring: string }) => response.substring
		);
	}
}
