import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

const log = Log.create('ThreadConfigurationActorProxy');

export class ThreadConfigurationActorProxy extends BaseActorProxy {

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public async updateConfiguration(configuration: Partial<FirefoxDebugProtocol.ThreadConfiguration>) {
		await this.sendRequest({ type: 'updateConfiguration', configuration });
	}
}