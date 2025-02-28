import { Registry } from './registry';
import { DescriptorActorProxy } from '../firefox/actorProxy/descriptor';
import { BreakpointListActorProxy } from '../firefox/actorProxy/breakpointList';
import { WatcherActorProxy } from '../firefox/actorProxy/watcher';
import { ThreadConfigurationActorProxy } from '../firefox/actorProxy/threadConfiguration';
import { ThreadAdapter } from './thread';

export class DescriptorAdapter {

	public readonly id: number;
	private readonly configuratorId: number;
	private readonly breakpointListId: number;
	public readonly threads = new Set<ThreadAdapter>();

	public constructor(
		private readonly descriptorRegistry: Registry<DescriptorAdapter>,
		private readonly configurators: Registry<ThreadConfigurationActorProxy>,
		private readonly breakpointLists: Registry<BreakpointListActorProxy>,
		public readonly descriptorActor: DescriptorActorProxy,
		public readonly watcherActor: WatcherActorProxy,
		private readonly configurator: ThreadConfigurationActorProxy,
		private readonly breakpointList: BreakpointListActorProxy
	) {
		this.id = descriptorRegistry.register(this);
		this.configuratorId = configurators.register(configurator);
		this.breakpointListId = breakpointLists.register(breakpointList);
	}

	public dispose() {
		for (const thread of this.threads) {
			thread.dispose();
		}
		this.descriptorRegistry.unregister(this.id);
		this.configurators.unregister(this.configuratorId);
		this.breakpointLists.unregister(this.breakpointListId);
		this.descriptorActor.dispose();
		this.configurator.dispose();
		this.breakpointList.dispose();
		this.watcherActor.dispose();
	}
}
