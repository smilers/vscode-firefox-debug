import { Log } from '../../util/log';
import { DebugConnection } from '../connection';
import { exceptionGripToString } from '../../util/misc';
import { BaseActorProxy } from './base';
import { DeferredMap } from '../../util/deferredMap';

let log = Log.create('ConsoleActorProxy');

/**
 * Proxy class for a console actor
 */
export class ConsoleActorProxy extends BaseActorProxy {

	private evaluationResults = new DeferredMap<string, FirefoxDebugProtocol.Grip>();

	constructor(name: string, connection: DebugConnection) {
		super(name, connection, log);
	}

	public async evaluate(expr: string, disableBreaks: boolean, frameActorName?: string): Promise<FirefoxDebugProtocol.Grip> {
		const resultIDResponse: FirefoxDebugProtocol.ResultIDResponse = await this.sendRequest({
			type: 'evaluateJSAsync',
			text: expr, frameActor: frameActorName, disableBreaks
		});
		const result = await this.evaluationResults.get(resultIDResponse.resultID);
		this.evaluationResults.delete(resultIDResponse.resultID);
		return result;
	}

	public async autoComplete(text: string, column: number, frameActor?: string) {
		const response: FirefoxDebugProtocol.AutoCompleteResponse = await this.sendRequest({ type: 'autocomplete', text, cursor: column, frameActor });
		return response.matches;
	}

	handleEvent(event: FirefoxDebugProtocol.EvaluationResultResponse): void {
		if (event.type === 'evaluationResult') {
			this.evaluationResults.set(event.resultID, event.exceptionMessage ? exceptionGripToString(event.exception) : event.result);
		} else {
			log.warn(`Unknown message: ${JSON.stringify(event)}`);
		}
	}
}
