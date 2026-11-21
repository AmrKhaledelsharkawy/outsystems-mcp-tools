/**
 * Sampler for the accuracy audit (#67): draws K edges and K absent pairs per (consumer layer,
 * producer kind) stratum from a snapshot, deterministically for a given seed.
 *
 * Only elements that own their own text can be consumers (screens, blocks, client and server
 * actions): an entity's or structure's text is a whole-module dump, which cannot say which element
 * referenced which. Edges whose target is an opaque external key are excluded and counted.
 */
import { isOpaqueExternalId, moduleId, parseId } from "../extract/ids.js";
import type { ElementKind } from "../extract/types.js";
import type { Snapshot, SnapshotNode } from "../graph/types.js";
import { UNKNOWN_LAYER } from "../graph/types.js";
import { createRng, drawWithoutReplacement, hashSeed, nextInt } from "./prng.js";
import type { AbsentPair, AuditPair, AuditSample, StratumSample } from "./types.js";

export const CONSUMER_KINDS: ReadonlySet<string> = new Set(["Screen", "Block", "ClientAction", "ServerAction"]);

const SEP = "\u0000";
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (a: string, b: string): string => `${a}${SEP}${b}`;

export interface SampleOptions {
  k: number;
  seed: string;
}

interface Element {
  id: string;
  module: string;
  kind: ElementKind;
}

function asElement(node: SnapshotNode | undefined): Element | undefined {
  if (node === undefined || node.placeholder || node.kind === "module" || node.kind === "unknown") return undefined;
  if (isOpaqueExternalId(node.id)) return undefined;
  const parsed = parseId(node.id);
  if (parsed === undefined || parsed.kind === "module") return undefined;
  return { id: node.id, module: parsed.module, kind: node.kind };
}

/** Consumer-module layers from the per-module summary, falling back to module nodes. */
function layerOf(snapshot: Snapshot): (module: string) => string {
  const layers = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.kind === "module" && node.layer !== undefined) layers.set(node.id, node.layer);
  }
  for (const m of snapshot.graph.osgraph.perModule) layers.set(moduleId(m.module), m.layer);
  return (module) => layers.get(moduleId(module)) ?? UNKNOWN_LAYER;
}

function toPair(consumer: Element, producer: Element, layerName: string): AuditPair {
  return {
    consumer: consumer.id,
    producer: producer.id,
    consumerModule: consumer.module,
    producerModule: producer.module,
    consumerKind: consumer.kind,
    kind: producer.kind,
    layer: layerName
  };
}

/**
 * Draws the sample. Pure: the same `snapshot`, `k` and `seed` always return the same value. Each
 * stratum has its own generator seeded from `seed` and the stratum key, so one stratum's draw does
 * not depend on how many pairs another stratum holds.
 */
export function sampleSnapshot(snapshot: Snapshot, options: SampleOptions): AuditSample {
  const { k, seed } = options;
  const layer = layerOf(snapshot);
  const byId = new Map<string, SnapshotNode>();
  for (const n of snapshot.nodes) byId.set(n.id, n);

  const linked = new Set<string>();
  /** layer + kind -> candidate edge pairs. */
  const edgeCandidates = new Map<string, AuditPair[]>();
  /** consumer module -> producer modules it already uses (the "near" pool). */
  const neighbours = new Map<string, Set<string>>();
  let opaque = 0;

  for (const link of snapshot.links) {
    if (isOpaqueExternalId(link.target)) {
      opaque++;
      continue;
    }
    const consumer = asElement(byId.get(link.source));
    const producer = asElement(byId.get(link.target));
    if (consumer === undefined || producer === undefined || !CONSUMER_KINDS.has(consumer.kind)) continue;
    const key = pairKey(consumer.id, producer.id);
    if (linked.has(key)) continue;
    linked.add(key);
    const set = neighbours.get(consumer.module) ?? new Set<string>();
    set.add(producer.module);
    neighbours.set(consumer.module, set);
    const bucketKey = `${layer(consumer.module)}${SEP}${producer.kind}`;
    const list = edgeCandidates.get(bucketKey) ?? [];
    list.push(toPair(consumer, producer, layer(consumer.module)));
    edgeCandidates.set(bucketKey, list);
  }

  const consumersByLayer = new Map<string, Element[]>();
  const producersByKind = new Map<string, Element[]>();
  const producersByKindModule = new Map<string, Element[]>();
  for (const node of snapshot.nodes) {
    const el = asElement(node);
    if (el === undefined) continue;
    if (CONSUMER_KINDS.has(el.kind) && !node.external) {
      const l = layer(el.module);
      consumersByLayer.set(l, [...(consumersByLayer.get(l) ?? []), el]);
    }
    producersByKind.set(el.kind, [...(producersByKind.get(el.kind) ?? []), el]);
    const km = `${el.kind}${SEP}${el.module}`;
    producersByKindModule.set(km, [...(producersByKindModule.get(km) ?? []), el]);
  }
  for (const m of [consumersByLayer, producersByKind, producersByKindModule]) {
    for (const list of m.values()) list.sort((a, b) => compare(a.id, b.id));
  }

  const strataKeys = new Set<string>(edgeCandidates.keys());
  for (const l of consumersByLayer.keys()) for (const kind of producersByKind.keys()) strataKeys.add(`${l}${SEP}${kind}`);

  const strata: StratumSample[] = [];
  for (const key of [...strataKeys].sort(compare)) {
    const [l, kind] = key.split(SEP) as [string, ElementKind];
    const rng = createRng(hashSeed(`${seed}${SEP}${key}`));
    const population = (edgeCandidates.get(key) ?? [])
      .slice()
      .sort((a, b) => compare(pairKey(a.consumer, a.producer), pairKey(b.consumer, b.producer)));
    const edges = drawWithoutReplacement(population, k, rng);
    const absent = drawAbsent({
      k,
      kind,
      consumers: consumersByLayer.get(l) ?? [],
      uniformProducers: producersByKind.get(kind) ?? [],
      producersByKindModule,
      neighbours,
      linked,
      layerName: l,
      rng
    });
    if (edges.length === 0 && absent.length === 0) continue;
    strata.push({ layer: l, kind, edgePopulation: population.length, edges, absent });
  }
  return { seed, k, strata, opaqueEdgesExcluded: opaque };
}

interface AbsentArgs {
  k: number;
  kind: ElementKind;
  consumers: Element[];
  uniformProducers: Element[];
  producersByKindModule: Map<string, Element[]>;
  neighbours: Map<string, Set<string>>;
  linked: Set<string>;
  layerName: string;
  rng: () => number;
}

/**
 * Half the absent pairs (rounded up) come from the "near" pool - a producer in a module the consumer's
 * module already uses, or its own - because that is where a missed edge is plausible; drawing only
 * uniformly would nearly always land on pairs no one would expect to be linked. The rest are uniform.
 */
function drawAbsent(a: AbsentArgs): AbsentPair[] {
  const out: AbsentPair[] = [];
  const seen = new Set<string>();
  if (a.consumers.length === 0 || a.uniformProducers.length === 0 || a.k === 0) return out;
  const attemptsFor = (n: number): number => Math.max(50, n * 50);

  const tryAdd = (consumer: Element, producer: Element, pool: AbsentPair["pool"]): boolean => {
    if (consumer.id === producer.id) return false;
    const key = pairKey(consumer.id, producer.id);
    if (a.linked.has(key) || seen.has(key)) return false;
    seen.add(key);
    out.push({ ...toPair(consumer, producer, a.layerName), pool });
    return true;
  };

  const nearTarget = Math.ceil(a.k / 2);
  let near = 0;
  for (let i = 0; i < attemptsFor(nearTarget) && near < nearTarget; i++) {
    const consumer = a.consumers[nextInt(a.rng, a.consumers.length)];
    const modules = [consumer.module, ...[...(a.neighbours.get(consumer.module) ?? [])].sort(compare)];
    const module = modules[nextInt(a.rng, modules.length)];
    const pool = a.producersByKindModule.get(`${a.kind}${SEP}${module}`) ?? [];
    if (pool.length === 0) continue;
    if (tryAdd(consumer, pool[nextInt(a.rng, pool.length)], "near")) near++;
  }
  let uniform = 0;
  const uniformTarget = a.k - near;
  for (let i = 0; i < attemptsFor(uniformTarget) && uniform < uniformTarget; i++) {
    const consumer = a.consumers[nextInt(a.rng, a.consumers.length)];
    if (tryAdd(consumer, a.uniformProducers[nextInt(a.rng, a.uniformProducers.length)], "uniform")) uniform++;
  }
  return out;
}
