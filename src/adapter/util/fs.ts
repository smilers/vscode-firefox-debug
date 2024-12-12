import * as fs from 'fs-extra';
import { isWindowsPlatform as detectWindowsPlatform } from '../../common/util';
import { Log } from './log';

let log = Log.create('fs');

export async function isExecutable(path: string): Promise<boolean> {
	try {
		await fs.access(path, fs.constants.X_OK);
		return true;
	} catch (e) {
		return false;
	}
}

const isWindowsPlatform = detectWindowsPlatform();
const windowsAbsolutePathRegEx = /^[a-zA-Z]:\\/;

export function normalizePath(sourcePathOrUrl: string): string {
	if (isWindowsPlatform && windowsAbsolutePathRegEx.test(sourcePathOrUrl)) {
		return sourcePathOrUrl.toLowerCase();
	} else {
		return sourcePathOrUrl;
	}
}
