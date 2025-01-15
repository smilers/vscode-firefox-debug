import { Log } from '../util/log';
import { MappedLocation } from '../location';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Source } from '@vscode/debugadapter';
import { ISourceActorProxy } from '../firefox/actorProxy/source';
import { SourceMappingSourceActorProxy } from '../firefox/sourceMaps/source';
import { Registry } from './registry';

const log = Log.create('SourceAdapter');

/**
 * Adapter class for a javascript source.
 */
export class SourceAdapter {

	public readonly url: string | undefined;
	public readonly generatedUrl: string | undefined;
	public readonly introductionType: 'scriptElement' | 'eval' | 'Function' | 'debugger eval' | 'wasm' | undefined;
	public readonly id: number;
	public readonly source: Source;
	public readonly actors: SourceActorCollection;
	private blackboxed = false;

	public get isBlackBoxed() { return this.blackboxed; }

	public constructor(
		actor: ISourceActorProxy,
		/** the path or url as seen by VS Code */
		public readonly path: string | undefined,
		sourceRegistry: Registry<SourceAdapter>
	) {
		this.url = actor.url ?? undefined;
		if (actor instanceof SourceMappingSourceActorProxy) {
			this.generatedUrl = actor.underlyingActor.url ?? undefined;
		}
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

		this.actors = new SourceActorCollection(actor);
	}

	public async setBlackBoxed(blackboxed: boolean) {
		if (this.blackboxed === blackboxed) {
			return;
		}
		this.blackboxed = blackboxed;
		(<DebugProtocol.Source>this.source).presentationHint = blackboxed ? 'deemphasize' : 'normal';
		await this.actors.runWithAllActors(actor => actor.setBlackbox(blackboxed));
	}

	public getBreakableLines(): Promise<number[]> {
		return this.actors.runWithSomeActor(actor => actor.getBreakableLines());
	}

	public getBreakableLocations(line: number): Promise<MappedLocation[]> {
		return this.actors.runWithSomeActor(actor => actor.getBreakableLocations(line));
	}

	public fetchSource(): Promise<FirefoxDebugProtocol.Grip> {
		return this.actors.runWithSomeActor(actor => actor.fetchSource());
	}

	public async findNextBreakableLocation(
		requestedLine: number,
		requestedColumn: number
	): Promise<MappedLocation | undefined> {

		let breakableLocations = await this.getBreakableLocations(requestedLine);
		for (const location of breakableLocations) {
			if (location.column >= requestedColumn) {
				return location;
			}
		}

		const breakableLines = await this.getBreakableLines();
		for (const line of breakableLines) {
			if (line > requestedLine) {
				breakableLocations = await this.getBreakableLocations(line);
				if (breakableLocations.length > 0) {
					return breakableLocations[0];
				}
			}
		}

		return undefined;
	}
}

export class SourceActorCollection {

	private readonly actors: ISourceActorProxy[];
	private someActor: Promise<ISourceActorProxy>;
	private resolveSomeActor: ((actor: ISourceActorProxy) => void) | undefined;

	public constructor(actor: ISourceActorProxy) {
		this.actors = [actor];
		this.someActor = Promise.resolve(actor);
	}

	public add(actor: ISourceActorProxy) {
		this.actors.push(actor);
		if (this.resolveSomeActor) {
			this.resolveSomeActor(actor);
			this.resolveSomeActor = undefined;
		}
	}

	public remove(actor: ISourceActorProxy) {
		const index = this.actors.indexOf(actor);
		if (index >= 0) {
			this.actors.splice(index, 1);
			if (this.actors.length > 0) {
				this.someActor = Promise.resolve(this.actors[0]);
			} else {
				this.someActor = new Promise(resolve => this.resolveSomeActor = resolve);
			}
		}
	}

	public async runWithSomeActor<T>(fn: (actor: ISourceActorProxy) => Promise<T>): Promise<T> {
		while (true) {
			const actor = await this.someActor;
			try {
				return await fn(actor);
			} catch (err: any) {
				if (err.error === 'noSuchActor') {
					this.remove(actor);
					continue;
				}
				throw err;
			}
		}
	}

	public async runWithAllActors<T>(fn: (actor: ISourceActorProxy) => Promise<T>): Promise<void> {
		await Promise.all(this.actors.map(actor => fn(actor)));
	}
}
