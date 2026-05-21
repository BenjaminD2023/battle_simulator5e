import type { ActionDefinition } from '../types'

export const noActionId = 'no-action'
export const noActionLabel = 'No action'

export const isNoActionId = (actionId?: string) => actionId === noActionId

const hasTag = (action: ActionDefinition | undefined, tag: string) =>
  action?.tags.some((candidate) => candidate.toLowerCase() === tag) ?? false

const hasAnyTag = (action: ActionDefinition | undefined, tags: string[]) =>
  tags.some((tag) => hasTag(action, tag))

export const isDamageModifierAction = (action: ActionDefinition | undefined) =>
  action?.kind === 'manual' &&
  Boolean(action.damageDice && action.damageDice !== '0') &&
  (action.damageApplication === 'modifier' ||
    hasAnyTag(action, ['damage-modifier', 'modifier', 'on-hit', 'smite']) ||
    /(?:divine smite|improved divine smite|hunter'?s mark|divine favor|extra .*damage|on a hit|when you hit)/i.test(
      `${action.name} ${action.description ?? ''}`,
    ))

export const isImmediateDamageAction = (action: ActionDefinition | undefined) =>
  action?.kind === 'manual' &&
  Boolean(action.damageDice && action.damageDice !== '0') &&
  action.damageApplication !== 'modifier' &&
  !isDamageModifierAction(action)

export const actionSupportsDamageModifier = (
  action: ActionDefinition | undefined,
  modifier: ActionDefinition | undefined,
) => {
  if (!action || !modifier || isDamageModifierAction(action)) {
    return false
  }

  const appliesTo = modifier.damageAppliesTo ?? 'damage'
  const isAttack = action.kind === 'attack'
  const isWeapon =
    hasTag(action, 'weapon') ||
    (isAttack && !hasAnyTag(action, ['spell', 'cantrip']) && Boolean(action.damageDice))
  const isMelee =
    hasTag(action, 'melee') ||
    ((action.reachFt ?? 0) > 0 && (action.rangeFt ?? action.reachFt ?? 5) <= 5)

  if (appliesTo === 'meleeWeaponAttack') {
    return isAttack && isWeapon && isMelee
  }

  if (appliesTo === 'weaponAttack') {
    return isAttack && isWeapon
  }

  if (appliesTo === 'attack') {
    return isAttack
  }

  return Boolean(action.damageDice)
}
