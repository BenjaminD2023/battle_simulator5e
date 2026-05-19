import {
  Activity,
  Archive,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Crosshair,
  Database,
  Download,
  Eye,
  FileJson,
  Flag,
  Gauge,
  Grid3X3,
  HeartPulse,
  LibraryBig,
  Map as MapIcon,
  MousePointer2,
  Move,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Ruler,
  Save,
  RotateCcw,
  Search,
  Settings,
  Shield,
  Swords,
  Square,
  Target,
  Upload,
  UserPlus,
  Users,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { sampleContent } from './data/sampleContent'
import {
  autoPlanRound,
  makeCombatant,
  makeInitialBattle,
  removeDefeated,
  longRestBattle,
  resolveRound,
  rollInitiative,
} from './lib/combatEngine'
import { abilityModifier } from './lib/dice'
import {
  defaultMap,
  detectGridFromImage,
  euclideanDistanceFt,
  gridDistanceFt,
  gridToPixel,
  pixelToGrid,
} from './lib/grid'
import {
  fetchSrdClass,
  fetchSrdClassIndex,
  fetchSrdEquipment,
  fetchSrdMonster,
  fetchSrdMonsterIndex,
  fetchSrdRace,
  fetchSrdRaceIndex,
  fetchSrdSpell,
  fetchSrdSpellIndex,
  fetchSrdWeaponIndex,
  type SrdClass,
  type SrdEquipment,
  type SrdIndexItem,
  type SrdRace,
  type SrdSpell,
} from './lib/srdApi'
import { deleteCache, readCache, readJsonState, writeCache, writeJsonState } from './lib/storage'
import type {
  ActiveEffect,
  ActionDefinition,
  ActionIntent,
  BattleMap,
  BattleState,
  Combatant,
  CombatantCondition,
  ContentEntry,
  EffectDefinition,
  GridCalibration,
  GridPoint,
  PlannedActionIntent,
  ResourceDefinition,
  RollBonusConfig,
  RollProfileKey,
  RollAdjustment,
  RollKey,
  Side,
  Strategy,
  Ability,
} from './types'

type MapTool = 'mouse' | 'move' | 'draw' | 'square' | 'circle' | 'measure' | 'visibility'
type InspectorTab = 'actions' | 'details' | 'conditions' | 'effects'

type MapPixelPoint = {
  x: number
  y: number
}

type MapView = {
  zoom: number
  panX: number
  panY: number
}

type MapAnnotation =
  | {
      id: string
      tool: 'draw'
      color: string
      points: MapPixelPoint[]
    }
  | {
      id: string
      tool: 'square' | 'circle'
      color: string
      center: MapPixelPoint
      widthCells: number
      heightCells: number
      fitToGrid: boolean
    }

type TacticalMapState = {
  activeMapTool: MapTool
  mapView: MapView
  measurement?: { from: GridPoint; to?: GridPoint }
  annotations: MapAnnotation[]
  showAnnotations: boolean
  toolsHidden: boolean
  drawColor: string
  shapeColor: string
  shapeWidthCells: number
  shapeHeightCells: number
  shapeFitToGrid: boolean
}

type GestureLikeEvent = Event & {
  scale?: number
  clientX?: number
  clientY?: number
}

const minMapZoom = 0.05
const maxMapZoom = 10

const clampMapZoom = (zoom: number) => Math.min(maxMapZoom, Math.max(minMapZoom, zoom))

const zoomViewAtPoint = (view: MapView, nextZoom: number, anchor: MapPixelPoint): MapView => {
  const zoom = clampMapZoom(nextZoom)
  const mapX = (anchor.x - view.panX) / view.zoom
  const mapY = (anchor.y - view.panY) / view.zoom

  return {
    zoom: Number(zoom.toFixed(3)),
    panX: anchor.x - mapX * zoom,
    panY: anchor.y - mapY * zoom,
  }
}

const resolveStateUpdate = <T,>(update: React.SetStateAction<T>, current: T) =>
  typeof update === 'function' ? (update as (value: T) => T)(current) : update

const calibrationWithDetection = (
  current: GridCalibration,
  detected: Partial<GridCalibration>,
): GridCalibration => {
  const detectedGrid = detected.detected && typeof detected.cellSizePx === 'number'

  return {
    ...current,
    confidence: detected.confidence ?? 0,
    detected: detectedGrid,
    ...(detectedGrid
      ? {
          cellSizePx: Math.max(12, Math.round(detected.cellSizePx ?? current.cellSizePx)),
          originX: Math.round(detected.originX ?? current.originX),
          originY: Math.round(detected.originY ?? current.originY),
          rotationDeg: detected.rotationDeg ?? current.rotationDeg,
        }
      : {}),
  }
}

const detectionMessage = (detected: Partial<GridCalibration>) =>
  detected.detected && detected.cellSizePx
    ? `Grid detected: ${Math.round(detected.cellSizePx)}px cells · ${Math.round((detected.confidence ?? 0) * 100)}%`
    : `No reliable grid found · ${Math.round((detected.confidence ?? 0) * 100)}%`

const midpoint = (a: MapPixelPoint, b: MapPixelPoint): MapPixelPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})

const pointDistance = (a: MapPixelPoint, b: MapPixelPoint) => Math.hypot(a.x - b.x, a.y - b.y)

type DraftAction = {
  id: string
  name: string
  kind: 'attack' | 'save' | 'heal' | 'manual'
  attackBonus: number
  saveDc: number
  saveAbility: Ability
  damageDice: string
  damageType: string
  damageOnSave: 'none' | 'half'
  rangeFt: number
  reachFt: number
  tags: string
  description: string
}

type DraftContent = {
  name: string
  kind: ContentEntry['kind']
  side: Side
  level: number
  abilityScores: Record<Ability, number>
  saveProficiencies: Ability[]
  attackAbility: Ability
  spellAbility: Ability
  actionMode: 'weaponAttack' | 'spellSave'
  useSrdPlayerMath: boolean
  armorClass: number
  maxHp: number
  speedFt: number
  initiativeBonus: number
  attackName: string
  attackBonus: number
  damageDice: string
  damageType: string
  rangeFt: number
  sourceKind: ContentEntry['source']['kind']
  meleeActions: DraftAction[]
  rangedActions: DraftAction[]
  spellActions: DraftAction[]
  customActions: DraftAction[]
  actionDraft: DraftAction
  resistances: string
  immunities: string
  vulnerabilities: string
  notes: string
}

type SrdCharacterDraft = {
  name: string
  side: Side
  level: number
  classIndex: string
  raceIndex: string
  weaponIndex: string
  spellIndex: string
  selectedWeaponIndexes: string[]
  selectedSpellIndexes: string[]
  actionSource: 'weapon' | 'spell'
  baseAbilityScores: Record<Ability, number>
  attackAbility: Ability
  spellAbility: Ability
  armorClass: number
}

type SrdCharacterBuilderState = {
  classes: SrdIndexItem[]
  races: SrdIndexItem[]
  weapons: SrdIndexItem[]
  spells: SrdIndexItem[]
  selectedClass?: SrdClass
  selectedRace?: SrdRace
  selectedWeapon?: SrdEquipment
  selectedSpell?: SrdSpell
  selectedWeapons: Record<string, SrdEquipment>
  selectedSpells: Record<string, SrdSpell>
  status: string
}

const libraryKey = 'battle-sim-5e:library:v1'
const battleKey = 'battle-sim-5e:battle:v1'
const mapKey = 'battle-sim-5e:map:v1'
const mapImageCacheKey = 'battle-sim-5e:map-image:v1'
const tacticalMapKey = 'battle-sim-5e:tactical-map:v1'
const encounterNameKey = 'battle-sim-5e:encounter-name:v1'
const encounterFileSchema = 'battle-simulator-5e.encounter'
const defaultEncounterName = 'Ruined Watchtower'
type LibraryTab = 'library' | 'custom' | 'character' | 'json'
type AppPage = 'battlefield' | 'combatants' | 'library'

type PersistedMapImage = {
  blob: Blob
  name: string
  type: string
  size: number
  lastModified: number
  width?: number
  height?: number
}

type EncounterMapImage = Omit<PersistedMapImage, 'blob'> & {
  dataUrl: string
}

type EncounterSaveFile = {
  schema: typeof encounterFileSchema
  version: 1
  savedAt: string
  state: {
    library: ContentEntry[]
    battle: BattleState
    battleMap: Omit<BattleMap, 'imageUrl'>
    mapImage?: EncounterMapImage
    tacticalMap: TacticalMapState
    ui: {
      activePage: AppPage
      activeLibraryTab: LibraryTab
      inspectorTab: InspectorTab
      encounterName?: string
      srdQuery: string
      draft: DraftContent
      srdCharacter: SrdCharacterDraft
    }
  }
}

const strategies: Strategy[] = ['manual', 'nearest', 'focusWeak', 'holdLine', 'protectAllies']
const abilities: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha']
const srdConditions = [
  {
    name: 'Blinded',
    note: "Can't see, fails sight checks, attacks have disadvantage, attacks against it have advantage.",
  },
  {
    name: 'Charmed',
    note: "Can't attack or target the charmer with harmful effects; charmer has advantage on social checks.",
  },
  {
    name: 'Deafened',
    note: "Can't hear and fails hearing checks.",
  },
  {
    name: 'Frightened',
    note: "Disadvantage while source is in sight; can't willingly move closer to the source.",
  },
  {
    name: 'Grappled',
    note: 'Speed becomes 0 until the grapple ends.',
  },
  {
    name: 'Incapacitated',
    note: "Can't take actions or reactions.",
  },
  {
    name: 'Invisible',
    note: "Can't be seen without magic or special sense; attacks have advantage, attacks against it have disadvantage.",
  },
  {
    name: 'Paralyzed',
    note: 'Incapacitated, cannot move or speak, fails STR/DEX saves, attacks have advantage, close hits are critical.',
  },
  {
    name: 'Petrified',
    note: 'Transformed into solid substance, incapacitated, resistant to all damage, and immune to poison/disease.',
  },
  {
    name: 'Poisoned',
    note: 'Disadvantage on attack rolls and ability checks.',
  },
  {
    name: 'Prone',
    note: 'Only crawl unless standing; attacks against it have advantage within 5 ft and disadvantage otherwise.',
  },
  {
    name: 'Restrained',
    note: 'Speed becomes 0, attacks against it have advantage, its attacks and DEX saves have disadvantage.',
  },
  {
    name: 'Stunned',
    note: 'Incapacitated, cannot move, speaks falteringly, fails STR/DEX saves, attacks against it have advantage.',
  },
  {
    name: 'Unconscious',
    note: 'Incapacitated, prone, drops held items, fails STR/DEX saves, attacks have advantage, close hits are critical.',
  },
  {
    name: 'Exhaustion',
    note: 'Track the exhaustion level in the note field and apply the relevant SRD penalties.',
  },
] as const

const baseAbilityScores: Record<Ability, number> = {
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
}

const createDraftAction = (
  category: 'melee' | 'ranged' | 'spell' | 'custom',
  overrides: Partial<DraftAction> = {},
): DraftAction => {
  const defaults: Record<typeof category, DraftAction> = {
    melee: {
      id: `draft-melee-${Date.now()}`,
      name: 'Longsword',
      kind: 'attack',
      attackBonus: 5,
      saveDc: 13,
      saveAbility: 'dex',
      damageDice: '1d8+3',
      damageType: 'slashing',
      damageOnSave: 'none',
      rangeFt: 5,
      reachFt: 5,
      tags: 'melee, weapon',
      description: 'Melee weapon attack.',
    },
    ranged: {
      id: `draft-ranged-${Date.now()}`,
      name: 'Shortbow',
      kind: 'attack',
      attackBonus: 5,
      saveDc: 13,
      saveAbility: 'dex',
      damageDice: '1d6+3',
      damageType: 'piercing',
      damageOnSave: 'none',
      rangeFt: 80,
      reachFt: 0,
      tags: 'ranged, weapon',
      description: 'Ranged weapon attack.',
    },
    spell: {
      id: `draft-spell-${Date.now()}`,
      name: 'Sacred Flame',
      kind: 'save',
      attackBonus: 5,
      saveDc: 13,
      saveAbility: 'dex',
      damageDice: '1d8',
      damageType: 'radiant',
      damageOnSave: 'none',
      rangeFt: 60,
      reachFt: 0,
      tags: 'spell',
      description: 'Spell or magical effect.',
    },
    custom: {
      id: `draft-custom-${Date.now()}`,
      name: 'Custom Action',
      kind: 'save',
      attackBonus: 4,
      saveDc: 13,
      saveAbility: 'dex',
      damageDice: '2d6',
      damageType: 'force',
      damageOnSave: 'half',
      rangeFt: 30,
      reachFt: 0,
      tags: 'custom',
      description: 'Configured custom action.',
    },
  }

  return {
    ...defaults[category],
    ...overrides,
    id: overrides.id ?? `${defaults[category].id}-${Math.random().toString(36).slice(2, 6)}`,
  }
}

const splitList = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

const abilityKeys = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const
const actionKinds = ['attack', 'save', 'heal', 'manual'] as const
const contentKinds = ['monster', 'player'] as const
const damageOnSaveOptions = ['none', 'half'] as const
const recoveryKinds = ['round', 'shortRest', 'longRest', 'manual'] as const
const sourceKinds = ['SRD', 'Custom', 'Third-party', 'Imported', 'Draft'] as const
const targetKinds = ['enemy', 'ally', 'self', 'area', 'manual'] as const

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

const asRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const isEnumValue = <T extends string>(value: unknown, options: readonly T[]): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value)

const enumValue = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  isEnumValue(value, options) ? value : fallback

const optionalEnumValue = <T extends string>(value: unknown, options: readonly T[]): T | undefined =>
  isEnumValue(value, options) ? value : undefined

const numberField = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const optionalNumberField = (value: unknown) => {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const stringField = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)

const stringListField = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean)
  }

  return typeof value === 'string' ? splitList(value) : []
}

const abilityListField = (value: unknown) =>
  stringListField(value).filter((entry): entry is Ability => abilityKeys.includes(entry as Ability))

const normalizeImportedEffects = (value: unknown): EffectDefinition[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }

  const effects = value
    .map((effect, index) => {
      const candidate = asRecord(effect)
      if (!candidate) {
        return undefined
      }

      return {
        id: stringField(candidate.id, `imported-effect-${index}`),
        label: stringField(candidate.label, 'Effect'),
        description: stringField(candidate.description, ''),
      }
    })
    .filter((effect): effect is EffectDefinition => Boolean(effect))

  return effects.length ? effects : undefined
}

const normalizeImportedAction = (value: unknown, index: number): ActionDefinition | undefined => {
  const candidate = asRecord(value)
  if (!candidate) {
    return undefined
  }

  const name = stringField(candidate.name, `Imported Action ${index + 1}`)
  const kind = enumValue(candidate.kind, actionKinds, 'manual')
  const target = enumValue(candidate.target, targetKinds, kind === 'heal' ? 'ally' : kind === 'manual' ? 'manual' : 'enemy')

  return {
    id: stringField(candidate.id, slugify(name) || `imported-action-${index}`),
    name,
    kind,
    attackBonus: kind === 'attack' ? numberField(candidate.attackBonus, 0) : optionalNumberField(candidate.attackBonus),
    damageDice: typeof candidate.damageDice === 'string' ? candidate.damageDice : kind === 'heal' ? undefined : '0',
    damageType: typeof candidate.damageType === 'string' ? candidate.damageType : undefined,
    healingDice: typeof candidate.healingDice === 'string' ? candidate.healingDice : kind === 'heal' ? '1d4' : undefined,
    rangeFt: optionalNumberField(candidate.rangeFt),
    reachFt: optionalNumberField(candidate.reachFt),
    saveDc: kind === 'save' ? numberField(candidate.saveDc, 10) : optionalNumberField(candidate.saveDc),
    saveAbility: optionalEnumValue(candidate.saveAbility, abilityKeys),
    damageOnSave: optionalEnumValue(candidate.damageOnSave, damageOnSaveOptions),
    target,
    tags: stringListField(candidate.tags),
    description: typeof candidate.description === 'string' ? candidate.description : undefined,
    effects: normalizeImportedEffects(candidate.effects),
  }
}

const normalizeImportedResource = (value: unknown, index: number): ResourceDefinition | undefined => {
  const candidate = asRecord(value)
  if (!candidate) {
    return undefined
  }

  const label = stringField(candidate.label, `Resource ${index + 1}`)
  const max = Math.max(0, numberField(candidate.max, 0))

  return {
    id: stringField(candidate.id, slugify(label) || `imported-resource-${index}`),
    label,
    max,
    current: Math.max(0, numberField(candidate.current, max)),
    recovery: enumValue(candidate.recovery, recoveryKinds, 'manual'),
  }
}

const normalizeImportedContentEntry = (value: unknown, index: number): ContentEntry | undefined => {
  const candidate = asRecord(value)
  if (!candidate) {
    return undefined
  }

  const name = stringField(candidate.name, `Imported Entry ${index + 1}`)
  const source = asRecord(candidate.source)
  const abilitySource = asRecord(candidate.abilityScores) ?? {}
  const actions = Array.isArray(candidate.actions)
    ? candidate.actions
        .map((action, actionIndex) => normalizeImportedAction(action, actionIndex))
        .filter((action): action is ActionDefinition => Boolean(action))
    : []

  return {
    id: stringField(candidate.id, `imported-${slugify(name) || 'entry'}-${Date.now()}-${index}`),
    name,
    kind: enumValue(candidate.kind, contentKinds, 'monster'),
    source: {
      kind: enumValue(source?.kind, sourceKinds, 'Imported'),
      book: typeof source?.book === 'string' ? source.book : 'Manual JSON import',
      apiIndex: typeof source?.apiIndex === 'string' ? source.apiIndex : undefined,
      apiUrl: typeof source?.apiUrl === 'string' ? source.apiUrl : undefined,
      attribution: typeof source?.attribution === 'string' ? source.attribution : undefined,
    },
    armorClass: numberField(candidate.armorClass, 10),
    maxHp: Math.max(1, numberField(candidate.maxHp, 1)),
    speedFt: Math.max(0, numberField(candidate.speedFt, 30)),
    initiativeBonus: numberField(candidate.initiativeBonus, numberField(abilitySource.dex, 10) >= 10 ? 0 : -1),
    level: optionalNumberField(candidate.level),
    proficiencyBonus: optionalNumberField(candidate.proficiencyBonus),
    challenge: typeof candidate.challenge === 'string' ? candidate.challenge : undefined,
    size: typeof candidate.size === 'string' ? candidate.size : undefined,
    type: typeof candidate.type === 'string' ? candidate.type : undefined,
    abilityScores: {
      ...baseAbilityScores,
      str: numberField(abilitySource.str, 10),
      dex: numberField(abilitySource.dex, 10),
      con: numberField(abilitySource.con, 10),
      int: numberField(abilitySource.int, 10),
      wis: numberField(abilitySource.wis, 10),
      cha: numberField(abilitySource.cha, 10),
    },
    saveProficiencies: abilityListField(candidate.saveProficiencies),
    resistances: stringListField(candidate.resistances),
    immunities: stringListField(candidate.immunities),
    vulnerabilities: stringListField(candidate.vulnerabilities),
    traits: stringListField(candidate.traits),
    resources: Array.isArray(candidate.resources)
      ? candidate.resources
          .map((resource, resourceIndex) => normalizeImportedResource(resource, resourceIndex))
          .filter((resource): resource is ResourceDefinition => Boolean(resource))
      : [],
    actions: actions.length
      ? actions
      : [
          {
            id: 'manual-ruling',
            name: 'Manual Ruling',
            kind: 'manual',
            reachFt: 5,
            rangeFt: 30,
            target: 'manual',
            tags: ['manual'],
            description: 'Imported entry did not include configured actions.',
          },
        ],
    rollBonuses: asRecord(candidate.rollBonuses) as ContentEntry['rollBonuses'],
    notes: typeof candidate.notes === 'string' ? candidate.notes : undefined,
  }
}

const extractJsonText = (value: string) => {
  const trimmed = value.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)

  return (fenced?.[1] ?? trimmed).trim()
}

const importedContentPayload = (payload: unknown) => {
  if (Array.isArray(payload)) {
    return payload
  }

  const candidate = asRecord(payload)
  const state = asRecord(candidate?.state)

  if (Array.isArray(candidate?.entries)) {
    return candidate.entries
  }
  if (Array.isArray(candidate?.content)) {
    return candidate.content
  }
  if (Array.isArray(candidate?.library)) {
    return candidate.library
  }
  if (Array.isArray(state?.library)) {
    return state.library
  }

  return payload ? [payload] : []
}

const parseImportedContentEntries = (value: string) => {
  const parsed = JSON.parse(extractJsonText(value)) as unknown
  const entries = importedContentPayload(parsed)
    .map((entry, index) => normalizeImportedContentEntry(entry, index))
    .filter((entry): entry is ContentEntry => Boolean(entry))

  if (!entries.length) {
    throw new Error('No importable content entries found.')
  }

  return entries
}

const draftActionToDefinition = (
  action: DraftAction,
  category: 'melee' | 'ranged' | 'spell' | 'custom',
): ContentEntry['actions'][number] => ({
  id: action.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || action.id,
  name: action.name.trim() || 'Configured Action',
  kind: action.kind,
  attackBonus: action.kind === 'attack' ? action.attackBonus : undefined,
  saveDc: action.kind === 'save' ? action.saveDc : undefined,
  saveAbility: action.kind === 'save' ? action.saveAbility : undefined,
  damageDice: action.kind === 'heal' ? undefined : action.damageDice,
  healingDice: action.kind === 'heal' ? action.damageDice : undefined,
  damageType: action.kind === 'heal' ? undefined : action.damageType,
  damageOnSave: action.kind === 'save' ? action.damageOnSave : undefined,
  reachFt: category === 'melee' ? Math.max(5, action.reachFt) : action.reachFt,
  rangeFt: action.rangeFt,
  target: action.kind === 'heal' ? 'ally' : action.kind === 'manual' ? 'manual' : 'enemy',
  tags: [...new Set([category, ...splitList(action.tags)])],
  description: action.description,
})

const srdFighterDefaults: Record<Ability, number> = {
  str: 16,
  dex: 14,
  con: 14,
  int: 10,
  wis: 12,
  cha: 10,
}

const srdClericDefaults: Record<Ability, number> = {
  str: 14,
  dex: 10,
  con: 13,
  int: 10,
  wis: 16,
  cha: 12,
}

const proficiencyBonusForLevel = (level: number) => {
  const boundedLevel = Math.min(20, Math.max(1, level))
  return Math.ceil(boundedLevel / 4) + 1
}

const signed = (value: number) => `${value >= 0 ? '+' : ''}${value}`

const damageWithAbility = (dice: string, modifier: number) => {
  const baseDice = dice.trim().match(/^(\d*d\d+)/i)?.[1] ?? (dice.trim() || '1d4')
  return modifier === 0 ? baseDice : `${baseDice}${signed(modifier)}`
}

const derivedPlayerMath = (draft: DraftContent) => {
  const proficiencyBonus = proficiencyBonusForLevel(draft.level)
  const attackModifier = abilityModifier(draft.abilityScores[draft.attackAbility])
  const spellModifier = abilityModifier(draft.abilityScores[draft.spellAbility])

  return {
    proficiencyBonus,
    initiativeBonus: abilityModifier(draft.abilityScores.dex),
    attackBonus: proficiencyBonus + attackModifier,
    damageDice: damageWithAbility(draft.damageDice, attackModifier),
    saveDc: 8 + proficiencyBonus + spellModifier,
  }
}

const applySrdPlayerDefaults = (
  draft: DraftContent,
  preset: 'fighter' | 'cleric' = 'fighter',
): DraftContent => {
  const abilityScores = preset === 'fighter' ? srdFighterDefaults : srdClericDefaults
  const baseDraft = {
    ...draft,
    name: preset === 'fighter' ? 'SRD Fighter' : 'SRD Cleric',
    kind: 'player' as const,
    side: 'Heroes' as const,
    level: 3,
    abilityScores,
    saveProficiencies: preset === 'fighter' ? (['str', 'con'] as Ability[]) : (['wis', 'cha'] as Ability[]),
    useSrdPlayerMath: true,
    attackAbility: preset === 'fighter' ? ('str' as const) : ('wis' as const),
    spellAbility: preset === 'fighter' ? ('str' as const) : ('wis' as const),
    actionMode: preset === 'fighter' ? ('weaponAttack' as const) : ('spellSave' as const),
    armorClass: preset === 'fighter' ? 16 : 18,
    maxHp: preset === 'fighter' ? 28 : 24,
    speedFt: 30,
    attackName: preset === 'fighter' ? 'Longsword' : 'Sacred Flame',
    damageDice: preset === 'fighter' ? '1d8' : '1d8',
    damageType: preset === 'fighter' ? 'slashing' : 'radiant',
    rangeFt: preset === 'fighter' ? 5 : 60,
    meleeActions:
      preset === 'fighter'
        ? [
            createDraftAction('melee', {
              name: 'Longsword',
              attackBonus: 5,
              damageDice: '1d8+3',
              damageType: 'slashing',
            }),
          ]
        : [
            createDraftAction('melee', {
              name: 'Mace',
              attackBonus: 4,
              damageDice: '1d6+2',
              damageType: 'bludgeoning',
            }),
          ],
    rangedActions: [],
    spellActions:
      preset === 'cleric'
        ? [
            createDraftAction('spell', {
              name: 'Sacred Flame',
              saveDc: 13,
              saveAbility: 'dex',
              damageDice: '1d8',
              damageType: 'radiant',
              damageOnSave: 'none',
              rangeFt: 60,
            }),
          ]
        : [],
    customActions: [],
    sourceKind: 'Custom' as const,
    resistances: '',
    immunities: '',
    vulnerabilities: '',
    notes:
      preset === 'fighter'
        ? 'SRD-shaped player entry: proficiency, initiative, attack bonus, and damage modifier are derived from level and abilities.'
        : 'SRD-shaped player entry: spell save DC is derived from level and Wisdom.',
  }
  const math = derivedPlayerMath(baseDraft)

  return {
    ...baseDraft,
    initiativeBonus: math.initiativeBonus,
    attackBonus: math.attackBonus,
    damageDice: math.damageDice,
  }
}

const srdClassDefaults: Record<
  string,
  {
    attackAbility: Ability
    spellAbility: Ability
    weaponIndex: string
    spellIndex: string
    actionSource: 'weapon' | 'spell'
    armorClass: number
    abilityScores: Record<Ability, number>
  }
> = {
  barbarian: {
    attackAbility: 'str',
    spellAbility: 'wis',
    weaponIndex: 'greataxe',
    spellIndex: 'fire-bolt',
    actionSource: 'weapon',
    armorClass: 14,
    abilityScores: { str: 16, dex: 14, con: 15, int: 8, wis: 12, cha: 10 },
  },
  bard: {
    attackAbility: 'dex',
    spellAbility: 'cha',
    weaponIndex: 'rapier',
    spellIndex: 'vicious-mockery',
    actionSource: 'spell',
    armorClass: 14,
    abilityScores: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 16 },
  },
  cleric: {
    attackAbility: 'str',
    spellAbility: 'wis',
    weaponIndex: 'mace',
    spellIndex: 'sacred-flame',
    actionSource: 'spell',
    armorClass: 18,
    abilityScores: srdClericDefaults,
  },
  druid: {
    attackAbility: 'wis',
    spellAbility: 'wis',
    weaponIndex: 'quarterstaff',
    spellIndex: 'produce-flame',
    actionSource: 'spell',
    armorClass: 14,
    abilityScores: { str: 10, dex: 14, con: 13, int: 12, wis: 16, cha: 8 },
  },
  fighter: {
    attackAbility: 'str',
    spellAbility: 'int',
    weaponIndex: 'longsword',
    spellIndex: 'fire-bolt',
    actionSource: 'weapon',
    armorClass: 16,
    abilityScores: srdFighterDefaults,
  },
  monk: {
    attackAbility: 'dex',
    spellAbility: 'wis',
    weaponIndex: 'quarterstaff',
    spellIndex: 'sacred-flame',
    actionSource: 'weapon',
    armorClass: 15,
    abilityScores: { str: 10, dex: 16, con: 13, int: 10, wis: 14, cha: 8 },
  },
  paladin: {
    attackAbility: 'str',
    spellAbility: 'cha',
    weaponIndex: 'longsword',
    spellIndex: 'sacred-flame',
    actionSource: 'weapon',
    armorClass: 18,
    abilityScores: { str: 16, dex: 10, con: 14, int: 8, wis: 10, cha: 14 },
  },
  ranger: {
    attackAbility: 'dex',
    spellAbility: 'wis',
    weaponIndex: 'longbow',
    spellIndex: 'sacred-flame',
    actionSource: 'weapon',
    armorClass: 15,
    abilityScores: { str: 10, dex: 16, con: 13, int: 10, wis: 14, cha: 8 },
  },
  rogue: {
    attackAbility: 'dex',
    spellAbility: 'int',
    weaponIndex: 'rapier',
    spellIndex: 'fire-bolt',
    actionSource: 'weapon',
    armorClass: 14,
    abilityScores: { str: 8, dex: 16, con: 14, int: 13, wis: 12, cha: 10 },
  },
  sorcerer: {
    attackAbility: 'dex',
    spellAbility: 'cha',
    weaponIndex: 'dagger',
    spellIndex: 'fire-bolt',
    actionSource: 'spell',
    armorClass: 12,
    abilityScores: { str: 8, dex: 14, con: 14, int: 10, wis: 10, cha: 16 },
  },
  warlock: {
    attackAbility: 'cha',
    spellAbility: 'cha',
    weaponIndex: 'dagger',
    spellIndex: 'eldritch-blast',
    actionSource: 'spell',
    armorClass: 13,
    abilityScores: { str: 8, dex: 14, con: 14, int: 10, wis: 10, cha: 16 },
  },
  wizard: {
    attackAbility: 'int',
    spellAbility: 'int',
    weaponIndex: 'quarterstaff',
    spellIndex: 'fire-bolt',
    actionSource: 'spell',
    armorClass: 12,
    abilityScores: { str: 8, dex: 14, con: 14, int: 16, wis: 12, cha: 10 },
  },
}

const createSrdCharacterDraft = (): SrdCharacterDraft => ({
  name: 'Aelar SRD Hero',
  side: 'Heroes',
  level: 3,
  classIndex: 'fighter',
  raceIndex: 'human',
  weaponIndex: 'longsword',
  spellIndex: 'fire-bolt',
  selectedWeaponIndexes: ['longsword'],
  selectedSpellIndexes: ['fire-bolt'],
  actionSource: 'weapon',
  baseAbilityScores: { ...srdFighterDefaults },
  attackAbility: 'str',
  spellAbility: 'int',
  armorClass: 16,
})

const createSrdBuilderState = (): SrdCharacterBuilderState => ({
  classes: [],
  races: [],
  weapons: [],
  spells: [],
  selectedWeapons: {},
  selectedSpells: {},
  status: 'SRD character data not loaded',
})

const applySrdClassPreset = (draft: SrdCharacterDraft, classIndex: string): SrdCharacterDraft => {
  const preset = srdClassDefaults[classIndex] ?? srdClassDefaults.fighter

  return {
    ...draft,
    name: `${classIndex.charAt(0).toUpperCase()}${classIndex.slice(1)} Hero`,
    classIndex,
    weaponIndex: preset.weaponIndex,
    spellIndex: preset.spellIndex,
    selectedWeaponIndexes: [preset.weaponIndex],
    selectedSpellIndexes: [preset.spellIndex],
    actionSource: preset.actionSource,
    attackAbility: preset.attackAbility,
    spellAbility: preset.spellAbility,
    armorClass: preset.armorClass,
    baseAbilityScores: { ...preset.abilityScores },
  }
}

const racialBonuses = (race?: SrdRace): Record<Ability, number> => {
  const bonuses = { ...baseAbilityScores }
  abilities.forEach((ability) => {
    bonuses[ability] = 0
  })
  race?.ability_bonuses?.forEach((bonus) => {
    bonuses[bonus.ability_score.index] = (bonuses[bonus.ability_score.index] ?? 0) + bonus.bonus
  })
  return bonuses
}

const srdCharacterScores = (draft: SrdCharacterDraft, race?: SrdRace): Record<Ability, number> => {
  const bonuses = racialBonuses(race)
  return abilities.reduce(
    (scores, ability) => ({
      ...scores,
      [ability]: (draft.baseAbilityScores[ability] ?? 10) + (bonuses[ability] ?? 0),
    }),
    {} as Record<Ability, number>,
  )
}

const spellDamageForLevel = (spell: SrdSpell | undefined, level: number) => {
  const damageByLevel = spell?.damage?.damage_at_character_level ?? spell?.damage?.damage_at_slot_level
  if (!damageByLevel) {
    return '1d4'
  }

  const thresholds = Object.keys(damageByLevel)
    .map(Number)
    .filter((threshold) => threshold <= level)
    .sort((a, b) => b - a)
  const threshold = thresholds[0] ?? Number(Object.keys(damageByLevel).sort()[0])
  return damageByLevel[String(threshold)] ?? '1d4'
}

const parseRangeFt = (range?: string) => {
  const match = range?.match(/(\d+)/)
  return match ? Number(match[1]) : 30
}

const buildSrdWeaponAction = (
  weapon: SrdEquipment,
  selectedClass: SrdClass | undefined,
  proficiencyBonus: number,
  ability: Ability,
  abilityMod: number,
): ContentEntry['actions'][number] => {
  const weaponRange = weapon.range?.normal ?? (weapon.weapon_range === 'Ranged' ? 80 : 5)

  return {
    id: `weapon-${weapon.index}`,
    name: weapon.name,
    kind: 'attack',
    attackBonus: proficiencyBonus + abilityMod,
    damageDice: damageWithAbility(weapon.damage?.damage_dice ?? '1d4', abilityMod),
    damageType: weapon.damage?.damage_type?.name?.toLowerCase() ?? 'damage',
    rangeFt: weaponRange,
    reachFt: weapon.weapon_range === 'Ranged' ? 0 : weaponRange,
    target: 'enemy',
    tags: ['srd', 'weapon', selectedClass?.index ?? 'class'],
    description: `${weapon.name} attack ${signed(proficiencyBonus + abilityMod)} = proficiency ${proficiencyBonus} + ${ability.toUpperCase()} ${signed(abilityMod)}.`,
  }
}

const buildSrdSpellAction = (
  spell: SrdSpell,
  selectedClass: SrdClass | undefined,
  level: number,
  proficiencyBonus: number,
  ability: Ability,
  abilityMod: number,
): ContentEntry['actions'][number] => {
  const spellDamage = spellDamageForLevel(spell, level)
  const spellSaveDc = 8 + proficiencyBonus + abilityMod
  const description = spell.desc?.[0] ?? ''

  if (spell.dc && spell.damage) {
    return {
      id: `spell-${spell.index}`,
      name: spell.name,
      kind: 'save',
      saveDc: spellSaveDc,
      saveAbility: spell.dc.dc_type?.index ?? 'dex',
      damageDice: spellDamage,
      damageType: spell.damage.damage_type?.name?.toLowerCase() ?? 'damage',
      damageOnSave: spell.dc.dc_success === 'half' ? 'half' : 'none',
      rangeFt: parseRangeFt(spell.range),
      reachFt: 0,
      target: 'enemy',
      tags: ['srd', 'spell', selectedClass?.index ?? 'class'],
      description: `${description} Save DC ${spellSaveDc} = 8 + proficiency ${proficiencyBonus} + ${ability.toUpperCase()} ${signed(abilityMod)}.`,
    }
  }

  if (spell.attack_type && spell.damage) {
    return {
      id: `spell-${spell.index}`,
      name: spell.name,
      kind: 'attack',
      attackBonus: proficiencyBonus + abilityMod,
      damageDice: spellDamage,
      damageType: spell.damage.damage_type?.name?.toLowerCase() ?? 'damage',
      rangeFt: parseRangeFt(spell.range),
      reachFt: spell.attack_type === 'melee' ? 5 : 0,
      target: 'enemy',
      tags: ['srd', 'spell', selectedClass?.index ?? 'class'],
      description: `${description} Spell attack ${signed(proficiencyBonus + abilityMod)} = proficiency ${proficiencyBonus} + ${ability.toUpperCase()} ${signed(abilityMod)}.`,
    }
  }

  return {
    id: `spell-${spell.index}`,
    name: spell.name,
    kind: 'manual',
    rangeFt: parseRangeFt(spell.range),
    reachFt: 0,
    target: 'manual',
    tags: ['srd', 'spell', 'manual', selectedClass?.index ?? 'class'],
    description: `${description} This SRD spell needs manual adjudication in the current engine.`,
  }
}

const buildSrdCharacterEntry = (
  draft: SrdCharacterDraft,
  builder: SrdCharacterBuilderState,
): ContentEntry => {
  const selectedClass = builder.selectedClass
  const selectedRace = builder.selectedRace
  const scores = srdCharacterScores(draft, selectedRace)
  const proficiencyBonus = proficiencyBonusForLevel(draft.level)
  const conMod = abilityModifier(scores.con)
  const hitDie = selectedClass?.hit_die ?? 8
  const averageHitDie = Math.floor(hitDie / 2) + 1
  const maxHp = Math.max(draft.level, hitDie + conMod + (draft.level - 1) * (averageHitDie + conMod))
  const initiativeBonus = abilityModifier(scores.dex)
  const attackMod = abilityModifier(scores[draft.attackAbility])
  const spellMod = abilityModifier(scores[draft.spellAbility])
  const selectedWeapons = draft.selectedWeaponIndexes
    .map((index) => builder.selectedWeapons[index] ?? (builder.selectedWeapon?.index === index ? builder.selectedWeapon : undefined))
    .filter((weapon): weapon is SrdEquipment => Boolean(weapon))
  const selectedSpells = draft.selectedSpellIndexes
    .map((index) => builder.selectedSpells[index] ?? (builder.selectedSpell?.index === index ? builder.selectedSpell : undefined))
    .filter((spell): spell is SrdSpell => Boolean(spell))
  const actions = [
    ...selectedWeapons.map((weapon) =>
      buildSrdWeaponAction(weapon, selectedClass, proficiencyBonus, draft.attackAbility, attackMod),
    ),
    ...selectedSpells.map((spell) =>
      buildSrdSpellAction(spell, selectedClass, draft.level, proficiencyBonus, draft.spellAbility, spellMod),
    ),
  ]

  return {
    id: `srd-character-${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
    name: draft.name.trim() || 'SRD Character',
    kind: 'player',
    source: {
      kind: 'SRD',
      book: 'SRD 5.1 character build',
      apiIndex: `${selectedRace?.index ?? draft.raceIndex}-${selectedClass?.index ?? draft.classIndex}`,
      attribution: 'D&D 5e SRD 5.1 CC-BY-4.0',
    },
    armorClass: draft.armorClass,
    maxHp,
    speedFt: selectedRace?.speed ?? 30,
    initiativeBonus,
    level: draft.level,
    proficiencyBonus,
    size: selectedRace?.size ?? 'Medium',
    type: `${selectedRace?.name ?? 'SRD race'} ${selectedClass?.name ?? 'class'}`,
    abilityScores: scores,
    saveProficiencies: selectedClass?.saving_throws?.map((save) => save.index) ?? [],
    resistances: [],
    immunities: [],
    vulnerabilities: [],
    traits: [
      `Class: ${selectedClass?.name ?? draft.classIndex}; hit die d${hitDie}; saves ${
        selectedClass?.saving_throws?.map((save) => save.name).join(', ') ?? 'none listed'
      }.`,
      `Race: ${selectedRace?.name ?? draft.raceIndex}; speed ${selectedRace?.speed ?? 30} ft; bonuses ${selectedRace?.ability_bonuses
        ?.map((bonus) => `${bonus.ability_score.name} +${bonus.bonus}`)
        .join(', ') ?? 'none'}.`,
      ...(selectedRace?.traits?.map((trait) => `Trait: ${trait.name}`) ?? []),
    ],
    resources: [],
    actions: [
      ...actions,
      {
        id: 'manual-ruling',
        name: 'Manual Ruling',
        kind: 'manual',
        reachFt: 5,
        rangeFt: 30,
        target: 'manual',
        tags: ['manual'],
        description: 'Pause and record an adjudicated SRD character feature.',
      },
    ],
    notes: `Built from SRD API class/race data: ${selectedRace?.name ?? draft.raceIndex} ${selectedClass?.name ?? draft.classIndex}.`,
  }
}

const createDemoBattle = () => {
  const battle = makeInitialBattle()
  const fighter = sampleContent.find((entry) => entry.id === 'custom-fighter')
  const cleric = sampleContent.find((entry) => entry.id === 'custom-cleric')
  const goblin = sampleContent.find((entry) => entry.id === 'srd-goblin')
  const ogre = sampleContent.find((entry) => entry.id === 'srd-ogre')
  const combatants = [
    fighter ? makeCombatant(fighter, 'Heroes', { x: 2, y: 3 }, 'manual') : undefined,
    cleric ? makeCombatant(cleric, 'Heroes', { x: 2, y: 6 }, 'manual') : undefined,
    goblin ? makeCombatant(goblin, 'Monsters', { x: 11, y: 3 }, 'nearest') : undefined,
    ogre ? makeCombatant(ogre, 'Monsters', { x: 12, y: 6 }, 'nearest') : undefined,
  ].filter(Boolean) as Combatant[]

  return {
    ...battle,
    combatants,
    selectedCombatantId: combatants[0]?.id,
  }
}

const createDraft = (): DraftContent => ({
  name: 'Custom Skirmisher',
  kind: 'monster',
  side: 'Monsters',
  level: 1,
  abilityScores: { ...baseAbilityScores, dex: 14 },
  saveProficiencies: ['dex'],
  attackAbility: 'dex',
  spellAbility: 'wis',
  actionMode: 'weaponAttack',
  useSrdPlayerMath: false,
  armorClass: 13,
  maxHp: 18,
  speedFt: 30,
  initiativeBonus: 2,
  attackName: 'Blade',
  attackBonus: 4,
  damageDice: '1d8+2',
  damageType: 'slashing',
  rangeFt: 5,
  sourceKind: 'Custom',
  meleeActions: [createDraftAction('melee', { name: 'Blade', attackBonus: 4, damageDice: '1d8+2', damageType: 'slashing' })],
  rangedActions: [createDraftAction('ranged')],
  spellActions: [createDraftAction('spell')],
  customActions: [createDraftAction('custom')],
  actionDraft: createDraftAction('custom'),
  resistances: '',
  immunities: '',
  vulnerabilities: '',
  notes: '',
})

const createCustomEntry = (draft: DraftContent): ContentEntry => {
  const usesPlayerMath = draft.kind === 'player' && draft.useSrdPlayerMath
  const math = derivedPlayerMath(draft)
  const attackBonus = usesPlayerMath ? math.attackBonus : draft.attackBonus
  const damageDice = usesPlayerMath && draft.actionMode === 'weaponAttack' ? math.damageDice : draft.damageDice
  const initiativeBonus = usesPlayerMath ? math.initiativeBonus : draft.initiativeBonus
  const baseActionId = draft.attackName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'custom-action'
  const configuredActions = [
    ...(draft.meleeActions ?? []).map((action) => draftActionToDefinition(action, 'melee')),
    ...(draft.rangedActions ?? []).map((action) => draftActionToDefinition(action, 'ranged')),
    ...(draft.spellActions ?? []).map((action) => draftActionToDefinition(action, 'spell')),
    ...(draft.customActions ?? []).map((action) => draftActionToDefinition(action, 'custom')),
  ]
  const primaryAction =
    usesPlayerMath && draft.actionMode === 'spellSave'
      ? {
          id: baseActionId,
          name: draft.attackName.trim() || 'Custom Spell',
          kind: 'save' as const,
          saveDc: math.saveDc,
          saveAbility: 'dex' as const,
          damageDice,
          damageType: draft.damageType,
          damageOnSave: 'none' as const,
          reachFt: 0,
          rangeFt: draft.rangeFt,
          target: 'enemy' as const,
          tags: ['spell', 'srd-math', 'custom'],
          description: `Spell save DC ${math.saveDc} = 8 + proficiency ${math.proficiencyBonus} + ${draft.spellAbility.toUpperCase()} ${signed(
            abilityModifier(draft.abilityScores[draft.spellAbility]),
          )}. ${draft.notes}`,
        }
      : {
          id: baseActionId,
          name: draft.attackName.trim() || 'Custom Action',
          kind: 'attack' as const,
          attackBonus,
          damageDice,
          damageType: draft.damageType,
          reachFt: draft.rangeFt <= 5 ? 5 : 0,
          rangeFt: draft.rangeFt,
          target: 'enemy' as const,
          tags:
            draft.rangeFt > 5
              ? ['ranged', usesPlayerMath ? 'srd-math' : 'custom']
              : ['melee', usesPlayerMath ? 'srd-math' : 'custom'],
          description: usesPlayerMath
            ? `Attack bonus ${signed(attackBonus)} = proficiency ${math.proficiencyBonus} + ${draft.attackAbility.toUpperCase()} ${signed(
                abilityModifier(draft.abilityScores[draft.attackAbility]),
              )}. ${draft.notes}`
            : draft.notes,
        }
  const traits = [
    usesPlayerMath
      ? `SRD player defaults: level ${draft.level}, proficiency ${signed(
          math.proficiencyBonus,
        )}, initiative ${signed(initiativeBonus)} from Dexterity.`
      : '',
    draft.saveProficiencies.length
      ? `Saving throw proficiencies: ${draft.saveProficiencies.map((ability) => ability.toUpperCase()).join(', ')}.`
      : '',
    draft.resistances ? `Resistances: ${draft.resistances}.` : '',
    draft.immunities ? `Immunities: ${draft.immunities}.` : '',
    draft.vulnerabilities ? `Vulnerabilities: ${draft.vulnerabilities}.` : '',
    draft.notes,
  ].filter(Boolean)

  return {
    id: `${draft.sourceKind.toLowerCase()}-${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
    name: draft.name.trim() || 'Untitled Entry',
    kind: draft.kind,
    source: {
      kind: draft.sourceKind,
      book: usesPlayerMath ? 'Manual SRD-shaped player entry' : draft.sourceKind === 'Custom' ? 'Manual entry' : 'User supplied',
    },
    armorClass: draft.armorClass,
    maxHp: draft.maxHp,
    speedFt: draft.speedFt,
    initiativeBonus,
    level: draft.kind === 'player' ? draft.level : undefined,
    proficiencyBonus: draft.kind === 'player' ? math.proficiencyBonus : undefined,
    size: draft.kind === 'monster' ? 'Medium' : 'Medium',
    type: draft.kind === 'monster' ? 'custom' : 'player character',
    abilityScores: { ...draft.abilityScores },
    saveProficiencies: [...draft.saveProficiencies],
    resistances: splitList(draft.resistances),
    immunities: splitList(draft.immunities),
    vulnerabilities: splitList(draft.vulnerabilities),
    traits,
    resources: [],
    actions: [
      ...(configuredActions.length ? configuredActions : [primaryAction]),
      {
        id: 'manual-ruling',
        name: 'Manual Ruling',
        kind: 'manual',
        reachFt: 5,
        rangeFt: 30,
        target: 'manual',
        tags: ['manual'],
        description: 'Pause and record an adjudicated custom effect.',
      },
    ],
    notes: draft.notes,
  }
}

const mergeLibrary = (library: ContentEntry[], entries: ContentEntry[]) => {
  const byId = new Map(library.map((entry) => [entry.id, entry]))
  entries.forEach((entry) => byId.set(entry.id, entry))
  return [...byId.values()]
}

const sourceClass = (source: ContentEntry['source']['kind']) =>
  `source source-${source.toLowerCase().replace(/[^a-z]+/g, '-')}`

const numberValue = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const optionalNumberValue = (value: string) => {
  if (!value.trim()) {
    return undefined
  }

  return Math.max(0, numberValue(value))
}

const createStatusId = (prefix: 'condition' | 'effect' | 'planned-action') =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const defaultRollBonus = (): RollBonusConfig => ({
  proficient: false,
  bonus: 0,
})

const primaryActionIdFor = (combatant?: Combatant) =>
  combatant?.intent.actionQueue?.[0]?.actionId ?? combatant?.intent.actionId

const selectedActionFor = (combatant?: Combatant) =>
  combatant?.actions.find((action) => action.id === primaryActionIdFor(combatant)) ?? combatant?.actions[0]

const combatantProficiencyBonus = (combatant: Pick<Combatant, 'level' | 'proficiencyBonus'>) =>
  combatant.proficiencyBonus ?? proficiencyBonusForLevel(combatant.level ?? 1)

const rollBonusConfig = (combatant: Combatant, key: RollProfileKey): RollBonusConfig => ({
  ...defaultRollBonus(),
  ...(combatant.rollBonuses?.[key] ?? {}),
})

const rollBonusTotal = (combatant: Combatant, key: RollProfileKey) => {
  const config = rollBonusConfig(combatant, key)

  return config.bonus + (config.proficient ? combatantProficiencyBonus(combatant) : 0)
}

const normalizeCondition = (condition: unknown, index: number): CombatantCondition => {
  if (typeof condition === 'string') {
    const match = srdConditions.find((candidate) => candidate.name.toLowerCase() === condition.toLowerCase())
    return {
      id: createStatusId('condition'),
      name: condition,
      note: match?.note,
    }
  }

  const candidate = condition as Partial<CombatantCondition> | undefined
  return {
    id: candidate?.id ?? `condition-restored-${index}`,
    name: candidate?.name?.trim() || 'Custom Condition',
    durationRounds: candidate?.durationRounds,
    source: candidate?.source,
    note: candidate?.note,
  }
}

const normalizeEffect = (effect: unknown, index: number): ActiveEffect => {
  const candidate = effect as Partial<ActiveEffect> | undefined
  return {
    id: candidate?.id ?? `effect-restored-${index}`,
    label: candidate?.label?.trim() || 'Custom Effect',
    description: candidate?.description ?? '',
    durationRounds: candidate?.durationRounds,
    source: candidate?.source,
  }
}

const createDefaultRollAdjustments = (): NonNullable<ActionIntent['rollAdjustments']> => ({
  attack: { modifier: 0, advantage: false, disadvantage: false },
  save: { modifier: 0, advantage: false, disadvantage: false },
  damage: { modifier: 0, advantage: false, disadvantage: false },
})

const normalizeCombatantIntent = (combatant: Combatant): ActionIntent => {
  const intent = combatant.intent as Partial<ActionIntent> | undefined
  const availableActionIds = new Set(combatant.actions.map((action) => action.id))
  const fallbackActionId =
    intent?.actionId && availableActionIds.has(intent.actionId)
      ? intent.actionId
      : combatant.actions[0]?.id ?? 'manual'
  const rawQueue = Array.isArray(intent?.actionQueue) ? intent.actionQueue : []
  const actionQueue = rawQueue
    .filter((plannedAction) => plannedAction?.actionId && availableActionIds.has(plannedAction.actionId))
    .map((plannedAction, index) => ({
      id: plannedAction.id ?? `planned-action-restored-${index}`,
      actionId: plannedAction.actionId,
      targetId: plannedAction.targetId,
    }))

  if (!actionQueue.length) {
    actionQueue.push({
      id: 'planned-action-restored-0',
      actionId: fallbackActionId,
      targetId: intent?.targetId,
    })
  }

  return {
    actionId: actionQueue[0]?.actionId ?? fallbackActionId,
    actionQueue,
    targetId: intent?.targetId ?? actionQueue[0]?.targetId,
    destination: intent?.destination,
    advantage: intent?.advantage ?? false,
    disadvantage: intent?.disadvantage ?? false,
    rollAdjustments: {
      ...createDefaultRollAdjustments(),
      ...(intent?.rollAdjustments ?? {}),
    },
    manualNote: intent?.manualNote,
  }
}

const normalizeCombatantStatuses = (combatant: Combatant): Combatant => ({
  ...combatant,
  conditions: Array.isArray(combatant.conditions)
    ? combatant.conditions.map(normalizeCondition)
    : [],
  activeEffects: Array.isArray(combatant.activeEffects)
    ? combatant.activeEffects.map(normalizeEffect)
    : [],
  actions: combatant.actions.map((action) => ({
    ...action,
    tags: [...action.tags],
    effects: action.effects?.map((effect) => ({ ...effect })),
  })),
  rollBonuses: combatant.rollBonuses ?? {},
  intent: normalizeCombatantIntent(combatant),
})

const normalizeBattleState = (battle: BattleState): BattleState => ({
  ...battle,
  status: battle.status === 'active' ? 'active' : 'setup',
  combatants: battle.combatants.map(normalizeCombatantStatuses),
})

const readInitialBattleMap = () => {
  const storedMap = readJsonState<BattleMap>(mapKey, defaultMap)
  const hasStoredImage = Boolean(storedMap.imageName)
  const isGeneratedMapState =
    !storedMap.imageName &&
    storedMap.width === defaultMap.width &&
    storedMap.height === defaultMap.height

  return {
    ...defaultMap,
    ...(hasStoredImage || isGeneratedMapState ? storedMap : {}),
    imageUrl: undefined,
  }
}

const createDefaultTacticalMapState = (): TacticalMapState => ({
  activeMapTool: 'mouse',
  mapView: { zoom: 1, panX: 0, panY: 0 },
  measurement: undefined,
  annotations: [],
  showAnnotations: true,
  toolsHidden: false,
  drawColor: '#f0c37b',
  shapeColor: '#7db9ff',
  shapeWidthCells: 3,
  shapeHeightCells: 3,
  shapeFitToGrid: true,
})

const normalizeTacticalMapState = (state: Partial<TacticalMapState> | undefined): TacticalMapState => {
  const defaults = createDefaultTacticalMapState()

  return {
    ...defaults,
    ...(state ?? {}),
    activeMapTool: state?.activeMapTool ?? defaults.activeMapTool,
    mapView: {
      ...defaults.mapView,
      ...(state?.mapView ?? {}),
      zoom: clampMapZoom(state?.mapView?.zoom ?? defaults.mapView.zoom),
    },
    annotations: Array.isArray(state?.annotations) ? state.annotations : defaults.annotations,
    measurement: state?.measurement,
    showAnnotations: state?.showAnnotations ?? defaults.showAnnotations,
    toolsHidden: state?.toolsHidden ?? defaults.toolsHidden,
    drawColor: state?.drawColor ?? defaults.drawColor,
    shapeColor: state?.shapeColor ?? defaults.shapeColor,
    shapeWidthCells: Math.max(0.5, state?.shapeWidthCells ?? defaults.shapeWidthCells),
    shapeHeightCells: Math.max(0.5, state?.shapeHeightCells ?? defaults.shapeHeightCells),
    shapeFitToGrid: state?.shapeFitToGrid ?? defaults.shapeFitToGrid,
  }
}

const serializableBattleMap = (battleMap: BattleMap): Omit<BattleMap, 'imageUrl'> => ({
  imageName: battleMap.imageName,
  width: battleMap.width,
  height: battleMap.height,
  calibration: {
    ...battleMap.calibration,
  },
})

const normalizeImportedBattleMap = (battleMap: Partial<BattleMap> | undefined): Omit<BattleMap, 'imageUrl'> => ({
  imageName: battleMap?.imageName,
  width: Math.max(1, battleMap?.width ?? defaultMap.width),
  height: Math.max(1, battleMap?.height ?? defaultMap.height),
  calibration: {
    ...defaultMap.calibration,
    ...(battleMap?.calibration ?? {}),
  },
})

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

const dataUrlToBlob = async (dataUrl: string) => {
  const response = await fetch(dataUrl)
  return response.blob()
}

const readMapImageForEncounter = async (battleMap: BattleMap): Promise<EncounterMapImage | undefined> => {
  if (!battleMap.imageName && !battleMap.imageUrl) {
    return undefined
  }

  let persistedImage: PersistedMapImage | undefined
  try {
    persistedImage = await readCache<PersistedMapImage>(mapImageCacheKey)
  } catch {
    persistedImage = undefined
  }

  let blob = persistedImage?.blob
  if (!blob && battleMap.imageUrl) {
    const response = await fetch(battleMap.imageUrl)
    blob = await response.blob()
  }

  if (!blob) {
    return undefined
  }

  return {
    dataUrl: await blobToDataUrl(blob),
    name: persistedImage?.name ?? battleMap.imageName ?? 'battle-map',
    type: (persistedImage?.type ?? blob.type) || 'application/octet-stream',
    size: persistedImage?.size ?? blob.size,
    lastModified: persistedImage?.lastModified ?? Date.now(),
    width: persistedImage?.width ?? battleMap.width,
    height: persistedImage?.height ?? battleMap.height,
  }
}

const downloadJsonFile = (fileName: string, payload: unknown) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const isEncounterSaveFile = (payload: Partial<EncounterSaveFile>): payload is EncounterSaveFile =>
  payload.schema === encounterFileSchema &&
  payload.version === 1 &&
  Boolean(payload.state?.battle) &&
  Boolean(payload.state?.battleMap) &&
  Boolean(payload.state?.tacticalMap) &&
  Boolean(payload.state?.ui) &&
  Array.isArray(payload.state?.library)

const encounterFileName = () => `battle-simulator-5e-encounter-${new Date().toISOString().slice(0, 10)}.json`

const validPage = (page: unknown): page is AppPage =>
  page === 'battlefield' || page === 'combatants' || page === 'library'

const validLibraryTab = (tab: unknown): tab is LibraryTab =>
  tab === 'library' || tab === 'custom' || tab === 'character' || tab === 'json'

const validInspectorTab = (tab: unknown): tab is InspectorTab =>
  tab === 'actions' || tab === 'details' || tab === 'conditions' || tab === 'effects'

function App() {
  const [library, setLibrary] = useState<ContentEntry[]>(() =>
    mergeLibrary(readJsonState(libraryKey, sampleContent), sampleContent),
  )
  const [battle, setBattle] = useState<BattleState>(() =>
    normalizeBattleState(readJsonState(battleKey, createDemoBattle())),
  )
  const [battleMap, setBattleMap] = useState<BattleMap>(() => readInitialBattleMap())
  const [tacticalMapState, setTacticalMapState] = useState<TacticalMapState>(() =>
    normalizeTacticalMapState(readJsonState(tacticalMapKey, createDefaultTacticalMapState())),
  )
  const [draft, setDraft] = useState<DraftContent>(() => createDraft())
  const [srdCharacter, setSrdCharacter] = useState<SrdCharacterDraft>(() => createSrdCharacterDraft())
  const [srdCharacterBuilder, setSrdCharacterBuilder] = useState<SrdCharacterBuilderState>(() =>
    createSrdBuilderState(),
  )
  const [srdIndex, setSrdIndex] = useState<SrdIndexItem[]>([])
  const [srdQuery, setSrdQuery] = useState('goblin')
  const [srdStatus, setSrdStatus] = useState('SRD index not loaded')
  const [jsonImport, setJsonImport] = useState('')
  const [jsonImportStatus, setJsonImportStatus] = useState('Paste content JSON, a fenced JSON block, or an exported encounter.')
  const [encounterName, setEncounterName] = useState(() => readJsonState(encounterNameKey, defaultEncounterName))
  const [activeLibraryTab, setActiveLibraryTab] = useState<LibraryTab>('library')
  const [activePage, setActivePage] = useState<AppPage>('battlefield')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('actions')
  const encounterFileInputRef = useRef<HTMLInputElement | null>(null)
  const autoLoadedSrd = useRef(false)
  const restoredMapUrl = useRef<string | undefined>(undefined)

  useEffect(() => {
    writeJsonState(libraryKey, library)
  }, [library])

  useEffect(() => {
    writeJsonState(battleKey, battle)
  }, [battle])

  useEffect(() => {
    const persistableMap = { ...battleMap, imageUrl: undefined }
    writeJsonState(mapKey, persistableMap)
  }, [battleMap])

  useEffect(() => {
    writeJsonState(tacticalMapKey, tacticalMapState)
  }, [tacticalMapState])

  useEffect(() => {
    writeJsonState(encounterNameKey, encounterName)
  }, [encounterName])

  useEffect(() => {
    let cancelled = false
    const storedMap = readJsonState<BattleMap>(mapKey, defaultMap)

    if (!storedMap.imageName) {
      return undefined
    }

    const restoreMapImage = async () => {
      try {
        const storedImage = await readCache<PersistedMapImage>(mapImageCacheKey)

        if (cancelled) {
          return
        }

        if (!storedImage?.blob) {
          setBattleMap((current) => (current.imageUrl ? current : { ...defaultMap }))
          return
        }

        const imageUrl = URL.createObjectURL(storedImage.blob)
        if (restoredMapUrl.current) {
          URL.revokeObjectURL(restoredMapUrl.current)
        }
        restoredMapUrl.current = imageUrl

        setBattleMap((current) =>
          current.imageUrl
            ? current
            : {
                ...defaultMap,
                ...storedMap,
                imageUrl,
                imageName: storedImage.name || storedMap.imageName,
                width: storedImage.width || storedMap.width,
                height: storedImage.height || storedMap.height,
              },
        )
      } catch {
        if (!cancelled) {
          setBattleMap((current) => (current.imageUrl ? current : { ...defaultMap }))
        }
      }
    }

    void restoreMapImage()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      if (restoredMapUrl.current) {
        URL.revokeObjectURL(restoredMapUrl.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (autoLoadedSrd.current) {
      return
    }

    autoLoadedSrd.current = true

    const loadInitialSrdContent = async () => {
      try {
        setSrdStatus('Auto-loading SRD monster index...')
        setSrdCharacterBuilder((current) => ({ ...current, status: 'Auto-loading SRD character data...' }))
        const [monsters, classes, races, weapons, spells, selectedClass, selectedRace, selectedWeapon, selectedSpell] =
          await Promise.all([
            fetchSrdMonsterIndex(),
            fetchSrdClassIndex(),
            fetchSrdRaceIndex(),
            fetchSrdWeaponIndex(),
            fetchSrdSpellIndex(),
            fetchSrdClass(srdCharacter.classIndex),
            fetchSrdRace(srdCharacter.raceIndex),
            fetchSrdEquipment(srdCharacter.weaponIndex),
            fetchSrdSpell(srdCharacter.spellIndex),
          ])

        setSrdIndex(monsters)
        setSrdStatus(`${monsters.length} SRD monsters cached locally`)
        setSrdCharacterBuilder({
          classes,
          races,
          weapons,
          spells,
          selectedClass,
          selectedRace,
          selectedWeapon,
          selectedSpell,
          selectedWeapons: { [selectedWeapon.index]: selectedWeapon },
          selectedSpells: { [selectedSpell.index]: selectedSpell },
          status: 'SRD content auto-loaded',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to auto-load SRD content'
        setSrdStatus(message)
        setSrdCharacterBuilder((current) => ({ ...current, status: message }))
      }
    }

    void loadInitialSrdContent()
  }, [srdCharacter.classIndex, srdCharacter.raceIndex, srdCharacter.spellIndex, srdCharacter.weaponIndex])

  const selectedCombatant = useMemo(
    () => battle.combatants.find((combatant) => combatant.id === battle.selectedCombatantId),
    [battle.combatants, battle.selectedCombatantId],
  )

  const filteredLibrary = useMemo(() => {
    const query = srdQuery.trim().toLowerCase()
    return library.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        entry.source.kind.toLowerCase().includes(query) ||
        entry.kind.toLowerCase().includes(query),
    )
  }, [library, srdQuery])

  const filteredSrdIndex = useMemo(() => {
    const query = srdQuery.trim().toLowerCase()
    return srdIndex
      .filter((entry) => entry.name.toLowerCase().includes(query) || entry.index.includes(query))
      .slice(0, 16)
  }, [srdIndex, srdQuery])

  const addCombatant = (entry: ContentEntry, side: Side = entry.kind === 'player' ? 'Heroes' : 'Monsters') => {
    setBattle((current) => {
      const sideCount = current.combatants.filter((combatant) => combatant.side === side).length
      const combatant = makeCombatant(
        entry,
        side,
        side === 'Heroes' ? { x: 2, y: 2 + sideCount * 2 } : { x: 11, y: 2 + sideCount * 2 },
        side === 'Heroes' ? 'manual' : 'nearest',
      )

      return {
        ...current,
        combatants: [...current.combatants, combatant],
        selectedCombatantId: combatant.id,
      }
    })
    setInspectorTab('details')
  }

  const addEntriesToBattle = (entries: ContentEntry[]) => {
    setBattle((current) => {
      const combatants = [...current.combatants]
      let selectedCombatantId = current.selectedCombatantId

      entries.forEach((entry) => {
        const side: Side = entry.kind === 'player' ? 'Heroes' : 'Monsters'
        const sideCount = combatants.filter((combatant) => combatant.side === side).length
        const combatant = makeCombatant(
          entry,
          side,
          side === 'Heroes' ? { x: 2, y: 2 + sideCount * 2 } : { x: 11, y: 2 + sideCount * 2 },
          side === 'Heroes' ? 'manual' : 'nearest',
        )
        combatants.push(combatant)
        selectedCombatantId = combatant.id
      })

      return {
        ...current,
        combatants,
        selectedCombatantId,
      }
    })
    setInspectorTab('details')
  }

  const selectCombatantSheet = (id: string) => {
    setBattle((current) => ({ ...current, selectedCombatantId: id }))
    setInspectorTab('details')
  }

  const updateCombatant = (id: string, patch: Partial<Combatant>) => {
    setBattle((current) => ({
      ...current,
      combatants: current.combatants.map((combatant) =>
        combatant.id === id ? { ...combatant, ...patch } : combatant,
      ),
    }))
  }

  const updateIntent = (id: string, patch: Partial<ActionIntent>) => {
    setBattle((current) => ({
      ...current,
      combatants: current.combatants.map((combatant) => {
        if (combatant.id !== id) {
          return combatant
        }

        const nextIntent: ActionIntent = { ...combatant.intent, ...patch }
        if (patch.actionId && !patch.actionQueue) {
          const currentQueue = nextIntent.actionQueue?.length
            ? nextIntent.actionQueue
            : [{ id: createStatusId('planned-action'), actionId: patch.actionId, targetId: nextIntent.targetId }]
          nextIntent.actionQueue = currentQueue.map((plannedAction, index) =>
            index === 0 ? { ...plannedAction, actionId: patch.actionId } : plannedAction,
          )
        }

        if (patch.targetId !== undefined && !patch.actionQueue && nextIntent.actionQueue?.length) {
          nextIntent.actionQueue = nextIntent.actionQueue.map((plannedAction, index) =>
            index === 0 ? { ...plannedAction, targetId: patch.targetId } : plannedAction,
          )
        }

        return { ...combatant, intent: nextIntent }
      }),
    }))
  }

  const removeCombatant = (id: string) => {
    setBattle((current) => ({
      ...current,
      combatants: current.combatants.filter((combatant) => combatant.id !== id),
      selectedCombatantId:
        current.selectedCombatantId === id
          ? current.combatants.find((combatant) => combatant.id !== id)?.id
          : current.selectedCombatantId,
    }))
  }

  const loadSrdIndex = async () => {
    try {
      setSrdStatus('Loading SRD monster index...')
      const results = await fetchSrdMonsterIndex()
      setSrdIndex(results)
      setSrdStatus(`${results.length} SRD monsters cached locally`)
    } catch (error) {
      setSrdStatus(error instanceof Error ? error.message : 'Unable to load SRD index')
    }
  }

  const importSrdMonster = async (index: string, addToField = false) => {
    try {
      setSrdStatus(`Importing ${index}...`)
      const monster = await fetchSrdMonster(index)
      setLibrary((current) => mergeLibrary(current, [monster]))
      if (addToField) {
        addCombatant(monster, 'Monsters')
      }
      setSrdStatus(`${monster.name} imported from SRD cache/API`)
    } catch (error) {
      setSrdStatus(error instanceof Error ? error.message : `Unable to import ${index}`)
    }
  }

  const loadSrdCharacterBuilder = async () => {
    try {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: 'Loading SRD classes, races, weapons, and spells...',
      }))
      const [classes, races, weapons, spells, selectedClass, selectedRace, selectedWeapon, selectedSpell] =
        await Promise.all([
          fetchSrdClassIndex(),
          fetchSrdRaceIndex(),
          fetchSrdWeaponIndex(),
          fetchSrdSpellIndex(),
          fetchSrdClass(srdCharacter.classIndex),
          fetchSrdRace(srdCharacter.raceIndex),
          fetchSrdEquipment(srdCharacter.weaponIndex),
          fetchSrdSpell(srdCharacter.spellIndex),
        ])

      setSrdCharacterBuilder({
        classes,
        races,
        weapons,
        spells,
        selectedClass,
        selectedRace,
        selectedWeapon,
        selectedSpell,
        selectedWeapons: { [selectedWeapon.index]: selectedWeapon },
        selectedSpells: { [selectedSpell.index]: selectedSpell },
        status: 'SRD character builder ready',
      })
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to load SRD character data',
      }))
    }
  }

  const selectSrdClass = async (classIndex: string) => {
    const nextDraft = applySrdClassPreset(srdCharacter, classIndex)
    setSrdCharacter(nextDraft)
    try {
      setSrdCharacterBuilder((current) => ({ ...current, status: `Loading ${classIndex} SRD class...` }))
      const [selectedClass, selectedWeapon, selectedSpell] = await Promise.all([
        fetchSrdClass(classIndex),
        fetchSrdEquipment(nextDraft.weaponIndex),
        fetchSrdSpell(nextDraft.spellIndex),
      ])
      setSrdCharacterBuilder((current) => ({
        ...current,
        selectedClass,
        selectedWeapon,
        selectedSpell,
        selectedWeapons: {
          ...current.selectedWeapons,
          [selectedWeapon.index]: selectedWeapon,
        },
        selectedSpells: {
          ...current.selectedSpells,
          [selectedSpell.index]: selectedSpell,
        },
        status: `${selectedClass.name} SRD class loaded`,
      }))
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to load SRD class',
      }))
    }
  }

  const selectSrdRace = async (raceIndex: string) => {
    setSrdCharacter((current) => ({ ...current, raceIndex }))
    try {
      const selectedRace = await fetchSrdRace(raceIndex)
      setSrdCharacterBuilder((current) => ({
        ...current,
        selectedRace,
        status: `${selectedRace.name} SRD race loaded`,
      }))
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to load SRD race',
      }))
    }
  }

  const selectSrdWeapon = async (weaponIndex: string) => {
    setSrdCharacter((current) => ({ ...current, weaponIndex, actionSource: 'weapon' }))
    try {
      const selectedWeapon = await fetchSrdEquipment(weaponIndex)
      setSrdCharacterBuilder((current) => ({
        ...current,
        selectedWeapon,
        selectedWeapons: {
          ...current.selectedWeapons,
          [selectedWeapon.index]: selectedWeapon,
        },
        status: `${selectedWeapon.name} SRD weapon loaded`,
      }))
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to load SRD weapon',
      }))
    }
  }

  const selectSrdSpell = async (spellIndex: string) => {
    setSrdCharacter((current) => ({ ...current, spellIndex, actionSource: 'spell' }))
    try {
      const selectedSpell = await fetchSrdSpell(spellIndex)
      setSrdCharacterBuilder((current) => ({
        ...current,
        selectedSpell,
        selectedSpells: {
          ...current.selectedSpells,
          [selectedSpell.index]: selectedSpell,
        },
        status: `${selectedSpell.name} SRD spell loaded`,
      }))
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to load SRD spell',
      }))
    }
  }

  const addSelectedSrdWeaponAction = async () => {
    try {
      const selectedWeapon =
        srdCharacterBuilder.selectedWeapons[srdCharacter.weaponIndex] ??
        (await fetchSrdEquipment(srdCharacter.weaponIndex))
      setSrdCharacter((current) => ({
        ...current,
        actionSource: 'weapon',
        selectedWeaponIndexes: [...new Set([...current.selectedWeaponIndexes, selectedWeapon.index])],
      }))
      setSrdCharacterBuilder((current) => ({
        ...current,
        selectedWeapon,
        selectedWeapons: {
          ...current.selectedWeapons,
          [selectedWeapon.index]: selectedWeapon,
        },
        status: `${selectedWeapon.name} added to this SRD character's actions`,
      }))
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to add SRD weapon action',
      }))
    }
  }

  const addSelectedSrdSpellAction = async () => {
    try {
      const selectedSpell =
        srdCharacterBuilder.selectedSpells[srdCharacter.spellIndex] ??
        (await fetchSrdSpell(srdCharacter.spellIndex))
      setSrdCharacter((current) => ({
        ...current,
        actionSource: 'spell',
        selectedSpellIndexes: [...new Set([...current.selectedSpellIndexes, selectedSpell.index])],
      }))
      setSrdCharacterBuilder((current) => ({
        ...current,
        selectedSpell,
        selectedSpells: {
          ...current.selectedSpells,
          [selectedSpell.index]: selectedSpell,
        },
        status: `${selectedSpell.name} added to this SRD character's actions`,
      }))
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to add SRD spell action',
      }))
    }
  }

  const removeSrdCharacterAction = (kind: 'weapon' | 'spell', index: string) => {
    setSrdCharacter((current) => ({
      ...current,
      selectedWeaponIndexes:
        kind === 'weapon' ? current.selectedWeaponIndexes.filter((weaponIndex) => weaponIndex !== index) : current.selectedWeaponIndexes,
      selectedSpellIndexes:
        kind === 'spell' ? current.selectedSpellIndexes.filter((spellIndex) => spellIndex !== index) : current.selectedSpellIndexes,
    }))
  }

  const addSrdCharacterToLibrary = async () => {
    try {
      const [selectedClass, selectedRace, selectedWeapons, selectedSpells] = await Promise.all([
        srdCharacterBuilder.selectedClass ?? fetchSrdClass(srdCharacter.classIndex),
        srdCharacterBuilder.selectedRace ?? fetchSrdRace(srdCharacter.raceIndex),
        Promise.all(
          srdCharacter.selectedWeaponIndexes.map(
            (index) => srdCharacterBuilder.selectedWeapons[index] ?? fetchSrdEquipment(index),
          ),
        ),
        Promise.all(
          srdCharacter.selectedSpellIndexes.map(
            (index) => srdCharacterBuilder.selectedSpells[index] ?? fetchSrdSpell(index),
          ),
        ),
      ])
      const builder = {
        ...srdCharacterBuilder,
        selectedClass,
        selectedRace,
        selectedWeapon: selectedWeapons[0],
        selectedSpell: selectedSpells[0],
        selectedWeapons: Object.fromEntries(selectedWeapons.map((weapon) => [weapon.index, weapon])),
        selectedSpells: Object.fromEntries(selectedSpells.map((spell) => [spell.index, spell])),
      }
      const entry = buildSrdCharacterEntry(srdCharacter, builder)
      setSrdCharacterBuilder({
        ...builder,
        status: `${entry.name} built from SRD and added to the battle`,
      })
      setLibrary((current) => mergeLibrary(current, [entry]))
      addCombatant(entry, srdCharacter.side)
      setActiveLibraryTab('library')
    } catch (error) {
      setSrdCharacterBuilder((current) => ({
        ...current,
        status: error instanceof Error ? error.message : 'Unable to build SRD character',
      }))
    }
  }

  const addCustomToLibrary = () => {
    const entry = createCustomEntry(draft)
    setLibrary((current) => mergeLibrary(current, [entry]))
    addCombatant(entry, draft.side)
    setDraft(createDraft())
    setActiveLibraryTab('library')
  }

  const importJsonContent = () => {
    try {
      const entries = parseImportedContentEntries(jsonImport)
      setLibrary((current) => mergeLibrary(current, entries))
      setJsonImport('')
      setJsonImportStatus(`${entries.length} content ${entries.length === 1 ? 'entry' : 'entries'} imported to the library.`)
      setActiveLibraryTab('library')
    } catch (error) {
      setJsonImportStatus(error instanceof Error ? error.message : 'Invalid JSON. Paste a ContentEntry or ContentEntry[] export.')
    }
  }

  const importJsonToBattle = () => {
    try {
      const entries = parseImportedContentEntries(jsonImport)
      setLibrary((current) => mergeLibrary(current, entries))
      addEntriesToBattle(entries)
      setJsonImport('')
      setJsonImportStatus(`${entries.length} content ${entries.length === 1 ? 'entry' : 'entries'} imported and added to the battle.`)
      setActiveLibraryTab('library')
      setActivePage('battlefield')
    } catch (error) {
      setJsonImportStatus(error instanceof Error ? error.message : 'Invalid JSON. Paste a ContentEntry or ContentEntry[] export.')
    }
  }

  const exportLibrary = () => {
    downloadJsonFile('battle-simulator-5e-content.json', library)
  }

  const exportEncounter = async () => {
    try {
      const mapImage = await readMapImageForEncounter(battleMap)
      const encounter: EncounterSaveFile = {
        schema: encounterFileSchema,
        version: 1,
        savedAt: new Date().toISOString(),
        state: {
          library,
          battle,
          battleMap: serializableBattleMap(battleMap),
          mapImage,
          tacticalMap: tacticalMapState,
          ui: {
          activePage,
          activeLibraryTab,
          inspectorTab,
          encounterName,
          srdQuery,
          draft,
          srdCharacter,
          },
        },
      }

      downloadJsonFile(encounterFileName(), encounter)
    } catch (error) {
      setJsonImport(error instanceof Error ? error.message : 'Unable to save encounter file.')
      setActiveLibraryTab('json')
      setActivePage('library')
    }
  }

  const importEncounterFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    try {
      const parsed = JSON.parse(await file.text()) as Partial<EncounterSaveFile>
      if (!isEncounterSaveFile(parsed)) {
        throw new Error('Invalid encounter file. Use a Battle Simulator 5e encounter export.')
      }

      const importedMap = normalizeImportedBattleMap(parsed.state.battleMap)
      let nextMap: BattleMap = {
        ...importedMap,
        imageUrl: undefined,
      }

      if (parsed.state.mapImage?.dataUrl) {
        const imageBlob = await dataUrlToBlob(parsed.state.mapImage.dataUrl)
        const cachedImage: PersistedMapImage = {
          blob: imageBlob,
          name: parsed.state.mapImage.name,
          type: parsed.state.mapImage.type,
          size: parsed.state.mapImage.size,
          lastModified: parsed.state.mapImage.lastModified,
          width: parsed.state.mapImage.width ?? importedMap.width,
          height: parsed.state.mapImage.height ?? importedMap.height,
        }
        await writeCache<PersistedMapImage>(mapImageCacheKey, cachedImage)

        if (restoredMapUrl.current) {
          URL.revokeObjectURL(restoredMapUrl.current)
        }

        const imageUrl = URL.createObjectURL(imageBlob)
        restoredMapUrl.current = imageUrl
        nextMap = {
          ...nextMap,
          imageUrl,
          imageName: cachedImage.name,
          width: cachedImage.width ?? nextMap.width,
          height: cachedImage.height ?? nextMap.height,
        }
      } else {
        await deleteCache(mapImageCacheKey)
        nextMap = {
          ...nextMap,
          imageName: undefined,
        }
      }

      setLibrary(parsed.state.library)
      setBattle(normalizeBattleState(parsed.state.battle))
      setBattleMap(nextMap)
      setTacticalMapState(normalizeTacticalMapState(parsed.state.tacticalMap))
      setEncounterName(parsed.state.ui.encounterName?.trim() || defaultEncounterName)
      setDraft(parsed.state.ui.draft ?? createDraft())
      setSrdCharacter(parsed.state.ui.srdCharacter ?? createSrdCharacterDraft())
      setSrdQuery(parsed.state.ui.srdQuery ?? 'goblin')
      setInspectorTab(validInspectorTab(parsed.state.ui.inspectorTab) ? parsed.state.ui.inspectorTab : 'details')
      setActiveLibraryTab(validLibraryTab(parsed.state.ui.activeLibraryTab) ? parsed.state.ui.activeLibraryTab : 'library')
      setActivePage(validPage(parsed.state.ui.activePage) ? parsed.state.ui.activePage : 'battlefield')
      setJsonImport(`Loaded encounter from ${file.name}`)
    } catch (error) {
      setJsonImport(error instanceof Error ? error.message : 'Unable to load encounter file.')
      setActiveLibraryTab('json')
      setActivePage('library')
    }
  }

  const resetWorkspace = () => {
    setBattle((current) => longRestBattle(current))
  }

  const renameEncounter = () => {
    const nextName = window.prompt('Rename encounter', encounterName)?.trim()
    if (!nextName) {
      return
    }

    setEncounterName(nextName)
  }

  const libraryPanel = (
    <LibraryPanel
      activeTab={activeLibraryTab}
      setActiveTab={setActiveLibraryTab}
      library={filteredLibrary}
      srdIndex={filteredSrdIndex}
      srdStatus={srdStatus}
      srdQuery={srdQuery}
      draft={draft}
      srdCharacter={srdCharacter}
      srdCharacterBuilder={srdCharacterBuilder}
      jsonImport={jsonImport}
      jsonImportStatus={jsonImportStatus}
      onQueryChange={setSrdQuery}
      onLoadSrd={loadSrdIndex}
      onImportSrd={importSrdMonster}
      onAddCombatant={addCombatant}
      onDraftChange={setDraft}
      onAddCustom={addCustomToLibrary}
      onSrdCharacterChange={setSrdCharacter}
      onLoadSrdCharacterBuilder={loadSrdCharacterBuilder}
      onSelectSrdClass={selectSrdClass}
      onSelectSrdRace={selectSrdRace}
      onSelectSrdWeapon={selectSrdWeapon}
      onSelectSrdSpell={selectSrdSpell}
      onAddSrdWeaponAction={addSelectedSrdWeaponAction}
      onAddSrdSpellAction={addSelectedSrdSpellAction}
      onRemoveSrdCharacterAction={removeSrdCharacterAction}
      onAddSrdCharacter={addSrdCharacterToLibrary}
      onJsonChange={setJsonImport}
      onImportJson={importJsonContent}
      onImportJsonToBattle={importJsonToBattle}
      onExportLibrary={exportLibrary}
      onImportEncounterFile={importEncounterFile}
      onExportEncounter={exportEncounter}
    />
  )

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M24 4 43 15v18L24 44 5 33V15Z" />
              <path d="M24 4v40M5 15l19 29 19-29M5 33l19-29 19 29M5 15h38M5 33h38" />
              <text x="24" y="28" textAnchor="middle">
                5e
              </text>
            </svg>
          </div>
          <div>
            <h1>Battle Simulator 5e</h1>
            <p>{encounterName} encounter desk</p>
          </div>
        </div>

        <nav className="page-nav" aria-label="Main pages">
          <button
            type="button"
            className={activePage === 'battlefield' ? 'selected' : ''}
            onClick={() => setActivePage('battlefield')}
          >
            <MapIcon size={17} />
            Battlefield
          </button>
          <button
            type="button"
            className={activePage === 'library' ? 'selected' : ''}
            onClick={() => {
              setActiveLibraryTab('library')
              setActivePage('library')
            }}
          >
            <BookOpen size={17} />
            SRD Library
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveLibraryTab('json')
              setActivePage('library')
            }}
          >
            <Download size={17} />
            Import
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveLibraryTab('custom')
              setActivePage('library')
            }}
          >
            <UserPlus size={17} />
            Manual Entry
          </button>
          <button type="button" onClick={() => encounterFileInputRef.current?.click()}>
            <Upload size={17} />
            Load Encounter
          </button>
          <input
            ref={encounterFileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={importEncounterFile}
            style={{ display: 'none' }}
          />
          <button type="button" onClick={() => void exportEncounter()}>
            <Save size={17} />
            Save Encounter
          </button>
          <button
            type="button"
            className={activePage === 'combatants' ? 'selected' : ''}
            onClick={() => setActivePage('combatants')}
          >
            <Users size={17} />
            Combatants
          </button>
        </nav>

        <div className="round-stepper" aria-label="Round navigation">
          <button type="button" aria-label="Previous round">
            <ChevronLeft size={17} />
          </button>
          <strong>Round {battle.round}</strong>
          <button type="button" aria-label="Next round">
            <ChevronRight size={17} />
          </button>
        </div>

        <div className="top-actions">
          <SeedControl seed={battle.seed} onChange={(seed) => setBattle((current) => ({ ...current, seed }))} />
          <button type="button" className="icon-button ghost" onClick={resetWorkspace} aria-label="Long rest reset">
            <RotateCcw size={18} />
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="Battle status">
        <Metric icon={<Activity size={17} />} label="Round" value={String(battle.round)} />
        <Metric icon={<Flag size={17} />} label="Status" value={battle.status} />
        <Metric icon={<Shield size={17} />} label="Combatants" value={String(battle.combatants.length)} />
        <Metric icon={<Grid3X3 size={17} />} label="Grid" value={`${battleMap.calibration.cellSizePx}px / 5 ft`} />
        <Metric icon={<Database size={17} />} label="Content" value={`${library.length} entries`} />
      </section>

      {activePage === 'battlefield' ? (
        <div className="workspace-grid battlefield-grid">
          <aside className="panel left-rail">
            <Roster
              encounterName={encounterName}
              combatants={battle.combatants}
              selectedId={battle.selectedCombatantId}
              onSelect={selectCombatantSheet}
              onRenameEncounter={renameEncounter}
            />
          </aside>

          <section className="center-stage">
            <TacticalMap
              battleMap={battleMap}
              setBattleMap={setBattleMap}
              tacticalMapState={tacticalMapState}
              setTacticalMapState={setTacticalMapState}
              combatants={battle.combatants}
              selectedCombatantId={battle.selectedCombatantId}
              onSelectCombatant={selectCombatantSheet}
              onSetDestination={(id, destination) => updateIntent(id, { destination })}
            />

            <div className="battle-bottom-dock">
              <CombatLog entries={battle.log} />
              <RoundControls
                battle={battle}
                onRollInitiative={() => setBattle((current) => rollInitiative(current))}
                onAutoPlan={() => setBattle((current) => autoPlanRound(current))}
                onResolve={() => setBattle((current) => resolveRound(current))}
                onResetHp={() => setBattle((current) => longRestBattle(current))}
                onRemoveDefeated={() => setBattle((current) => removeDefeated(current))}
              />
            </div>
          </section>

          <aside className="panel right-rail">
            <ActionInspector
              combatant={selectedCombatant}
              combatants={battle.combatants}
              activeTab={inspectorTab}
              onActiveTabChange={setInspectorTab}
              onUpdateCombatant={updateCombatant}
              onUpdateIntent={updateIntent}
              onRemoveCombatant={removeCombatant}
            />
          </aside>
        </div>
      ) : null}

      {activePage === 'combatants' ? (
        <CombatantManagementPage
          combatants={battle.combatants}
          selectedCombatant={selectedCombatant}
          selectedId={battle.selectedCombatantId}
          activeInspectorTab={inspectorTab}
          onActiveInspectorTabChange={setInspectorTab}
          onSelect={selectCombatantSheet}
          onUpdateCombatant={updateCombatant}
          onUpdateIntent={updateIntent}
          onRemoveCombatant={removeCombatant}
        />
      ) : null}

      {activePage === 'library' ? (
        <div className="library-page">
          <section className="panel library-page-main">{libraryPanel}</section>
          <aside className="panel library-page-side">
            <Roster
              encounterName={encounterName}
              combatants={battle.combatants}
              selectedId={battle.selectedCombatantId}
              onSelect={selectCombatantSheet}
              onRenameEncounter={renameEncounter}
            />
          </aside>
        </div>
      ) : null}
    </main>
  )
}

function CombatantManagementPage({
  combatants,
  selectedCombatant,
  selectedId,
  activeInspectorTab,
  onActiveInspectorTabChange,
  onSelect,
  onUpdateCombatant,
  onUpdateIntent,
  onRemoveCombatant,
}: {
  combatants: Combatant[]
  selectedCombatant?: Combatant
  selectedId?: string
  activeInspectorTab: InspectorTab
  onActiveInspectorTabChange: (tab: InspectorTab) => void
  onSelect: (id: string) => void
  onUpdateCombatant: (id: string, patch: Partial<Combatant>) => void
  onUpdateIntent: (id: string, patch: Partial<ActionIntent>) => void
  onRemoveCombatant: (id: string) => void
}) {
  return (
    <div className="management-page">
      <section className="panel management-list">
        <PanelHeading icon={<Users size={18} />} title="Combatant Management" />
        <div className="combatant-table">
          {combatants.map((combatant) => (
            <button
              type="button"
              key={combatant.id}
              className={`combatant-card ${selectedId === combatant.id ? 'selected' : ''}`}
              onClick={() => onSelect(combatant.id)}
            >
              <span className={`token-dot ${combatant.side.toLowerCase()}`} />
              <div>
                <strong>{combatant.name}</strong>
                <p>
                  {combatant.side} · {combatant.source.kind} · {combatant.actions.length} actions
                </p>
              </div>
              <span>AC {combatant.armorClass}</span>
              <span>
                {combatant.currentHp}/{combatant.maxHp} HP
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="panel action-catalog">
        <PanelHeading icon={<Swords size={18} />} title="Action Catalog" />
        {selectedCombatant ? (
          <div className="combatant-detail-stack">
            <div className="stat-chip-grid">
              {abilities.map((ability) => (
                <div key={ability}>
                  <span>{ability.toUpperCase()}</span>
                  <strong>{selectedCombatant.abilityScores[ability]}</strong>
                  <small>{signed(abilityModifier(selectedCombatant.abilityScores[ability]))}</small>
                </div>
              ))}
            </div>
            <div className="trait-summary-grid">
              <div>
                <span>Saves</span>
                <strong>{selectedCombatant.saveProficiencies?.map((ability) => ability.toUpperCase()).join(', ') || 'none'}</strong>
              </div>
              <div>
                <span>Resist</span>
                <strong>{selectedCombatant.resistances?.join(', ') || 'none'}</strong>
              </div>
              <div>
                <span>Immune</span>
                <strong>{selectedCombatant.immunities?.join(', ') || 'none'}</strong>
              </div>
              <div>
                <span>Vulnerable</span>
                <strong>{selectedCombatant.vulnerabilities?.join(', ') || 'none'}</strong>
              </div>
            </div>
            <div className="action-list">
              {selectedCombatant.actions.map((action) => (
                <article key={action.id} className="action-row">
                  <div>
                    <strong>{action.name}</strong>
                    <p>
                      {action.kind}
                      {typeof action.attackBonus === 'number' ? ` · attack ${signed(action.attackBonus)}` : ''}
                      {typeof action.saveDc === 'number' ? ` · DC ${action.saveDc}` : ''}
                      {action.damageDice ? ` · ${action.damageDice} ${action.damageType ?? ''}` : ''}
                      {action.damageOnSave ? ` · pass ${action.damageOnSave === 'half' ? 'half' : 'zero'}` : ''}
                    </p>
                  </div>
                  <span>{action.rangeFt ?? action.reachFt ?? 0} ft</span>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <p className="muted-copy">Select a combatant to inspect all configured actions.</p>
        )}
      </section>

      <aside className="panel management-inspector">
        <ActionInspector
          combatant={selectedCombatant}
          combatants={combatants}
          activeTab={activeInspectorTab}
          onActiveTabChange={onActiveInspectorTabChange}
          onUpdateCombatant={onUpdateCombatant}
          onUpdateIntent={onUpdateIntent}
          onRemoveCombatant={onRemoveCombatant}
        />
      </aside>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  )
}

function SeedControl({ seed, onChange }: { seed: string; onChange: (seed: string) => void }) {
  return (
    <label className="seed-control">
      <span>Seed</span>
      <input value={seed} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function RoundControls({
  battle,
  onRollInitiative,
  onAutoPlan,
  onResolve,
  onResetHp,
  onRemoveDefeated,
}: {
  battle: BattleState
  onRollInitiative: () => void
  onAutoPlan: () => void
  onResolve: () => void
  onResetHp: () => void
  onRemoveDefeated: () => void
}) {
  const visibleTurns = battle.combatants.slice(0, 7)
  const selectedTurn = battle.combatants.find((combatant) => combatant.id === battle.selectedCombatantId) ?? battle.combatants[0]
  const selectedAction = selectedActionFor(selectedTurn)
  const selectedActionCount = selectedTurn?.intent.actionQueue?.length ?? (selectedTurn ? 1 : 0)
  const timelineRounds = Array.from({ length: Math.max(5, battle.round) }, (_, index) => index + 1)
  const activeRoundRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    activeRoundRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [battle.round])

  return (
    <div className="round-controls">
      <div className="round-timeline" aria-label="Round timeline">
        {timelineRounds.map((round) => (
          <span
            key={round}
            ref={round === battle.round ? activeRoundRef : undefined}
            className={round === battle.round ? 'active' : ''}
          >
            Round {round}
          </span>
        ))}
      </div>

      <div className="initiative-strip" aria-label="Round order">
        {visibleTurns.map((combatant) => (
          <span
            key={combatant.id}
            className={`turn-chip ${combatant.id === battle.selectedCombatantId ? 'active' : ''}`}
            title={combatant.name}
          >
            <strong>{combatant.initiative ?? '-'}</strong>
            <em className="turn-name">{combatant.name}</em>
          </span>
        ))}
        <button type="button" className="icon-button ghost" aria-label="More turns">
          <MoreVertical size={17} />
        </button>
      </div>

      <div className="dice-command-deck">
        <div className="dice-result">
          <span>D20</span>
          <strong>{selectedTurn?.initiative ?? 14}</strong>
          <small>+{Math.max(0, selectedTurn?.initiativeBonus ?? 0)}</small>
        </div>
        <div className="damage-expression">
          <span>{selectedActionCount > 1 ? 'Actions' : 'Damage'}</span>
          <strong>{selectedActionCount > 1 ? selectedActionCount : selectedAction?.damageDice ?? '1d8'} </strong>
          <small>{selectedActionCount > 1 ? 'planned' : selectedAction?.damageType ?? 'Piercing'}</small>
        </div>
        <div className="range-expression">
          <span>{selectedAction?.kind === 'save' ? 'Save' : 'Attack'}</span>
          <strong>
            {selectedAction?.kind === 'save'
              ? `DC ${selectedAction.saveDc ?? '-'}`
              : `${selectedAction?.rangeFt ?? selectedAction?.reachFt ?? 5} ft`}
          </strong>
        </div>
        <div className="round-button-row">
          <button type="button" onClick={onRollInitiative}>
            <Gauge size={17} />
            Initiative
          </button>
          <button type="button" onClick={onAutoPlan}>
            <Bot size={17} />
            Strategy
          </button>
          <button type="button" className="primary" onClick={onResolve} disabled={!battle.combatants.length}>
            <Play size={17} />
            Run Round
          </button>
          <button type="button" onClick={onResetHp}>
            <HeartPulse size={17} />
            Long Rest
          </button>
          <button type="button" onClick={onRemoveDefeated}>
            <Archive size={17} />
            Clear Defeated
          </button>
        </div>
      </div>
    </div>
  )
}

function LibraryPanel({
  activeTab,
  setActiveTab,
  library,
  srdIndex,
  srdStatus,
  srdQuery,
  draft,
  srdCharacter,
  srdCharacterBuilder,
  jsonImport,
  jsonImportStatus,
  onQueryChange,
  onLoadSrd,
  onImportSrd,
  onAddCombatant,
  onDraftChange,
  onAddCustom,
  onSrdCharacterChange,
  onLoadSrdCharacterBuilder,
  onSelectSrdClass,
  onSelectSrdRace,
  onSelectSrdWeapon,
  onSelectSrdSpell,
  onAddSrdWeaponAction,
  onAddSrdSpellAction,
  onRemoveSrdCharacterAction,
  onAddSrdCharacter,
  onJsonChange,
  onImportJson,
  onImportJsonToBattle,
  onExportLibrary,
  onImportEncounterFile,
  onExportEncounter,
}: {
  activeTab: LibraryTab
  setActiveTab: (tab: LibraryTab) => void
  library: ContentEntry[]
  srdIndex: SrdIndexItem[]
  srdStatus: string
  srdQuery: string
  draft: DraftContent
  srdCharacter: SrdCharacterDraft
  srdCharacterBuilder: SrdCharacterBuilderState
  jsonImport: string
  jsonImportStatus: string
  onQueryChange: (query: string) => void
  onLoadSrd: () => void
  onImportSrd: (index: string, addToField?: boolean) => void
  onAddCombatant: (entry: ContentEntry, side?: Side) => void
  onDraftChange: (draft: DraftContent) => void
  onAddCustom: () => void
  onSrdCharacterChange: (draft: SrdCharacterDraft) => void
  onLoadSrdCharacterBuilder: () => void
  onSelectSrdClass: (classIndex: string) => void
  onSelectSrdRace: (raceIndex: string) => void
  onSelectSrdWeapon: (weaponIndex: string) => void
  onSelectSrdSpell: (spellIndex: string) => void
  onAddSrdWeaponAction: () => void
  onAddSrdSpellAction: () => void
  onRemoveSrdCharacterAction: (kind: 'weapon' | 'spell', index: string) => void
  onAddSrdCharacter: () => void
  onJsonChange: (value: string) => void
  onImportJson: () => void
  onImportJsonToBattle: () => void
  onExportLibrary: () => void
  onImportEncounterFile: (event: ChangeEvent<HTMLInputElement>) => void
  onExportEncounter: () => Promise<void>
}) {
  return (
    <div className="library-panel">
      <PanelHeading icon={<Database size={18} />} title="Content Library" />
      <div className="segmented">
        <button type="button" className={activeTab === 'library' ? 'selected' : ''} onClick={() => setActiveTab('library')}>
          Library
        </button>
        <button type="button" className={activeTab === 'custom' ? 'selected' : ''} onClick={() => setActiveTab('custom')}>
          Custom
        </button>
        <button
          type="button"
          className={activeTab === 'character' ? 'selected' : ''}
          onClick={() => setActiveTab('character')}
        >
          SRD PC
        </button>
        <button type="button" className={activeTab === 'json' ? 'selected' : ''} onClick={() => setActiveTab('json')}>
          JSON
        </button>
      </div>

      {activeTab === 'library' ? (
        <>
          <label className="search-box">
            <Search size={16} />
            <input value={srdQuery} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search library or SRD" />
          </label>

          <div className="srd-import">
            <div>
              <strong>SRD 5.1 API</strong>
              <p>{srdStatus}</p>
            </div>
            <button type="button" className="small-button" onClick={onLoadSrd}>
              Load
            </button>
          </div>

          {srdIndex.length > 0 ? (
            <div className="srd-results">
              {srdIndex.map((entry) => (
                <button type="button" key={entry.index} onClick={() => onImportSrd(entry.index, true)}>
                  <Plus size={14} />
                  {entry.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className="library-list">
            {library.map((entry) => (
              <article key={entry.id} className="content-card">
                <div>
                  <span className={sourceClass(entry.source.kind)}>{entry.source.kind}</span>
                  <h3>{entry.name}</h3>
                  <p>
                    AC {entry.armorClass} · HP {entry.maxHp} · Speed {entry.speedFt} ft
                  </p>
                </div>
                <div className="card-actions">
                  <button type="button" onClick={() => onAddCombatant(entry, 'Heroes')}>
                    Hero
                  </button>
                  <button type="button" onClick={() => onAddCombatant(entry, 'Monsters')}>
                    Mob
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

      {activeTab === 'custom' ? (
        <CustomBuilder draft={draft} onDraftChange={onDraftChange} onAddCustom={onAddCustom} />
      ) : null}

      {activeTab === 'character' ? (
        <SrdCharacterBuilder
          draft={srdCharacter}
          builder={srdCharacterBuilder}
          onDraftChange={onSrdCharacterChange}
          onLoad={onLoadSrdCharacterBuilder}
          onSelectClass={onSelectSrdClass}
          onSelectRace={onSelectSrdRace}
          onSelectWeapon={onSelectSrdWeapon}
          onSelectSpell={onSelectSrdSpell}
          onAddWeaponAction={onAddSrdWeaponAction}
          onAddSpellAction={onAddSrdSpellAction}
          onRemoveAction={onRemoveSrdCharacterAction}
          onAddCharacter={onAddSrdCharacter}
        />
      ) : null}

      {activeTab === 'json' ? (
        <div className="json-tools">
          <textarea
            value={jsonImport}
            onChange={(event) => onJsonChange(event.target.value)}
            placeholder="Paste a ContentEntry, ContentEntry[], fenced JSON block, content pack, or saved encounter JSON."
          />
          <div className="srd-import">
            <div>
              <strong>JSON import</strong>
              <p>{jsonImportStatus}</p>
            </div>
          </div>
          <div className="tool-row">
            <button type="button" onClick={onImportJson}>
              <FileJson size={16} />
              Import content JSON
            </button>
            <button type="button" onClick={onImportJsonToBattle}>
              <Swords size={16} />
              Import to battle
            </button>
            <button type="button" onClick={onExportLibrary}>
              <Download size={16} />
              Export library
            </button>
            <label className="upload-button">
              <Upload size={16} />
              Load encounter
              <input type="file" accept="application/json,.json" onChange={onImportEncounterFile} />
            </label>
            <button type="button" onClick={() => void onExportEncounter()}>
              <Save size={16} />
              Save encounter
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SrdCharacterBuilder({
  draft,
  builder,
  onDraftChange,
  onLoad,
  onSelectClass,
  onSelectRace,
  onSelectWeapon,
  onSelectSpell,
  onAddWeaponAction,
  onAddSpellAction,
  onRemoveAction,
  onAddCharacter,
}: {
  draft: SrdCharacterDraft
  builder: SrdCharacterBuilderState
  onDraftChange: (draft: SrdCharacterDraft) => void
  onLoad: () => void
  onSelectClass: (classIndex: string) => void
  onSelectRace: (raceIndex: string) => void
  onSelectWeapon: (weaponIndex: string) => void
  onSelectSpell: (spellIndex: string) => void
  onAddWeaponAction: () => void
  onAddSpellAction: () => void
  onRemoveAction: (kind: 'weapon' | 'spell', index: string) => void
  onAddCharacter: () => void
}) {
  const scores = srdCharacterScores(draft, builder.selectedRace)
  const proficiencyBonus = proficiencyBonusForLevel(draft.level)
  const conMod = abilityModifier(scores.con)
  const hitDie = builder.selectedClass?.hit_die ?? 8
  const averageHitDie = Math.floor(hitDie / 2) + 1
  const maxHp = Math.max(draft.level, hitDie + conMod + (draft.level - 1) * (averageHitDie + conMod))
  const initiativeBonus = abilityModifier(scores.dex)
  const attackBonus = proficiencyBonus + abilityModifier(scores[draft.attackAbility])
  const spellBonus = proficiencyBonus + abilityModifier(scores[draft.spellAbility])
  const spellSaveDc = 8 + spellBonus
  const racialBonusText =
    builder.selectedRace?.ability_bonuses
      ?.map((bonus) => `${bonus.ability_score.name} +${bonus.bonus}`)
      .join(', ') ?? 'Load race'
  const classOptions = builder.classes.length
    ? builder.classes
    : [{ index: draft.classIndex, name: draft.classIndex, url: '' }]
  const raceOptions = builder.races.length ? builder.races : [{ index: draft.raceIndex, name: draft.raceIndex, url: '' }]
  const weaponOptions = builder.weapons.length
    ? builder.weapons
    : [{ index: draft.weaponIndex, name: draft.weaponIndex, url: '' }]
  const spellOptions = builder.spells.length ? builder.spells : [{ index: draft.spellIndex, name: draft.spellIndex, url: '' }]
  const selectedWeapons = draft.selectedWeaponIndexes.map((index) => ({
    index,
    name: builder.selectedWeapons[index]?.name ?? (builder.selectedWeapon?.index === index ? builder.selectedWeapon.name : index),
  }))
  const selectedSpells = draft.selectedSpellIndexes.map((index) => ({
    index,
    name: builder.selectedSpells[index]?.name ?? (builder.selectedSpell?.index === index ? builder.selectedSpell.name : index),
  }))

  const update = <K extends keyof SrdCharacterDraft>(key: K, value: SrdCharacterDraft[K]) => {
    onDraftChange({ ...draft, [key]: value })
  }

  const updateAbility = (ability: Ability, value: number) => {
    onDraftChange({
      ...draft,
      baseAbilityScores: {
        ...draft.baseAbilityScores,
        [ability]: value,
      },
    })
  }

  return (
    <div className="srd-character-builder">
      <div className="srd-import">
        <div>
          <strong>SRD character builder</strong>
          <p>{builder.status}</p>
        </div>
        <button type="button" className="small-button" onClick={onLoad}>
          Load
        </button>
      </div>

      <Field label="Character name">
        <input value={draft.name} onChange={(event) => update('name', event.target.value)} />
      </Field>

      <div className="form-grid two">
        <Field label="Class">
          <select value={draft.classIndex} onChange={(event) => onSelectClass(event.target.value)}>
            {classOptions.map((option) => (
              <option key={option.index} value={option.index}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Race">
          <select value={draft.raceIndex} onChange={(event) => onSelectRace(event.target.value)}>
            {raceOptions.map((option) => (
              <option key={option.index} value={option.index}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Level">
          <input
            type="number"
            min={1}
            max={20}
            value={draft.level}
            onChange={(event) => update('level', Math.min(20, Math.max(1, numberValue(event.target.value))))}
          />
        </Field>
        <Field label="Side">
          <select value={draft.side} onChange={(event) => update('side', event.target.value as Side)}>
            <option value="Heroes">Heroes</option>
            <option value="Monsters">Monsters</option>
          </select>
        </Field>
        <Field label="AC">
          <input type="number" value={draft.armorClass} onChange={(event) => update('armorClass', numberValue(event.target.value))} />
        </Field>
        <div className="derived-rule">
          <span>HP</span>
          <strong>{maxHp}</strong>
        </div>
      </div>

      <div className="srd-summary-grid">
        <div>
          <span>Hit die</span>
          <strong>d{hitDie}</strong>
        </div>
        <div>
          <span>Prof</span>
          <strong>{signed(proficiencyBonus)}</strong>
        </div>
        <div>
          <span>Speed</span>
          <strong>{builder.selectedRace?.speed ?? 30} ft</strong>
        </div>
        <div>
          <span>Init</span>
          <strong>{signed(initiativeBonus)}</strong>
        </div>
      </div>

      <div className="ability-grid">
        {abilities.map((ability) => (
          <Field key={ability} label={`${ability.toUpperCase()} ${scores[ability]} (${signed(abilityModifier(scores[ability]))})`}>
            <input
              type="number"
              min={1}
              max={30}
              value={draft.baseAbilityScores[ability]}
              onChange={(event) => updateAbility(ability, numberValue(event.target.value))}
            />
          </Field>
        ))}
      </div>

      <div className="srd-rule-note">
        <LibraryBig size={16} />
        <span>{racialBonusText}</span>
      </div>

      <div className="form-grid two">
        <Field label="Action focus">
          <select value={draft.actionSource} onChange={(event) => update('actionSource', event.target.value as SrdCharacterDraft['actionSource'])}>
            <option value="weapon">SRD weapon</option>
            <option value="spell">SRD spell</option>
          </select>
        </Field>
        <Field label="Attack ability">
          <select value={draft.attackAbility} onChange={(event) => update('attackAbility', event.target.value as Ability)}>
            {abilities.map((ability) => (
              <option key={ability} value={ability}>
                {ability.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Weapon">
          <select value={draft.weaponIndex} onChange={(event) => onSelectWeapon(event.target.value)}>
            {weaponOptions.map((option) => (
              <option key={option.index} value={option.index}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <button type="button" className="small-button align-end" onClick={onAddWeaponAction}>
          <Plus size={14} />
          Add weapon
        </button>
        <Field label="Spell ability">
          <select value={draft.spellAbility} onChange={(event) => update('spellAbility', event.target.value as Ability)}>
            {abilities.map((ability) => (
              <option key={ability} value={ability}>
                {ability.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Spell">
          <select value={draft.spellIndex} onChange={(event) => onSelectSpell(event.target.value)}>
            {spellOptions.map((option) => (
              <option key={option.index} value={option.index}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>
        <button type="button" className="small-button align-end" onClick={onAddSpellAction}>
          <Plus size={14} />
          Add spell
        </button>
        <div className="derived-rule">
          <span>{draft.actionSource === 'spell' ? 'Spell/DC' : 'Weapon'}</span>
          <strong>{draft.actionSource === 'spell' ? `${signed(spellBonus)} / ${spellSaveDc}` : signed(attackBonus)}</strong>
        </div>
      </div>

      <div className="action-tray">
        <div>
          <h3>Weapon actions</h3>
          {selectedWeapons.length ? (
            selectedWeapons.map((weapon) => (
              <button type="button" key={weapon.index} onClick={() => onRemoveAction('weapon', weapon.index)}>
                {weapon.name}
              </button>
            ))
          ) : (
            <p>No weapon actions selected.</p>
          )}
        </div>
        <div>
          <h3>Spell actions</h3>
          {selectedSpells.length ? (
            selectedSpells.map((spell) => (
              <button type="button" key={spell.index} onClick={() => onRemoveAction('spell', spell.index)}>
                {spell.name}
              </button>
            ))
          ) : (
            <p>No spell actions selected.</p>
          )}
        </div>
      </div>

      <button type="button" className="primary full-width" onClick={onAddCharacter}>
        <Plus size={17} />
        Build and add SRD character
      </button>
    </div>
  )
}

function CustomBuilder({
  draft,
  onDraftChange,
  onAddCustom,
}: {
  draft: DraftContent
  onDraftChange: (draft: DraftContent) => void
  onAddCustom: () => void
}) {
  const playerMath = derivedPlayerMath(draft)
  const update = <K extends keyof DraftContent>(key: K, value: DraftContent[K]) => {
    onDraftChange({ ...draft, [key]: value })
  }
  const updateAbility = (ability: Ability, value: number) => {
    const nextDraft = {
      ...draft,
      abilityScores: {
        ...draft.abilityScores,
        [ability]: value,
      },
    }
    const nextMath = derivedPlayerMath(nextDraft)
    onDraftChange({
      ...nextDraft,
      initiativeBonus: nextDraft.kind === 'player' && nextDraft.useSrdPlayerMath ? nextMath.initiativeBonus : nextDraft.initiativeBonus,
      attackBonus: nextDraft.kind === 'player' && nextDraft.useSrdPlayerMath ? nextMath.attackBonus : nextDraft.attackBonus,
    })
  }
  const updateKind = (kind: DraftContent['kind']) => {
    if (kind === 'player') {
      onDraftChange(applySrdPlayerDefaults(draft, 'fighter'))
      return
    }

    onDraftChange({
      ...draft,
      name: 'Custom Skirmisher',
      kind: 'monster',
      side: 'Monsters',
      level: 1,
      abilityScores: { ...baseAbilityScores, dex: 14 },
      saveProficiencies: ['dex'],
      attackAbility: 'dex',
      spellAbility: 'wis',
      actionMode: 'weaponAttack',
      useSrdPlayerMath: false,
      armorClass: 13,
      maxHp: 18,
      speedFt: 30,
      initiativeBonus: 2,
      attackName: 'Blade',
      attackBonus: 4,
      damageDice: '1d8+2',
      damageType: 'slashing',
      rangeFt: 5,
      meleeActions: [createDraftAction('melee', { name: 'Blade', attackBonus: 4, damageDice: '1d8+2', damageType: 'slashing' })],
      rangedActions: [createDraftAction('ranged')],
      spellActions: [],
      customActions: [createDraftAction('custom')],
      actionDraft: createDraftAction('custom'),
      resistances: '',
      immunities: '',
      vulnerabilities: '',
      notes: '',
    })
  }
  const updateLevel = (level: number) => {
    const nextDraft = { ...draft, level: Math.min(20, Math.max(1, level)) }
    const nextMath = derivedPlayerMath(nextDraft)
    onDraftChange({
      ...nextDraft,
      initiativeBonus: nextDraft.useSrdPlayerMath ? nextMath.initiativeBonus : nextDraft.initiativeBonus,
      attackBonus: nextDraft.useSrdPlayerMath ? nextMath.attackBonus : nextDraft.attackBonus,
    })
  }
  const updateSrdMath = (useSrdPlayerMath: boolean) => {
    const nextDraft = { ...draft, useSrdPlayerMath }
    const nextMath = derivedPlayerMath(nextDraft)
    onDraftChange({
      ...nextDraft,
      initiativeBonus: useSrdPlayerMath ? nextMath.initiativeBonus : nextDraft.initiativeBonus,
      attackBonus: useSrdPlayerMath ? nextMath.attackBonus : nextDraft.attackBonus,
    })
  }
  const toggleSaveProficiency = (ability: Ability) => {
    const current = new Set(draft.saveProficiencies)
    if (current.has(ability)) {
      current.delete(ability)
    } else {
      current.add(ability)
    }
    onDraftChange({ ...draft, saveProficiencies: abilities.filter((candidate) => current.has(candidate)) })
  }
  const updateActionDraft = <K extends keyof DraftAction>(key: K, value: DraftAction[K]) => {
    onDraftChange({ ...draft, actionDraft: { ...draft.actionDraft, [key]: value } })
  }
  const actionKeyForCategory = (category: 'melee' | 'ranged' | 'spell' | 'custom') =>
    `${category}Actions` as 'meleeActions' | 'rangedActions' | 'spellActions' | 'customActions'
  const addActionToCategory = (category: 'melee' | 'ranged' | 'spell' | 'custom') => {
    const key = actionKeyForCategory(category)
    onDraftChange({
      ...draft,
      [key]: [...draft[key], { ...draft.actionDraft, id: `${category}-${Date.now()}` }],
      actionDraft: createDraftAction(category),
    })
  }
  const updateAction = <K extends keyof DraftAction>(
    category: 'melee' | 'ranged' | 'spell' | 'custom',
    id: string,
    key: K,
    value: DraftAction[K],
  ) => {
    const actionKey = actionKeyForCategory(category)
    onDraftChange({
      ...draft,
      [actionKey]: draft[actionKey].map((action) => (action.id === id ? { ...action, [key]: value } : action)),
    })
  }
  const removeAction = (category: 'melee' | 'ranged' | 'spell' | 'custom', id: string) => {
    const key = actionKeyForCategory(category)
    onDraftChange({ ...draft, [key]: draft[key].filter((action) => action.id !== id) })
  }
  const renderActionGroup = (
    title: string,
    category: 'melee' | 'ranged' | 'spell' | 'custom',
    actions: DraftAction[],
  ) => (
    <section className="builder-section">
      <div className="builder-section-title">
        <h3>{title}</h3>
        <span>{actions.length} configured</span>
      </div>
      <div className="configured-action-list">
        {actions.map((action) => (
          <article key={action.id} className="configured-action-card">
            <div className="form-grid two">
              <Field label="Name">
                <input value={action.name} onChange={(event) => updateAction(category, action.id, 'name', event.target.value)} />
              </Field>
              <Field label="Roll kind">
                <select value={action.kind} onChange={(event) => updateAction(category, action.id, 'kind', event.target.value as DraftAction['kind'])}>
                  <option value="attack">To hit</option>
                  <option value="save">Save</option>
                  <option value="heal">Healing</option>
                  <option value="manual">Manual</option>
                </select>
              </Field>
              {action.kind === 'attack' ? (
                <Field label="To hit modifier">
                  <input
                    type="number"
                    value={action.attackBonus}
                    onChange={(event) => updateAction(category, action.id, 'attackBonus', numberValue(event.target.value))}
                  />
                </Field>
              ) : null}
              {action.kind === 'save' ? (
                <>
                  <Field label="Save DC">
                    <input
                      type="number"
                      value={action.saveDc}
                      onChange={(event) => updateAction(category, action.id, 'saveDc', numberValue(event.target.value))}
                    />
                  </Field>
                  <Field label="Save ability">
                    <select value={action.saveAbility} onChange={(event) => updateAction(category, action.id, 'saveAbility', event.target.value as Ability)}>
                      {abilities.map((ability) => (
                        <option key={ability} value={ability}>
                          {ability.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Damage on pass">
                    <select
                      value={action.damageOnSave}
                      onChange={(event) => updateAction(category, action.id, 'damageOnSave', event.target.value as DraftAction['damageOnSave'])}
                    >
                      <option value="none">Zero</option>
                      <option value="half">Half</option>
                    </select>
                  </Field>
                </>
              ) : null}
              <Field label={action.kind === 'heal' ? 'Healing dice' : 'Damage on hit/fail'}>
                <input value={action.damageDice} onChange={(event) => updateAction(category, action.id, 'damageDice', event.target.value)} />
              </Field>
              <Field label="Damage type">
                <input value={action.damageType} onChange={(event) => updateAction(category, action.id, 'damageType', event.target.value)} />
              </Field>
              <Field label="Range ft">
                <input
                  type="number"
                  value={action.rangeFt}
                  onChange={(event) => updateAction(category, action.id, 'rangeFt', numberValue(event.target.value))}
                />
              </Field>
              <Field label="Reach ft">
                <input
                  type="number"
                  value={action.reachFt}
                  onChange={(event) => updateAction(category, action.id, 'reachFt', numberValue(event.target.value))}
                />
              </Field>
            </div>
            <Field label="Description">
              <textarea value={action.description} onChange={(event) => updateAction(category, action.id, 'description', event.target.value)} />
            </Field>
            <button type="button" className="danger small-button" onClick={() => removeAction(category, action.id)}>
              Remove action
            </button>
          </article>
        ))}
      </div>
    </section>
  )

  return (
    <div className="custom-builder">
      <Field label="Name">
        <input value={draft.name} onChange={(event) => update('name', event.target.value)} />
      </Field>
      <div className="form-grid two">
        <Field label="Kind">
          <select value={draft.kind} onChange={(event) => updateKind(event.target.value as DraftContent['kind'])}>
            <option value="monster">Monster</option>
            <option value="player">Player</option>
          </select>
        </Field>
        <Field label="Side">
          <select value={draft.side} onChange={(event) => update('side', event.target.value as Side)}>
            <option value="Heroes">Heroes</option>
            <option value="Monsters">Monsters</option>
          </select>
        </Field>
        <Field label="Source">
          <select
            value={draft.sourceKind}
            onChange={(event) => update('sourceKind', event.target.value as DraftContent['sourceKind'])}
          >
            <option value="Custom">Custom</option>
            <option value="Third-party">Third-party</option>
            <option value="Imported">Imported</option>
            <option value="Draft">Draft</option>
          </select>
        </Field>
        {draft.kind === 'player' ? (
          <Field label="Level">
            <input type="number" min={1} max={20} value={draft.level} onChange={(event) => updateLevel(numberValue(event.target.value))} />
          </Field>
        ) : null}
        <Field label="Initiative">
          <input
            type="number"
            value={draft.initiativeBonus}
            disabled={draft.kind === 'player' && draft.useSrdPlayerMath}
            onChange={(event) => update('initiativeBonus', numberValue(event.target.value))}
          />
        </Field>
        <Field label="AC">
          <input type="number" value={draft.armorClass} onChange={(event) => update('armorClass', numberValue(event.target.value))} />
        </Field>
        <Field label="HP">
          <input type="number" value={draft.maxHp} onChange={(event) => update('maxHp', numberValue(event.target.value))} />
        </Field>
        <Field label="Speed">
          <input type="number" value={draft.speedFt} onChange={(event) => update('speedFt', numberValue(event.target.value))} />
        </Field>
        <Field label="Range">
          <input type="number" value={draft.rangeFt} onChange={(event) => update('rangeFt', numberValue(event.target.value))} />
        </Field>
      </div>

      <section className="builder-section">
        <div className="builder-section-title">
          <h3>Stats</h3>
          <span>Ability scores and save proficiencies</span>
        </div>
        <div className="ability-grid">
          {abilities.map((ability) => (
            <Field key={ability} label={`${ability.toUpperCase()} ${signed(abilityModifier(draft.abilityScores[ability]))}`}>
              <input
                type="number"
                min={1}
                max={30}
                value={draft.abilityScores[ability]}
                onChange={(event) => updateAbility(ability, numberValue(event.target.value))}
              />
            </Field>
          ))}
        </div>
        <div className="save-prof-grid" aria-label="Saving throw proficiencies">
          {abilities.map((ability) => (
            <label key={ability}>
              <input
                type="checkbox"
                checked={draft.saveProficiencies.includes(ability)}
                onChange={() => toggleSaveProficiency(ability)}
              />
              {ability.toUpperCase()} save
            </label>
          ))}
        </div>
      </section>

      {draft.kind === 'player' ? (
        <div className="srd-player-box">
          <div className="check-row">
            <label>
              <input
                type="checkbox"
                checked={draft.useSrdPlayerMath}
                onChange={(event) => updateSrdMath(event.target.checked)}
              />
              SRD player math
            </label>
            <strong>Prof {signed(playerMath.proficiencyBonus)}</strong>
          </div>
          <div className="tool-row">
            <button type="button" onClick={() => onDraftChange(applySrdPlayerDefaults(draft, 'fighter'))}>
              Fighter defaults
            </button>
            <button type="button" onClick={() => onDraftChange(applySrdPlayerDefaults(draft, 'cleric'))}>
              Cleric defaults
            </button>
          </div>
          <div className="form-grid two">
            <Field label="Action model">
              <select value={draft.actionMode} onChange={(event) => update('actionMode', event.target.value as DraftContent['actionMode'])}>
                <option value="weaponAttack">Weapon attack</option>
                <option value="spellSave">Spell save</option>
              </select>
            </Field>
            <Field label="Attack ability">
              <select value={draft.attackAbility} onChange={(event) => update('attackAbility', event.target.value as Ability)}>
                {abilities.map((ability) => (
                  <option key={ability} value={ability}>
                    {ability.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Spell ability">
              <select value={draft.spellAbility} onChange={(event) => update('spellAbility', event.target.value as Ability)}>
                {abilities.map((ability) => (
                  <option key={ability} value={ability}>
                    {ability.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <div className="derived-rule">
              <span>{draft.actionMode === 'spellSave' ? 'Save DC' : 'Attack'}</span>
              <strong>{draft.actionMode === 'spellSave' ? playerMath.saveDc : signed(playerMath.attackBonus)}</strong>
            </div>
          </div>
        </div>
      ) : null}

      <section className="builder-section action-composer">
        <div className="builder-section-title">
          <h3>New action</h3>
          <span>Configure once, then add to a group</span>
        </div>
        <div className="form-grid two">
          <Field label="Action name">
            <input value={draft.actionDraft.name} onChange={(event) => updateActionDraft('name', event.target.value)} />
          </Field>
          <Field label="Roll kind">
            <select value={draft.actionDraft.kind} onChange={(event) => updateActionDraft('kind', event.target.value as DraftAction['kind'])}>
              <option value="attack">To hit</option>
              <option value="save">Save</option>
              <option value="heal">Healing</option>
              <option value="manual">Manual</option>
            </select>
          </Field>
          {draft.actionDraft.kind === 'attack' ? (
            <Field label="To hit modifier">
              <input
                type="number"
                value={draft.actionDraft.attackBonus}
                onChange={(event) => updateActionDraft('attackBonus', numberValue(event.target.value))}
              />
            </Field>
          ) : null}
          {draft.actionDraft.kind === 'save' ? (
            <>
              <Field label="Save DC">
                <input
                  type="number"
                  value={draft.actionDraft.saveDc}
                  onChange={(event) => updateActionDraft('saveDc', numberValue(event.target.value))}
                />
              </Field>
              <Field label="Save ability">
                <select value={draft.actionDraft.saveAbility} onChange={(event) => updateActionDraft('saveAbility', event.target.value as Ability)}>
                  {abilities.map((ability) => (
                    <option key={ability} value={ability}>
                      {ability.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Damage on pass">
                <select
                  value={draft.actionDraft.damageOnSave}
                  onChange={(event) => updateActionDraft('damageOnSave', event.target.value as DraftAction['damageOnSave'])}
                >
                  <option value="none">Zero</option>
                  <option value="half">Half</option>
                </select>
              </Field>
            </>
          ) : null}
          <Field label={draft.actionDraft.kind === 'heal' ? 'Healing dice' : 'Damage on hit/fail'}>
            <input value={draft.actionDraft.damageDice} onChange={(event) => updateActionDraft('damageDice', event.target.value)} />
          </Field>
          <Field label="Damage type">
            <input value={draft.actionDraft.damageType} onChange={(event) => updateActionDraft('damageType', event.target.value)} />
          </Field>
          <Field label="Range ft">
            <input
              type="number"
              value={draft.actionDraft.rangeFt}
              onChange={(event) => updateActionDraft('rangeFt', numberValue(event.target.value))}
            />
          </Field>
          <Field label="Reach ft">
            <input
              type="number"
              value={draft.actionDraft.reachFt}
              onChange={(event) => updateActionDraft('reachFt', numberValue(event.target.value))}
            />
          </Field>
        </div>
        <Field label="Action description">
          <textarea value={draft.actionDraft.description} onChange={(event) => updateActionDraft('description', event.target.value)} />
        </Field>
        <div className="action-add-grid">
          <button type="button" onClick={() => addActionToCategory('melee')}>
            Add melee atk
          </button>
          <button type="button" onClick={() => addActionToCategory('ranged')}>
            Add ranged atk
          </button>
          <button type="button" onClick={() => addActionToCategory('spell')}>
            Add spell
          </button>
          <button type="button" onClick={() => addActionToCategory('custom')}>
            Add custom action
          </button>
        </div>
      </section>

      {renderActionGroup('Melee Atk', 'melee', draft.meleeActions)}
      {renderActionGroup('Ranged Atk', 'ranged', draft.rangedActions)}
      {renderActionGroup('Spells', 'spell', draft.spellActions)}
      {renderActionGroup('Customized Action', 'custom', draft.customActions)}

      <section className="builder-section">
        <div className="builder-section-title">
          <h3>Damage traits</h3>
          <span>Comma-separated damage types and conditions</span>
        </div>
        <div className="form-grid three">
          <Field label="Resistances">
            <input value={draft.resistances} onChange={(event) => update('resistances', event.target.value)} placeholder="fire, cold" />
          </Field>
          <Field label="Immunities">
            <input value={draft.immunities} onChange={(event) => update('immunities', event.target.value)} placeholder="poison, charmed condition" />
          </Field>
          <Field label="Vulnerabilities">
            <input value={draft.vulnerabilities} onChange={(event) => update('vulnerabilities', event.target.value)} placeholder="radiant" />
          </Field>
        </div>
      </section>

      <Field label="Traits and notes">
        <textarea value={draft.notes} onChange={(event) => update('notes', event.target.value)} />
      </Field>
      <button type="button" className="primary full-width" onClick={onAddCustom}>
        <Plus size={17} />
        Add configured content
      </button>
    </div>
  )
}

function TacticalMap({
  battleMap,
  setBattleMap,
  tacticalMapState,
  setTacticalMapState,
  combatants,
  selectedCombatantId,
  onSelectCombatant,
  onSetDestination,
}: {
  battleMap: BattleMap
  setBattleMap: React.Dispatch<React.SetStateAction<BattleMap>>
  tacticalMapState: TacticalMapState
  setTacticalMapState: React.Dispatch<React.SetStateAction<TacticalMapState>>
  combatants: Combatant[]
  selectedCombatantId?: string
  onSelectCombatant: (id: string) => void
  onSetDestination: (id: string, destination: { x: number; y: number } | undefined) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const mapWindowRef = useRef<HTMLDivElement | null>(null)
  const mapViewRef = useRef<MapView>({ zoom: 1, panX: 0, panY: 0 })
  const autoDetectedImageRef = useRef<string | undefined>(undefined)
  const touchPointersRef = useRef<Map<number, MapPixelPoint>>(new Map())
  const pinchRef = useRef<
    | {
        pointerIds: [number, number]
        startDistance: number
        startView: MapView
        anchor: MapPixelPoint
      }
    | undefined
  >(undefined)
  const interactionRef = useRef<
    | { type: 'pan'; pointerId: number; startClient: MapPixelPoint; startView: MapView }
    | { type: 'draw'; pointerId: number; annotationId: string }
    | undefined
  >(undefined)
  const [mapImage, setMapImage] = useState<HTMLImageElement | null>(null)
  const {
    activeMapTool,
    mapView,
    measurement,
    annotations,
    showAnnotations,
    toolsHidden,
    drawColor,
    shapeColor,
    shapeWidthCells,
    shapeHeightCells,
    shapeFitToGrid,
  } = tacticalMapState
  const setActiveMapTool = (next: React.SetStateAction<MapTool>) =>
    setTacticalMapState((current) => ({
      ...current,
      activeMapTool: resolveStateUpdate(next, current.activeMapTool),
    }))
  const setMapView = (next: React.SetStateAction<MapView>) =>
    setTacticalMapState((current) => ({
      ...current,
      mapView: resolveStateUpdate(next, current.mapView),
    }))
  const setMeasurement = (next: React.SetStateAction<TacticalMapState['measurement']>) =>
    setTacticalMapState((current) => ({
      ...current,
      measurement: resolveStateUpdate(next, current.measurement),
    }))
  const setAnnotations = (next: React.SetStateAction<MapAnnotation[]>) =>
    setTacticalMapState((current) => ({
      ...current,
      annotations: resolveStateUpdate(next, current.annotations),
    }))
  const setShowAnnotations = (next: React.SetStateAction<boolean>) =>
    setTacticalMapState((current) => ({
      ...current,
      showAnnotations: resolveStateUpdate(next, current.showAnnotations),
    }))
  const setToolsHidden = (next: React.SetStateAction<boolean>) =>
    setTacticalMapState((current) => ({
      ...current,
      toolsHidden: resolveStateUpdate(next, current.toolsHidden),
    }))
  const setDrawColor = (next: React.SetStateAction<string>) =>
    setTacticalMapState((current) => ({
      ...current,
      drawColor: resolveStateUpdate(next, current.drawColor),
    }))
  const setShapeColor = (next: React.SetStateAction<string>) =>
    setTacticalMapState((current) => ({
      ...current,
      shapeColor: resolveStateUpdate(next, current.shapeColor),
    }))
  const setShapeWidthCells = (next: React.SetStateAction<number>) =>
    setTacticalMapState((current) => ({
      ...current,
      shapeWidthCells: resolveStateUpdate(next, current.shapeWidthCells),
    }))
  const setShapeHeightCells = (next: React.SetStateAction<number>) =>
    setTacticalMapState((current) => ({
      ...current,
      shapeHeightCells: resolveStateUpdate(next, current.shapeHeightCells),
    }))
  const setShapeFitToGrid = (next: React.SetStateAction<boolean>) =>
    setTacticalMapState((current) => ({
      ...current,
      shapeFitToGrid: resolveStateUpdate(next, current.shapeFitToGrid),
    }))
  const [isDetectingGrid, setIsDetectingGrid] = useState(false)
  const [gridDetectionStatus, setGridDetectionStatus] = useState('')
  const selectedCombatant = combatants.find((combatant) => combatant.id === selectedCombatantId)
  const selectedAction = selectedActionFor(selectedCombatant)
  const mapTools: Array<{ id: MapTool; label: string; icon: React.ReactNode }> = [
    { id: 'mouse', label: 'Mouse', icon: <MousePointer2 size={18} /> },
    { id: 'move', label: 'Move map', icon: <Move size={18} /> },
    { id: 'draw', label: 'Draw freely', icon: <Pencil size={18} /> },
    { id: 'square', label: 'Square area', icon: <Square size={18} /> },
    { id: 'circle', label: 'Circle area', icon: <Circle size={18} /> },
    { id: 'measure', label: 'Measure', icon: <Ruler size={18} /> },
    { id: 'visibility', label: 'Visibility', icon: <Eye size={18} /> },
  ]

  useEffect(() => {
    mapViewRef.current = mapView
  }, [mapView])

  useEffect(() => {
    if (!battleMap.imageUrl) {
      queueMicrotask(() => setMapImage(null))
      autoDetectedImageRef.current = undefined
      return
    }

    const image = new Image()
    image.onload = () => setMapImage(image)
    image.src = battleMap.imageUrl
  }, [battleMap.imageUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    const mapWindow = mapWindowRef.current
    if (!canvas || !mapWindow) {
      return
    }

    let gestureStartView: MapView | undefined
    let gestureAnchor: MapPixelPoint | undefined
    const wheelOptions = { capture: true, passive: false } as const

    const pointFromClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: ((clientX - rect.left) / rect.width) * canvas.width,
        y: ((clientY - rect.top) / rect.height) * canvas.height,
      }
    }

    const pointFromGesture = (event: GestureLikeEvent) =>
      pointFromClient(
        event.clientX ?? mapWindow.getBoundingClientRect().left + mapWindow.clientWidth / 2,
        event.clientY ?? mapWindow.getBoundingClientRect().top + mapWindow.clientHeight / 2,
      )

    const handleGestureStart = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      const gestureEvent = event as GestureLikeEvent
      gestureStartView = mapViewRef.current
      gestureAnchor = pointFromGesture(gestureEvent)
    }

    const handleGestureChange = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!gestureStartView || !gestureAnchor) {
        return
      }

      const gestureEvent = event as GestureLikeEvent
      setTacticalMapState((current) => ({
        ...current,
        mapView: zoomViewAtPoint(gestureStartView, gestureStartView.zoom * (gestureEvent.scale ?? 1), gestureAnchor),
      }))
    }

    const handleGestureEnd = (event: Event) => {
      event.stopPropagation()
      gestureStartView = undefined
      gestureAnchor = undefined
    }

    const handleNativeWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      const anchor = pointFromClient(event.clientX, event.clientY)
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY

      setTacticalMapState((current) => ({
        ...current,
        mapView: zoomViewAtPoint(current.mapView, current.mapView.zoom * Math.exp(-delta * 0.0025), anchor),
      }))
    }

    mapWindow.addEventListener('wheel', handleNativeWheel, wheelOptions)
    mapWindow.addEventListener('gesturestart', handleGestureStart, { passive: false })
    mapWindow.addEventListener('gesturechange', handleGestureChange, { passive: false })
    mapWindow.addEventListener('gestureend', handleGestureEnd)

    return () => {
      mapWindow.removeEventListener('wheel', handleNativeWheel, wheelOptions)
      mapWindow.removeEventListener('gesturestart', handleGestureStart)
      mapWindow.removeEventListener('gesturechange', handleGestureChange)
      mapWindow.removeEventListener('gestureend', handleGestureEnd)
    }
  }, [setTacticalMapState])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')

    if (!canvas || !context) {
      return
    }

    canvas.width = battleMap.width
    canvas.height = battleMap.height
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#17201d'
    context.fillRect(0, 0, canvas.width, canvas.height)

    context.save()
    context.translate(mapView.panX, mapView.panY)
    context.scale(mapView.zoom, mapView.zoom)

    if (mapImage) {
      context.drawImage(mapImage, 0, 0)
    } else {
      drawGeneratedBattleMap(context, canvas.width, canvas.height)
    }

    drawGrid(context, battleMap)
    drawAnnotations(context, showAnnotations ? annotations : [], battleMap.calibration)
    drawMeasurement(context, measurement, battleMap.calibration)
    drawTokens(context, combatants, selectedCombatantId, battleMap.calibration, selectedAction, mapView.zoom)
    context.restore()
  }, [annotations, battleMap, combatants, mapImage, mapView, measurement, selectedAction, selectedCombatantId, showAnnotations])

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const imageUrl = URL.createObjectURL(file)
    const image = new Image()
    image.src = imageUrl
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to load map image.'))
    })

    const width = image.naturalWidth
    const height = image.naturalHeight
    try {
      await writeCache<PersistedMapImage>(mapImageCacheKey, {
        blob: file,
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        width,
        height,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Map image loaded, but it could not be saved for reload.'
      setGridDetectionStatus(message)
    }

    setBattleMap((current) => ({
      ...current,
      imageUrl,
      imageName: file.name,
      width,
      height,
      calibration: {
        ...defaultMap.calibration,
        opacity: current.calibration.opacity,
      },
    }))
    setMapView((current) => ({ ...current, panX: 0, panY: 0 }))
  }

  const redetect = async () => {
    if (isDetectingGrid) {
      return
    }

    if (!battleMap.imageUrl) {
      const detected: Partial<GridCalibration> = {
        ...battleMap.calibration,
        confidence: 1,
        detected: true,
      }

      setBattleMap((current) => ({
        ...current,
        calibration: calibrationWithDetection(current.calibration, detected),
      }))
      setGridDetectionStatus(detectionMessage(detected))
      return
    }

    setIsDetectingGrid(true)
    setGridDetectionStatus('Detecting grid...')

    try {
      const detected = await detectGridFromImage(battleMap.imageUrl, { fileName: battleMap.imageName })
      setBattleMap((current) => ({
        ...current,
        calibration: calibrationWithDetection(current.calibration, detected),
      }))
      setGridDetectionStatus(detectionMessage(detected))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to detect grid.'
      setGridDetectionStatus(message)
    } finally {
      setIsDetectingGrid(false)
    }
  }

  const updateCalibration = (patch: Partial<GridCalibration>) => {
    setBattleMap((current) => ({
      ...current,
      calibration: {
        ...current.calibration,
        ...patch,
      },
    }))
  }

  useEffect(() => {
    if (!battleMap.imageUrl || autoDetectedImageRef.current === battleMap.imageUrl) {
      return
    }

    let active = true
    autoDetectedImageRef.current = battleMap.imageUrl
    setIsDetectingGrid(true)
    setGridDetectionStatus('Refreshing grid scale...')

    const refreshCurrentMapScale = async () => {
      try {
        const detected = await detectGridFromImage(battleMap.imageUrl!, { fileName: battleMap.imageName })

        if (!active) {
          return
        }

        setBattleMap((current) =>
          current.imageUrl === battleMap.imageUrl
            ? {
                ...current,
                calibration: calibrationWithDetection(current.calibration, detected),
              }
            : current,
        )
        setGridDetectionStatus(detectionMessage(detected))
      } catch (error) {
        if (!active) {
          return
        }

        const message = error instanceof Error ? error.message : 'Unable to refresh grid scale.'
        setGridDetectionStatus(message)
      } finally {
        if (active) {
          setIsDetectingGrid(false)
        }
      }
    }

    void refreshCurrentMapScale()

    return () => {
      active = false
    }
  }, [battleMap.imageName, battleMap.imageUrl, setBattleMap])

  const zoomMap = (factor: number, anchor?: MapPixelPoint) => {
    const canvas = canvasRef.current
    const zoomAnchor = anchor ?? {
      x: (canvas?.width ?? battleMap.width) / 2,
      y: (canvas?.height ?? battleMap.height) / 2,
    }

    setMapView((current) => zoomViewAtPoint(current, current.zoom * factor, zoomAnchor))
  }

  const canvasPointFromClient = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) {
      return undefined
    }

    const rect = canvas.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  const canvasPointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) =>
    canvasPointFromClient(event.clientX, event.clientY)

  const mapPointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = canvasPointFromEvent(event)

    if (!point) {
      return undefined
    }

    return {
      x: (point.x - mapView.panX) / mapView.zoom,
      y: (point.y - mapView.panY) / mapView.zoom,
    }
  }

	  const findTokenAtPoint = (mapPoint: MapPixelPoint) =>
    combatants.find((combatant) => {
      const pixel = gridToPixel(combatant.position, battleMap.calibration)
      return Math.hypot(pixel.x - mapPoint.x, pixel.y - mapPoint.y) < Math.max(22, 22 / mapView.zoom)
    })

  const createShapeAnnotation = (tool: 'square' | 'circle', mapPoint: MapPixelPoint): MapAnnotation => {
    const gridPoint = pixelToGrid(mapPoint, battleMap.calibration)
    return {
      id: `${tool}-${Date.now()}`,
      tool,
      color: shapeColor,
      center: shapeFitToGrid ? gridToPixel(gridPoint, battleMap.calibration) : mapPoint,
      widthCells: Math.max(0.5, shapeWidthCells),
      heightCells: Math.max(0.5, shapeHeightCells),
      fitToGrid: shapeFitToGrid,
    }
  }

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const mapPoint = mapPointFromEvent(event)

    if (!canvas || !mapPoint) {
      return
    }

    canvas.setPointerCapture(event.pointerId)

    if (event.pointerType === 'touch') {
      const canvasPoint = canvasPointFromEvent(event)
      if (!canvasPoint) {
        return
      }

      touchPointersRef.current.set(event.pointerId, canvasPoint)

      if (touchPointersRef.current.size >= 2) {
        const pointerEntries = [...touchPointersRef.current.entries()].slice(-2)
        const first = pointerEntries[0]
        const second = pointerEntries[1]

        if (first && second) {
          interactionRef.current = undefined
          pinchRef.current = {
            pointerIds: [first[0], second[0]],
            startDistance: Math.max(1, pointDistance(first[1], second[1])),
            startView: mapViewRef.current,
            anchor: midpoint(first[1], second[1]),
          }
        }
      }

      return
    }

    if (activeMapTool === 'move') {
      interactionRef.current = {
        type: 'pan',
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        startView: mapView,
      }
      return
    }

    if (activeMapTool === 'draw') {
      const annotationId = `draw-${Date.now()}`
      interactionRef.current = { type: 'draw', pointerId: event.pointerId, annotationId }
      setAnnotations((current) => [
        ...current,
        {
          id: annotationId,
          tool: 'draw',
          color: drawColor,
          points: [mapPoint],
        },
      ])
      return
    }

    if (activeMapTool === 'square' || activeMapTool === 'circle') {
      setAnnotations((current) => [...current, createShapeAnnotation(activeMapTool, mapPoint)])
      return
    }

    const clickedToken = findTokenAtPoint(mapPoint)
    const gridPoint = clickedToken?.position ?? pixelToGrid(mapPoint, battleMap.calibration)

    if (activeMapTool === 'measure') {
      setMeasurement((current) => (!current || current.to ? { from: gridPoint } : { from: current.from, to: gridPoint }))

      if (clickedToken) {
        onSelectCombatant(clickedToken.id)
      }

      return
    }

    if (clickedToken) {
      if (clickedToken.id === selectedCombatantId) {
        onSetDestination(clickedToken.id, undefined)
        return
      }

      onSelectCombatant(clickedToken.id)
      return
    }

    if (selectedCombatantId && activeMapTool === 'mouse') {
      onSetDestination(selectedCombatantId, gridPoint)
    }
  }

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      const canvasPoint = canvasPointFromEvent(event)
      if (!canvasPoint) {
        return
      }

      touchPointersRef.current.set(event.pointerId, canvasPoint)
      const pinch = pinchRef.current

      if (pinch) {
        const first = touchPointersRef.current.get(pinch.pointerIds[0])
        const second = touchPointersRef.current.get(pinch.pointerIds[1])

        if (first && second) {
          event.preventDefault()
          const nextDistance = Math.max(1, pointDistance(first, second))
          setMapView(zoomViewAtPoint(pinch.startView, pinch.startView.zoom * (nextDistance / pinch.startDistance), pinch.anchor))
        }
      }

      return
    }

    const interaction = interactionRef.current

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return
    }

    if (interaction.type === 'pan') {
      const canvas = canvasRef.current
      const rect = canvas?.getBoundingClientRect()

      if (!canvas || !rect) {
        return
      }

      const deltaX = ((event.clientX - interaction.startClient.x) / rect.width) * canvas.width
      const deltaY = ((event.clientY - interaction.startClient.y) / rect.height) * canvas.height
      setMapView({
        ...interaction.startView,
        panX: interaction.startView.panX + deltaX,
        panY: interaction.startView.panY + deltaY,
      })
      return
    }

    if (interaction.type === 'draw') {
      const mapPoint = mapPointFromEvent(event)

      if (!mapPoint) {
        return
      }

      setAnnotations((current) =>
        current.map((annotation) => {
          if (annotation.id !== interaction.annotationId || annotation.tool !== 'draw') {
            return annotation
          }

          const lastPoint = annotation.points.at(-1)
          if (lastPoint && Math.hypot(lastPoint.x - mapPoint.x, lastPoint.y - mapPoint.y) < 2) {
            return annotation
          }

          return { ...annotation, points: [...annotation.points, mapPoint] }
        }),
      )
    }
  }

  const endCanvasInteraction = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      touchPointersRef.current.delete(event.pointerId)

      if (pinchRef.current?.pointerIds.includes(event.pointerId) || touchPointersRef.current.size < 2) {
        pinchRef.current = undefined
      }
    }

    if (interactionRef.current?.pointerId === event.pointerId) {
      interactionRef.current = undefined
    }
  }

  const selectedRangeFt = selectedAction ? actionRangeFt(selectedAction) : undefined
  const toolHint = {
    mouse: 'Mouse: select tokens; click open map space to plan movement for the selected token',
    move: 'Move map: drag the battlefield to pan',
    draw: 'Pen: drag freely on the map',
    square: `Square: click to place a ${shapeWidthCells} x ${shapeHeightCells} grid shape`,
    circle: `Circle: click to place a ${shapeWidthCells} x ${shapeHeightCells} grid oval`,
    measure: measurement?.to
      ? `Measure: ${gridDistanceFt(measurement.from, measurement.to)} ft DMG 5-10-5 / ${euclideanDistanceFt(measurement.from, measurement.to)} ft ruler`
      : 'Measure tool: click two grid points',
    visibility: showAnnotations ? 'Visibility: map drawings are shown' : 'Visibility: map drawings are hidden',
  } satisfies Record<MapTool, string>

  const measuredDistance =
    selectedCombatant?.intent.destination !== undefined
      ? `${gridDistanceFt(selectedCombatant.position, selectedCombatant.intent.destination)} ft DMG 5-10-5 / ${euclideanDistanceFt(
          selectedCombatant.position,
          selectedCombatant.intent.destination,
        )} ft ruler`
      : `${toolHint[activeMapTool]}${
          selectedAction && selectedRangeFt ? ` · ${selectedAction.name} range ${selectedRangeFt} ft` : ''
        } · each grid is 5 ft`

  return (
    <section className="map-panel">
      <div className="map-toolbar">
        <div>
          <PanelHeading icon={<MapIcon size={18} />} title="Virtual Map" />
          <p>{battleMap.imageName ?? 'Generated tactical board'} · {measuredDistance} · Zoom {Math.round(mapView.zoom * 100)}%</p>
        </div>
        <div className="tool-row">
          <label className="upload-button">
            <Upload size={16} />
            Map image
            <input type="file" accept="image/*" onChange={handleUpload} />
          </label>
          <button type="button" onClick={redetect} aria-busy={isDetectingGrid}>
            <Wand2 size={16} />
            {isDetectingGrid ? 'Detecting...' : 'Detect grid'}
          </button>
          <button
            type="button"
            className={toolsHidden ? '' : 'selected'}
            onClick={() => setToolsHidden((current) => !current)}
            aria-pressed={!toolsHidden}
            aria-label={toolsHidden ? 'Show map tools' : 'Hide map tools'}
            title={toolsHidden ? 'Show map tools' : 'Hide map tools'}
          >
            <Settings size={16} />
            Tools
          </button>
          {gridDetectionStatus ? <span className="grid-detect-status">{gridDetectionStatus}</span> : null}
        </div>
      </div>

      {!toolsHidden ? (
        <div className="map-tool-palette" aria-label="Map tools">
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomMap(1.25)}>
            <ZoomIn size={18} />
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomMap(1 / 1.25)}>
            <ZoomOut size={18} />
          </button>
          <span className="map-zoom-readout" aria-label="Map zoom">
            {Math.round(mapView.zoom * 100)}%
          </span>
          {mapTools.map((tool) => (
            <button
              type="button"
              key={tool.id}
              className={activeMapTool === tool.id ? 'selected' : ''}
              aria-label={tool.label}
              aria-pressed={activeMapTool === tool.id}
              title={tool.label}
              onClick={() => {
                if (tool.id === 'visibility') {
                  setShowAnnotations((current) => !current)
                }

                setActiveMapTool(tool.id)
              }}
            >
              {tool.icon}
            </button>
          ))}
        </div>
      ) : null}
      {!toolsHidden && activeMapTool === 'draw' ? (
          <div className="map-tool-options">
            <label>
              <span>Ink</span>
              <input type="color" value={drawColor} onChange={(event) => setDrawColor(event.target.value)} />
            </label>
          </div>
        ) : null}
      {!toolsHidden && (activeMapTool === 'square' || activeMapTool === 'circle') ? (
          <div className="map-tool-options">
            <label>
              <span>Color</span>
              <input type="color" value={shapeColor} onChange={(event) => setShapeColor(event.target.value)} />
            </label>
            <label>
              <span>W</span>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={shapeWidthCells}
                onChange={(event) => setShapeWidthCells(Math.max(0.5, numberValue(event.target.value)))}
              />
            </label>
            <label>
              <span>H</span>
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={shapeHeightCells}
                onChange={(event) => setShapeHeightCells(Math.max(0.5, numberValue(event.target.value)))}
              />
            </label>
            <label className="map-option-check">
              <input type="checkbox" checked={shapeFitToGrid} onChange={(event) => setShapeFitToGrid(event.target.checked)} />
              <span>Grid</span>
            </label>
          </div>
        ) : null}

      <div ref={mapWindowRef} className={`canvas-wrap${battleMap.imageUrl ? ' has-native-map' : ''}`}>
        <canvas
          ref={canvasRef}
          className={`battle-canvas tool-${activeMapTool}${battleMap.imageUrl ? ' battle-canvas--native-image' : ''}`}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={endCanvasInteraction}
          onPointerCancel={endCanvasInteraction}
          onPointerLeave={endCanvasInteraction}
        />
      </div>

      <div className="grid-controls">
        <CalibrationInput
          label="Cell"
          value={battleMap.calibration.cellSizePx}
          min={16}
          max={160}
          onChange={(value) => updateCalibration({ cellSizePx: value })}
        />
        <CalibrationInput
          label="Origin X"
          value={battleMap.calibration.originX}
          min={-200}
          max={200}
          onChange={(value) => updateCalibration({ originX: value })}
        />
        <CalibrationInput
          label="Origin Y"
          value={battleMap.calibration.originY}
          min={-200}
          max={200}
          onChange={(value) => updateCalibration({ originY: value })}
        />
        <CalibrationInput
          label="Rotate"
          value={battleMap.calibration.rotationDeg}
          min={-15}
          max={15}
          onChange={(value) => updateCalibration({ rotationDeg: value })}
        />
        <CalibrationInput
          label="Opacity"
          value={Math.round(battleMap.calibration.opacity * 100)}
          min={10}
          max={90}
          onChange={(value) => updateCalibration({ opacity: value / 100 })}
        />
        <div className="confidence-meter">
          <span>Auto-fit</span>
          <strong>{Math.round(battleMap.calibration.confidence * 100)}%</strong>
        </div>
      </div>
    </section>
  )
}

function drawGrid(context: CanvasRenderingContext2D, battleMap: BattleMap) {
  const { calibration } = battleMap
  const span = Math.max(battleMap.width, battleMap.height) * 2
  const start = -span
  const end = span

  context.save()
  context.translate(calibration.originX, calibration.originY)
  context.rotate((calibration.rotationDeg * Math.PI) / 180)
  context.strokeStyle = `rgba(238, 233, 216, ${calibration.opacity})`
  context.lineWidth = 1

  for (let x = start; x <= end; x += calibration.cellSizePx) {
    context.beginPath()
    context.moveTo(x, start)
    context.lineTo(x, end)
    context.stroke()
  }

  for (let y = start; y <= end; y += calibration.cellSizePx) {
    context.beginPath()
    context.moveTo(start, y)
    context.lineTo(end, y)
    context.stroke()
  }

  context.restore()
}

function drawGeneratedBattleMap(context: CanvasRenderingContext2D, width: number, height: number) {
  const base = context.createLinearGradient(0, 0, width, height)
  base.addColorStop(0, '#37331f')
  base.addColorStop(0.42, '#262d1e')
  base.addColorStop(0.72, '#3b3122')
  base.addColorStop(1, '#111815')
  context.fillStyle = base
  context.fillRect(0, 0, width, height)

  context.save()
  context.globalAlpha = 0.28
  for (let i = 0; i < 120; i += 1) {
    const x = (i * 67) % width
    const y = (i * 131) % height
    const size = 18 + ((i * 17) % 46)
    context.fillStyle = i % 3 === 0 ? '#5f593d' : i % 3 === 1 ? '#1f2c1f' : '#4a3a25'
    context.beginPath()
    context.ellipse(x, y, size, size * 0.52, ((i * 29) % 180) * (Math.PI / 180), 0, Math.PI * 2)
    context.fill()
  }
  context.restore()

  context.save()
  context.strokeStyle = 'rgba(160, 146, 105, 0.42)'
  context.lineWidth = 18
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(width * 0.09, height * 0.18)
  context.lineTo(width * 0.35, height * 0.1)
  context.lineTo(width * 0.68, height * 0.18)
  context.lineTo(width * 0.86, height * 0.12)
  context.stroke()
  context.beginPath()
  context.moveTo(width * 0.14, height * 0.78)
  context.lineTo(width * 0.38, height * 0.67)
  context.lineTo(width * 0.65, height * 0.78)
  context.lineTo(width * 0.87, height * 0.62)
  context.stroke()
  context.restore()

  context.save()
  context.globalAlpha = 0.5
  for (let i = 0; i < 28; i += 1) {
    const x = (i * 173) % width
    const y = (i * 97) % height
    context.fillStyle = '#756843'
    context.fillRect(x, y, 26 + (i % 4) * 8, 14 + (i % 3) * 6)
    context.strokeStyle = 'rgba(17, 15, 10, 0.45)'
    context.strokeRect(x, y, 26 + (i % 4) * 8, 14 + (i % 3) * 6)
  }
  context.restore()

  const vignette = context.createRadialGradient(width / 2, height / 2, width * 0.18, width / 2, height / 2, width * 0.72)
  vignette.addColorStop(0, 'rgba(255, 226, 145, 0.08)')
  vignette.addColorStop(0.62, 'rgba(0, 0, 0, 0.08)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.56)')
  context.fillStyle = vignette
  context.fillRect(0, 0, width, height)
}

const actionRangeFt = (action: ActionDefinition) => {
  if (action.target === 'self') {
    return undefined
  }

  return action.rangeFt ?? action.reachFt ?? (action.kind === 'attack' || action.kind === 'save' ? 5 : undefined)
}

function drawAnnotations(context: CanvasRenderingContext2D, annotations: MapAnnotation[], calibration: GridCalibration) {
  if (!annotations.length) {
    return
  }

  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  annotations.forEach((annotation) => {
    context.strokeStyle = annotation.color
    context.fillStyle = `${annotation.color}22`

    if (annotation.tool === 'draw') {
      if (annotation.points.length < 2) {
        const point = annotation.points[0]
        context.beginPath()
        context.arc(point.x, point.y, 2.5, 0, Math.PI * 2)
        context.fill()
        return
      }

      context.lineWidth = 3
      context.setLineDash([])
      context.beginPath()
      context.moveTo(annotation.points[0].x, annotation.points[0].y)
      annotation.points.slice(1).forEach((point) => context.lineTo(point.x, point.y))
      context.stroke()
      return
    }

    const width = annotation.widthCells * calibration.cellSizePx
    const height = annotation.heightCells * calibration.cellSizePx

    if (annotation.tool === 'square') {
      context.lineWidth = 2
      context.setLineDash(annotation.fitToGrid ? [] : [7, 5])
      context.strokeRect(annotation.center.x - width / 2, annotation.center.y - height / 2, width, height)
      context.fillRect(annotation.center.x - width / 2, annotation.center.y - height / 2, width, height)
      return
    }

    context.lineWidth = 2
    context.setLineDash(annotation.fitToGrid ? [] : [7, 5])
    context.beginPath()
    context.ellipse(annotation.center.x, annotation.center.y, width / 2, height / 2, 0, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  })
  context.restore()
}

function drawMeasurement(
  context: CanvasRenderingContext2D,
  measurement: { from: GridPoint; to?: GridPoint } | undefined,
  calibration: GridCalibration,
) {
  if (!measurement) {
    return
  }

  const from = gridToPixel(measurement.from, calibration)

  context.save()
  context.strokeStyle = 'rgba(238, 215, 154, 0.88)'
  context.fillStyle = '#f6ecd7'
  context.lineWidth = 2
  context.setLineDash([4, 5])

  if (!measurement.to) {
    context.beginPath()
    context.arc(from.x, from.y, 8, 0, Math.PI * 2)
    context.stroke()
    context.restore()
    return
  }

  const to = gridToPixel(measurement.to, calibration)
  context.beginPath()
  context.moveTo(from.x, from.y)
  context.lineTo(to.x, to.y)
  context.stroke()
  context.setLineDash([])

  const distance = gridDistanceFt(measurement.from, measurement.to)
  const label = `${distance} ft`
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const labelWidth = context.measureText(label).width + 18
  context.fillStyle = 'rgba(8, 9, 7, 0.82)'
  context.strokeStyle = 'rgba(238, 215, 154, 0.72)'
  context.beginPath()
  context.roundRect(midX - labelWidth / 2, midY - 13, labelWidth, 26, 6)
  context.fill()
  context.stroke()
  context.fillStyle = '#f6ecd7'
  context.font = '800 12px Inter, system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(label, midX, midY + 1)
  context.restore()
}

function drawTokens(
  context: CanvasRenderingContext2D,
  combatants: Combatant[],
  selectedCombatantId: string | undefined,
  calibration: GridCalibration,
  selectedAction: ActionDefinition | undefined,
  currentZoom: number,
) {
  const zoom = Math.max(currentZoom, 0.001)
  const screenPx = (value: number) => value / zoom
  const tokenInitials = (name: string) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()

  const selected = combatants.find((combatant) => combatant.id === selectedCombatantId)
  if (selected) {
    const selectedPixel = gridToPixel(selected.position, calibration)
    const selectedRangeFt = selectedAction ? actionRangeFt(selectedAction) : undefined

    if (selectedRangeFt) {
      const rangeRadius = Math.max(calibration.cellSizePx * 0.5, (selectedRangeFt / 5) * calibration.cellSizePx)
      const rangeColor = selected.side === 'Heroes' ? '85, 164, 255' : '255, 102, 82'
      context.save()
      context.beginPath()
      context.arc(selectedPixel.x, selectedPixel.y, rangeRadius, 0, Math.PI * 2)
      context.fillStyle = `rgba(${rangeColor}, 0.1)`
      context.fill()
      context.strokeStyle = `rgba(${rangeColor}, 0.84)`
      context.lineWidth = screenPx(2.5)
      context.setLineDash([screenPx(10), screenPx(7)])
      context.stroke()
      context.setLineDash([])

      const label = `${selectedAction?.name ?? 'Range'} · ${selectedRangeFt} ft`
      context.font = `850 ${screenPx(12)}px Inter, system-ui, sans-serif`
      const labelWidth = Math.min(context.measureText(label).width + screenPx(18), context.canvas.width - screenPx(16))
      const labelHeight = screenPx(26)
      const labelX = Math.min(
        Math.max(selectedPixel.x, labelWidth / 2 + screenPx(8)),
        context.canvas.width - labelWidth / 2 - screenPx(8),
      )
      const labelY = Math.min(
        Math.max(selectedPixel.y - Math.min(rangeRadius, screenPx(92)), screenPx(20)),
        context.canvas.height - screenPx(20),
      )
      context.fillStyle = 'rgba(8, 9, 7, 0.88)'
      context.strokeStyle = `rgba(${rangeColor}, 0.62)`
      context.lineWidth = screenPx(1.2)
      context.beginPath()
      context.roundRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight, screenPx(6))
      context.fill()
      context.stroke()
      context.fillStyle = '#f6ecd7'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(label, labelX, labelY + screenPx(1), labelWidth - screenPx(12))
      context.restore()
    }
  }

  combatants.forEach((combatant) => {
    const pixel = gridToPixel(combatant.position, calibration)
    const defeated = combatant.currentHp <= 0
    const palette =
      combatant.side === 'Heroes'
        ? {
            ring: '#64b5ff',
            outer: '#0a2b57',
            glow: 'rgba(80, 170, 255, 0.78)',
            face: '#ffd6b1',
            body: '#1d5f9b',
            label: '#dff1ff',
          }
        : {
            ring: '#ff6f54',
            outer: '#53160f',
            glow: 'rgba(255, 76, 54, 0.78)',
            face: '#c3c77a',
            body: '#315f26',
            label: '#ffe1d6',
          }
    const tokenScreenRadius = Math.min(34, Math.max(combatant.side === 'Heroes' ? 18 : 20, calibration.cellSizePx * 0.28 * zoom))
    const radius = screenPx(tokenScreenRadius)
    const outerRadius = radius + screenPx(combatant.id === selectedCombatantId ? 5 : 3)
    const ringColor = defeated ? '#8c8779' : palette.ring
    const inner = context.createRadialGradient(
      pixel.x - radius * 0.32,
      pixel.y - radius * 0.4,
      Math.max(1, radius * 0.08),
      pixel.x,
      pixel.y,
      radius,
    )
    inner.addColorStop(0, defeated ? '#c5bba5' : palette.face)
    inner.addColorStop(0.5, defeated ? '#777266' : palette.body)
    inner.addColorStop(1, '#090907')

    context.save()
    context.beginPath()
    context.arc(pixel.x, pixel.y, outerRadius, 0, Math.PI * 2)
    context.shadowColor = defeated ? 'rgba(0, 0, 0, 0.92)' : palette.glow
    context.shadowBlur = screenPx(18)
    context.fillStyle = 'rgba(0, 0, 0, 0.82)'
    context.fill()
    context.shadowBlur = 0

    context.beginPath()
    context.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2)
    context.fillStyle = inner
    context.fill()
    context.lineWidth = screenPx(5)
    context.strokeStyle = '#050504'
    context.stroke()
    context.lineWidth = screenPx(combatant.id === selectedCombatantId ? 4 : 2.5)
    context.strokeStyle = combatant.id === selectedCombatantId ? '#fff2c8' : ringColor
    context.stroke()

    context.beginPath()
    context.arc(pixel.x, pixel.y - radius * 0.24, radius * 0.28, 0, Math.PI * 2)
    context.fillStyle = defeated ? '#9f9886' : palette.face
    context.fill()
    context.fillStyle = defeated ? '#5c5850' : palette.body
    context.fillRect(pixel.x - radius * 0.48, pixel.y + radius * 0.12, radius * 0.96, radius * 0.42)

    const initials = tokenInitials(combatant.name)
    context.font = `950 ${screenPx(11)}px Inter, system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.lineWidth = screenPx(3.5)
    context.strokeStyle = 'rgba(0, 0, 0, 0.9)'
    context.fillStyle = '#fff8e8'
    context.strokeText(initials, pixel.x, pixel.y + screenPx(1))
    context.fillText(initials, pixel.x, pixel.y + screenPx(1))

    context.font = `900 ${screenPx(10)}px Inter, system-ui, sans-serif`
    context.lineWidth = screenPx(3)
    context.strokeStyle = 'rgba(0, 0, 0, 0.92)'
    context.fillStyle = defeated ? '#d1c7b3' : palette.label
    context.strokeText(combatant.name.slice(0, 12), pixel.x, pixel.y + radius + screenPx(11))
    context.fillText(combatant.name.slice(0, 12), pixel.x, pixel.y + radius + screenPx(11))
    context.restore()

    if (combatant.id === selectedCombatantId) {
      context.save()
      context.strokeStyle = '#f2ead8'
      context.lineWidth = screenPx(3)
      context.shadowColor = 'rgba(0, 0, 0, 0.86)'
      context.shadowBlur = screenPx(7)
      const corner = radius + screenPx(10)
      const length = screenPx(12)
      ;[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].forEach(([xSign, ySign]) => {
        const x = pixel.x + xSign * corner
        const y = pixel.y + ySign * corner
        context.beginPath()
        context.moveTo(x, y + ySign * length)
        context.lineTo(x, y)
        context.lineTo(x + xSign * length, y)
        context.stroke()
      })
      context.restore()
    }

    if (combatant.intent.destination) {
      const destination = gridToPixel(combatant.intent.destination, calibration)
      const movementCost = gridDistanceFt(combatant.position, combatant.intent.destination)
      const overSpeed = movementCost > combatant.speedFt
      const overBudgetFt = Math.max(0, movementCost - combatant.speedFt)
      context.beginPath()
      context.moveTo(pixel.x, pixel.y)
      context.lineTo(destination.x, destination.y)
      context.strokeStyle = overSpeed ? '#f0c37b' : combatant.side === 'Heroes' ? '#7db9ff' : '#ff876d'
      context.lineWidth = screenPx(2.5)
      context.setLineDash([screenPx(7), screenPx(6)])
      context.stroke()
      context.setLineDash([])
      const destinationSize = screenPx(38)
      context.strokeRect(destination.x - destinationSize / 2, destination.y - destinationSize / 2, destinationSize, destinationSize)

      const midX = (pixel.x + destination.x) / 2
      const midY = (pixel.y + destination.y) / 2
      context.save()
      context.font = `850 ${screenPx(12)}px Inter, system-ui, sans-serif`
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      const label = overSpeed ? `${movementCost} ft · +${overBudgetFt}` : `${movementCost} ft`
      const labelWidth = context.measureText(label).width + screenPx(18)
      const labelHeight = screenPx(26)
      context.fillStyle = 'rgba(8, 9, 7, 0.84)'
      context.strokeStyle = overSpeed ? 'rgba(240, 195, 123, 0.82)' : 'rgba(246, 236, 215, 0.45)'
      context.lineWidth = screenPx(1)
      context.beginPath()
      context.roundRect(midX - labelWidth / 2, midY - labelHeight / 2, labelWidth, labelHeight, screenPx(6))
      context.fill()
      context.stroke()
      context.fillStyle = overSpeed ? '#f0c37b' : '#f6ecd7'
      context.fillText(label, midX, midY + screenPx(1))
      context.restore()
    }
  })
}

function CalibrationInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="calibration-input">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(numberValue(event.target.value))} />
      <input type="number" value={value} onChange={(event) => onChange(numberValue(event.target.value))} />
    </label>
  )
}

function Roster({
  encounterName,
  combatants,
  selectedId,
  onSelect,
  onRenameEncounter,
}: {
  encounterName: string
  combatants: Combatant[]
  selectedId?: string
  onSelect: (id: string) => void
  onRenameEncounter: () => void
}) {
  const heroCount = combatants.filter((combatant) => combatant.side === 'Heroes').length
  const monsterCount = combatants.filter((combatant) => combatant.side === 'Monsters').length

  return (
    <section className="roster">
      <div className="encounter-card">
        <div className="encounter-title">
          <div>
            <span>Encounter</span>
            <strong>{encounterName}</strong>
          </div>
          <button
            type="button"
            className="icon-button ghost"
            onClick={onRenameEncounter}
            aria-label="Rename encounter"
            title="Rename encounter"
          >
            <MoreVertical size={17} />
          </button>
        </div>
        <div className="team-list">
          <div>
            <span className="team-dot heroes" />
            Heroes ({heroCount})
            <Eye size={15} />
          </div>
          <div>
            <span className="team-dot monsters" />
            Enemies ({monsterCount})
            <Eye size={15} />
          </div>
        </div>
      </div>
      <PanelHeading icon={<Crosshair size={18} />} title="Initiative" />
      <div className="roster-list">
        {combatants.map((combatant) => (
          <button
            type="button"
            className={`roster-row ${selectedId === combatant.id ? 'selected' : ''}`}
            key={combatant.id}
            onClick={() => onSelect(combatant.id)}
          >
            <span className="initiative-score">{combatant.initiative ?? '-'}</span>
            <span className={`token-dot ${combatant.side.toLowerCase()}`} />
            <div>
              <strong>{combatant.name}</strong>
              <p>
                {combatant.side} · Init {combatant.initiative ?? 'not rolled'}
              </p>
            </div>
            <meter value={combatant.currentHp} max={combatant.maxHp} />
            <span className="hp-chip">
              {combatant.currentHp}/{combatant.maxHp}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ActionInspector({
  combatant,
  combatants,
  activeTab,
  onActiveTabChange,
  onUpdateCombatant,
  onUpdateIntent,
  onRemoveCombatant,
}: {
  combatant?: Combatant
  combatants: Combatant[]
  activeTab: InspectorTab
  onActiveTabChange: (tab: InspectorTab) => void
  onUpdateCombatant: (id: string, patch: Partial<Combatant>) => void
  onUpdateIntent: (id: string, patch: Partial<ActionIntent>) => void
  onRemoveCombatant: (id: string) => void
}) {
  const [selectedConditionName, setSelectedConditionName] = useState<string>(srdConditions[0].name)
  const [conditionDuration, setConditionDuration] = useState('')
  const [conditionSource, setConditionSource] = useState('')
  const [customConditionName, setCustomConditionName] = useState('')
  const [customConditionNote, setCustomConditionNote] = useState('')
  const [effectLabel, setEffectLabel] = useState('')
  const [effectDuration, setEffectDuration] = useState('')
  const [effectSource, setEffectSource] = useState('')
  const [effectDescription, setEffectDescription] = useState('')

  if (!combatant) {
    return (
      <section className="inspector empty-state">
        <MousePointer2 size={28} />
        <p>Select or add a combatant to edit actions, movement, strategy, and HP.</p>
      </section>
    )
  }

  const targetOptions = combatants
  const selectedAction = selectedActionFor(combatant)
  const fallbackActionId = selectedAction?.id ?? combatant.actions[0]?.id ?? 'manual'
  const plannedActions: PlannedActionIntent[] = combatant.intent.actionQueue?.length
    ? combatant.intent.actionQueue.map((plannedAction, index) => ({
        id: plannedAction.id ?? `planned-action-${index}`,
        actionId: combatant.actions.some((action) => action.id === plannedAction.actionId)
          ? plannedAction.actionId
          : fallbackActionId,
        targetId: plannedAction.targetId,
      }))
    : [
        {
          id: 'primary-action',
          actionId: fallbackActionId,
          targetId: combatant.intent.targetId,
        },
      ]
  const plannedActionDetails = plannedActions.map(
    (plannedAction) => combatant.actions.find((action) => action.id === plannedAction.actionId) ?? selectedAction,
  )
  const plannedDestination = combatant.intent.destination ?? combatant.position
  const plannedMoveFt = gridDistanceFt(combatant.position, plannedDestination)
  const overMoveBudget = plannedMoveFt > combatant.speedFt
  const overMoveBudgetFt = Math.max(0, plannedMoveFt - combatant.speedFt)
  const conditions = combatant.conditions ?? []
  const activeEffects = combatant.activeEffects ?? []
  const rollAdjustment = (key: RollKey): RollAdjustment => ({
    modifier: combatant.intent.rollAdjustments?.[key]?.modifier ?? 0,
    advantage: combatant.intent.rollAdjustments?.[key]?.advantage ?? false,
    disadvantage: combatant.intent.rollAdjustments?.[key]?.disadvantage ?? false,
  })
  const updateRollAdjustment = (key: RollKey, patch: Partial<RollAdjustment>) => {
    onUpdateIntent(combatant.id, {
      rollAdjustments: {
        ...combatant.intent.rollAdjustments,
        [key]: {
          ...rollAdjustment(key),
          ...patch,
        },
      },
    })
  }
  const proficiencyBonus = combatantProficiencyBonus(combatant)
  const updateRollBonus = (key: RollProfileKey, patch: Partial<RollBonusConfig>) => {
    onUpdateCombatant(combatant.id, {
      rollBonuses: {
        ...combatant.rollBonuses,
        [key]: {
          ...rollBonusConfig(combatant, key),
          ...patch,
        },
      },
    })
  }
  const updateAbilityScore = (ability: Ability, score: number) => {
    onUpdateCombatant(combatant.id, {
      abilityScores: {
        ...combatant.abilityScores,
        [ability]: score,
      },
    })
  }
  const updateSaveProficiency = (ability: Ability, proficient: boolean) => {
    const current = new Set(combatant.saveProficiencies ?? [])
    if (proficient) {
      current.add(ability)
    } else {
      current.delete(ability)
    }

    onUpdateCombatant(combatant.id, {
      saveProficiencies: abilities.filter((candidate) => current.has(candidate)),
    })
  }
  const updateCondition = (id: string, patch: Partial<CombatantCondition>) => {
    onUpdateCombatant(combatant.id, {
      conditions: conditions.map((condition) => (condition.id === id ? { ...condition, ...patch } : condition)),
    })
  }
  const removeCondition = (id: string) => {
    onUpdateCombatant(combatant.id, {
      conditions: conditions.filter((condition) => condition.id !== id),
    })
  }
  const addSrdCondition = () => {
    const template = srdConditions.find((condition) => condition.name === selectedConditionName) ?? srdConditions[0]
    onUpdateCombatant(combatant.id, {
      conditions: [
        ...conditions,
        {
          id: createStatusId('condition'),
          name: template.name,
          durationRounds: optionalNumberValue(conditionDuration),
          source: conditionSource.trim() || undefined,
          note: template.note,
        },
      ],
    })
    setConditionDuration('')
  }
  const addCustomCondition = () => {
    const name = customConditionName.trim()
    if (!name) {
      return
    }

    onUpdateCombatant(combatant.id, {
      conditions: [
        ...conditions,
        {
          id: createStatusId('condition'),
          name,
          durationRounds: optionalNumberValue(conditionDuration),
          source: conditionSource.trim() || undefined,
          note: customConditionNote.trim() || undefined,
        },
      ],
    })
    setCustomConditionName('')
    setCustomConditionNote('')
    setConditionDuration('')
  }
  const updateEffect = (id: string, patch: Partial<ActiveEffect>) => {
    onUpdateCombatant(combatant.id, {
      activeEffects: activeEffects.map((effect) => (effect.id === id ? { ...effect, ...patch } : effect)),
    })
  }
  const removeEffect = (id: string) => {
    onUpdateCombatant(combatant.id, {
      activeEffects: activeEffects.filter((effect) => effect.id !== id),
    })
  }
  const addEffect = (effect: EffectDefinition, source?: string, duration?: number) => {
    onUpdateCombatant(combatant.id, {
      activeEffects: [
        ...activeEffects,
        {
          id: createStatusId('effect'),
          label: effect.label.trim() || 'Custom Effect',
          description: effect.description,
          durationRounds: duration,
          source,
        },
      ],
    })
  }
  const addCustomEffect = () => {
    const label = effectLabel.trim()
    if (!label) {
      return
    }

    addEffect(
      {
        id: createStatusId('effect'),
        label,
        description: effectDescription.trim(),
      },
      effectSource.trim() || undefined,
      optionalNumberValue(effectDuration),
    )
    setEffectLabel('')
    setEffectDescription('')
    setEffectDuration('')
  }
  const updateActionQueue = (nextQueue: PlannedActionIntent[]) => {
    const normalizedQueue = nextQueue.length
      ? nextQueue
      : [{ id: createStatusId('planned-action'), actionId: fallbackActionId, targetId: combatant.intent.targetId }]

    onUpdateIntent(combatant.id, {
      actionId: normalizedQueue[0]?.actionId ?? fallbackActionId,
      targetId: normalizedQueue[0]?.targetId,
      actionQueue: normalizedQueue,
    })
  }
  const addPlannedAction = () => {
    updateActionQueue([
      ...plannedActions,
      {
        id: createStatusId('planned-action'),
        actionId: fallbackActionId,
        targetId: combatant.intent.targetId,
      },
    ])
  }
  const updatePlannedAction = (index: number, patch: Partial<PlannedActionIntent>) => {
    updateActionQueue(
      plannedActions.map((plannedAction, plannedIndex) =>
        plannedIndex === index ? { ...plannedAction, ...patch } : plannedAction,
      ),
    )
  }
  const removePlannedAction = (index: number) => {
    if (plannedActions.length <= 1) {
      return
    }

    updateActionQueue(plannedActions.filter((_, plannedIndex) => plannedIndex !== index))
  }
  const inspectorTabs: Array<{ id: InspectorTab; label: string; count?: number }> = [
    { id: 'actions', label: 'Actions', count: combatant.actions.length },
    { id: 'details', label: 'Details' },
    { id: 'conditions', label: 'Conditions', count: conditions.length },
    { id: 'effects', label: 'Effects', count: activeEffects.length },
  ]
  const renderActionsTab = () => (
    <>
      <div className="action-stack">
        <article className={`action-card move-card ${overMoveBudget ? 'over-budget' : ''}`}>
          <Move size={21} />
          <div>
            <strong>Move</strong>
            <p>
              {plannedMoveFt} / {combatant.speedFt} ft · 5-10-5 diagonal
              {overMoveBudget ? ` · ${overMoveBudgetFt} ft over allowed movement` : ''}
            </p>
          </div>
          <input
            type="number"
            value={combatant.intent.destination?.x ?? combatant.position.x}
            onChange={(event) =>
              onUpdateIntent(combatant.id, {
                destination: {
                  x: numberValue(event.target.value),
                  y: combatant.intent.destination?.y ?? combatant.position.y,
                },
              })
            }
          />
        </article>
        <article className="action-card">
          <Swords size={22} />
          <div>
            <strong>
              {selectedAction?.name ?? 'Manual Ruling'}
              {plannedActions.length > 1 ? ` + ${plannedActions.length - 1} more` : ''}
            </strong>
            <p>
              {selectedAction?.kind ?? 'manual'}
              {typeof selectedAction?.attackBonus === 'number' ? ` · ${signed(selectedAction.attackBonus)} to hit` : ''}
              {typeof selectedAction?.saveDc === 'number' ? ` · DC ${selectedAction.saveDc}` : ''}
              {selectedAction?.effects?.length ? ` · ${selectedAction.effects.length} effects` : ''}
            </p>
          </div>
          <button type="button" className="icon-button ghost" aria-label="Targeting">
            <Target size={18} />
          </button>
        </article>
      </div>

      <Field label="Strategy">
        <select value={combatant.strategy} onChange={(event) => onUpdateCombatant(combatant.id, { strategy: event.target.value as Strategy })}>
          {strategies.map((strategy) => (
            <option key={strategy} value={strategy}>
              {strategy}
            </option>
          ))}
        </select>
      </Field>

      <section className="planned-action-panel">
        <div className="builder-section-title">
          <h3>Planned actions</h3>
          <span>{plannedActions.length} this round</span>
        </div>
        <div className="planned-action-list">
          {plannedActions.map((plannedAction, index) => {
            const action = plannedActionDetails[index]
            return (
              <article key={plannedAction.id} className="planned-action-row">
                <div className="planned-action-index">{index + 1}</div>
                <Field label="Action">
                  <select value={plannedAction.actionId} onChange={(event) => updatePlannedAction(index, { actionId: event.target.value })}>
                    {combatant.actions.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name} · {candidate.kind}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Target">
                  <select value={plannedAction.targetId ?? ''} onChange={(event) => updatePlannedAction(index, { targetId: event.target.value || undefined })}>
                    <option value="">Auto target</option>
                    {targetOptions.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name} · {target.side}
                      </option>
                    ))}
                  </select>
                </Field>
                <button
                  type="button"
                  className="icon-button ghost"
                  aria-label={`Remove action ${index + 1}`}
                  disabled={plannedActions.length <= 1}
                  onClick={() => removePlannedAction(index)}
                >
                  -
                </button>
                <p>
                  {action?.kind ?? 'manual'}
                  {typeof action?.attackBonus === 'number' ? ` · ${signed(action.attackBonus)} to hit` : ''}
                  {typeof action?.saveDc === 'number' ? ` · DC ${action.saveDc}` : ''}
                  {action?.damageDice ? ` · ${action.damageDice}` : ''}
                </p>
              </article>
            )
          })}
        </div>
        <button type="button" className="small-button" onClick={addPlannedAction}>
          <Plus size={16} />
          Add action
        </button>
      </section>

      <section className="roll-adjustment-panel">
        <div className="builder-section-title">
          <h3>Roll adjustments</h3>
          <span>Per-roll modifier and advantage state</span>
        </div>
        {(['attack', 'save', 'damage'] as RollKey[]).map((key) => {
          const adjustment = rollAdjustment(key)
          return (
            <div key={key} className="roll-adjustment-row">
              <strong>{key}</strong>
              <input
                type="number"
                aria-label={`${key} modifier`}
                value={adjustment.modifier}
                onChange={(event) => updateRollAdjustment(key, { modifier: numberValue(event.target.value) })}
              />
              <label>
                <input
                  type="checkbox"
                  checked={adjustment.advantage}
                  onChange={(event) => updateRollAdjustment(key, { advantage: event.target.checked })}
                />
                Adv
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={adjustment.disadvantage}
                  onChange={(event) => updateRollAdjustment(key, { disadvantage: event.target.checked })}
                />
                Dis
              </label>
            </div>
          )
        })}
      </section>

      <div className="form-grid two">
        <Field label="Move X">
          <input
            type="number"
            value={combatant.intent.destination?.x ?? combatant.position.x}
            onChange={(event) =>
              onUpdateIntent(combatant.id, {
                destination: {
                  x: numberValue(event.target.value),
                  y: combatant.intent.destination?.y ?? combatant.position.y,
                },
              })
            }
          />
        </Field>
        <Field label="Move Y">
          <input
            type="number"
            value={combatant.intent.destination?.y ?? combatant.position.y}
            onChange={(event) =>
              onUpdateIntent(combatant.id, {
                destination: {
                  x: combatant.intent.destination?.x ?? combatant.position.x,
                  y: numberValue(event.target.value),
                },
              })
            }
          />
        </Field>
      </div>

      <div className="check-row">
        <label>
          <input
            type="checkbox"
            checked={combatant.intent.advantage}
            onChange={(event) => onUpdateIntent(combatant.id, { advantage: event.target.checked })}
          />
          Advantage
        </label>
        <label>
          <input
            type="checkbox"
            checked={combatant.intent.disadvantage}
            onChange={(event) => onUpdateIntent(combatant.id, { disadvantage: event.target.checked })}
          />
          Disadvantage
        </label>
      </div>

      <Field label="Manual note">
        <textarea
          value={combatant.intent.manualNote ?? ''}
          onChange={(event) => onUpdateIntent(combatant.id, { manualNote: event.target.value })}
        />
      </Field>
    </>
  )
  const renderRollProfileRow = (
    label: string,
    key: RollProfileKey,
    base: number,
    options: { proficiency?: boolean; abilityLabel?: string } = {},
  ) => {
    const config = rollBonusConfig(combatant, key)
    const total = base + rollBonusTotal(combatant, key)
    const allowProficiency = options.proficiency ?? true

    return (
      <div className="sheet-roll-row">
        <strong>{label}</strong>
        <span>{options.abilityLabel ?? 'Base'}</span>
        <span>{signed(base)}</span>
        <label>
          <input
            type="checkbox"
            checked={config.proficient}
            disabled={!allowProficiency}
            onChange={(event) => updateRollBonus(key, { proficient: event.target.checked })}
          />
          Prof
        </label>
        <input
          type="number"
          aria-label={`${label} bonus`}
          value={config.bonus}
          onChange={(event) => updateRollBonus(key, { bonus: numberValue(event.target.value) })}
        />
        <em>{signed(total)}</em>
      </div>
    )
  }
  const renderSaveRow = (ability: Ability) => {
    const key = `${ability}Save` as RollProfileKey
    const config = rollBonusConfig(combatant, key)
    const base = abilityModifier(combatant.abilityScores[ability])
    const proficient = combatant.saveProficiencies?.includes(ability) ?? false
    const total = base + (proficient ? proficiencyBonus : 0) + config.bonus

    return (
      <div key={ability} className="sheet-roll-row">
        <strong>{ability.toUpperCase()} save</strong>
        <span>{combatant.abilityScores[ability]}</span>
        <span>{signed(base)}</span>
        <label>
          <input
            type="checkbox"
            checked={proficient}
            onChange={(event) => updateSaveProficiency(ability, event.target.checked)}
          />
          Prof
        </label>
        <input
          type="number"
          aria-label={`${ability.toUpperCase()} save bonus`}
          value={config.bonus}
          onChange={(event) => updateRollBonus(key, { bonus: numberValue(event.target.value) })}
        />
        <em>{signed(total)}</em>
      </div>
    )
  }
  const renderCheckRow = (ability: Ability) => {
    const key = `${ability}Check` as RollProfileKey
    const config = rollBonusConfig(combatant, key)
    const base = abilityModifier(combatant.abilityScores[ability])
    const total = base + rollBonusTotal(combatant, key)

    return (
      <div key={ability} className="sheet-roll-row">
        <strong>{ability.toUpperCase()} check</strong>
        <span>{combatant.abilityScores[ability]}</span>
        <span>{signed(base)}</span>
        <label>
          <input
            type="checkbox"
            checked={config.proficient}
            onChange={(event) => updateRollBonus(key, { proficient: event.target.checked })}
          />
          Prof
        </label>
        <input
          type="number"
          aria-label={`${ability.toUpperCase()} check bonus`}
          value={config.bonus}
          onChange={(event) => updateRollBonus(key, { bonus: numberValue(event.target.value) })}
        />
        <em>{signed(total)}</em>
      </div>
    )
  }
  const renderDetailsTab = () => (
    <>
      <section className="builder-section character-sheet-section">
        <div className="builder-section-title">
          <h3>Character sheet</h3>
          <span>Manual combat stats and roll math</span>
        </div>
        <div className="form-grid two">
          <Field label="Name">
            <input value={combatant.name} onChange={(event) => onUpdateCombatant(combatant.id, { name: event.target.value })} />
          </Field>
          <Field label="Side">
            <select value={combatant.side} onChange={(event) => onUpdateCombatant(combatant.id, { side: event.target.value as Side })}>
              <option value="Heroes">Heroes</option>
              <option value="Monsters">Monsters</option>
            </select>
          </Field>
          <Field label="Level">
            <input
              type="number"
              min={1}
              max={20}
              value={combatant.level ?? 1}
              onChange={(event) => onUpdateCombatant(combatant.id, { level: Math.min(20, Math.max(1, numberValue(event.target.value))) })}
            />
          </Field>
          <Field label="Proficiency bonus">
            <input
              type="number"
              value={proficiencyBonus}
              onChange={(event) => onUpdateCombatant(combatant.id, { proficiencyBonus: numberValue(event.target.value) })}
            />
          </Field>
        </div>
      </section>

      <div className="form-grid two">
        <Field label="HP">
          <input
            type="number"
            value={combatant.currentHp}
            onChange={(event) => onUpdateCombatant(combatant.id, { currentHp: numberValue(event.target.value) })}
          />
        </Field>
        <Field label="Max HP">
          <input
            type="number"
            value={combatant.maxHp}
            onChange={(event) => onUpdateCombatant(combatant.id, { maxHp: numberValue(event.target.value) })}
          />
        </Field>
        <Field label="AC">
          <input
            type="number"
            value={combatant.armorClass}
            onChange={(event) => onUpdateCombatant(combatant.id, { armorClass: numberValue(event.target.value) })}
          />
        </Field>
        <Field label="Speed">
          <input
            type="number"
            value={combatant.speedFt}
            onChange={(event) => onUpdateCombatant(combatant.id, { speedFt: numberValue(event.target.value) })}
          />
        </Field>
        <Field label="Initiative base">
          <input
            type="number"
            value={combatant.initiativeBonus}
            onChange={(event) => onUpdateCombatant(combatant.id, { initiativeBonus: numberValue(event.target.value) })}
          />
        </Field>
      </div>

      <section className="builder-section">
        <div className="builder-section-title">
          <h3>Ability scores</h3>
          <span>Editable SRD abilities</span>
        </div>
        <div className="stat-chip-grid">
          {abilities.map((ability) => (
            <div key={ability}>
              <span>{ability.toUpperCase()}</span>
              <input
                type="number"
                min={1}
                max={30}
                aria-label={`${ability.toUpperCase()} score`}
                value={combatant.abilityScores[ability]}
                onChange={(event) => updateAbilityScore(ability, numberValue(event.target.value))}
              />
              <small>{signed(abilityModifier(combatant.abilityScores[ability]))}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="builder-section character-sheet-section">
        <div className="builder-section-title">
          <h3>Roll bonuses</h3>
          <span>Prof adds {signed(proficiencyBonus)} when checked; bonus is extra manual math</span>
        </div>
        <div className="sheet-roll-table">
          <div className="sheet-roll-header">
            <span>Roll</span>
            <span>Score</span>
            <span>Base</span>
            <span>Prof</span>
            <span>Bonus</span>
            <span>Total</span>
          </div>
          {renderRollProfileRow('Attack rolls', 'attack', selectedAction?.attackBonus ?? 0, {
            abilityLabel: selectedAction?.name ?? 'Action',
          })}
          {renderRollProfileRow('Damage rolls', 'damage', 0, { abilityLabel: 'Global' })}
          {renderRollProfileRow('Initiative', 'initiative', combatant.initiativeBonus, { abilityLabel: 'Manual' })}
          {renderRollProfileRow('Save DC', 'saveDc', selectedAction?.saveDc ?? 0, {
            abilityLabel: selectedAction?.kind === 'save' ? selectedAction.name : 'Action',
          })}
        </div>
      </section>

      <section className="builder-section character-sheet-section">
        <div className="builder-section-title">
          <h3>Saving throws</h3>
          <span>Used by spell and feature save resolution</span>
        </div>
        <div className="sheet-roll-table">
          <div className="sheet-roll-header">
            <span>Save</span>
            <span>Score</span>
            <span>Mod</span>
            <span>Prof</span>
            <span>Bonus</span>
            <span>Total</span>
          </div>
          {abilities.map(renderSaveRow)}
        </div>
      </section>

      <section className="builder-section character-sheet-section">
        <div className="builder-section-title">
          <h3>Ability checks</h3>
          <span>Stored for manual rulings and future automated checks</span>
        </div>
        <div className="sheet-roll-table">
          <div className="sheet-roll-header">
            <span>Check</span>
            <span>Score</span>
            <span>Mod</span>
            <span>Prof</span>
            <span>Bonus</span>
            <span>Total</span>
          </div>
          {abilities.map(renderCheckRow)}
        </div>
      </section>

      <section className="builder-section">
        <div className="builder-section-title">
          <h3>Traits</h3>
          <span>Defenses and source data</span>
        </div>
        <div className="trait-summary-grid">
          <div>
            <span>Saves</span>
            <strong>{combatant.saveProficiencies?.map((ability) => ability.toUpperCase()).join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>Source</span>
            <strong>{combatant.source.book ?? combatant.source.kind}</strong>
          </div>
          <div>
            <span>Resist</span>
            <strong>{combatant.resistances?.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>Immune</span>
            <strong>{combatant.immunities?.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>Vulnerable</span>
            <strong>{combatant.vulnerabilities?.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>Resources</span>
            <strong>{combatant.resources.length ? combatant.resources.map((resource) => `${resource.label} ${resource.current}/${resource.max}`).join(', ') : 'none'}</strong>
          </div>
        </div>
      </section>
    </>
  )
  const renderConditionCard = (condition: CombatantCondition) => (
    <article key={condition.id} className="status-card condition-card">
      <div className="status-card-title">
        <strong>{condition.name}</strong>
        <button type="button" className="small-button danger" onClick={() => removeCondition(condition.id)}>
          Remove
        </button>
      </div>
      <div className="form-grid two compact">
        <Field label="Rounds left">
          <input
            type="number"
            value={condition.durationRounds ?? ''}
            placeholder="until cleared"
            onChange={(event) => updateCondition(condition.id, { durationRounds: optionalNumberValue(event.target.value) })}
          />
        </Field>
        <Field label="Source">
          <input value={condition.source ?? ''} onChange={(event) => updateCondition(condition.id, { source: event.target.value || undefined })} />
        </Field>
      </div>
      <Field label="Rules / note">
        <textarea value={condition.note ?? ''} onChange={(event) => updateCondition(condition.id, { note: event.target.value })} />
      </Field>
    </article>
  )
  const renderConditionsTab = () => (
    <section className="status-editor-panel">
      <div className="builder-section-title">
        <h3>Active conditions</h3>
        <span>{conditions.length ? `${conditions.length} on ${combatant.name}` : 'none applied'}</span>
      </div>
      <div className="status-card-list">
        {conditions.length ? conditions.map(renderConditionCard) : <p className="muted-copy">No conditions are currently applied.</p>}
      </div>

      <div className="status-add-panel">
        <div className="builder-section-title">
          <h3>Add SRD condition</h3>
          <span>Uses the SRD condition text as the default note</span>
        </div>
        <div className="form-grid two">
          <Field label="Condition">
            <select value={selectedConditionName} onChange={(event) => setSelectedConditionName(event.target.value)}>
              {srdConditions.map((condition) => (
                <option key={condition.name} value={condition.name}>
                  {condition.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Duration rounds">
            <input value={conditionDuration} placeholder="blank = until cleared" onChange={(event) => setConditionDuration(event.target.value)} />
          </Field>
          <Field label="Source">
            <input value={conditionSource} placeholder="spell, action, ruling" onChange={(event) => setConditionSource(event.target.value)} />
          </Field>
        </div>
        <button type="button" className="primary full-width" onClick={addSrdCondition}>
          <Plus size={16} />
          Add SRD condition
        </button>
      </div>

      <div className="status-add-panel">
        <div className="builder-section-title">
          <h3>Add custom condition</h3>
          <span>Homebrew and third-party status entries work the same way</span>
        </div>
        <Field label="Name">
          <input value={customConditionName} onChange={(event) => setCustomConditionName(event.target.value)} />
        </Field>
        <Field label="Rules / note">
          <textarea value={customConditionNote} onChange={(event) => setCustomConditionNote(event.target.value)} />
        </Field>
        <button type="button" className="primary full-width" onClick={addCustomCondition}>
          <Plus size={16} />
          Add custom condition
        </button>
      </div>
    </section>
  )
  const renderEffectCard = (effect: ActiveEffect) => (
    <article key={effect.id} className="status-card effect-card">
      <div className="status-card-title">
        <strong>{effect.label}</strong>
        <button type="button" className="small-button danger" onClick={() => removeEffect(effect.id)}>
          Remove
        </button>
      </div>
      <div className="form-grid two compact">
        <Field label="Rounds left">
          <input
            type="number"
            value={effect.durationRounds ?? ''}
            placeholder="until cleared"
            onChange={(event) => updateEffect(effect.id, { durationRounds: optionalNumberValue(event.target.value) })}
          />
        </Field>
        <Field label="Source">
          <input value={effect.source ?? ''} onChange={(event) => updateEffect(effect.id, { source: event.target.value || undefined })} />
        </Field>
      </div>
      <Field label="Effect">
        <textarea value={effect.description} onChange={(event) => updateEffect(effect.id, { description: event.target.value })} />
      </Field>
    </article>
  )
  const renderEffectsTab = () => (
    <section className="status-editor-panel">
      <div className="builder-section-title">
        <h3>Active effects</h3>
        <span>{activeEffects.length ? `${activeEffects.length} on ${combatant.name}` : 'none applied'}</span>
      </div>
      <div className="status-card-list">
        {activeEffects.length ? activeEffects.map(renderEffectCard) : <p className="muted-copy">No ongoing effects are currently applied.</p>}
      </div>

      {selectedAction?.effects?.length ? (
        <div className="status-add-panel">
          <div className="builder-section-title">
            <h3>Action effects</h3>
            <span>These can also be applied by round resolution when the action lands</span>
          </div>
          <div className="status-effect-options">
            {selectedAction.effects.map((effect) => (
              <button
                key={effect.id}
                type="button"
                onClick={() => addEffect(effect, `${combatant.name}: ${selectedAction.name}`)}
              >
                <strong>{effect.label}</strong>
                <small>{effect.description}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="status-add-panel">
        <div className="builder-section-title">
          <h3>Add custom effect</h3>
          <span>Temporary bonuses, auras, marks, and custom feature tracking</span>
        </div>
        <div className="form-grid two">
          <Field label="Label">
            <input value={effectLabel} onChange={(event) => setEffectLabel(event.target.value)} />
          </Field>
          <Field label="Duration rounds">
            <input value={effectDuration} placeholder="blank = until cleared" onChange={(event) => setEffectDuration(event.target.value)} />
          </Field>
          <Field label="Source">
            <input value={effectSource} placeholder="spell, aura, item" onChange={(event) => setEffectSource(event.target.value)} />
          </Field>
        </div>
        <Field label="Effect text">
          <textarea value={effectDescription} onChange={(event) => setEffectDescription(event.target.value)} />
        </Field>
        <button type="button" className="primary full-width" onClick={addCustomEffect}>
          <Plus size={16} />
          Add custom effect
        </button>
      </div>
    </section>
  )

  return (
    <section className="inspector">
      <div className="inspector-topline">
        <PanelHeading icon={<MousePointer2 size={18} />} title="Turn Intent" />
        <button type="button" className="icon-button ghost" aria-label="Inspector settings">
          <Settings size={17} />
        </button>
      </div>
      <div className="selected-card">
        <div className={`portrait-token ${combatant.side.toLowerCase()}`}>{combatant.name.slice(0, 2).toUpperCase()}</div>
        <div>
          <span className={sourceClass(combatant.source.kind)}>{combatant.source.kind}</span>
          <h2>{combatant.name}</h2>
          <p>
            {combatant.side} · AC {combatant.armorClass} · Speed {combatant.speedFt} ft
          </p>
        </div>
      </div>

      <div className="vital-strip">
        <div>
          <span>HP</span>
          <strong>
            {combatant.currentHp} / {combatant.maxHp}
          </strong>
          <meter value={combatant.currentHp} max={combatant.maxHp} />
        </div>
        <div className="armor-badge">
          <Shield size={18} />
          <span>AC</span>
          <strong>{combatant.armorClass}</strong>
        </div>
        <div className="armor-badge">
          <Gauge size={18} />
          <span>Init</span>
          <strong>{signed(combatant.initiativeBonus)}</strong>
        </div>
      </div>

      <div className="inspector-tabs" aria-label="Inspector sections">
        {inspectorTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'active' : ''}
            onClick={() => onActiveTabChange(tab.id)}
          >
            <span>{tab.label}</span>
            {typeof tab.count === 'number' ? <small>{tab.count}</small> : null}
          </button>
        ))}
      </div>

      <div className="inspector-tab-panel">
        {activeTab === 'actions' ? renderActionsTab() : null}
        {activeTab === 'details' ? renderDetailsTab() : null}
        {activeTab === 'conditions' ? renderConditionsTab() : null}
        {activeTab === 'effects' ? renderEffectsTab() : null}
      </div>

      <button type="button" className="danger full-width" onClick={() => onRemoveCombatant(combatant.id)}>
        Remove combatant
      </button>
    </section>
  )
}

function CombatLog({ entries }: { entries: BattleState['log'] }) {
  return (
    <section className="combat-log">
      <PanelHeading icon={<ChevronDown size={18} />} title="Combat Log" />
      <div className="log-list">
        {entries.map((entry) => (
          <article key={entry.id} className={`log-entry ${entry.tone}`}>
            <span>R{entry.round}</span>
            <div>
              <strong>{entry.actor ?? entry.tone}</strong>
              <p>{entry.message}</p>
              {entry.detail ? <small>{entry.detail}</small> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function PanelHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-heading">
      {icon}
      <h2>{title}</h2>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export default App
