import * as url from 'url';
import * as fs from 'fs-extra';
import isAbsoluteUrl from 'is-absolute-url';
import { SourceMapConsumer, RawSourceMap } from 'source-map';
import { Log } from '../../util/log';
import { getUri, urlDirname } from '../../util/net';
import { PathMapper } from '../../util/pathMapper';
import { PendingRequest } from '../../util/pendingRequests';
import { DebugConnection } from '../connection';
import { SourceActorProxy } from '../actorProxy/source';
import { SourceMappingSourceActorProxy } from './source';
import { SourceMappingInfo } from './info';
import { UrlLocation } from '../../location';

let log = Log.create('SourceMapsManager');

export class SourceMapsManager {

	private sourceMappingInfos = new Map<string, Promise<SourceMappingInfo>>();
	private pendingSources = new Map<string, PendingRequest<SourceMappingInfo>>();

	public constructor(
		private readonly pathMapper: PathMapper,
		private readonly connection: DebugConnection
	) {}

	public getOrCreateSourceMappingInfo(source: FirefoxDebugProtocol.Source): Promise<SourceMappingInfo> {

		if (this.sourceMappingInfos.has(source.actor)) {

			if (this.pendingSources.has(source.actor)) {

				const pending = this.pendingSources.get(source.actor)!;
				this.pendingSources.delete(source.actor);

				(async () => {
					try {

						const sourceMappingInfos = await this.createSourceMappingInfo(source);
						pending.resolve(sourceMappingInfos);

					} catch(e) {
						pending.reject(e);
					}
				})();
			}

			return this.sourceMappingInfos.get(source.actor)!;

		} else {

			let sourceMappingInfoPromise = this.createSourceMappingInfo(source);
			this.sourceMappingInfos.set(source.actor, sourceMappingInfoPromise);
			return sourceMappingInfoPromise;
		}
	}

	public getSourceMappingInfo(actor: string): Promise<SourceMappingInfo> {

		if (this.sourceMappingInfos.has(actor)) {

			return this.sourceMappingInfos.get(actor)!;

		} else {

			const promise = new Promise<SourceMappingInfo>((resolve, reject) => {
				this.pendingSources.set(actor, { resolve, reject });
			});

			this.sourceMappingInfos.set(actor, promise);

			return promise;
		}
	}

	public async findOriginalLocation(
		generatedUrl: string,
		line: number,
		column?: number
	): Promise<UrlLocation | undefined> {

		for (const infoPromise of this.sourceMappingInfos.values()) {
			const info = await infoPromise;
			if (generatedUrl === info.underlyingSource.url) {

				const originalLocation = info.originalLocationFor({ line, column: column || 0 });

				if (originalLocation && originalLocation.url && originalLocation.line) {
					return {
						url: originalLocation.url,
						line: originalLocation.line,
						column: originalLocation.column || 0
					};
				}
			}
		}

		return undefined;
	}

	public async applySourceMapToFrame(frame: FirefoxDebugProtocol.Frame): Promise<void> {

		const sourceMappingInfo = await this.connection.sourceMaps.getSourceMappingInfo(frame.where.actor);
		const source = sourceMappingInfo.underlyingSource.source;

		if (source && sourceMappingInfo && sourceMappingInfo.hasSourceMap && frame.where.line) {

			let originalLocation = sourceMappingInfo.originalLocationFor({
				line: frame.where.line, column: frame.where.column || 0
			});

			if (originalLocation && originalLocation.url) {

				frame.where = {
					actor: `${source.actor}!${originalLocation.url}`,
					line: originalLocation.line || undefined,
					column: originalLocation.column || undefined
				}
			}
		}
	}

	private async createSourceMappingInfo(source: FirefoxDebugProtocol.Source): Promise<SourceMappingInfo> {

		if (log.isDebugEnabled()) {
			log.debug(`Trying to sourcemap ${JSON.stringify(source)}`);
		}

		let sourceActor = this.connection.getOrCreate(
			source.actor, () => new SourceActorProxy(source, this.connection));

		let sourceMapUrl = source.sourceMapURL;
		if (!sourceMapUrl) {
			return new SourceMappingInfo([sourceActor], sourceActor);
		}

		if (!isAbsoluteUrl(sourceMapUrl)) {
			if (source.url) {
				sourceMapUrl = url.resolve(urlDirname(source.url), sourceMapUrl);
			} else {
				log.warn(`Can't create absolute sourcemap URL from ${sourceMapUrl} - giving up`);
				return new SourceMappingInfo([sourceActor], sourceActor);
			}
		}

		let rawSourceMap: RawSourceMap | undefined = undefined;
		try {

			const sourceMapPath = this.pathMapper.convertFirefoxUrlToPath(sourceMapUrl);
			if (sourceMapPath && !isAbsoluteUrl(sourceMapPath)) {
				try {
					// TODO support remote development - this only works for local files
					const sourceMapString = await fs.readFile(sourceMapPath, 'utf8');
					log.debug('Loaded sourcemap from disk');
					rawSourceMap = JSON.parse(sourceMapString);
					log.debug('Parsed sourcemap');
				} catch(e) {
					log.debug(`Failed reading sourcemap from ${sourceMapPath} - trying to fetch it from ${sourceMapUrl}`);
				}
			}

			if (!rawSourceMap) {
				const sourceMapString = await getUri(sourceMapUrl);
				log.debug('Received sourcemap');
				rawSourceMap = JSON.parse(sourceMapString);
				log.debug('Parsed sourcemap');
			}

		} catch(e) {
			log.warn(`Failed fetching sourcemap from ${sourceMapUrl} - giving up`);
			return new SourceMappingInfo([sourceActor], sourceActor);
		}

		let sourceMapConsumer = await new SourceMapConsumer(rawSourceMap!);
		let sourceMappingSourceActors: SourceMappingSourceActorProxy[] = [];
		let sourceRoot = rawSourceMap!.sourceRoot;
		if (!sourceRoot && source.url) {
			sourceRoot = urlDirname(source.url);
		} else if ((sourceRoot !== undefined) && !isAbsoluteUrl(sourceRoot)) {
			sourceRoot = url.resolve(sourceMapUrl, sourceRoot);
		}
		log.debug('Created SourceMapConsumer');

		let sourceMappingInfo = new SourceMappingInfo(
			sourceMappingSourceActors, sourceActor, sourceMapUrl, sourceMapConsumer, sourceRoot);

		for (let origSource of sourceMapConsumer.sources) {

			origSource = sourceMappingInfo.resolveSource(origSource);

			let sourceMappingSource = this.createOriginalSource(source, origSource, sourceMapUrl);

			let sourceMappingSourceActor = new SourceMappingSourceActorProxy(
				sourceMappingSource, sourceMappingInfo);

			sourceMappingSourceActors.push(sourceMappingSourceActor);
		}

		return sourceMappingInfo;
	}

	private createOriginalSource(
		generatedSource: FirefoxDebugProtocol.Source,
		originalSourceUrl: string | null,
		sourceMapUrl: string
	): FirefoxDebugProtocol.Source {

		return <FirefoxDebugProtocol.Source>{
			actor: `${generatedSource.actor}!${originalSourceUrl}`,
			url: originalSourceUrl,
			introductionUrl: generatedSource.introductionUrl,
			introductionType: generatedSource.introductionType,
			generatedUrl: generatedSource.url,
			isBlackBoxed: false,
			isPrettyPrinted: false,
			isSourceMapped: true,
			sourceMapURL: sourceMapUrl
		}
	}
}
