import type { DiceRoll } from '../types'

const cleanExpression = (expression: string) =>
  expression.toLowerCase().replace(/\s/g, '').replace(/-/g, '+-')

export const createRng = (seed: string) => {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }

  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

export const abilityModifier = (score: number) => Math.floor((score - 10) / 2)

export const rollDie = (sides: number, rng: () => number) =>
  Math.floor(rng() * sides) + 1

export const rollExpression = (expression: string, rng: () => number): DiceRoll => {
  const normalized = cleanExpression(expression)
  const terms = normalized.split('+').filter(Boolean)
  const rolls: DiceRoll['rolls'] = []
  let modifier = 0
  let total = 0

  for (const term of terms) {
    const diceMatch = term.match(/^(-?\d*)d(\d+)$/)

    if (diceMatch) {
      const rawCount = diceMatch[1]
      const count =
        rawCount === '' || rawCount === undefined
          ? 1
          : rawCount === '-'
            ? -1
            : Number(rawCount)
      const sides = Number(diceMatch[2])
      const direction = count < 0 ? -1 : 1

      for (let i = 0; i < Math.abs(count); i += 1) {
        const value = rollDie(sides, rng)
        rolls.push({ sides, value: value * direction })
        total += value * direction
      }
      continue
    }

    const value = Number(term)
    if (!Number.isNaN(value)) {
      modifier += value
      total += value
    }
  }

  const diceText = rolls.map((roll) => `d${roll.sides}:${roll.value}`).join(', ')
  const modifierText = modifier === 0 ? '' : `${modifier > 0 ? '+' : ''}${modifier}`

  return {
    expression,
    total,
    rolls,
    modifier,
    detail: `${diceText}${diceText && modifierText ? ' ' : ''}${modifierText}`.trim(),
  }
}

export const rollDamageExpression = (
  expression: string,
  rng: () => number,
  critical = false,
): DiceRoll => {
  const normalized = cleanExpression(expression)
  const terms = normalized.split('+').filter(Boolean)
  const rolls: DiceRoll['rolls'] = []
  let modifier = 0
  let total = 0

  for (const term of terms) {
    const diceMatch = term.match(/^(-?\d*)d(\d+)$/)

    if (diceMatch) {
      const rawCount = diceMatch[1]
      const count =
        rawCount === '' || rawCount === undefined
          ? 1
          : rawCount === '-'
            ? -1
            : Number(rawCount)
      const sides = Number(diceMatch[2])
      const direction = count < 0 ? -1 : 1
      const diceCount = Math.abs(count) * (critical ? 2 : 1)

      for (let i = 0; i < diceCount; i += 1) {
        const value = rollDie(sides, rng)
        rolls.push({ sides, value: value * direction })
        total += value * direction
      }
      continue
    }

    const value = Number(term)
    if (!Number.isNaN(value)) {
      modifier += value
      total += value
    }
  }

  const diceText = rolls.map((roll) => `d${roll.sides}:${roll.value}`).join(', ')
  const modifierText = modifier === 0 ? '' : `${modifier > 0 ? '+' : ''}${modifier}`

  return {
    expression: critical ? `${expression} crit` : expression,
    total,
    rolls,
    modifier,
    detail: `${diceText}${diceText && modifierText ? ' ' : ''}${modifierText}`.trim(),
  }
}

export const rollD20 = (
  rng: () => number,
  mode: 'normal' | 'advantage' | 'disadvantage' = 'normal',
) => {
  const first = rollDie(20, rng)
  const second = mode === 'normal' ? undefined : rollDie(20, rng)
  const value =
    second === undefined
      ? first
      : mode === 'advantage'
        ? Math.max(first, second)
        : Math.min(first, second)

  return {
    value,
    rolls: second === undefined ? [first] : [first, second],
    mode,
  }
}
