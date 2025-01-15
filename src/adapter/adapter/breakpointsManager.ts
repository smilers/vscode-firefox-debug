import { Log } from '../util/log';
import { BreakpointInfo } from './breakpoint';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Event, Breakpoint, BreakpointEvent } from '@vscode/debugadapter';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { SourceMappingSourceActorProxy } from '../firefox/sourceMaps/source';
import { normalizePath } from '../util/fs';

let log = Log.create('BreakpointsManager');

/**
 * This class holds all breakpoints that have been set in VS Code and synchronizes them with all
 * sources in all threads in Firefox using [`SourceAdapter#updateBreakpoints()`](./source.ts).
 */
export class BreakpointsManager {

	private nextBreakpointId = 1;
	private readonly breakpointsBySourcePathOrUrl = new Map<string, BreakpointInfo[]>();

	constructor(
		private readonly session: FirefoxDebugSession
	) {
		session.breakpointLists.onRegistered(breakpointListActor => {
			[...this.breakpointsBySourcePathOrUrl.entries()].forEach(async ([sourcePath, breakpoints]) => {
				const sourceAdapter = await session.sources.getAdapterForPath(sourcePath);
				if (sourceAdapter.url) {
					breakpoints.forEach(async breakpointInfo => {
						const actualLocation = await sourceAdapter.findNextBreakableLocation(
							breakpointInfo.requestedBreakpoint.line,
							(breakpointInfo.requestedBreakpoint.column || 1) - 1
						);
						if (actualLocation) {
							breakpointInfo.actualLocation = actualLocation;

							let logValue: string | undefined;
							if (breakpointInfo.requestedBreakpoint.logMessage) {
								logValue = '...' + convertLogpointMessage(breakpointInfo.requestedBreakpoint.logMessage);
							}
				
							const location = actualLocation.generated ?? actualLocation;
							const url = actualLocation.generated ? sourceAdapter.generatedUrl : sourceAdapter.url;
							if (url) {
								breakpointListActor.setBreakpoint(
									url,
									location.line,
									location.column,
									breakpointInfo.requestedBreakpoint.condition,
									logValue
								);
							}
							if (!breakpointInfo.verified) {
								this.verifyBreakpoint(breakpointInfo);
							}	
						}
					});
				}
			});
		});
	}

	/**
	 * called by [`FirefoxDebugAdapter#setBreakpoints()`](../firefoxDebugAdapter.ts) whenever the
	 * breakpoints have been changed by the user in VS Code
	 */
	public setBreakpoints(
		breakpoints: DebugProtocol.SourceBreakpoint[],
		sourcePathOrUrl: string
	): BreakpointInfo[] {

		log.debug(`Setting ${breakpoints.length} breakpoints for ${sourcePathOrUrl}`);

		const normalizedPathOrUrl = normalizePath(sourcePathOrUrl);
		const oldBreakpointInfos = this.breakpointsBySourcePathOrUrl.get(normalizedPathOrUrl);
		const breakpointInfos = breakpoints.map(
			breakpoint => this.getOrCreateBreakpointInfo(breakpoint, oldBreakpointInfos)
		);

		this.breakpointsBySourcePathOrUrl.set(normalizedPathOrUrl, breakpointInfos);

		breakpointInfos.forEach(async breakpointInfo => {
			if (!oldBreakpointInfos?.some(oldBreakpointInfo => oldBreakpointInfo === breakpointInfo)) {
				let sourceAdapter = this.session.sources.getExistingAdapterForPath(normalizedPathOrUrl);
				if (!sourceAdapter) {
					this.session.sendEvent(new Event('unknownSource', sourcePathOrUrl));
					sourceAdapter = await this.session.sources.getAdapterForPath(normalizedPathOrUrl);
				}
				if (sourceAdapter.url) {
					const actualLocation = await sourceAdapter.findNextBreakableLocation(
						breakpointInfo.requestedBreakpoint.line,
						(breakpointInfo.requestedBreakpoint.column || 1) - 1
					);
					if (actualLocation) {
						breakpointInfo.actualLocation = actualLocation;

						let logValue: string | undefined;
						if (breakpointInfo.requestedBreakpoint.logMessage) {
							logValue = '...' + convertLogpointMessage(breakpointInfo.requestedBreakpoint.logMessage);
						}
			
						const location = actualLocation.generated ?? actualLocation;
						const url = actualLocation.generated ? sourceAdapter.generatedUrl : sourceAdapter.url;
						if (url) {
							for (const [, breakpointListActor] of this.session.breakpointLists) {
								breakpointListActor.setBreakpoint(
									url,
									location.line,
									location.column,
									breakpointInfo.requestedBreakpoint.condition,
									logValue
								);
							}
						}
						if (!breakpointInfo.verified) {
							this.verifyBreakpoint(breakpointInfo);
						}
					}
				}
			}
		});

		if (oldBreakpointInfos) {
			oldBreakpointInfos.forEach(async oldBreakpointInfo => {
				if (!breakpointInfos.some(breakpointInfo => 
					breakpointInfo.requestedBreakpoint.line === oldBreakpointInfo.requestedBreakpoint.line &&
					breakpointInfo.requestedBreakpoint.column === oldBreakpointInfo.requestedBreakpoint.column
				)) {
					const sourceAdapter = await this.session.sources.getAdapterForPath(normalizedPathOrUrl);
					if (sourceAdapter.url) {
						const actualLocation = await sourceAdapter.findNextBreakableLocation(
							oldBreakpointInfo.requestedBreakpoint.line,
							(oldBreakpointInfo.requestedBreakpoint.column || 1) - 1
						);
						if (actualLocation) {
							const location = actualLocation.generated ?? actualLocation;
							const url = actualLocation.generated ? sourceAdapter.generatedUrl : sourceAdapter.url;
							if (url) {
								for (const [, breakpointListActor] of this.session.breakpointLists) {
									breakpointListActor.removeBreakpoint(
										url,
										location.line,
										location.column
									);
								}
							}
						}
					}
					}
			});
		}

		return breakpointInfos;
	}

	public getBreakpoints(sourcePathOrUrl: string) {
		return this.breakpointsBySourcePathOrUrl.get(normalizePath(sourcePathOrUrl));
	}

	private verifyBreakpoint(breakpointInfo: BreakpointInfo): void {

		if (!breakpointInfo.actualLocation) return;

		let breakpoint: DebugProtocol.Breakpoint = new Breakpoint(
			true, breakpointInfo.actualLocation.line, breakpointInfo.actualLocation.column + 1);
		breakpoint.id = breakpointInfo.id;
		this.session.sendEvent(new BreakpointEvent('changed', breakpoint));

		breakpointInfo.verified = true;
	}

	private getOrCreateBreakpointInfo(
		requestedBreakpoint: DebugProtocol.SourceBreakpoint,
		oldBreakpointInfos: BreakpointInfo[] | undefined
	): BreakpointInfo {

		if (oldBreakpointInfos) {

			const oldBreakpointInfo = oldBreakpointInfos.find(
				breakpointInfo => breakpointInfo.isEquivalent(requestedBreakpoint)
			);

			if (oldBreakpointInfo) {
				return oldBreakpointInfo;
			}
		}

		return new BreakpointInfo(this.nextBreakpointId++, requestedBreakpoint);
	}
}

/**
 * convert the message of a logpoint (which can contain javascript expressions in curly braces)
 * to a javascript expression that evaluates to an array of values to be displayed in the debug console
 * (doesn't support escaping or nested curly braces)
 */
export function convertLogpointMessage(msg: string): string {

	// split `msg` into string literals and javascript expressions
	const items: string[] = [];
	let currentPos = 0;
	while (true) {

		const leftBrace = msg.indexOf('{', currentPos);

		if (leftBrace < 0) {

			items.push(JSON.stringify(msg.substring(currentPos)));
			break;

		} else {

			let rightBrace = msg.indexOf('}', leftBrace + 1);
			if (rightBrace < 0) rightBrace = msg.length;

			items.push(JSON.stringify(msg.substring(currentPos, leftBrace)));
			items.push(msg.substring(leftBrace + 1, rightBrace));
			currentPos = rightBrace + 1;
		}
	}

	// the appended `reduce()` call will convert all non-object values to strings and concatenate consecutive strings
	return `[${items.join(',')}].reduce((a,c)=>{if(typeof c==='object'&&c){a.push(c,'')}else{a.push(a.pop()+c)}return a},[''])`;
}
