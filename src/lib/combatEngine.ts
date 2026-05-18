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
  Side,
  Strategy,
} from '../types'
import { abilityModifier, createRng, rollD20, rollDamageExpression, rollExpression } from './dice'
import { gridDistanceFt, stepToward } from './grid'

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

export const makeDefaultIntent = (entry: Pick<ContentEntry, 'actions'>) => ({
  actionId: entry.actions[0]?.id ?? 'manual',
  actionQueue: [
    {
      id: createId('planned-action'),
      actionId: entry.actions[0]?.id ?? 'manual',
    },
  ],
  advantage: false,
  disadvantage: false,
  rollAdjustments: createRollAdjustments(),
})

export const makeCombatant = (
  entry: ContentEntry,
  side: Side,
  position: GridPoint,
  strategy: Strategy = side === 'Heroes' ? 'manual' : 'nearest',
): Combatant => ({
  id: createId('combatant'),
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
  })),
  rollBonuses: { ...(entry.rollBonuses ?? {}) },
  strategy,
  intent: makeDefaultIntent(entry),
})

export const makeInitialBattle = (): BattleState => ({
  round: 1,
  seed: `playtest-${new Date().toISOString().slice(0, 10)}`,
  status: 'setup',
  combatants: [],
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

const findAction = (combatant: Combatant): ActionDefinition | undefined =>
  combatant.actions.find(
    (action) => action.id === (combatant.intent.actionQueue?.[0]?.actionId ?? combatant.intent.actionId),
  ) ?? combatant.actions[0]

const findActionById = (combatant: Combatant, actionId: string): ActionDefinition | undefined =>
  combatant.actions.find((action) => action.id === actionId)

const plannedActionsFor = (combatant: Combatant): PlannedActionIntent[] => {
  const fallbackActionId = findAction(combatant)?.id ?? combatant.intent.actionId
  const queue = combatant.intent.actionQueue?.length
    ? combatant.intent.actionQueue
    : [{ id: 'primary-action', actionId: fallbackActionId, targetId: combatant.intent.targetId }]

  return queue.map((plannedAction, index) => ({
    id: plannedAction.id ?? `planned-action-${index}`,
    actionId: findActionById(combatant, plannedAction.actionId)?.id ?? fallbackActionId,
    targetId: plannedAction.targetId ?? combatant.intent.targetId,
  }))
}

const proficiencyBonus = (combatant: Combatant) => combatant.proficiencyBonus ?? 2

const rollBonusConfig = (combatant: Combatant, key: RollProfileKey): RollBonusConfig => ({
  proficient: combatant.rollBonuses?.[key]?.proficient ?? false,
  bonus: combatant.rollBonuses?.[key]?.bonus ?? 0,
})

const rollProfileBonus = (combatant: Combatant, key: RollProfileKey) => {
  const config = rollBonusConfig(combatant, key)

  return config.bonus + (config.proficient ? proficiencyBonus(combatant) : 0)
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

  return {
    ...battle,
    status: 'active',
    combatants,
    selectedCombatantId: battle.selectedCombatantId ?? combatants[0]?.id,
    log: [...logs, ...battle.log],
  }
}

export const autoPlanRound = (battle: BattleState): BattleState => {
  const combatants = battle.combatants.map((combatant) => {
    if (!living(combatant) || cannotAct(combatant) || combatant.strategy === 'manual') {
      return combatant
    }

    const target = chooseTarget(combatant, battle.combatants, combatant.strategy)
    const action = chooseStrategyAction(combatant, target)
    const range = action?.rangeFt ?? action?.reachFt ?? 5
    const destination =
      target && gridDistanceFt(combatant.position, target.position) > range
        ? stepToward(combatant.position, target.position, effectiveSpeed(combatant), range)
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
            targetId: target?.id,
          },
        ],
        targetId: target?.id,
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
    return { target, logs }
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
  const saveBonus =
    abilityModifier(target.abilityScores?.[ability] ?? 10) +
    (target.saveProficiencies?.includes(ability) ? proficiencyBonus(target) : 0) +
    rollProfileBonus(target, `${ability}Save`)
  const saveAdjustment = getRollAdjustment(actor, 'save')
  const damageAdjustment = getRollAdjustment(actor, 'damage')
  const adjustedSaveBonus = saveBonus + saveAdjustment.modifier
  const forcedFailure = conditionAutoFailsSave(target, ability)
  const saveD20 = rollD20(rng, rollMode(saveAdjustment, false, conditionSaveDisadvantage(target, ability)))
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

const resolveHeal = (
  actor: Combatant,
  target: Combatant,
  action: ActionDefinition,
  rng: () => number,
  round: number,
) => {
  const healing = rollExpression(action.healingDice ?? '1d4', rng)
  const effectResult = applyActionEffects(applyHealing(target, healing.total), action, actor.name)
  const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round }))

  return {
    target: effectResult.target,
    logs: [
      makeLog(
        round,
        `${actor.name} restores ${healing.total} HP to ${target.name} with ${action.name}`,
        'heal',
        actor.name,
        healing.detail,
      ),
      ...effectLogs,
    ],
  }
}

export const resolveRound = (battle: BattleState): BattleState => {
  if (!battle.combatants.length) {
    return battle
  }

  const rng = createRng(`${battle.seed}:round:${battle.round}:${battle.log.length}`)
  let combatants = [...battle.combatants].sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0))
  const logs: LogEntry[] = []

  for (const actorSnapshot of combatants) {
    const actor = combatants.find((combatant) => combatant.id === actorSnapshot.id)

    if (!actor || !living(actor)) {
      continue
    }

    if (cannotAct(actor)) {
      logs.push(makeLog(battle.round, `${actor.name} cannot act because of a condition.`, 'system', actor.name))
      continue
    }

    const plannedActions = plannedActionsFor(actor)
    if (!plannedActions.length) {
      logs.push(makeLog(battle.round, `${actor.name} has no configured actions.`, 'system', actor.name))
      continue
    }

    if (actor.intent.destination) {
      const distance = gridDistanceFt(actor.position, actor.intent.destination)
      const speedBudget = effectiveSpeed(actor)
      const overBudgetFt = Math.max(0, distance - speedBudget)
      const destination = actor.intent.destination

      logs.push(
        makeLog(
          battle.round,
          `${actor.name} moves ${distance} ft${overBudgetFt > 0 ? ` (${overBudgetFt} ft over speed)` : ''}`,
          'info',
          actor.name,
          `(${actor.position.x}, ${actor.position.y}) to (${destination.x}, ${destination.y})${
            overBudgetFt > 0 ? ` · Speed ${speedBudget} ft` : ''
          }`,
        ),
      )

      combatants = combatants.map((combatant) =>
        combatant.id === actor.id ? { ...combatant, position: destination } : combatant,
      )
    }

    for (const plannedAction of plannedActions) {
      const updatedActor = combatants.find((combatant) => combatant.id === actor.id) ?? actor
      const action = findActionById(updatedActor, plannedAction.actionId)

      if (!action) {
        logs.push(makeLog(battle.round, `${updatedActor.name} has an unconfigured planned action.`, 'system', updatedActor.name))
        continue
      }

      const targetId =
        plannedAction.targetId ??
        updatedActor.intent.targetId ??
        (action.target === 'self'
          ? updatedActor.id
          : chooseTarget(updatedActor, combatants, updatedActor.strategy === 'manual' ? 'nearest' : updatedActor.strategy)?.id)
      const target = combatants.find((combatant) => combatant.id === targetId)

      if (!target || !living(target)) {
        logs.push(makeLog(battle.round, `${updatedActor.name} has no legal target for ${action.name}.`, 'system', updatedActor.name))
        continue
      }

      const range = action.rangeFt ?? action.reachFt ?? 5
      const distance = gridDistanceFt(updatedActor.position, target.position)
      if (action.target !== 'self' && distance > range) {
        logs.push(
          makeLog(
            battle.round,
            `${updatedActor.name}'s ${action.name} is out of range (${distance} ft > ${range} ft).`,
            'miss',
            updatedActor.name,
          ),
        )
        continue
      }

      let result:
        | {
            target: Combatant
            logs: LogEntry[]
          }
        | undefined

      if (action.kind === 'attack') {
        result = resolveAttack(updatedActor, target, action, rng, battle.round)
      } else if (action.kind === 'save') {
        result = resolveSave(updatedActor, target, action, rng, battle.round)
      } else if (action.kind === 'heal') {
        result = resolveHeal(updatedActor, target, action, rng, battle.round)
      } else {
        const effectResult = applyActionEffects(target, action, updatedActor.name)
        const effectLogs = effectResult.logs.map((entry) => ({ ...entry, round: battle.round }))
        result = {
          target: effectResult.target,
          logs: [
            makeLog(
              battle.round,
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
        combatants = combatants.map((combatant) =>
          combatant.id === result?.target.id ? result.target : combatant,
        )
      }
    }
  }

  const combatantsAfterDurations = combatants.map(tickStatusDurations)
  const completionLog = [makeLog(battle.round, `Round ${battle.round} resolved.`, 'system')]

  return {
    ...battle,
    round: battle.round + 1,
    status: 'active',
    combatants: combatantsAfterDurations,
    log: [...completionLog, ...logs.reverse(), ...battle.log],
  }
}

export const longRestBattle = (battle: BattleState): BattleState => ({
  ...battle,
  status: 'setup',
  round: 1,
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
    intent: makeDefaultIntent(combatant),
  })),
  log: [makeLog(1, 'Long rest complete. HP, resources, conditions, effects, initiative, and intents reset.', 'system'), ...battle.log],
})

export const removeDefeated = (battle: BattleState): BattleState => ({
  ...battle,
  combatants: battle.combatants.filter(living),
  log: [makeLog(battle.round, 'Removed defeated combatants from the field.', 'system'), ...battle.log],
})

export const getEnemySide = enemySides
