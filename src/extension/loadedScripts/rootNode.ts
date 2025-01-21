import * as vscode from 'vscode';
import { ThreadStartedEventBody, NewSourceEventBody } from '../../common/customEvents';
import { TreeNode } from './treeNode';
import { SessionNode } from './sessionNode';
import { DeferredMap } from '../../common/deferredMap';

export class RootNode extends TreeNode {

	private children = new DeferredMap<string, SessionNode>();
	private showSessions = false;

	public constructor() {
		super('');
		this.treeItem.contextValue = 'root';
	}

	private waitForSession(sessionId: string): Promise<SessionNode> {
		return this.children.get(sessionId);
	}

	public addSession(session: vscode.DebugSession): TreeNode | undefined {
		this.children.set(session.id, new SessionNode(session, this));
		return this;
	}

	public removeSession(sessionId: string): TreeNode | undefined {
		this.children.delete(sessionId);
		return this;
	}

	public async addThread(
		threadInfo: ThreadStartedEventBody,
		sessionId: string
	): Promise<TreeNode | undefined> {

		const sessionNode = await this.waitForSession(sessionId);
		return this.fixChangedItem(sessionNode.addThread(threadInfo));

	}

	public async removeThread(
		threadId: number,
		sessionId: string
	): Promise<TreeNode | undefined> {

		const sessionItem = await this.waitForSession(sessionId);
		return sessionItem ? this.fixChangedItem(sessionItem.removeThread(threadId)) : undefined;

	}

	public async addSource(
		sourceInfo: NewSourceEventBody,
		sessionId: string
	): Promise<TreeNode | undefined> {

		const sessionNode = await this.waitForSession(sessionId);
		return this.fixChangedItem(sessionNode.addSource(sourceInfo));

	}

	public async removeSources(threadId: number, sessionId: string): Promise<TreeNode | undefined> {

		const sessionItem = await this.waitForSession(sessionId);
		return sessionItem ? this.fixChangedItem(sessionItem.removeSources(threadId)) : undefined;

	}

	public async getSourceUrls(sessionId: string): Promise<string[] | undefined> {

		const sessionNode = await this.waitForSession(sessionId);
		return sessionNode ? sessionNode.getSourceUrls() : undefined;

	}

	public getChildren(): TreeNode[] {

		this.treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

		const existingChildren = this.children.getAllExisting();
	
		if (this.showSessions || (existingChildren.length > 1)) {

			this.showSessions = true;
			return existingChildren;

		} else if (existingChildren.length == 1) {

			return existingChildren[0].getChildren();

		} else {
			return [];
		}
	}

	private fixChangedItem(changedItem: TreeNode | undefined): TreeNode | undefined {

		if (!changedItem) return undefined;

		if (!this.showSessions && (changedItem instanceof SessionNode)) {
			return this;
		} else {
			return changedItem;
		}
	}
}
