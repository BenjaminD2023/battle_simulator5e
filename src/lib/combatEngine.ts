import type {
  ActiveEffect,
  ActionDefinition,
  BattleState,
  Combatant,
  CombatantCondition,
  ContentEntry,
  GridPoint,
  LogEntry,
  PlannedActionIntent,
  RollBonusConfig,
  RollProfileKey,
  RollAdjustment,
  RollKey,
  ScheduledAction,
  ScheduledActionTimingMode,
  Side,
  Strategy,
} from '../types'
import {
  actionSupportsDamageModifier,
  isDamageModifierAction,
  isImmediateDamageAction,
  isNoActionId,
  noActionId,
} from './actions'
import { abilityModifier, createRng, rollD20, rollDamageExpression, rollExpression } from './dice'
import { gridDistanceFt, stepToward } from './grid'
import { actionResourceAvailability, resourceCostLabel } from './resources'

const createId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`

const srdConditionNames = new Set([
  'blinded',
  'charmed',
  'deafened',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
  'exhaustion',
])

const createRollAdjustments = (): Record<RollKey, RollAdjustment> => ({
  attack: { modifier: 0, advantage: false, disadvantage: false },
  save: { modifier: 0, advantage: false, disadvantage: false },
  damage: { modifier: 0, advantage: false, disadvantage: false },
})

export const makeDefaultIntent = (entry: Pick<ContentEntry, 'actions'>, combatantId?: string) => {
  const primaryAction = entry.actions[0]
  const targetId = primaryAction?.kind === 'heal' ? combatantId : undefined

  return {
    actionId: primaryAction?.id ?? noActionId,
    actionQueue: [
      {
        id: createId('planned-action'),
        actionId: primaryAction?.id ?? noActionId,
        targetId,
      },
    ],
    targetId,
    advantage: false,
    disadvantage: false,
    rollAdjustments: createRollAdjustments(),
  }
}

export const makeCombatant = (
  entry: ContentEntry,
  side: Side,
  position: GridPoint,
  strategy: Strategy = side === 'Heroes' ? 'manual' : 'nearest',
): Combatant => {
  const id = createId('combatant')

  return {
    id,
    contentId: entry.id,
    name: entry.name,
    side,
    source: entry.source,
    armorClass: entry.armorClass,
    maxHp: entry.maxHp,
    currentHp: entry.maxHp,
    speedFt: entry.speedFt,
    initiativeBonus: entry.initiativeBonus,
    level: entry.level,
    proficiencyBonus: entry.proficiencyBonus,
    type: entry.type,
    abilityScores: { ...entry.abilityScores },
    saveProficiencies: [...(entry.saveProficiencies ?? [])],
    resistances: [...(entry.resistances ?? [])],
    immunities: [...(entry.immunities ?? [])],
    vulnerabilities: [...(entry.vulnerabilities ?? [])],
    position,
    conditions: [],
    activeEffects: [],
    resources: entry.resources.map((resource) => ({ ...resource })),
    actions: entry.actions.map((action) => ({
      ...action,
      tags: [...action.tags],
      effects: action.effects?.map((effect) => ({ ...effect })),
      secondaryDamage: action.secondaryDamage?.map((damage) => ({
        ...damage,
        targetTypes: damage.targetTypes ? [...damage.targetTypes] : undefined,
      })),
    })),
    rollBonuses: Object.fromEntries(
      Object.entries(entry.rollBonuses ?? {}).map(([key, config]) => [
        key,
        {
          proficient: config?.proficient ?? false,
          expertise: config?.expertise ?? false,
          bonus: config?.bonus ?? 0,
          advantage: config?.advantage ?? false,
          disadvantage: config?.disadvantage ?? false,
        },
      ]),
    ) as Combatant['rollBonuses'],
    strategy,
    intent: makeDefaultIntent(entry, id),
  }
}

export const makeInitialBattle = (): BattleState => ({
  round: 1,
  seed: `playtest-${new Date().toISOString().slice(0, 10)}`,
  status: 'setup',
  combatants: [],
  scheduledActions: [],
  timelineCursor: { round: 1, itemIndex: 0 },
  selectedCombatantId: undefined,
  log: [
    {
      id: createId('log'),
      round: 1,
      message: 'Battle workspace ready. Add combatants, roll initiative, then resolve rounds.',
      tone: 'system',
    },
  ],
})

const makeLog = (
  round: number,
  message: string,
  tone: LogEntry['tone'] = 'info',
  actor?: string,
  detail?: string,
): LogEntry => ({
  id: createId('log'),
  round,
  message,
  tone,
  actor,
  detail,
})

const living = (combatant: Combatant) => combatant.currentHp > 0

const hasCondition = (combatant: Combatant, condition: string) =>
  (combatant.conditions ?? []).some((entry) => entry.name.toLowerCase() === condition.toLowerCase())

const hasAnyCondition = (combatant: Combatant, conditions: string[]) =>
  conditions.some((condition) => hasCondition(combatant, condition))

const cannotAct = (combatant: Combatant) =>
  hasAnyCondition(combatant, ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'])

const effectiveSpeed = (combatant: Combatant) =>
  hasAnyCondition(combatant, ['grappled', 'paralyzed', 'petrified', 'restrained', 'stunned', 'unconscious'])
    ? 0
    : combatant.speedFt

const conditionAttackDisadvantage = (actor: Combatant) =>
  hasAnyCondition(actor, ['blinded', 'poisoned', 'prone', 'restrained'])

const conditionAttackAdvantageAgainst = (target: Combatant, distance: number) =>
  hasAnyCondition(target, ['blinded', 'paralyzed', 'petrified', 'restrained', 'stunned', 'unconscious']) ||
  (hasCondition(target, 'prone') && distance <= 5)

const conditionAttackDisadvantageAgainst = (target: Combatant, distance: number) =>
  hasCondition(target, 'invisible') || (hasCondition(target, 'prone') && distance > 5)

const conditionSaveDisadvantage = (target: Combatant, ability: string) =>
  (ability === 'dex' && hasCondition(target, 'restrained')) || hasCondition(target, 'petrified')

const conditionAutoFailsSave = (target: Combatant, ability: string) =>
  (ability === 'str' || ability === 'dex') &&
  hasAnyCondition(target, ['paralyzed', 'petrified', 'stunned', 'unconscious'])

const closeConditionCritical = (target: Combatant, distance: number) =>
  distance <= 5 && hasAnyCondition(target, ['paralyzed', 'unconscious'])

const enemySides = (side: Side): Side => (side === 'Heroes' ? 'Monsters' : 'Heroes')

export type BattleTimelineItem =
  | {
      id: string
      type: 'turn'
      combatantId: string
      initiative: number
    }
  | {
      id: string
      type: 'scheduledAction'
      scheduledActionId: string
      ownerCombatantId: string
      actionId: string
      initiative: number
      timingMode: ScheduledActionTimingMode
      triggerCombatantId?: string
    }

const combatantInitiative = (combatant: Combatant) => combatant.initiative ?? 0

const initiativeOrder = (combatants: Combatant[]) =>
  combatants
    .map((combatant, index) => ({ combatant, index }))
    .sort(
      (a, b) =>
        combatantInitiative(b.combatant) - combatantInitiative(a.combatant) ||
        a.index - b.index ||
        a.combatant.name.localeCompare(b.combatant.name) ||
        a.combatant.id.localeCompare(b.combatant.id),
    )
    .map(({ combatant }) => combatant)

const timelineReadyScheduledActions = (battle: BattleState) => {
  const combatantById = new Map(battle.combatants.map((combatant) => [combatant.id, combatant]))

  return (battle.scheduledActions ?? []).filter((scheduledAction) => {
    const owner = combatantById.get(scheduledAction.ownerCombatantId)
    if (!owner || !living(owner)) {
      return false
    }

    if (scheduledAction.timingMode === 'initiativeCount') {
      return Number.isFinite(scheduledAction.initiativeCount)
    }

    return Boolean(scheduledAction.triggerCombatantId && combatantById.has(scheduledAction.triggerCombatantId))
  })
}

const scheduledActionSorter = (combatants: Combatant[]) => {
  const orderedCombatants = initiativeOrder(combatants)
  const combatantById = new Map(combatants.map((combatant) => [combatant.id, combatant]))
  const orderIndexById = new Map(orderedCombatants.map((combatant, index) => [combatant.id, index]))

  return (a: ScheduledAction, b: ScheduledAction) => {
    const aOwner = combatantById.get(a.ownerCombatantId)
    const bOwner = combatantById.get(b.ownerCombatantId)
    const initiativeDifference = (bOwner?.initiative ?? 0) - (aOwner?.initiative ?? 0)

    return (
      initiativeDifference ||
      (orderIndexById.get(a.ownerCombatantId) ?? Number.MAX_SAFE_INTEGER) -
        (orderIndexById.get(b.ownerCombatantId) ?? Number.MAX_SAFE_INTEGER) ||
      (aOwner?.name ?? '').localeCompare(bOwner?.name ?? '') ||
      a.ownerCombatantId.localeCompare(b.ownerCombatantId) ||
      a.id.localeCompare(b.id)
    )
  }
}

const scheduledTimelineItem = (
  scheduledAction: ScheduledAction,
  initiative: number,
): BattleTimelineItem => ({
  id: `scheduled:${scheduledAction.id}`,
  type: 'scheduledAction',
  scheduledActionId: scheduledAction.id,
  ownerCombatantId: scheduledAction.ownerCombatantId,
  actionId: scheduledAction.actionId,
  initiative,
  timingMode: scheduledAction.timingMode,
  triggerCombatantId: scheduledAction.triggerCombatantId,
})

export const getBattleTimeline = (battle: BattleState): BattleTimelineItem[] => {
  const combatants = initiativeOrder(battle.combatants)
  const readyScheduledActions = timelineReadyScheduledActions(battle)
  const sortScheduledActions = scheduledActionSorter(battle.combatants)
  const initiativeScheduledActions = new Map<number, ScheduledAction[]>()
  const beforeCombatantScheduledActions = new Map<string, ScheduledAction[]>()
  const afterCombatantScheduledActions = new Map<string, ScheduledAction[]>()

  readyScheduledActions.forEach((scheduledAction) => {
    if (scheduledAction.timingMode === 'initiativeCount') {
      const initiative = Math.trunc(scheduledAction.initiativeCount ?? 0)
      initiativeScheduledActions.set(initiative, [...(initiativeScheduledActions.get(initiative) ?? []), scheduledAction])
      return
    }

    const triggerCombatantId = scheduledAction.triggerCombatantId
    if (!triggerCombatantId) {
      return
    }

    const byCombatant =
      scheduledAction.timingMode === 'beforeCombatant'
        ? beforeCombatantScheduledActions
        : afterCombatantScheduledActions
    byCombatant.set(triggerCombatantId, [...(byCombatant.get(triggerCombatantId) ?? []), scheduledAction])
  })

  const initiativeCounts = new Set<number>([
    ...combatants.map(combatantInitiative),
    ...initiativeScheduledActions.keys(),
  ])

  return [...initiativeCounts]
    .sort((a, b) => b - a)
    .flatMap((initiative) => {
      const turnsAtInitiative = combatants.filter((combatant) => combatantInitiative(combatant) === initiative)
      const timelineItems: BattleTimelineItem[] = [
        ...(initiativeScheduledActions.get(initiative) ?? [])
          .sort(sortScheduledActions)
          .map((scheduledAction) => scheduledTimelineItem(scheduledAction, initiative)),
      ]

      turnsAtInitiative.forEach((combatant) => {
        timelineItems.push(
          ...(beforeCombatantScheduledActions.get(combatant.id) ?? [])
            .sort(sortScheduledActions)
            .map((scheduledAction) => scheduledTimelineItem(scheduledAction, initiative)),
          {
            id: `turn:${combatant.id}`,
            type: 'turn',
            combatantId: combatant.id,
            initiative,
          },
          ...(afterCombatantScheduledActions.get(combatant.id) ?? [])
            .sort(sortScheduledActions)
            .map((scheduledAction) => scheduledTimelineItem(scheduledAction, initiative)),
        )
      })

      return timelineItems
    })
}

const currentTimelineIndex = (battle: BattleState, timeline = getBattleTimeline(battle)) => {
  const cursor = battle.timelineCursor
  const itemIndex =
    cursor?.round === battle.round && Number.isFinite(cursor.itemIndex)
      ? Math.trunc(cursor.itemIndex)
      : 0

  return Math.max(0, Math.min(itemIndex, Math.max(0, timeline.length - 1)))
}

export const getCurrentTimelineItem = (battle: BattleState) => {
  const timeline = getBattleTimeline(battle)
  return timeline[currentTimelineIndex(battle, timeline)]
}

export const getCurrentTimelineCombatantId = (battle: BattleState) => {
  const item = getCurrentTimelineItem(battle)
  if (!item) {
    return undefined
  }

  return item.type === 'turn' ? item.combatantId : item.ownerCombatantId
}

const findAction = (combatant: Combatant): ActionDefinition | undefined => {
  const actionId = combatant.intent.actionQueue?.[0]?.actionId ?? combatant.intent.actionId
  if (isNoActionId(actionId)) {
    return undefined
  }

  return combatant.actions.find((action) => action.id === actionId) ?? combatant.actions[0]
}

const findActionById = (combatant: Combatant, actionId: string): ActionDefinition | undefined =>
  isNoActionId(actionId) ? undefined : combatant.actions.find((action) => action.id === actionId)

const defaultTargetIdForAction = (
  actor: Combatant,
  action: ActionDefinition | undefined,
  combatants: Combatant[],
  strategy: Strategy,
) =>
  action?.kind === 'heal' || action?.target === 'self'
    ? actor.id
    : chooseTarget(actor, combatants, strategy)?.id

const supportsChosenHealingAmount = (action: ActionDefinition | undefined) =>
  action?.kind === 'heal' &&
  (action.tags.some((tag) => ['lay-on-hands', 'heal-pool', 'variable-heal-pool'].includes(tag)) ||
    /lay on hands/i.test(action.name))

const plannedActionsFor = (combatant: Combatant): PlannedActionIntent[] => {
  const primaryActionId = combatant.intent.actionQueue?.[0]?.actionId ?? combatant.intent.actionId
  const fallbackActionId = isNoActionId(primaryActionId) ? noActionId : findAction(combatant)?.id ?? combatant.intent.actionId
  const queue = combatant.intent.actionQueue?.length
    ? combatant.intent.actionQueue
    : [{ id: 'primary-action', actionId: fallbackActionId, targetId: combatant.intent.targetId }]

  return queue.map((plannedAction, index) => ({
    id: plannedAction.id ?? `planned-action-${index}`,
    actionId: isNoActionId(plannedAction.actionId)
      ? noActionId
      : findActionById(combatant, plannedAction.actionId)?.id ?? fallbackActionId,
    targetId: plannedAction.targetId ?? combatant.intent.targetId,
    healingAmount: supportsChosenHealingAmount(findActionById(combatant, plannedAction.actionId))
      ? plannedAction.healingAmount
      : undefined,
  }))
}

const proficiencyBonus = (combatant: Combatant) => combatant.proficiencyBonus ?? 2

const rollBonusConfig = (combatant: Combatant, key: RollProfileKey): RollBonusConfig => ({
  proficient: combatant.rollBonuses?.[key]?.proficient ?? false,
  expertise: combatant.rollBonuses?.[key]?.expertise ?? false,
  bonus: combatant.rollBonuses?.[key]?.bonus ?? 0,
  advantage: combatant.rollBonuses?.[key]?.advantage ?? false,
  disadvantage: combatant.rollBonuses?.[key]?.disadvantage ?? false,
})

const rollProfileBonus = (combatant: Combatant, key: RollProfileKey) => {
  const config = rollBonusConfig(combatant, key)

  return config.bonus + (config.proficient ? proficiencyBonus(combatant) * (config.expertise ? 2 : 1) : 0)
}

const getRollAdjustment = (actor: Combatant, key: RollKey): RollAdjustment => ({
  modifier: actor.intent.rollAdjustments?.[key]?.modifier ?? 0,
  advantage: actor.intent.rollAdjustments?.[key]?.advantage ?? false,
  disadvantage: actor.intent.rollAdjustments?.[key]?.disadvantage ?? false,
})

const rollMode = (adjustment: RollAdjustment, fallbackAdvantage = false, fallbackDisadvantage = false) => {
  const advantage = adjustment.advantage || fallbackAdvantage
  const disadvantage = adjustment.disadvantage || fallbackDisadvantage

  return advantage && !disadvantage ? 'advantage' : disadvantage && !advantage ? 'disadvantage' : 'normal'
}

const withModifier = (expression: string, modifier: number) =>
  modifier === 0 ? expression : `${expression}${signedModifier(modifier)}`

const signedModifier = (value: number) => `${value >= 0 ? '+' : ''}${value}`

const chooseStrategyAction = (
  actor: Combatant,
  target: Combatant | undefined,
): ActionDefinition | undefined => {
  if (!target) {
    return findAction(actor)
  }

  const actionable = actor.actions.filter((action) => action.kind === 'attack' || action.kind === 'save')
  const currentDistance = gridDistanceFt(actor.position, target.position)

  const reachableNow = actionable.find((action) => currentDistance <= (action.rangeFt ?? action.reachFt ?? 5))
  if (reachableNow) {
    return reachableNow
  }

  const reachableAfterMove = actionable.find((action) => {
    const range = action.rangeFt ?? action.reachFt ?? 5
    const destination = stepToward(actor.position, target.position, actor.speedFt, range)
    return gridDistanceFt(destination, target.position) <= range
  })

  return reachableAfterMove ?? actionable.sort((a, b) => (b.rangeFt ?? b.reachFt ?? 5) - (a.rangeFt ?? a.reachFt ?? 5))[0] ?? findAction(actor)
}

const chooseTarget = (
  actor: Combatant,
  combatants: Combatant[],
  strategy: Strategy,
): Combatant | undefined => {
  const enemies = combatants.filter((combatant) => combatant.side !== actor.side && living(combatant))

  if (!enemies.length) {
    return undefined
  }

  if (strategy === 'focusWeak') {
    return [...enemies].sort((a, b) => a.currentHp - b.currentHp)[0]
  }

  return [...enemies].sort(
    (a, b) => gridDistanceFt(actor.position, a.position) - gridDistanceFt(actor.position, b.position),
  )[0]
}

export const rollInitiative = (battle: BattleState): BattleState => {
  const rng = createRng(`${battle.seed}:initiative:${battle.round}`)
  const logs: LogEntry[] = []
  const combatants = battle.combatants
    .map((combatant) => {
      const modifier = combatant.initiativeBonus + rollProfileBonus(combatant, 'initiative')
      const roll = rollExpression(`1d20${modifier >= 0 ? '+' : ''}${modifier}`, rng)
      logs.push(
        makeLog(
          battle.round,
          `${combatant.name} initiative ${roll.total}`,
          'roll',
          combatant.name,
          roll.detail,
        ),
      )
      return { ...combatant, initiative: roll.total }
    })
    .sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0))

  const nextBattle: BattleState = {
    ...battle,
    status: 'active',
    combatants,
    selectedCombatantId: combatants[0]?.id,
    timelineCursor: { round: battle.round, itemIndex: 0 },
    log: [...logs, ...battle.log],
  }

  return {
    ...nextBattle,
    selectedCombatantId: getCurrentTimelineCombatantId(nextBattle) ?? nextBattle.selectedCombatantId,
  }
}

export const autoPlanRound = (battle: BattleState): BattleState => {
  const combatants = battle.combatants.map((combatant) => {
    const primaryActionId = combatant.intent.actionQueue?.[0]?.actionId ?? combatant.intent.actionId
    if (!living(combatant) || cannotAct(combatant) || combatant.strategy === 'manual' || isNoActionId(primaryActionId)) {
      return combatant
    }

    const target = chooseTarget(combatant, battle.combatants, combatant.strategy)
    const action = chooseStrategyAction(combatant, target)
    const range = action?.rangeFt ?? action?.reachFt ?? 5
    const targetId = defaultTargetIdForAction(combatant, action, battle.combatants, combatant.strategy)
    const resolvedTarget = battle.combatants.find((candidate) => candidate.id === targetId)
    const destination =
      resolvedTarget && resolvedTarget.id !== combatant.id && gridDistanceFt(combatant.position, resolvedTarget.position) > range
        ? stepToward(combatant.position, resolvedTarget.position, effectiveSpeed(combatant), range)
        : combatant.position

    return {
      ...combatant,
      intent: {
        ...combatant.intent,
        actionId: action?.id ?? combatant.intent.actionId,
        actionQueue: [
          {
            id: combatant.intent.actionQueue?.[0]?.id ?? createId('planned-action'),
            actionId: action?.id ?? combatant.intent.actionId,
            targetId,
            healingAmount: supportsChosenHealingAmount(action)
              ? combatant.intent.actionQueue?.[0]?.healingAmount
              : undefined,
          },
        ],
        targetId,
        destination,
      },
    }
  })

  return {
    ...battle,
    combatants,
    log: [
      makeLog(battle.round, 'Strategies proposed movement and targets for editable turn intents.', 'system'),
      ...battle.log,
    ],
  }
}

const damageMultiplier = (target: Combatant, damageType?: string) => {
  const type = damageType?.toLowerCase().trim()
  if (!type) {
    return 1
  }

  if (target.immunities?.some((entry) => entry.toLowerCase() === type)) {
    return 0
  }

  if (target.vulnerabilities?.some((entry) => entry.toLowerCase() === type)) {
    return 2
  }

  if (target.resistances?.some((entry) => entry.toLowerCase() === type)) {
    return 0.5
  }

  return 1
}

const adjustedDamage = (target: Combatant, amount: number, damageType?: string) => {
  const multiplier = damageMultiplier(target, damageType)
  return multiplier === 0.5 ? Math.floor(amount / 2) : Math.floor(amount * multiplier)
}

const applyDamage = (target: Combatant, amount: number, damageType?: string) => ({
  ...target,
  currentHp: Math.max(0, target.currentHp - adjustedDamage(target, amount, damageType)),
})

const applyHealing = (target: Combatant, amount: number) => ({
  ...target,
  currentHp: Math.min(target.maxHp, target.currentHp + amount),
})

const applyActionEffects = (target: Combatant, action: ActionDefinition, source: string) => {
  if (!action.effects?.length) {
    return {
      target,
      logs: [] as LogEntry[],
    }
  }

  const effects: ActiveEffect[] = action.effects.map((effect) => ({
    id: createId('effect'),
    label: effect.label,
    description: effect.description,
    source: `${source}: ${action.name}`,
  }))
  const conditions: CombatantCondition[] = action.effects
    .filter((effect) => srdConditionNames.has(effect.label.toLowerCase()))
    .map((effect) => ({
      id: createId('condition'),
      name: effect.label,
      source: `${source}: ${action.name}`,
      note: effect.description,
    }))

  return {
    target: {
      ...target,
      conditions: [...(target.conditions ?? []), ...conditions],
      activeEffects: [...(target.activeEffects ?? []), ...effects],
    },
    logs: [
      ...conditions.map((condition) =>
        makeLog(0, `${target.name} gains condition: ${condition.name}`, 'system', source, condition.note),
      ),
      ...effects.map((effect) =>
        makeLog(0, `${target.name} gains effect: ${effect.label}`, 'system', source, effect.description),
      ),
    ],
  }
}

const tickStatusDurations = (combatant: Combatant) => ({
  ...combatant,
  conditions: (combatant.conditions ?? [])
    .map((condition) =>
      typeof condition.durationRounds === 'number'
        ? { ...condition, durationRounds: condition.durationRounds - 1 }
        : condition,
    )
    .filter((condition) => condition.durationRounds === undefined || condition.durationRounds > 0),
  activeEffects: (combatant.activeEffects ?? [])
    .map((effect) =>
      typeof effect.durationRounds === 'number'
        ? { ...effect, durationRounds: effect.durationRounds - 1 }
        : effect,
    )
    .filter((effect) => effect.durationRounds === undefined || effect.durationRounds > 0),
})

type ActionResolutionResult = {
  target: Combatant
  logs: LogEntry[]
  landed?: boolean
  critical?: boolean
  targetId?: string
}

const resolveAttack = (
  actor: Combatant,
  target: Combatant,
  action: ActionDefinition,
  rng: () => number,
  round: number,
) => {
  const attackAdjustment = getRollAdjustment(actor, 'attack')
  const damageAdjustment = getRollAdjustment(actor, 'damage')
  const distance = gridDistanceFt(actor.position, target.position)
  const mode = rollMode(
    attackAdjustment,
    actor.intent.advantage || hasCondition(actor, 'invisible') || conditionAttackAdvantageAgainst(target, distance),
    actor.intent.disadvantage || conditionAttackDisadvantage(actor) || conditionAttackDisadvantageAgainst(target, distance),
  )
  const d20 = rollD20(rng, mode)
  const attackBonus = (action.attackBonus ?? 0) + attackAdjustment.modifier + rollProfileBonus(actor, 'attack')
  const total = d20.value + attackBonus
  const naturalCritical = d20.value === 20
  const automaticMiss = d20.value === 1
  const hit = !automaticMiss && (naturalCritical || total >= target.armorClass)
  const critical = naturalCritical || (hit && closeConditionCritical(target, distance))
  const logs = [
    makeLog(
      round,
      `${actor.name} uses ${action.name} on ${target.name}: ${total} vs AC ${target.armorClass}`,
      hit ? 'hit' : 'miss',
      actor.name,
      `${mode}; d20 ${d20.rolls.join('/')} ${attackBonus >= 0 ? '+' : ''}${attackBonus}`,
    ),
  ]

  if (!hit) {
    return { target, logs, landed: false, critical: false, targetId: target.id }
  }

  const damage = rollDamageExpression(
    withModifier(action.damageDice ?? '1d4', damageAdjustment.modifier + rollProfileBonus(actor, 'damage')),
    rng,
    critical,
  )
  const finalDamage = adjustedDamage(target, damage.total, action.damageType)
  logs.push(
    makeLog(
      round,
      `${target.name} takes ${finalDamage} ${action.damageType ?? 'damage'}`,
      'damage',
      actor.name,
      finalDamage === damage.total ? damage.detail : `${damage.detail}; adjusted from ${damage.total}`,
    ),
  )

  const effectResult = applyActionEffects(applyDamage(target, damage.total, action.damageType), action, actor.name)
  const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))

  return {
    target: effectResult.target,
    logs: [...logs, ...effectLogs],
    landed: true,
    critical,
    targetId: target.id,
  }
}

const resolveSave = (
  actor: Combatant,
  target: Combatant,
  action: ActionDefinition,
  rng: () => number,
  round: number,
) => {
  const ability = action.saveAbility ?? 'dex'
  const saveProfile = rollBonusConfig(target, `${ability}Save`)
  const hasSaveProficiency = target.saveProficiencies?.includes(ability) ?? false
  const saveBonus =
    abilityModifier(target.abilityScores?.[ability] ?? 10) +
    (hasSaveProficiency ? proficiencyBonus(target) * (saveProfile.expertise ? 2 : 1) : 0) +
    saveProfile.bonus
  const saveAdjustment = getRollAdjustment(actor, 'save')
  const damageAdjustment = getRollAdjustment(actor, 'damage')
  const adjustedSaveBonus = saveBonus + saveAdjustment.modifier
  const forcedFailure = conditionAutoFailsSave(target, ability)
  const saveD20 = rollD20(
    rng,
    rollMode(saveAdjustment, saveProfile.advantage, saveProfile.disadvantage || conditionSaveDisadvantage(target, ability)),
  )
  const save = {
    total: saveD20.value + adjustedSaveBonus,
    detail: `${saveD20.mode}; d20 ${saveD20.rolls.join('/')} ${adjustedSaveBonus >= 0 ? '+' : ''}${adjustedSaveBonus}`,
  }
  const dc = (action.saveDc ?? 10) + rollProfileBonus(actor, 'saveDc')
  const saved = !forcedFailure && save.total >= dc
  const damage = rollDamageExpression(
    withModifier(action.damageDice ?? '1d6', damageAdjustment.modifier + rollProfileBonus(actor, 'damage')),
    rng,
  )
  const appliedDamage = saved && action.damageOnSave === 'half' ? Math.floor(damage.total / 2) : saved ? 0 : damage.total
  const finalDamage = adjustedDamage(target, appliedDamage, action.damageType)
  const damagedTarget = appliedDamage > 0 ? applyDamage(target, appliedDamage, action.damageType) : target
  const effectResult = !saved ? applyActionEffects(damagedTarget, action, actor.name) : { target: damagedTarget, logs: [] as LogEntry[] }
  const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))

  return {
    target: effectResult.target,
    landed: appliedDamage > 0,
    critical: false,
    targetId: target.id,
    logs: [
      makeLog(
        round,
        `${target.name} makes a ${ability.toUpperCase()} save ${save.total} vs DC ${dc}`,
        saved ? 'miss' : 'hit',
        actor.name,
        forcedFailure ? `${save.detail}; condition auto-fail` : save.detail,
      ),
      makeLog(
        round,
        `${actor.name}'s ${action.name} deals ${finalDamage} ${action.damageType ?? 'damage'}`,
        finalDamage > 0 ? 'damage' : 'info',
        actor.name,
        finalDamage === appliedDamage ? damage.detail : `${damage.detail}; adjusted from ${appliedDamage}`,
      ),
      ...effectLogs,
    ],
  }
}

const secondaryDamageApplies = (target: Combatant, damage: NonNullable<ActionDefinition['secondaryDamage']>[number]) => {
  if (!damage.targetTypes?.length) {
    return true
  }

  const targetType = target.type?.toLowerCase() ?? ''
  return damage.targetTypes.some((type) => targetType.includes(type.toLowerCase()))
}

const resolveDamageModifier = (
  actor: Combatant,
  target: Combatant,
  action: ActionDefinition,
  rng: () => number,
  round: number,
  critical = false,
): ActionResolutionResult => {
  const damageAdjustment = getRollAdjustment(actor, 'damage')
  const damage = rollDamageExpression(
    withModifier(action.damageDice ?? '0', damageAdjustment.modifier + rollProfileBonus(actor, 'damage')),
    rng,
    critical,
  )
  const secondaryDamage = (action.secondaryDamage ?? [])
    .filter((entry) => secondaryDamageApplies(target, entry))
    .map((entry) => ({
      definition: entry,
      roll: rollDamageExpression(entry.damageDice, rng, critical),
    }))
  const finalPrimaryDamage = adjustedDamage(target, damage.total, action.damageType)
  const finalSecondaryDamage = secondaryDamage.reduce(
    (total, entry) => total + adjustedDamage(target, entry.roll.total, entry.definition.damageType ?? action.damageType),
    0,
  )
  const finalDamage = finalPrimaryDamage + finalSecondaryDamage
  const damagedTarget = secondaryDamage.reduce(
    (current, entry) => applyDamage(current, entry.roll.total, entry.definition.damageType ?? action.damageType),
    applyDamage(target, damage.total, action.damageType),
  )
  const effectResult = applyActionEffects(damagedTarget, action, actor.name)
  const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))
  const secondaryDetail = secondaryDamage
    .map(
      (entry) =>
        `${entry.definition.source ?? action.name}${entry.definition.condition ? ` (${entry.definition.condition})` : ''}: ${
          entry.roll.detail
        }`,
    )
    .join('; ')

  return {
    target: effectResult.target,
    logs: [
      makeLog(
        round,
        `${actor.name} adds ${action.name}: ${target.name} takes ${finalDamage} ${action.damageType ?? 'damage'}`,
        finalDamage > 0 ? 'damage' : 'info',
        actor.name,
        `${critical ? 'critical modifier; ' : 'modifier; '}${
          finalPrimaryDamage === damage.total ? damage.detail : `${damage.detail}; adjusted from ${damage.total}`
        }${secondaryDetail ? `; ${secondaryDetail}` : ''}`,
      ),
      ...effectLogs,
    ],
    landed: true,
    critical,
    targetId: target.id,
  }
}

const resolveManualDamage = (
  actor: Combatant,
  target: Combatant,
  action: ActionDefinition,
  rng: () => number,
  round: number,
): ActionResolutionResult => {
  const damageAdjustment = getRollAdjustment(actor, 'damage')
  const damage = rollDamageExpression(
    withModifier(action.damageDice ?? '0', damageAdjustment.modifier + rollProfileBonus(actor, 'damage')),
    rng,
  )
  const finalDamage = adjustedDamage(target, damage.total, action.damageType)
  const effectResult = applyActionEffects(applyDamage(target, damage.total, action.damageType), action, actor.name)
  const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))

  return {
    target: effectResult.target,
    landed: finalDamage > 0,
    critical: false,
    targetId: target.id,
    logs: [
      makeLog(
        round,
        `${actor.name} uses ${action.name}: ${target.name} takes ${finalDamage} ${action.damageType ?? 'damage'}`,
        finalDamage > 0 ? 'damage' : 'info',
        actor.name,
        finalDamage === damage.total ? damage.detail : `${damage.detail}; adjusted from ${damage.total}`,
      ),
      ...effectLogs,
    ],
  }
}

const resolveHeal = (
  actor: Combatant,
  target: Combatant,
  action: ActionDefinition,
  plannedAction: PlannedActionIntent | undefined,
  rng: () => number,
  round: number,
) => {
  const rolledHealing =
    plannedAction?.healingAmount !== undefined ? undefined : rollExpression(action.healingDice ?? '1d4', rng)
  const healing = plannedAction?.healingAmount ?? rolledHealing?.total ?? 0
  const effectResult = applyActionEffects(applyHealing(target, healing), action, actor.name)
  const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))

  return {
    target: effectResult.target,
    landed: healing > 0,
    critical: false,
    targetId: target.id,
    logs: [
      makeLog(
        round,
        `${actor.name} restores ${healing} HP to ${target.name} with ${action.name}`,
        'heal',
        actor.name,
        plannedAction?.healingAmount !== undefined ? `planned heal amount ${plannedAction.healingAmount}` : rolledHealing?.detail,
      ),
      ...effectLogs,
    ],
  }
}

const spendActionResource = (actor: Combatant, action: ActionDefinition, round: number) => {
  const availability = actionResourceAvailability(actor, action)
  if (!availability.cost) {
    return {
      actor,
      available: true,
      logs: [] as LogEntry[],
    }
  }

  const costLabel = resourceCostLabel(availability.cost)
  if (!availability.resource) {
    return {
      actor,
      available: false,
      logs: [
        makeLog(
          round,
          `${actor.name} cannot use ${action.name}: missing ${costLabel}.`,
          'system',
          actor.name,
          'Add the resource in Details or import spell slots with the character.',
        ),
      ],
    }
  }

  if (availability.resource.current < availability.cost.amount) {
    return {
      actor,
      available: false,
      logs: [
        makeLog(
          round,
          `${actor.name} cannot use ${action.name}: insufficient ${availability.resource.label}.`,
          'system',
          actor.name,
          `${availability.resource.current}/${availability.resource.max} available; needs ${availability.cost.amount}.`,
        ),
      ],
    }
  }

  const nextCurrent = Math.max(0, availability.resource.current - availability.cost.amount)
  const updatedActor = {
    ...actor,
    resources: actor.resources.map((resource) =>
      resource.id === availability.resource?.id
        ? {
            ...resource,
            current: nextCurrent,
          }
        : resource,
    ),
  }

  return {
    actor: updatedActor,
    available: true,
    logs: [
      makeLog(
        round,
        `${actor.name} spends ${costLabel} for ${action.name}.`,
        'system',
        actor.name,
        `${availability.resource.label}: ${nextCurrent}/${availability.resource.max}`,
      ),
    ],
  }
}

const rechargeThreshold = (resource: { rechargeMin?: number }) =>
  Math.min(6, Math.max(2, Math.round(resource.rechargeMin ?? 6)))

const rechargeTurnResources = (actor: Combatant, rng: () => number, round: number) => {
  const logs: LogEntry[] = []
  let changed = false

  const resources = actor.resources.map((resource) => {
    if (resource.recovery !== 'recharge' || resource.current >= resource.max) {
      return resource
    }

    const threshold = rechargeThreshold(resource)
    const roll = Math.floor(rng() * 6) + 1
    const recharged = roll >= threshold
    logs.push(
      makeLog(
        round,
        recharged
          ? `${actor.name}'s ${resource.label} recharges.`
          : `${actor.name}'s ${resource.label} does not recharge.`,
        recharged ? 'system' : 'info',
        actor.name,
        `d6 ${roll}; recharges on ${threshold}-6`,
      ),
    )

    if (!recharged) {
      return resource
    }

    changed = true
    return {
      ...resource,
      current: resource.max,
    }
  })

  return {
    actor: changed ? { ...actor, resources } : actor,
    logs,
  }
}

const executePlannedActionQueue = (
  combatants: Combatant[],
  actorId: string,
  plannedActions: PlannedActionIntent[],
  rng: () => number,
  round: number,
  logs: LogEntry[],
) => {
  let updatedCombatants = combatants
  let previousTargetId: string | undefined
  let previousAction: ActionDefinition | undefined
  let previousActionLanded = false
  let previousActionCritical = false

  for (const plannedAction of plannedActions) {
    const actor = updatedCombatants.find((combatant) => combatant.id === actorId)
    if (!actor) {
      break
    }

    let updatedActor = actor
    if (isNoActionId(plannedAction.actionId)) {
      logs.push(makeLog(round, `${updatedActor.name} takes no action.`, 'system', updatedActor.name))
      previousActionLanded = false
      previousActionCritical = false
      previousAction = undefined
      continue
    }

    const action = findActionById(updatedActor, plannedAction.actionId)
    if (!action) {
      logs.push(makeLog(round, `${updatedActor.name} has an unconfigured planned action.`, 'system', updatedActor.name))
      previousActionLanded = false
      previousActionCritical = false
      previousAction = undefined
      continue
    }

    const damageModifier = isDamageModifierAction(action)
    const immediateDamage = isImmediateDamageAction(action)
    const triggeredTargetId =
      damageModifier &&
      !plannedAction.targetId &&
      previousActionLanded &&
      actionSupportsDamageModifier(previousAction, action)
        ? previousTargetId
        : undefined

    if (damageModifier && !plannedAction.targetId && !triggeredTargetId) {
      logs.push(
        makeLog(
          round,
          `${updatedActor.name}'s ${action.name} has no compatible landed action to modify.`,
          'system',
          updatedActor.name,
          action.description,
        ),
      )
      previousActionLanded = false
      previousActionCritical = false
      previousAction = undefined
      continue
    }

    const targetId =
      plannedAction.targetId ??
      triggeredTargetId ??
      defaultTargetIdForAction(
        updatedActor,
        action,
        updatedCombatants,
        updatedActor.strategy === 'manual' ? 'nearest' : updatedActor.strategy,
      )
      ?? updatedActor.intent.targetId
    let target = updatedCombatants.find((combatant) => combatant.id === targetId)

    if (!target || (!living(target) && !triggeredTargetId)) {
      logs.push(makeLog(round, `${updatedActor.name} has no legal target for ${action.name}.`, 'system', updatedActor.name))
      previousActionLanded = false
      previousActionCritical = false
      previousAction = undefined
      continue
    }

    const range = action.rangeFt ?? action.reachFt ?? 5
    const distance = gridDistanceFt(updatedActor.position, target.position)
    if (action.target !== 'self' && !triggeredTargetId && distance > range) {
      logs.push(
        makeLog(
          round,
          `${updatedActor.name}'s ${action.name} is out of range (${distance} ft > ${range} ft).`,
          'miss',
          updatedActor.name,
        ),
      )
      previousActionLanded = false
      previousActionCritical = false
      previousAction = undefined
      continue
    }

    const resourceSpend = spendActionResource(updatedActor, action, round)
    if (!resourceSpend.available) {
      logs.push(...resourceSpend.logs)
      previousActionLanded = false
      previousActionCritical = false
      previousAction = undefined
      continue
    }

    if (resourceSpend.actor !== updatedActor) {
      updatedActor = resourceSpend.actor
      updatedCombatants = updatedCombatants.map((combatant) =>
        combatant.id === updatedActor.id ? updatedActor : combatant,
      )
      if (target.id === updatedActor.id) {
        target = updatedActor
      }
    }
    logs.push(...resourceSpend.logs)

    let result: ActionResolutionResult | undefined
    if (damageModifier) {
      result = resolveDamageModifier(updatedActor, target, action, rng, round, Boolean(triggeredTargetId && previousActionCritical))
    } else if (immediateDamage) {
      result = resolveManualDamage(updatedActor, target, action, rng, round)
    } else if (action.kind === 'attack') {
      result = resolveAttack(updatedActor, target, action, rng, round)
    } else if (action.kind === 'save') {
      result = resolveSave(updatedActor, target, action, rng, round)
    } else if (action.kind === 'heal') {
      result = resolveHeal(updatedActor, target, action, plannedAction, rng, round)
    } else {
      const effectResult = applyActionEffects(target, action, updatedActor.name)
      const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))
      result = {
        target: effectResult.target,
        logs: [
          makeLog(
            round,
            `${updatedActor.name}'s ${action.name} needs manual adjudication.`,
            'system',
            updatedActor.name,
            updatedActor.intent.manualNote,
          ),
          ...effectLogs,
        ],
      }
    }

    if (result) {
      logs.push(...result.logs)
      updatedCombatants = updatedCombatants.map((combatant) =>
        combatant.id === result?.target.id ? result.target : combatant,
      )
      previousTargetId = result.targetId ?? result.target.id
      previousActionLanded = result.landed ?? true
      previousActionCritical = result.critical ?? false
      previousAction = damageModifier ? previousAction : action
    }
  }

  return updatedCombatants
}

const resolveCombatantTurn = (
  combatants: Combatant[],
  combatantId: string,
  rng: () => number,
  round: number,
) => {
  const logs: LogEntry[] = []
  let actor = combatants.find((combatant) => combatant.id === combatantId)

  if (!actor || !living(actor)) {
    return { combatants, logs }
  }

  const rechargeResult = rechargeTurnResources(actor, rng, round)
  logs.push(...rechargeResult.logs)
  if (rechargeResult.actor !== actor) {
    actor = rechargeResult.actor
    combatants = combatants.map((combatant) => (combatant.id === actor?.id ? actor : combatant))
  }

  if (cannotAct(actor)) {
    logs.push(makeLog(round, `${actor.name} cannot act because of a condition.`, 'system', actor.name))
    return { combatants, logs }
  }

  const plannedActions = plannedActionsFor(actor)
  if (!plannedActions.length) {
    logs.push(makeLog(round, `${actor.name} has no configured actions.`, 'system', actor.name))
    return { combatants, logs }
  }

  let updatedCombatants = combatants
  if (actor.intent.destination) {
    const distance = gridDistanceFt(actor.position, actor.intent.destination)
    const speedBudget = effectiveSpeed(actor)
    const overBudgetFt = Math.max(0, distance - speedBudget)
    const destination = actor.intent.destination

    logs.push(
      makeLog(
        round,
        `${actor.name} moves ${distance} ft${overBudgetFt > 0 ? ` (${overBudgetFt} ft over speed)` : ''}`,
        'info',
        actor.name,
        `(${actor.position.x}, ${actor.position.y}) to (${destination.x}, ${destination.y})${
          overBudgetFt > 0 ? ` · Speed ${speedBudget} ft` : ''
        }`,
      ),
    )

    updatedCombatants = updatedCombatants.map((combatant) =>
      combatant.id === actor.id ? { ...combatant, position: destination } : combatant,
    )
  }

  return {
    combatants: executePlannedActionQueue(updatedCombatants, combatantId, plannedActions, rng, round, logs),
    logs,
  }
}

const resolveScheduledAction = (
  combatants: Combatant[],
  scheduledAction: ScheduledAction,
  rng: () => number,
  round: number,
) => {
  const logs: LogEntry[] = []
  const actor = combatants.find((combatant) => combatant.id === scheduledAction.ownerCombatantId)

  if (!actor || !living(actor)) {
    logs.push(
      makeLog(round, `${scheduledAction.ownerCombatantId} no longer has a valid scheduled action owner.`, 'system', scheduledAction.ownerCombatantId),
    )
    return { combatants, logs }
  }

  if (isNoActionId(scheduledAction.actionId)) {
    logs.push(makeLog(round, `${actor.name} has a scheduled action that does nothing.`, 'system', actor.name))
    return { combatants, logs }
  }

  return {
    combatants: executePlannedActionQueue(
      combatants,
      actor.id,
      [
        {
          id: scheduledAction.id,
          actionId: scheduledAction.actionId,
          targetId: scheduledAction.targetId,
          healingAmount: scheduledAction.healingAmount,
        },
      ],
      rng,
      round,
      logs,
    ),
    logs,
  }
}

const resolveCurrentTimelineItem = (battle: BattleState): BattleState => {
  const timeline = getBattleTimeline(battle)
  if (!battle.combatants.length || !timeline.length) {
    return battle
  }

  const itemIndex = currentTimelineIndex(battle, timeline)
  const item = timeline[itemIndex]
  if (!item) {
    return battle
  }

  const rng = createRng(`${battle.seed}:timeline:${battle.round}:${battle.log.length}:${item.id}`)
  let combatants = battle.combatants
  let scheduledActions = [...battle.scheduledActions]
  const logs: LogEntry[] = []

  if (item.type === 'scheduledAction') {
    const scheduledAction = scheduledActions.find((action) => action.id === item.scheduledActionId)
    if (!scheduledAction) {
      logs.push(
        makeLog(
          battle.round,
          `A scheduled action at initiative ${item.initiative} is no longer available and is being skipped.`,
          'system',
        ),
      )
    } else {
      const result = resolveScheduledAction(combatants, scheduledAction, rng, battle.round)
      logs.push(...result.logs)
      combatants = result.combatants
      scheduledActions = scheduledActions.filter((action) => action.id !== scheduledAction.id)
    }
  } else {
    const result = resolveCombatantTurn(combatants, item.combatantId, rng, battle.round)
    logs.push(...result.logs)
    combatants = result.combatants
  }

  const roundEnds = itemIndex >= timeline.length - 1
  const nextRound = roundEnds ? battle.round + 1 : battle.round
  const nextCombatants = roundEnds ? combatants.map(tickStatusDurations) : combatants

  const nextBattle: BattleState = {
    ...battle,
    round: nextRound,
    combatants: nextCombatants,
    scheduledActions,
    timelineCursor: {
      round: nextRound,
      itemIndex: roundEnds ? 0 : itemIndex + 1,
    },
    status: 'active',
    log: [
      ...(roundEnds ? [makeLog(battle.round, `Round ${battle.round} resolved.`, 'system')] : []),
      ...logs.reverse(),
      ...battle.log,
    ],
  }

  return {
    ...nextBattle,
    selectedCombatantId: getCurrentTimelineCombatantId(nextBattle) ?? nextCombatants[0]?.id,
  }
}

export const resolveCurrentTurn = (battle: BattleState): BattleState => {
  return resolveCurrentTimelineItem(battle)
}

export const resolveRound = (battle: BattleState): BattleState => {
  if (!battle.combatants.length) {
    return battle
  }

  let state = battle
  while (state.round === battle.round) {
    const item = getCurrentTimelineItem(state)
    if (!item) {
      return state
    }

    state = resolveCurrentTimelineItem(state)

    if (state.round > battle.round) {
      return state
    }

    if (item.type === 'scheduledAction') {
      return state
    }
  }

  return state
}

const filterScheduledActions = (combatants: Combatant[], scheduledActions: ScheduledAction[]) => {
  const combatantIds = new Set(combatants.map((combatant) => combatant.id))

  return scheduledActions.filter((action) => {
    const hasOwner = combatantIds.has(action.ownerCombatantId)
    const hasTrigger = action.timingMode === 'initiativeCount' || !action.triggerCombatantId || combatantIds.has(action.triggerCombatantId)

    return hasOwner && hasTrigger
  })
}

export const longRestBattle = (battle: BattleState): BattleState => ({
  ...battle,
  status: 'setup',
  round: 1,
  timelineCursor: { round: 1, itemIndex: 0 },
  combatants: battle.combatants.map((combatant) => ({
    ...combatant,
    currentHp: combatant.maxHp,
    initiative: undefined,
    conditions: [],
    activeEffects: [],
    resources: combatant.resources.map((resource) => ({
      ...resource,
      current: resource.max,
    })),
    intent: makeDefaultIntent(combatant, combatant.id),
  })),
  scheduledActions: [],
  log: [makeLog(1, 'Long rest complete. HP, resources, conditions, effects, initiative, and intents reset.', 'system'), ...battle.log],
})

export const removeDefeated = (battle: BattleState): BattleState => ({
  ...battle,
  combatants: battle.combatants.filter(living),
  scheduledActions: filterScheduledActions(battle.combatants.filter(living), battle.scheduledActions),
  log: [makeLog(battle.round, 'Removed defeated combatants from the field.', 'system'), ...battle.log],
})

export const getEnemySide = enemySides
