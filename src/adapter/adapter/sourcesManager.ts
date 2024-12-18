import { Log } from '../util/log';
import { ISourceActorProxy } from "../firefox/actorProxy/source";
import { DeferredMap } from "../util/deferredMap";
import { pathsAreEqual } from "../util/misc";
import { PathMapper } from "../util/pathMapper";
import { Registry } from "./registry";
import { SourceAdapter } from './source';
import { normalizePath } from '../util/fs';

const log = Log.create('SourcesManager');

export class SourcesManager {

	private readonly adapters = new Registry<SourceAdapter>();
	private readonly adaptersByPath = new DeferredMap<string, SourceAdapter>();
	private readonly adaptersByActor = new DeferredMap<string, SourceAdapter>();
	private readonly adaptersByUrl = new Map<string, SourceAdapter>();

	constructor(private readonly pathMapper: PathMapper) {}

	public addActor(actor: ISourceActorProxy) {
		log.debug(`Adding source ${actor.name}`);

		let adapter: SourceAdapter | undefined = actor.url ? this.adaptersByUrl.get(actor.url) : undefined;
		const path = this.pathMapper.convertFirefoxSourceToPath(actor.source);
		const normalizedPath = path ? normalizePath(path) : undefined;

		if (adapter) {
			adapter.actors.push(actor);
		} else {
			if (normalizedPath) {
				adapter = this.adaptersByPath.getExisting(normalizedPath);
			}
			if (adapter) {
				adapter.actors.push(actor);
			} else {
				adapter = new SourceAdapter(actor, path, this.adapters);
			}
		}

		if (normalizedPath) {
			this.adaptersByPath.set(normalizedPath, adapter);
		}
		this.adaptersByActor.set(actor.name, adapter);
		if (actor.url) {
			this.adaptersByUrl.set(actor.url, adapter);
		}

		return adapter;
	}

	public removeActor(actor: ISourceActorProxy) {
		log.info(`Removing source ${actor.name}`);

		const adapter = this.adaptersByActor.getExisting(actor.name);
		if (!adapter) return;

		this.adaptersByActor.delete(actor.name);
		const index = adapter.actors.indexOf(actor);
		if (index >= 0) {
			adapter.actors.splice(index, 1);
		}
	}

	public getAdapterForID(id: number) {
		return this.adapters.find(id);
	}

	public getAdapterForPath(path: string) {
		return this.adaptersByPath.get(path);
	}

	public getExistingAdapterForPath(path: string) {
		return this.adaptersByPath.getExisting(path);
	}

	public getAdapterForActor(actor: string) {
		return this.adaptersByActor.get(actor);
	}

	public getAdapterForUrl(url: string) {
		return this.adaptersByUrl.get(url);
	}

	public findSourceAdaptersForPathOrUrl(pathOrUrl: string): SourceAdapter[] {
		if (!pathOrUrl) return [];

		return this.adapters.filter((sourceAdapter) =>
			pathsAreEqual(pathOrUrl, sourceAdapter.path) || (sourceAdapter.url === pathOrUrl)
		);
	}

	public findSourceAdaptersForUrlWithoutQuery(url: string): SourceAdapter[] {

		return this.adapters.filter((sourceAdapter) => {

			let sourceUrl = sourceAdapter.url;
			if (!sourceUrl) return false;

			let queryStringIndex = sourceUrl.indexOf('?');
			if (queryStringIndex >= 0) {
				sourceUrl = sourceUrl.substr(0, queryStringIndex);
			}

			return url === sourceUrl;
		});
	}
}
