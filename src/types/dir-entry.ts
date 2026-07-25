/** Directory entry returned by the Tauri `read_dir_entries` command. */
export interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly is_file: boolean;
  readonly size: number;
  readonly extension: string | null;
}
