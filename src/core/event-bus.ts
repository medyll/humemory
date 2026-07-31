/**
 * Event bus seam — lets tests drive events.
 *
 * Counterpart to the clock seam ([clock.ts](./clock.ts)): prospective memory
 * (Phase 5) is not only time-driven, it is event-driven. A cue can be armed on
 * `file_open`, `branch_switch`, `error_pattern` or `commit`. Without this seam,
 * testing "this cue fires when the branch changes" would mean actually touching
 * the filesystem or git.
 *
 * - `InMemoryEventBus` — tests: `publish()` an event by hand, synchronously.
 * - `FileSystemEventBus` — production: to be wired in Phase 5.2, once there is a
 *   resolver to feed (fs.watch / chokidar plus git hooks). Deliberately absent
 *   here: nothing to observe while the `intentions`/`cues` tables do not exist.
 *
 * See docs/TESTING.md → pillar 4, and PHASE5_PLAN.md § 5.0.2.
 */

/** Application events a cue can be armed on (see PHASE5_PLAN.md § 5.2). */
export type AppEvent =
  | { type: 'file_open'; path: string; directory: string }
  | { type: 'branch_switch'; branch: string; directory: string }
  | { type: 'error_pattern'; text: string; directory: string }
  | { type: 'commit'; sha: string; message: string; files: string[]; directory: string };

export type AppEventType = AppEvent['type'];

/** Extracts the `AppEvent` variant matching `T`. */
export type AppEventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>;

export type EventHandler<E extends AppEvent = AppEvent> = (event: E) => void | Promise<void>;

/** Unsubscribes the registered handler. Idempotent. */
export type Unsubscribe = () => void;

export interface EventBus {
  /** Dispatches an event to subscribers of its type, then to global subscribers. */
  publish(event: AppEvent): Promise<void>;
  /** Subscribes a handler to one event type. */
  subscribe<T extends AppEventType>(type: T, handler: EventHandler<AppEventOf<T>>): Unsubscribe;
  /** Subscribes a handler to *every* event. */
  subscribeAll(handler: EventHandler): Unsubscribe;
}

/**
 * In-memory bus, no I/O. Handlers are awaited in subscription order, so that
 * `await bus.publish(e)` guarantees everything has been handled — a test should
 * never need a `setTimeout` to observe an effect.
 */
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<AppEventType, Set<EventHandler<any>>>();
  private globalHandlers = new Set<EventHandler>();
  private log: AppEvent[] = [];

  async publish(event: AppEvent): Promise<void> {
    this.log.push(event);
    // Snapshot: a handler unsubscribing mid-dispatch must not corrupt the
    // iteration in progress.
    const typed = [...(this.handlers.get(event.type) ?? [])];
    const globals = [...this.globalHandlers];
    for (const handler of [...typed, ...globals]) {
      await handler(event);
    }
  }

  subscribe<T extends AppEventType>(type: T, handler: EventHandler<AppEventOf<T>>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  subscribeAll(handler: EventHandler): Unsubscribe {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  /** Events published since the last `reset()` — for test assertions. */
  published(): readonly AppEvent[] {
    return this.log;
  }

  /** Published events of a given type, typed. */
  publishedOf<T extends AppEventType>(type: T): AppEventOf<T>[] {
    return this.log.filter((e): e is AppEventOf<T> => e.type === type);
  }

  /** Clears the log and every subscription. */
  reset(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
    this.log = [];
  }
}
