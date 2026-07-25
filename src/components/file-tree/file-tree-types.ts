export type { DirEntry } from "@/types";

export interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly extension: string | null;
  readonly children: ReadonlyArray<TreeNode> | null;
}

export interface CreatingInfo {
  readonly parentPath: string;
  readonly type: "file" | "dir";
}

export interface ContextMenuInfo {
  readonly x: number;
  readonly y: number;
  readonly nodePath: string;
  readonly nodeIsDir: boolean;
}

export interface RenameInfo {
  readonly path: string;
  readonly oldName: string;
}
