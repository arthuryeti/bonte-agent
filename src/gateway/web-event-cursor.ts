const MAX_SEEN_EVENT_IDS = 10_000;

export interface OrderedGatewayEvent {
  event_id?: string;
  sequence?: number;
  session_id?: string;
  turn_id?: string;
}

/** Reject replayed or out-of-order gateway events without trusting payloads. */
export class GatewayEventCursor {
  private seenEventIds = new Set<string>();
  private eventIdOrder: string[] = [];
  private lastSequenceByTurn = new Map<string, number>();

  accept(event: OrderedGatewayEvent): boolean {
    if (event.event_id && this.seenEventIds.has(event.event_id)) return false;

    if (
      event.session_id &&
      event.turn_id &&
      typeof event.sequence === "number" &&
      event.sequence > 0
    ) {
      const turnKey = `${event.session_id}:${event.turn_id}`;
      const previous = this.lastSequenceByTurn.get(turnKey) ?? 0;
      if (event.sequence <= previous) return false;
      this.lastSequenceByTurn.set(turnKey, event.sequence);
    }

    if (event.event_id) {
      this.seenEventIds.add(event.event_id);
      this.eventIdOrder.push(event.event_id);
      if (this.eventIdOrder.length > MAX_SEEN_EVENT_IDS) {
        const oldest = this.eventIdOrder.shift();
        if (oldest) this.seenEventIds.delete(oldest);
      }
    }

    return true;
  }
}
