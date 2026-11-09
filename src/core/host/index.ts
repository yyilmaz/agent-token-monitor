// Interfaces the core needs from its host (ADR 0006, R-25, R-26).
// The standalone Node.js host and the future VS Code host implement these.
// The core never touches the filesystem, network or clock itself.

/** One log file as seen by the core: path relative to its log root, plus its lines. */
export interface LogFile {
  readonly logRoot: string;
  readonly file: string;
  readonly lines: readonly string[];
}

export interface LogSource {
  /** Lists files under the configured root `logRoot` whose relative path matches `pattern`. */
  list(logRoot: string, pattern: RegExp): Promise<readonly string[]>;
  /** Reads one file read-only (R-15). */
  read(logRoot: string, file: string): Promise<LogFile>;
}

export interface ConfigSource {
  /** Text of the shipped default configuration (config/default.json). */
  readDefaults(): Promise<string>;
  /** Text of the user override file, or null when it does not exist. */
  readUser(): Promise<UserConfigText | null>;
}

export interface UserConfigText {
  /** Shown in error messages so the user knows which file to fix. */
  readonly path: string;
  readonly text: string;
}

export type Unsubscribe = () => void;

export interface ChangeNotifier {
  onLogsChanged(listener: () => void): Unsubscribe;
  onConfigChanged(listener: () => void): Unsubscribe;
}
