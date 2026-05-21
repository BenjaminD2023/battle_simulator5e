import type { ActionDefinition, Combatant, ResourceCostDefinition, ResourceDefinition } from '../types'

const fullCasterSlots: number[][] = [
  [],
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
]

const halfCasterSlots: number[][] = [
  [],
  [],
  [2],
  [3],
  [3],
  [4, 2],
  [4, 2],
  [4, 3],
  [4, 3],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2],
]

const fullCasterClasses = new Set(['bard', 'cleric', 'druid', 'sorcerer', 'wizard'])
const halfCasterClasses = new Set(['paladin', 'ranger'])
const nonCasterClasses = new Set(['barbarian', 'fighter', 'monk', 'rogue'])

const classTextMatches = (classIndex: string | undefined, candidates: Set<string>) => {
  const normalizedClass = classIndex?.toLowerCase().replace(/[^a-z]+/g, ' ').trim()
  if (!normalizedClass) {
    return false
  }

  return normalizedClass.split(/\s+/).some((token) => candidates.has(token)) || candidates.has(normalizedClass)
}

const ordinal = (value: number) => {
  const suffix = value % 10 === 1 && value % 100 !== 11 ? 'st' : value % 10 === 2 && value % 100 !== 12 ? 'nd' : value % 10 === 3 && value % 100 !== 13 ? 'rd' : 'th'
  return `${value}${suffix}`
}

export const spellSlotResourceId = (level: number) => `spell-slot-${level}`

export const spellSlotResourceLabel = (level: number) => `${ordinal(level)}-level slot`

export const spellSlotResourcePluralLabel = (level: number) => `${ordinal(level)}-level slots`

const clampLevel = (level: number | undefined) => Math.min(20, Math.max(1, Math.floor(level ?? 1)))

export const spellSlotMaximumsForClass = (classIndex: string | undefined, level: number | undefined) => {
  const table = classTextMatches(classIndex, halfCasterClasses)
    ? halfCasterSlots
    : classTextMatches(classIndex, fullCasterClasses)
      ? fullCasterSlots
      : classTextMatches(classIndex, nonCasterClasses)
        ? []
      : fullCasterSlots

  return table[clampLevel(level)] ?? []
}

export const buildSpellSlotResources = (classIndex: string | undefined, level: number | undefined): ResourceDefinition[] =>
  spellSlotMaximumsForClass(classIndex, level)
    .map((max, index) => ({ level: index + 1, max }))
    .filter(({ max }) => max > 0)
    .map(({ level: spellLevel, max }) => ({
      id: spellSlotResourceId(spellLevel),
      label: spellSlotResourcePluralLabel(spellLevel),
      max,
      current: max,
      recovery: 'longRest',
    }))

const normalizeKey = (value: string | undefined) => value?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? ''

const spellSlotLevelFromCost = (cost: ResourceCostDefinition | undefined) => {
  const source = `${cost?.resourceId ?? ''} ${cost?.resourceLabel ?? ''}`
  const match = source.match(/(?:spell-slot-|spell slot |^)(\d+)/i) ?? source.match(/(\d+)(?:st|nd|rd|th)?[- ]level/i)
  return match ? Number(match[1]) : undefined
}

export const resourceCostForAction = (action: ActionDefinition | undefined): ResourceCostDefinition | undefined => {
  if (!action) {
    return undefined
  }

  if (action.resourceCost && action.resourceCost.amount > 0) {
    return action.resourceCost
  }

  if (typeof action.spellLevel === 'number' && action.spellLevel > 0) {
    return {
      resourceId: spellSlotResourceId(action.spellLevel),
      resourceLabel: spellSlotResourceLabel(action.spellLevel),
      amount: 1,
    }
  }

  return undefined
}

export const resourceCostLabel = (cost: ResourceCostDefinition | undefined) => {
  if (!cost) {
    return ''
  }

  return `${cost.amount} ${cost.resourceLabel ?? cost.resourceId ?? 'resource'}`
}

export const findResourceForCost = (
  resources: ResourceDefinition[],
  cost: ResourceCostDefinition | undefined,
) => {
  if (!cost) {
    return undefined
  }

  const candidates = [
    cost.resourceId,
    cost.resourceLabel,
    spellSlotLevelFromCost(cost) ? spellSlotResourceId(spellSlotLevelFromCost(cost) ?? 0) : undefined,
    spellSlotLevelFromCost(cost) ? spellSlotResourcePluralLabel(spellSlotLevelFromCost(cost) ?? 0) : undefined,
  ].map(normalizeKey)

  return resources.find((resource) =>
    [resource.id, resource.label].map(normalizeKey).some((key) => candidates.includes(key)),
  )
}

export const actionResourceAvailability = (combatant: Pick<Combatant, 'resources'>, action: ActionDefinition | undefined) => {
  const cost = resourceCostForAction(action)
  if (!cost) {
    return { cost, resource: undefined, available: true }
  }

  const resource = findResourceForCost(combatant.resources, cost)
  return {
    cost,
    resource,
    available: Boolean(resource && resource.current >= cost.amount),
  }
}

export const ensureResourcesForActions = (
  resources: ResourceDefinition[],
  actions: ActionDefinition[],
  classIndex: string | undefined,
  level: number | undefined,
): ResourceDefinition[] => {
  const nextResources = [...resources]
  const slotMaximums = spellSlotMaximumsForClass(classIndex, level)

  actions.forEach((action) => {
    const cost = resourceCostForAction(action)
    const spellLevel = spellSlotLevelFromCost(cost)
    if (!cost || !spellLevel || findResourceForCost(nextResources, cost)) {
      return
    }

    const max = slotMaximums[spellLevel - 1] ?? Math.max(cost.amount, 1)
    nextResources.push({
      id: spellSlotResourceId(spellLevel),
      label: spellSlotResourcePluralLabel(spellLevel),
      max,
      current: max,
      recovery: 'longRest',
    })
  })

  return nextResources
}
