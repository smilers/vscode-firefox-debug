import assert from 'assert';
import { SourceActorCollection } from '../adapter/adapter/source';
import { ISourceActorProxy } from '../adapter/firefox/actorProxy/source';
import { MappedLocation } from '../adapter/location';
import { delay } from '../common/util';

class FakeSourceActorProxy implements ISourceActorProxy {
	public readonly url = null;
	public readonly source = {
		actor: this.name,
		url: null,
		generatedUrl: null,
		introductionUrl: null,
		isBlackBoxed: false,
		isPrettyPrinted: false,
		isSourceMapped: false,
		sourceMapURL: null,
	};
	constructor(public readonly name: string) {}
	getBreakableLines(): Promise<number[]> {
		throw new Error('Method not implemented.');
	}
	getBreakableLocations(line: number): Promise<MappedLocation[]> {
		throw new Error('Method not implemented.');
	}
	fetchSource(): Promise<FirefoxDebugProtocol.Grip> {
		throw new Error('Method not implemented.');
	}
	setBlackbox(blackbox: boolean): Promise<void> {
		throw new Error('Method not implemented.');
	}
	dispose(): void {
		throw new Error('Method not implemented.');
	}
}

const a1 = new FakeSourceActorProxy('fakeSourceActor1');
const a2 = new FakeSourceActorProxy('fakeSourceActor2');

async function getName(actor: ISourceActorProxy) {
	return actor.name;
}

async function getNameOrFail(actor: ISourceActorProxy) {
	if (actor === a1) {
		throw { from: actor.name, error: 'noSuchActor' }
	}
	return actor.name;
}

describe('SourceActorCollection: runWithSomeActor', function() {

	it('should work', async function() {
		const collection = new SourceActorCollection(a1);
		const result = await collection.runWithSomeActor(getName);
		assert.equal(result, a1.name);
	});

	it('should work after the first actor was replaced', async function() {
		const collection = new SourceActorCollection(a1);
		collection.remove(a1);
		collection.add(a2);
		const result = await collection.runWithSomeActor(getName);
		assert.equal(result, a2.name);
	});

	it('should work while the first actor is being replaced', async function() {
		const collection = new SourceActorCollection(a1);
		collection.remove(a1);
		const resultPromise = collection.runWithSomeActor(getName);
		await delay(1);
		collection.add(a2);
		assert.equal(await resultPromise, a2.name);
	});

	it('should work after a second actor was removed', async function() {
		const collection = new SourceActorCollection(a1);
		collection.add(a2);
		collection.remove(a2);
		const result = await collection.runWithSomeActor(getName);
		assert.equal(result, a1.name);
	});

	it('should work when an actor was destroyed before another was added', async function() {
		const collection = new SourceActorCollection(a1);
		const resultPromise = collection.runWithSomeActor(getNameOrFail);
		await delay(1);
		collection.add(a2);
		assert.equal(await resultPromise, a2.name);
	});

	it('should work when an actor was destroyed after another was added', async function() {
		const collection = new SourceActorCollection(a1);
		collection.add(a2);
		const resultPromise = collection.runWithSomeActor(getNameOrFail);
		assert.equal(await resultPromise, a2.name);
	});

	it('should rethrow actor exceptions', async function() {
		const collection = new SourceActorCollection(a1);
		try {
			await collection.runWithSomeActor(actor => actor.fetchSource());
		} catch (err: any) {
			assert.equal(err.message, "Method not implemented.");
			return;
		}
		assert.fail();
	});
});
