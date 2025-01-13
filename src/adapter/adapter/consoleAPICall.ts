import { VariablesProvider } from './variablesProvider';
import { VariableAdapter } from './variable';
import { ThreadAdapter } from './thread';

/**
 * Adapter class for representing a `consoleAPICall` event from Firefox.
 */
export class ConsoleAPICallAdapter implements VariablesProvider {

	public readonly variablesProviderId: number;
	public readonly referenceExpression = undefined;
	public readonly referenceFrame = undefined;
	private readonly argsAdapter: VariableAdapter;

	public constructor(
		args: VariableAdapter[],
		preview: string,
		public readonly threadAdapter: ThreadAdapter
	) {
		this.variablesProviderId = threadAdapter.debugSession.variablesProviders.register(this);
		this.argsAdapter = VariableAdapter.fromArgumentList(args, preview, threadAdapter);
	}

	public getVariables(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.argsAdapter ? [this.argsAdapter] : []);
	}
}

export class ArgumentListAdapter implements VariablesProvider {

	public readonly variablesProviderId: number;
	public readonly referenceExpression = undefined;
	public readonly referenceFrame = undefined;

	public constructor(
		private readonly args: VariableAdapter[],
		public readonly threadAdapter: ThreadAdapter
	) {
		this.variablesProviderId = threadAdapter.debugSession.variablesProviders.register(this);
	}

	public getVariables(): Promise<VariableAdapter[]> {
		return Promise.resolve(this.args);
	}
}
