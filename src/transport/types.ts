/**
 * Transport-agnostic chat adapter contract.
 *
 * The bot's core logic (sessions, routing, turns) should talk to a chat through
 * this interface, never to a specific SDK. Telegram is the first implementation
 * (`./telegram.ts`); Slack follows in roadmap Phase 2.
 *
 * Markup note: message text is carried as an opaque string tagged with a
 * `format`. We deliberately do NOT define a cross-platform markup IR yet — the
 * whole UX (and the Claude-facing UI tools) is built on Telegram HTML, and a
 * second consumer (Slack/Block Kit) is what should drive that abstraction. Until
 * then a non-Telegram adapter can translate or reject a format it can't render.
 */

/** A handle to a message that was sent, so it can be edited or deleted later. */
export interface MessageRef {
  chatId: number;
  messageId: number;
}

/** One inline button: a link, a callback action, or an inert label. */
export interface Button {
  text: string;
  /** Opens this URL when tapped. */
  url?: string;
  /** Opaque payload delivered back as an InboundCallback when tapped. */
  data?: string;
}

/** Rows of inline buttons. */
export type Buttons = Button[][];

/** How a message's `text` should be interpreted by the transport. */
export type MarkupFormat = 'tgHtml' | 'tgMarkdownV2' | 'plain';

/** A message to deliver to a chat. */
export interface OutgoingMessage {
  text: string;
  /** Defaults to 'tgHtml'. */
  format?: MarkupFormat;
  buttons?: Buttons;
  /** Clear any persistent (reply) keyboard alongside this message. */
  removeKeyboard?: boolean;
}

/** A reaction glyph. Telegram uses emoji; other transports may map these. */
export type ReactEmoji = '✍' | '👀' | '👍' | '🤔' | '😱';

// --- Inbound events (used as handlers are ported off the SDK's context) -------

export interface InboundMessage {
  kind: 'message';
  chatId: number;
  userId?: number;
  text: string;
  messageId: number;
  replyToMessageId?: number;
}

export interface InboundCommand {
  kind: 'command';
  chatId: number;
  userId?: number;
  /** Command name without the leading slash, e.g. 'sessions'. */
  command: string;
  /** Everything after the command, trimmed. */
  args: string;
  messageId: number;
}

export interface InboundCallback {
  kind: 'callback';
  chatId: number;
  userId?: number;
  /** The button's `data` payload. */
  data: string;
  /** The message the button is attached to, if known. */
  messageId?: number;
  /** Acknowledge the tap (Telegram requires this; others may no-op). */
  answer(text?: string): Promise<void>;
}

export type Inbound = InboundMessage | InboundCommand | InboundCallback;

/** A command the transport should advertise (e.g. Telegram's command menu). */
export interface CommandSpec {
  command: string;
  description: string;
}

/** The outbound surface the core uses to talk to a chat. */
export interface ChatTransport {
  /** Send a message; resolves to a ref for later edit/delete. */
  send(chatId: number, msg: OutgoingMessage): Promise<MessageRef>;
  /** Replace a previously-sent message's content. Best-effort. */
  edit(ref: MessageRef, msg: OutgoingMessage): Promise<void>;
  /** Remove a previously-sent message. Best-effort. */
  delete(ref: MessageRef): Promise<void>;
  /** Add a reaction to a user's message. Best-effort. */
  react(chatId: number, messageId: number, emoji: ReactEmoji): Promise<void>;
  /** Show a transient "typing…" indicator. Best-effort. */
  typing(chatId: number): Promise<void>;
}

/**
 * A full chat adapter: the transport plus lifecycle. `index.ts` depends only on
 * this — swapping Telegram for Slack is a one-line construction change.
 */
export interface ChatAdapter extends ChatTransport {
  /** Transport name for logs, e.g. 'telegram'. */
  readonly name: string;
  /** Begin receiving and dispatching events. Resolves once running. */
  start(): Promise<void>;
  /** Stop receiving events and release resources. */
  stop(): Promise<void>;
}
