import { Log } from '../util/log';
import { MappedLocation } from '../location';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Source } from 'vscode-debugadapter';
import { ISourceActorProxy } from '../firefox/actorProxy/source';
import { Registry } from './registry';

const log = Log.create('SourceAdapter');

/**
 * Adapter class for a javascript source.
 */
export class SourceAdapter {

	public readonly url: string | undefined;
	public readonly introductionType: 'scriptElement' | 'eval' | 'Function' | 'debugger eval' | 'wasm' | undefined;
	public readonly id: number;
	public readonly source: Source;
	public readonly actors: ISourceActorProxy[];
	private blackboxed = false;

	public get isBlackBoxed() { return this.blackboxed; }

	public constructor(
		actor: ISourceActorProxy,
		/** the path or url as seen by VS Code */
		public readonly path: string | undefined,
		sourceRegistry: Registry<SourceAdapter>
	) {
		this.url = actor.url ?? undefined;
		this.introductionType = actor.source.introductionType ?? undefined;
		this.id = sourceRegistry.register(this);

		let sourceName = '';
		if (actor.url) {
			sourceName = actor.url.split('/').pop()!.split('#')[0];
		} else {
			sourceName = `${actor.source.introductionType || 'Script'} ${this.id}`;
		}

		if (path !== undefined) {
			this.source = new Source(sourceName, path);
		} else {
			this.source = new Source(sourceName, actor.url || undefined, this.id);
		}

		this.actors = [actor];
	}

	public async setBlackBoxed(blackboxed: boolean) {
		if (this.blackboxed === blackboxed) {
			return;
		}
		this.blackboxed = blackboxed;
		(<DebugProtocol.Source>this.source).presentationHint = blackboxed ? 'deemphasize' : 'normal';
		await Promise.all(this.actors.map(actor => actor.setBlackbox(blackboxed)));
	}

	public async getBreakableLocations(line: number): Promise<MappedLocation[]> {
		return await this.actors[0]?.getBreakableLocations(line) ?? [];
	}

	public async findNextBreakableLocation(
		requestedLine: number,
		requestedColumn: number
	): Promise<MappedLocation | undefined> {

		const actor = this.actors[0];
		if (!actor) return;

		let breakableLocations = await actor.getBreakableLocations(requestedLine);
		for (const location of breakableLocations) {
			if (location.column >= requestedColumn) {
				return location;
			}
		}

		const breakableLines = await actor.getBreakableLines();
		for (const line of breakableLines) {
			if (line > requestedLine) {
				breakableLocations = await actor.getBreakableLocations(line);
				if (breakableLocations.length > 0) {
					return breakableLocations[0];
				}
			}
		}

		return undefined;
	}
}
