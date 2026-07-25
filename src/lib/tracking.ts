import type { EventCategory } from "@/types/tracking";

/**
 * Compatibility hook for existing call sites. Community builds do not collect
 * or transmit product analytics.
 */
export function track(
  category: EventCategory,
  eventName: string,
  metadata?: Record<string, unknown>,
): void {
  void category;
  void eventName;
  void metadata;
}
