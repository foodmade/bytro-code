export interface FileState {
  readonly path: string;
  readonly content: string;
  readonly isDirty: boolean;
  readonly isLargeFile: boolean;
}

export function isLoadedFileStateForPath(fileState: FileState | null, filePath: string | null | undefined): fileState is FileState {
  return Boolean(filePath && fileState && fileState.path === filePath);
}
