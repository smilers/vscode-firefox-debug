export interface ThreadStartedEventBody {
	name: string;
	id: number;
}

export interface ThreadExitedEventBody {
	id: number;
}

export interface NewSourceEventBody {
	threadId: number;
	sourceId: number;
	/** as seen by Firefox */
	url: string | undefined;
	/** path or url as seen by VS Code */
	path: string | undefined;
}

export interface RemoveSourcesEventBody {
	threadId: number;
}

export interface PopupAutohideEventBody {
	popupAutohide: boolean;
}

export interface AvailableEventCategory {
	name: string;
	events: AvailableEvent[];
}

export interface AvailableEvent {
	id: string;
	name: string;
}

export type AvailableEventsEventBody = AvailableEventCategory[];
