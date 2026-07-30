import { setLLMClient, type LLMClient, type GeneratedLevels } from '../../src/core/llm-generator.js';

export interface StubLLMOptions {
  /** Niveaux renvoyés. Par défaut dérivés du prompt, pour rester parlants. */
  levels?: Partial<GeneratedLevels>;
  /** Force une erreur — pour tester les chemins de repli. */
  fail?: Error;
}

/**
 * Client LLM déterministe, à la forme d'un client Anthropic (`messages.create`
 * renvoyant un bloc texte JSON), ce qu'attend `generateMemoryLevels`.
 *
 * Aucun test ne doit instancier un vrai client : la CI tourne sans
 * `ANTHROPIC_API_KEY`, un appel réseau est un bug (docs/TESTING.md → pilier 3).
 */
export function stubLLMClient(options: StubLLMOptions = {}): LLMClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    messages: {
      async create(params: any) {
        calls.push(params);
        if (options.fail) throw options.fail;

        // Le contenu de la trace est le dernier message utilisateur.
        const prompt: string = params?.messages?.at(-1)?.content ?? '';
        const words = String(prompt).split(/\s+/).filter(Boolean);

        const levels: GeneratedLevels = {
          level1Summary: options.levels?.level1Summary ?? `résumé: ${words.slice(0, 8).join(' ')}`,
          level2Essential: options.levels?.level2Essential ?? `essentiel: ${words.slice(0, 3).join(' ')}`,
          level3Keywords: options.levels?.level3Keywords ?? words.slice(0, 3).join(', '),
        };

        return { content: [{ type: 'text', text: JSON.stringify(levels) }] };
      },
    },
  };
}

/** Installe le stub globalement. À appeler dans un `beforeEach`. */
export function useStubLLM(options?: StubLLMOptions) {
  const client = stubLLMClient(options);
  setLLMClient(client);
  return client;
}
