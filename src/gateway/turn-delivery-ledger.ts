import type { SentMessageRef } from "./types.js";

interface StreamSegment {
  messageId: string;
  text: string;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Per-turn delivery state inspired by Hermes Agent's GatewayStreamConsumer.
 *
 * The gateway records the exact text acknowledged by an adapter and reconciles
 * it with the completed agent response. A delivery flag alone is deliberately
 * not trusted: a tool preamble or a throttled partial preview is not proof that
 * the final answer reached the user.
 */
export class TurnDeliveryLedger {
  private segments: StreamSegment[] = [];
  private deliveredSegmentTexts = new Set<string>();
  private deliveredFinalText?: string;
  private lastAcknowledgedText = "";
  private ref?: SentMessageRef;
  private ledgerText = "";

  get streamText(): string {
    return this.ledgerText;
  }

  get messageRef(): SentMessageRef | undefined {
    return this.ref;
  }

  get acknowledgedText(): string {
    return this.lastAcknowledgedText;
  }

  recordStreamDelta(messageId: string, delta: string): void {
    if (!delta) return;

    let segment = this.segments.at(-1);
    if (!segment || segment.messageId !== messageId) {
      segment = { messageId, text: "" };
      this.segments.push(segment);
    }

    segment.text += delta;
    this.ledgerText += delta;
  }

  /** Record an adapter-acknowledged live preview, not merely buffered text. */
  recordStreamDelivery(text: string, ref: SentMessageRef): void {
    this.ref = ref;
    this.lastAcknowledgedText = text;

    const acknowledged = normalizeText(text);
    if (!acknowledged) return;

    for (const segment of this.segments) {
      const candidate = normalizeText(segment.text);
      if (candidate && acknowledged.includes(candidate)) {
        this.deliveredSegmentTexts.add(candidate);
      }
    }
  }

  /** Record the completed final response only after every delivery call succeeds. */
  recordFinalDelivery(text: string, ref?: SentMessageRef): void {
    if (ref) this.ref = ref;
    this.deliveredFinalText = normalizeText(text);
  }

  /**
   * Hermes-style tri-state reconciliation.
   *
   * true: the exact final response was demonstrably visible.
   * false: something was delivered, but it was not the final response.
   * undefined: no delivery evidence is available.
   */
  deliveredFinalMatches(finalText: string): boolean | undefined {
    const target = normalizeText(finalText);
    if (!target) return undefined;

    if (this.deliveredFinalText !== undefined) {
      return this.deliveredFinalText === target;
    }

    if (normalizeText(this.lastAcknowledgedText) === target) return true;
    if (this.deliveredSegmentTexts.has(target)) return true;

    return this.lastAcknowledgedText ? false : undefined;
  }
}
