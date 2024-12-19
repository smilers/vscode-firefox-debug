import * as vscode from 'vscode';
import { AvailableEvent, AvailableEventCategory } from '../common/customEvents';

export class EventBreakpointsProvider implements vscode.TreeDataProvider<TreeNode> {

	private availableEvents: AvailableEventCategory[] = [];
	private readonly rootNode = new RootNode(this);
	private readonly treeDataChanged = new vscode.EventEmitter<TreeNode | void>();
	public readonly onDidChangeTreeData: vscode.Event<TreeNode | void>;
	public readonly activeEventBreakpoints = new Set<string>();

	constructor() {
		this.onDidChangeTreeData = this.treeDataChanged.event;
	}

	setAvailableEvents(availableEvents: AvailableEventCategory[]) {
		this.availableEvents = availableEvents;
		this.treeDataChanged.fire();
	}

	getAvailableEvents() {
		return this.availableEvents;
	}

	updateActiveEventBreakpoints(event: vscode.TreeCheckboxChangeEvent<TreeNode>) {
		for (const [item, state] of event.items) {
			item.setChecked(state === vscode.TreeItemCheckboxState.Checked);
		}
		this.treeDataChanged.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element.item;
	}

	getChildren(element?: TreeNode | undefined): vscode.ProviderResult<TreeNode[]> {
		return (element ?? this.rootNode).getChildren?.() ?? [];
	}
}

interface TreeNode {
	item: vscode.TreeItem;
	setChecked(checked: boolean): void;
	getChildren?(): TreeNode[];
}

class RootNode implements TreeNode {

	public readonly item: vscode.TreeItem;

	constructor(private readonly provider: EventBreakpointsProvider) {
		this.item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.Collapsed);
	}

	setChecked(checked: boolean): void {}

	getChildren(): TreeNode[] {
		return this.provider.getAvailableEvents()?.map(category => new CategoryNode(category, this.provider)) ?? [];
	}
}

class CategoryNode implements TreeNode {

	public readonly item: vscode.TreeItem;

	constructor(
		private readonly category: AvailableEventCategory,
		private readonly provider: EventBreakpointsProvider
	) {
		this.item = new vscode.TreeItem(category.name, vscode.TreeItemCollapsibleState.Collapsed);
		this.item.checkboxState = this.category.events.every(event => this.provider.activeEventBreakpoints.has(event.id)) ?
			vscode.TreeItemCheckboxState.Checked :
			vscode.TreeItemCheckboxState.Unchecked;
	}

	setChecked(checked: boolean): void {
		for (const event of this.category.events) {
			if (checked) {
				this.provider.activeEventBreakpoints.add(event.id);
			} else {
				this.provider.activeEventBreakpoints.delete(event.id);
			}
		}
	}

	getChildren(): TreeNode[] {
		return this.category.events.map(event => new EventNode(event, this.provider));
	}
}

class EventNode implements TreeNode {

	public readonly item: vscode.TreeItem;

	constructor(
		private readonly event: AvailableEvent,
		private readonly provider: EventBreakpointsProvider
	) {
		this.item = new vscode.TreeItem(event.name);
		this.item.checkboxState = provider.activeEventBreakpoints.has(event.id) ?
			vscode.TreeItemCheckboxState.Checked :
			vscode.TreeItemCheckboxState.Unchecked;
	}

	setChecked(checked: boolean): void {
		if (checked) {
			this.provider.activeEventBreakpoints.add(this.event.id);
		} else {
			this.provider.activeEventBreakpoints.delete(this.event.id);
		}
	}
}
