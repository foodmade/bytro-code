import { create } from "zustand";

interface FileNode {
  readonly name: string;
  readonly path: string;
  readonly isDir: boolean;
  readonly isFile: boolean;
  readonly size: number;
  readonly children?: ReadonlyArray<FileNode>;
  readonly isExpanded?: boolean;
}

interface FileTreeState {
  readonly rootPath: string | null;
  readonly nodes: ReadonlyArray<FileNode>;
  readonly selectedPath: string | null;
  readonly setRootPath: (path: string) => void;
  readonly setNodes: (nodes: ReadonlyArray<FileNode>) => void;
  readonly setSelectedPath: (path: string | null) => void;
}

export const useFileTreeStore = create<FileTreeState>((set) => ({
  rootPath: null,
  nodes: [],
  selectedPath: null,
  setRootPath: (path) => set({ rootPath: path }),
  setNodes: (nodes) => set({ nodes }),
  setSelectedPath: (path) => set({ selectedPath: path }),
}));
