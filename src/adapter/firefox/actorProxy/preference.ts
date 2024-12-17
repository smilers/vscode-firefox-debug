import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { BaseActorProxy } from './base';

let log = Log.create('PreferenceActorProxy');

/**
 * Proxy class for a preference actor
 * ([spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/preference.js))
 */
export class PreferenceActorProxy extends BaseActorProxy {

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public async getBoolPref(pref: string): Promise<boolean> {

		let prefString = await this.getPref(pref, 'Bool');
		return (prefString === 'true');

	}

	public getCharPref(pref: string): Promise<string> {

		return this.getPref(pref, 'Char');

	}

	public async getIntPref(pref: string): Promise<number> {

		let prefString = await this.getPref(pref, 'Bool');
		return parseInt(prefString, 10);

	}

	public setBoolPref(pref: string, val: boolean): Promise<void> {

		return this.setPref(pref, val, 'Bool');

	}

	public setCharPref(pref: string, val: string): Promise<void> {

		return this.setPref(pref, val, 'Char');

	}

	public setIntPref(pref: string, val: number): Promise<void> {

		return this.setPref(pref, val, 'Int');

	}

	private async getPref(
		pref: string,
		type: 'Bool' | 'Char' | 'Int'
	): Promise<string> {
		const response: { value: any } = await this.sendRequest({
			type: `get${type}Pref`,
			value: pref
		});
		return response.value.toString();
	}

	private setPref(
		pref: string,
		val: boolean | string | number,
		type: 'Bool' | 'Char' | 'Int'
	): Promise<void> {
		return this.sendRequest({ 
			type: `set${type}Pref`,
			name: pref,
			value: val
		});
	}
}
