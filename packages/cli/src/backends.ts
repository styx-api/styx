import {
  BoutiquesBackend,
  JsonSchemaBackend,
  NipypeBackend,
  PydraBackend,
  PythonBackend,
  TypeScriptBackend,
  type Backend,
} from "@styx-api/core";

/**
 * Registry of backends keyed by CLI alias. The alias is what users pass to
 * `-b`; the backend's `name`/`target` is what we use for the output subdir.
 */
const registry: Record<string, () => Backend> = {
  python: () => new PythonBackend(),
  typescript: () => new TypeScriptBackend(),
  ts: () => new TypeScriptBackend(),
  schema: () => new JsonSchemaBackend(),
  "json-schema": () => new JsonSchemaBackend(),
  boutiques: () => new BoutiquesBackend(),
  nipype: () => new NipypeBackend(),
  pydra: () => new PydraBackend(),
};

export const knownBackends = Object.keys(registry);

export function resolveBackends(names: string[]): { backends: Backend[]; unknown: string[] } {
  const backends: Backend[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    const factory = registry[name];
    if (!factory) {
      unknown.push(name);
      continue;
    }
    const backend = factory();
    if (seen.has(backend.name)) continue;
    seen.add(backend.name);
    backends.push(backend);
  }
  return { backends, unknown };
}
