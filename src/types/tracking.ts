/** Event category for tracking */
export type EventCategory =
  | "chat"
  | "build"
  | "file"
  | "git"
  | "health_check"
  | "idea_hub"
  | "settings"
  | "mcp"
  | "remote"
  | "skills"
  | "teams"
  | "terminal"
  | "navigation";

/** A tracking event queued locally before flush */
export interface TrackingEvent {
  readonly eventName: string;
  readonly eventCategory: EventCategory;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp: string;
}

/** Full payload sent to the server (event + device/user context) */
export interface TrackingEventPayload extends TrackingEvent {
  readonly deviceId: string;
  readonly userId: string | null;
  readonly platform: string;
  readonly appVersion: string;
}
