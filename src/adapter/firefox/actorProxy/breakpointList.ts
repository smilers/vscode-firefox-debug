import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

const log = Log.create('BreakpointListActorProxy');

export class BreakpointListActorProxy extends BaseActorProxy {

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public async setBreakpoint(sourceUrl: string, line: number, column: number, condition?: string, logValue?: string) {
		await this.sendRequest({
			type: 'setBreakpoint',
			location: { sourceUrl, line, column },
			options: { condition, logValue }
		});
	}

	public async removeBreakpoint(sourceUrl: string, line: number, column: number) {
		await this.sendRequest({ type: 'removeBreakpoint', location: { sourceUrl, line, column } });
	}

	public async setActiveEventBreakpoints(ids: string[]) {
		await this.sendRequest({ type: 'setActiveEventBreakpoints', ids });
	}
}
