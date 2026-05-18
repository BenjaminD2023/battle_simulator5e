import type { Ability, ActionDefinition, ContentEntry } from '../types'
import { readCache, writeCache } from './storage'

const API_BASE = 'https://www.dnd5eapi.co'
const API_ROOT = `${API_BASE}/api/2014`

export type SrdIndexItem = {
  index: string
  name: string
  url: string
}

type SrdIndexResponse = {
  count: number
  results: SrdIndexItem[]
}

type SrdMonsterAction = {
  name: string
  desc?: string
  attack_bonus?: number
  damage?: Array<{
    damage_dice?: string
    damage_type?: {
      name?: string
    }
  }>
  dc?: {
    dc_type?: {
      index?: Ability
      name?: string
    }
    dc_value?: number
    success_type?: string
  }
}

type SrdMonster = {
  index: string
  name: string
  size?: string
  type?: string
  challenge_rating?: number
  armor_class?: number | Array<{ value?: number }>
  hit_points?: number
  speed?: Record<string, string>
  strength?: number
  dexterity?: number
  constitution?: number
  intelligence?: number
  wisdom?: number
  charisma?: number
  proficiencies?: Array<{
    value: number
    proficiency?: SrdIndexItem
  }>
  damage_vulnerabilities?: string[]
  damage_resistances?: string[]
  damage_immunities?: string[]
  condition_immunities?: SrdIndexItem[]
  actions?: SrdMonsterAction[]
  special_abilities?: Array<{ name: string; desc?: string }>
  url?: string
}

export type SrdClass = {
  index: string
  name: string
  hit_die: number
  proficiencies?: SrdIndexItem[]
  saving_throws?: Array<SrdIndexItem & { index: Ability }>
  starting_equipment?: Array<{
    equipment: SrdIndexItem
    quantity: number
  }>
  url?: string
}

export type SrdRace = {
  index: string
  name: string
  speed: number
  ability_bonuses?: Array<{
    ability_score: SrdIndexItem & { index: Ability }
    bonus: number
  }>
  size?: string
  traits?: SrdIndexItem[]
  languages?: SrdIndexItem[]
  url?: string
}

export type SrdEquipment = {
  index: string
  name: string
  equipment_category?: SrdIndexItem
  weapon_category?: string
  weapon_range?: 'Melee' | 'Ranged'
  category_range?: string
  damage?: {
    damage_dice?: string
    damage_type?: SrdIndexItem
  }
  range?: {
    normal?: number
    long?: number
  }
  properties?: SrdIndexItem[]
  url?: string
}

export type SrdSpell = {
  index: string
  name: string
  desc?: string[]
  range?: string
  level: number
  attack_type?: 'melee' | 'ranged'
  damage?: {
    damage_type?: SrdIndexItem
    damage_at_character_level?: Record<string, string>
    damage_at_slot_level?: Record<string, string>
  }
  dc?: {
    dc_type?: SrdIndexItem & { index: Ability }
    dc_success?: 'none' | 'half' | 'other'
  }
  classes?: SrdIndexItem[]
  url?: string
}

type SrdWeaponCategory = {
  index: string
  name: string
  equipment: SrdIndexItem[]
}

const fetchCachedJson = async <T>(cacheKey: string, url: string): Promise<T> => {
  const cached = await readCache<T>(cacheKey)

  if (cached) {
    return cached
  }

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`SRD request failed: ${response.status}`)
  }

  const payload = (await response.json()) as T
  await writeCache(cacheKey, payload)
  return payload
}

export const fetchSrdMonsterIndex = async () => {
  const cacheKey = 'srd:2014:monsters:index'
  const cached = await readCache<SrdIndexItem[]>(cacheKey)

  if (cached?.length) {
    return cached
  }

  const response = await fetch(`${API_ROOT}/monsters`)
  if (!response.ok) {
    throw new Error(`SRD monster index request failed: ${response.status}`)
  }

  const payload = (await response.json()) as SrdIndexResponse
  await writeCache(cacheKey, payload.results)
  return payload.results
}

export const fetchSrdMonster = async (index: string) => {
  const cacheKey = `srd:2014:monster:${index}`
  const cached = await readCache<SrdMonster>(cacheKey)

  if (cached) {
    return normalizeSrdMonster(cached)
  }

  const response = await fetch(`${API_ROOT}/monsters/${index}`)
  if (!response.ok) {
    throw new Error(`SRD monster request failed: ${response.status}`)
  }

  const monster = (await response.json()) as SrdMonster
  await writeCache(cacheKey, monster)
  return normalizeSrdMonster(monster)
}

export const fetchSrdClassIndex = async () => {
  const payload = await fetchCachedJson<SrdIndexResponse>('srd:2014:classes:index', `${API_ROOT}/classes`)
  return payload.results
}

export const fetchSrdRaceIndex = async () => {
  const payload = await fetchCachedJson<SrdIndexResponse>('srd:2014:races:index', `${API_ROOT}/races`)
  return payload.results
}

export const fetchSrdWeaponIndex = async () => {
  const payload = await fetchCachedJson<SrdWeaponCategory>('srd:2014:weapons:index', `${API_ROOT}/equipment-categories/weapon`)
  return payload.equipment.filter((item) => item.url.includes('/equipment/'))
}

export const fetchSrdSpellIndex = async () => {
  const payload = await fetchCachedJson<SrdIndexResponse>('srd:2014:spells:index', `${API_ROOT}/spells`)
  return payload.results
}

export const fetchSrdClass = (index: string) =>
  fetchCachedJson<SrdClass>(`srd:2014:class:${index}`, `${API_ROOT}/classes/${index}`)

export const fetchSrdRace = (index: string) =>
  fetchCachedJson<SrdRace>(`srd:2014:race:${index}`, `${API_ROOT}/races/${index}`)

export const fetchSrdEquipment = (index: string) =>
  fetchCachedJson<SrdEquipment>(`srd:2014:equipment:${index}`, `${API_ROOT}/equipment/${index}`)

export const fetchSrdSpell = (index: string) =>
  fetchCachedJson<SrdSpell>(`srd:2014:spell:${index}`, `${API_ROOT}/spells/${index}`)

const parseSpeed = (speed?: Record<string, string>) => {
  const walk = speed?.walk ?? Object.values(speed ?? {})[0] ?? '30 ft.'
  const match = walk.match(/(\d+)/)
  return match ? Number(match[1]) : 30
}

const parseArmorClass = (armorClass?: SrdMonster['armor_class']) => {
  if (Array.isArray(armorClass)) {
    return armorClass[0]?.value ?? 10
  }

  return typeof armorClass === 'number' ? armorClass : 10
}

const actionId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const normalizeAbilityIndex = (index?: string): Ability | undefined => {
  const match = index?.match(/(?:saving-throw-|^)(str|dex|con|int|wis|cha)$/)
  return match?.[1] as Ability | undefined
}

const normalizeSaveProficiencies = (monster: SrdMonster) =>
  monster.proficiencies
    ?.map((proficiency) => normalizeAbilityIndex(proficiency.proficiency?.index))
    .filter((ability): ability is Ability => Boolean(ability)) ?? []

const normalizeAction = (action: SrdMonsterAction): ActionDefinition => {
  const firstDamage = action.damage?.[0]
  const lowerDescription = action.desc?.toLowerCase() ?? ''
  const rangeMatch = lowerDescription.match(/range\s+(\d+)(?:\/(\d+))?\s*ft/)
  const reachMatch = lowerDescription.match(/reach\s+(\d+)\s*ft/)

  if (typeof action.attack_bonus === 'number') {
    return {
      id: actionId(action.name),
      name: action.name,
      kind: 'attack',
      attackBonus: action.attack_bonus,
      damageDice: firstDamage?.damage_dice ?? '1d4',
      damageType: firstDamage?.damage_type?.name?.toLowerCase() ?? 'damage',
      rangeFt: rangeMatch ? Number(rangeMatch[1]) : reachMatch ? Number(reachMatch[1]) : 5,
      reachFt: reachMatch ? Number(reachMatch[1]) : 5,
      target: 'enemy',
      tags: lowerDescription.includes('ranged') ? ['ranged'] : ['melee'],
      description: action.desc,
    }
  }

  if (action.dc?.dc_value && firstDamage?.damage_dice) {
    return {
      id: actionId(action.name),
      name: action.name,
      kind: 'save',
      saveDc: action.dc.dc_value,
      saveAbility: action.dc.dc_type?.index ?? 'dex',
      damageDice: firstDamage.damage_dice,
      damageType: firstDamage.damage_type?.name?.toLowerCase() ?? 'damage',
      damageOnSave: action.dc.success_type === 'half' ? 'half' : 'none',
      rangeFt: rangeMatch ? Number(rangeMatch[1]) : 30,
      reachFt: reachMatch ? Number(reachMatch[1]) : 0,
      target: 'enemy',
      tags: ['save'],
      description: action.desc,
    }
  }

  return {
    id: actionId(action.name),
    name: action.name,
    kind: 'manual',
    rangeFt: rangeMatch ? Number(rangeMatch[1]) : 5,
    reachFt: reachMatch ? Number(reachMatch[1]) : 5,
    target: 'manual',
    tags: ['manual'],
    description: action.desc,
  }
}

export const normalizeSrdMonster = (monster: SrdMonster): ContentEntry => ({
  id: `srd-${monster.index}`,
  name: monster.name,
  kind: 'monster',
  source: {
    kind: 'SRD',
    book: 'SRD 5.1',
    apiIndex: monster.index,
    apiUrl: `${API_BASE}${monster.url ?? `/api/2014/monsters/${monster.index}`}`,
    attribution: 'D&D 5e SRD 5.1 CC-BY-4.0',
  },
  armorClass: parseArmorClass(monster.armor_class),
  maxHp: monster.hit_points ?? 1,
  speedFt: parseSpeed(monster.speed),
  initiativeBonus: Math.floor(((monster.dexterity ?? 10) - 10) / 2),
  challenge: String(monster.challenge_rating ?? ''),
  size: monster.size,
  type: monster.type,
  abilityScores: {
    str: monster.strength ?? 10,
    dex: monster.dexterity ?? 10,
    con: monster.constitution ?? 10,
    int: monster.intelligence ?? 10,
    wis: monster.wisdom ?? 10,
    cha: monster.charisma ?? 10,
  },
  saveProficiencies: normalizeSaveProficiencies(monster),
  resistances: monster.damage_resistances ?? [],
  immunities: [
    ...(monster.damage_immunities ?? []),
    ...(monster.condition_immunities?.map((condition) => `${condition.name} condition`) ?? []),
  ],
  vulnerabilities: monster.damage_vulnerabilities ?? [],
  traits: monster.special_abilities?.map((trait) => `${trait.name}: ${trait.desc ?? ''}`) ?? [],
  resources: [],
  actions: monster.actions?.map(normalizeAction) ?? [],
})
