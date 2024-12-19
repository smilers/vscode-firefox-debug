import { AvailableEventCategory } from '../../common/customEvents';
import { FirefoxDebugSession } from '../firefoxDebugSession';
import { compareStrings } from '../util/misc';

export class EventBreakpointsManager {

	public readonly availableEvents: AvailableEventCategory[] = [];

	constructor(
		private readonly session: FirefoxDebugSession
	) {
		session.threads.onRegistered(async threadAdapter => {
			const newAvailableEvents = await threadAdapter.actor.getAvailableEventBreakpoints();
			let categoryWasAdded = false;
			for (const newCategory of newAvailableEvents) {
				const category = this.availableEvents.find(category => category.name === newCategory.name);

				if (!category) {
					this.availableEvents.push({
						name: newCategory.name,
						events: newCategory.events.map(newEvent => ({
							name: newEvent.name,
							id: newEvent.id,
						})),
					});
					categoryWasAdded = true;
					continue;
				}

				let eventWasAdded = false;
				for (const newEvent of newCategory.events) {
					if (!category.events.find(event => event.id === newEvent.id)) {
						category.events.push({
							name: newEvent.name,
							id: newEvent.id,
						});
						eventWasAdded = true;
					}
				}

				if (eventWasAdded) {
					category.events.sort((e1, e2) => compareStrings(e1.name, e2.name))
				}
			}

			if (categoryWasAdded) {
				this.availableEvents.sort((c1, c2) => compareStrings(c1.name, c2.name));
			}

			this.session.sendCustomEvent('availableEvents', this.availableEvents);
		});
	}

	public async setActiveEventBreakpoints(ids: string[]) {
		await Promise.all(this.session.breakpointLists.map(breakpointList => 
			breakpointList.setActiveEventBreakpoints(ids)
		));
	}
}
