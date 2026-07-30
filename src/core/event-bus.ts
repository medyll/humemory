/**
 * Event bus seam — permet de piloter les events en test.
 *
 * Pendant du clock seam ([clock.ts](./clock.ts)) : la mémoire prospective (Phase 5)
 * n'est pas seulement time-driven, elle est event-driven. Un cue peut être armé sur
 * `file_open`, `branch_switch`, `error_pattern` ou `commit`. Sans ce seam, tester
 * « ce cue se déclenche quand on switche de branche » supposerait de vraiment
 * toucher au FS ou à git.
 *
 * - `InMemoryEventBus` — tests : on `publish()` un event à la main, synchrone.
 * - `FileSystemEventBus` — prod : à câbler en Phase 5.2, quand il y aura un
 *   resolver à alimenter (fs.watch / chokidar + hooks git). Volontairement absent
 *   ici : rien à observer tant que les tables `intentions`/`cues` n'existent pas.
 *
 * Voir docs/TESTING.md → pilier 4, et PHASE5_PLAN.md § 5.0.2.
 */

/** Events applicatifs sur lesquels un cue peut être armé (cf. PHASE5_PLAN.md § 5.2). */
export type AppEvent =
  | { type: 'file_open'; path: string; directory: string }
  | { type: 'branch_switch'; branch: string; directory: string }
  | { type: 'error_pattern'; text: string; directory: string }
  | { type: 'commit'; sha: string; message: string; files: string[]; directory: string };

export type AppEventType = AppEvent['type'];

/** Extrait la variante d'`AppEvent` correspondant à `T`. */
export type AppEventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>;

export type EventHandler<E extends AppEvent = AppEvent> = (event: E) => void | Promise<void>;

/** Désabonne le handler enregistré. Idempotent. */
export type Unsubscribe = () => void;

export interface EventBus {
  /** Diffuse un event à tous les abonnés du type, puis aux abonnés globaux. */
  publish(event: AppEvent): Promise<void>;
  /** Abonne un handler à un type d'event. */
  subscribe<T extends AppEventType>(type: T, handler: EventHandler<AppEventOf<T>>): Unsubscribe;
  /** Abonne un handler à *tous* les events. */
  subscribeAll(handler: EventHandler): Unsubscribe;
}

/**
 * Bus en mémoire, sans I/O. Les handlers sont attendus (`await`) dans l'ordre
 * d'abonnement, pour que `await bus.publish(e)` garantisse que tout a été traité —
 * un test ne doit jamais avoir à `setTimeout` pour observer un effet.
 */
export class InMemoryEventBus implements EventBus {
  private handlers = new Map<AppEventType, Set<EventHandler<any>>>();
  private globalHandlers = new Set<EventHandler>();
  private log: AppEvent[] = [];

  async publish(event: AppEvent): Promise<void> {
    this.log.push(event);
    // Snapshot : un handler qui se désabonne pendant la diffusion ne doit pas
    // corrompre l'itération en cours.
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

  /** Events publiés depuis le dernier `reset()` — pour assertions de test. */
  published(): readonly AppEvent[] {
    return this.log;
  }

  /** Events publiés d'un type donné, typés. */
  publishedOf<T extends AppEventType>(type: T): AppEventOf<T>[] {
    return this.log.filter((e): e is AppEventOf<T> => e.type === type);
  }

  /** Vide le journal et tous les abonnements. */
  reset(): void {
    this.handlers.clear();
    this.globalHandlers.clear();
    this.log = [];
  }
}
