/**
 * An in-process event bus. THIS IS A STUB - you finish it.
 *
 * Requirements:
 *   - a handler that throws must not stop the other handlers
 *   - publish returns the number of handlers it reached
 *   - subscribing the same function twice registers it twice (do not dedupe)
 *   - publishing a name nobody listens to is fine and returns 0
 */

/** The events this system publishes. Add to it as you need to. */
export interface DomainEvents {
  "order.placed": { orderId: string; email: string; amountPaise: number };
}

export type EventName = keyof DomainEvents;
export type Handler<K extends EventName> = (payload: DomainEvents[K]) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  publish<K extends EventName>(name: K, payload: DomainEvents[K]): number;
  subscribe<K extends EventName>(name: K, fn: Handler<K>): Unsubscribe;
}

export function createEventBus(): EventBus {
  const handlers = new Map<EventName, Array<(payload: unknown) => void>>();

  return {
    publish<K extends EventName>(name: K, payload: DomainEvents[K]): number {
      const subscribers = handlers.get(name);
      if (!subscribers) return 0;

      const subscribersToCall = [...subscribers];
      for (const handler of subscribersToCall) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`Event handler for "${name}" failed:`, error);
        }
      }
      return subscribersToCall.length;
    },

    subscribe<K extends EventName>(name: K, fn: Handler<K>): Unsubscribe {
      const handler = (payload: unknown) => fn(payload as DomainEvents[K]);
      const subscribers = handlers.get(name) ?? [];
      subscribers.push(handler);
      handlers.set(name, subscribers);

      return () => {
        const index = subscribers.indexOf(handler);
        if (index !== -1) subscribers.splice(index, 1);
      };
    },
  };
}

export const eventBus = createEventBus();
