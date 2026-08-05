/**
 * Minimal ambient type declarations for @whiskeysockets/baileys.
 *
 * These are used when the package is not installed, ensuring the
 * TypeScript project still compiles. If the real package is present,
 * its own types override these declarations.
 */

declare module "@whiskeysockets/baileys" {
  export function useMultiFileAuthState(
    dir: string
  ): Promise<{ state: any; saveCreds: () => Promise<void> }>;

  export function makeWASocket(options: any): WASocket;

  export interface WASocket {
    ev: EventEmitterLike;
    sendMessage: (jid: string, content: any, options?: any) => Promise<any>;
    end: (reason?: any) => void;
  }

  export interface EventEmitterLike {
    on: (event: string, listener: (...args: any[]) => void) => void;
    off: (event: string, listener: (...args: any[]) => void) => void;
  }

  export const DisconnectReason: {
    loggedOut: number;
    connectionClosed: number;
    connectionLost: number;
    connectionReplaced: number;
    timedOut: number;
    badSession: number;
    restartRequired: number;
    forbidden: number;
    unavailableService: number;
  };

  export interface Boom {
    output?: {
      statusCode?: number;
    };
  }
}
