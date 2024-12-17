import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { MappedLocation, Range } from '../../location';
import { BaseActorProxy } from './base';

let log = Log.create('SourceActorProxy');

export interface ISourceActorProxy {
	name: string;
	source: FirefoxDebugProtocol.Source;
	url: string | null;
	getBreakableLines(): Promise<number[]>;
	getBreakableLocations(line: number): Promise<MappedLocation[]>;
	fetchSource(): Promise<FirefoxDebugProtocol.Grip>;
	setBlackbox(blackbox: boolean): Promise<void>;
	dispose(): void;
}

/**
 * Proxy class for a source actor
 * ([docs](https://github.com/mozilla/gecko-dev/blob/master/devtools/docs/backend/protocol.md#loading-script-sources),
 * [spec](https://github.com/mozilla/gecko-dev/blob/master/devtools/shared/specs/source.js))
 */
export class SourceActorProxy extends BaseActorProxy implements ISourceActorProxy {

	constructor(
		public readonly source: FirefoxDebugProtocol.Source,
		connection: DebugConnection
	) {
		super(source.actor, connection, log);
	}

	public get url() {
		return this.source.url;
	}

	public getBreakableLines(): Promise<number[]> {
		log.debug(`Fetching breakableLines of ${this.url}`);

		return this.sendCachedRequest(
			'getBreakableLines',
			{ type: 'getBreakableLines' },
			(response: FirefoxDebugProtocol.GetBreakableLinesResponse) => response.lines
		);
	}

	public async getBreakableLocations(line: number): Promise<MappedLocation[]> {
		log.debug(`Fetching breakpointPositions of line ${line} in ${this.url}`);

		const positions = await this.getBreakpointPositionsForRange({
			start: { line, column: 0 },
			end: { line, column: Number.MAX_SAFE_INTEGER }
		});

		if (positions[line]) {
			return (positions[line].map(column => ({ line, column })));
		} else {
			return [];
		}
	}

	public getBreakpointPositionsForRange(range: Range): Promise<FirefoxDebugProtocol.BreakpointPositions> {
		log.debug(`Fetching breakpoint positions of ${this.url} for range: ${JSON.stringify(range)}`);

		return this.sendCachedRequest(
			`getBreakpointPositionsCompressed_${range.start.line}:${range.start.column}-${range.end.line}:${range.end.line}`,
			{
				type: 'getBreakpointPositionsCompressed',
				query: {
					start: { line: range.start.line, column: range.start.column },
					end: { line: range.end.line, column: range.end.column },
				},
			},
			(response: FirefoxDebugProtocol.GetBreakpointPositionsCompressedResponse) => response.positions
		);
	}

	public fetchSource(): Promise<FirefoxDebugProtocol.Grip> {
		log.debug(`Fetching source of ${this.url}`);

		return this.sendCachedRequest(
			'source',
			{ type: 'source' },
			(response: FirefoxDebugProtocol.SourceResponse) => response.source
		);
	}

	public async setBlackbox(blackbox: boolean): Promise<void> {
		log.debug(`Setting blackboxing of ${this.url} to ${blackbox}`);

		await this.sendRequest({ type: blackbox ? 'blackbox' : 'unblackbox' });
	}
}
