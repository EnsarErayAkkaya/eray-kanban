import type { BoardEvent } from '@shared/events';
import type { BoardEventSink } from '../../services/ports';

type Listener = (event: BoardEvent) => void;

// Fans board events out to SSE connections.
export class EventHub implements BoardEventSink {
  private readonly _listeners = new Set<Listener>();

  publish(event: BoardEvent): void {
    for (const listener of this._listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}
