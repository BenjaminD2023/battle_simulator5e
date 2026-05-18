export type SourceKind = 'SRD' | 'Custom' | 'Third-party' | 'Imported' | 'Draft'

export type ContentKind = 'monster' | 'player'

export type Side = 'Heroes' | 'Monsters'

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

export type ActionKind = 'attack' | 'save' | 'heal' | 'manual'

export type RollKey = 'attack' | 'save' | 'damage'

export type RollAdjustment = {
  modifier: number
  advantage: boolean
  disadvantage: boolean
}

export type RollProfileKey =
  | 'attack'
  | 'damage'
  | 'initiative'
  | 'saveDc'
  | `${Ability}Save`
  | `${Ability}Check`

export type RollBonusConfig = {
  proficient: boolean
  bonus: number
}

export type Strategy =
  | 'manual'
  | 'nearest'
  | 'focusWeak'
  | 'holdLine'
  | 'protectAllies'

export type GridPoint = {
  x: number
  y: number
}

export type SourceMetadata = {
  kind: SourceKind
  book?: string
  apiIndex?: string
  apiUrl?: string
  attribution?: string
}

export type EffectDefinition = {
  id: string
  label: string
  description: string
}

export type CombatantCondition = {
  id: string
  name: string
  durationRounds?: number
  source?: string
  note?: string
}

export type ActiveEffect = {
  id: string
  label: string
  description: string
  durationRounds?: number
  source?: string
}

export type ResourceDefinition = {
  id: string
  label: string
  max: number
  current: number
  recovery: 'round' | 'shortRest' | 'longRest' | 'manual'
}

export type ActionDefinition = {
  id: string
  name: string
  kind: ActionKind
  attackBonus?: number
  damageDice?: string
  damageType?: string
  healingDice?: string
  rangeFt?: number
  reachFt?: number
  saveDc?: number
  saveAbility?: Ability
  damageOnSave?: 'none' | 'half'
  target: 'enemy' | 'ally' | 'self' | 'area' | 'manual'
  tags: string[]
  description?: string
  effects?: EffectDefinition[]
}

export type ContentEntry = {
  id: string
  name: string
  kind: ContentKind
  source: SourceMetadata
  armorClass: number
  maxHp: number
  speedFt: number
  initiativeBonus: number
  level?: number
  proficiencyBonus?: number
  challenge?: string
  size?: string
  type?: string
  abilityScores: Record<Ability, number>
  saveProficiencies?: Ability[]
  resistances?: string[]
  immunities?: string[]
  vulnerabilities?: string[]
  traits: string[]
  resources: ResourceDefinition[]
  actions: ActionDefinition[]
  rollBonuses?: Partial<Record<RollProfileKey, RollBonusConfig>>
  notes?: string
}

export type PlannedActionIntent = {
  id: string
  actionId: string
  targetId?: string
}

export type ActionIntent = {
  actionId: string
  actionQueue?: PlannedActionIntent[]
  targetId?: string
  destination?: GridPoint
  advantage: boolean
  disadvantage: boolean
  rollAdjustments?: Partial<Record<RollKey, RollAdjustment>>
  manualNote?: string
}

export type Combatant = {
  id: string
  contentId: string
  name: string
  side: Side
  source: SourceMetadata
  armorClass: number
  maxHp: number
  currentHp: number
  speedFt: number
  initiativeBonus: number
  level?: number
  proficiencyBonus?: number
  abilityScores: Record<Ability, number>
  saveProficiencies?: Ability[]
  resistances?: string[]
  immunities?: string[]
  vulnerabilities?: string[]
  initiative?: number
  position: GridPoint
  conditions: CombatantCondition[]
  activeEffects: ActiveEffect[]
  resources: ResourceDefinition[]
  actions: ActionDefinition[]
  rollBonuses: Partial<Record<RollProfileKey, RollBonusConfig>>
  strategy: Strategy
  intent: ActionIntent
}

export type LogEntry = {
  id: string
  round: number
  actor?: string
  message: string
  detail?: string
  tone: 'info' | 'roll' | 'hit' | 'miss' | 'damage' | 'heal' | 'system'
}

export type BattleStatus = 'setup' | 'active'

export type BattleState = {
  round: number
  seed: string
  status: BattleStatus
  selectedCombatantId?: string
  combatants: Combatant[]
  log: LogEntry[]
}

export type GridCalibration = {
  cellSizePx: number
  originX: number
  originY: number
  rotationDeg: number
  opacity: number
  confidence: number
  detected: boolean
}

export type BattleMap = {
  imageUrl?: string
  imageName?: string
  width: number
  height: number
  calibration: GridCalibration
}

export type DiceRoll = {
  expression: string
  total: number
  rolls: Array<{
    sides: number
    value: number
  }>
  modifier: number
  detail: string
}
