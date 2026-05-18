import type { BattleMap, GridCalibration, GridPoint } from '../types'

export const defaultCalibration: GridCalibration = {
  cellSizePx: 56,
  originX: 0,
  originY: 0,
  rotationDeg: 0,
  opacity: 0.45,
  confidence: 0,
  detected: false,
}

export const defaultMap: BattleMap = {
  width: 920,
  height: 620,
  calibration: defaultCalibration,
}

const samePoint = (a: GridPoint, b: GridPoint) => a.x === b.x && a.y === b.y

const directLineCandidates = (from: GridPoint, to: GridPoint) => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  const candidates: GridPoint[] = []
  let previous = from

  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps
    const candidate = {
      x: Math.round(from.x + dx * progress),
      y: Math.round(from.y + dy * progress),
    }

    if (!samePoint(candidate, previous)) {
      candidates.push(candidate)
      previous = candidate
    }
  }

  return candidates
}

export const gridDistanceFt = (from: GridPoint, to: GridPoint) => {
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  const diagonals = Math.min(dx, dy)
  const straight = Math.max(dx, dy) - diagonals
  const diagonalPairs = Math.floor(diagonals / 2)
  const oddDiagonal = diagonals % 2

  return straight * 5 + diagonalPairs * 15 + oddDiagonal * 5
}

export const euclideanDistanceFt = (from: GridPoint, to: GridPoint) => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.round(Math.sqrt(dx * dx + dy * dy) * 5)
}

export const clampMove = (from: GridPoint, to: GridPoint, speedFt: number): GridPoint => {
  if (speedFt <= 0 || samePoint(from, to)) {
    return from
  }

  if (gridDistanceFt(from, to) <= speedFt) {
    return to
  }

  let legalDestination = from

  for (const candidate of directLineCandidates(from, to)) {
    if (gridDistanceFt(from, candidate) > speedFt) {
      break
    }

    legalDestination = candidate
  }

  return legalDestination
}

export const stepToward = (from: GridPoint, to: GridPoint, speedFt: number, stopWithinFt = 5) => {
  if (speedFt <= 0 || samePoint(from, to) || gridDistanceFt(from, to) <= stopWithinFt) {
    return from
  }

  let farthestLegal = from

  for (const candidate of directLineCandidates(from, to)) {
    const movementCost = gridDistanceFt(from, candidate)

    if (movementCost > speedFt) {
      break
    }

    farthestLegal = candidate

    if (stopWithinFt > 0 && gridDistanceFt(candidate, to) <= stopWithinFt) {
      return candidate
    }
  }

  return farthestLegal
}

export const gridToPixel = (point: GridPoint, calibration: GridCalibration) => {
  const radians = (calibration.rotationDeg * Math.PI) / 180
  const rawX = calibration.originX + point.x * calibration.cellSizePx + calibration.cellSizePx / 2
  const rawY = calibration.originY + point.y * calibration.cellSizePx + calibration.cellSizePx / 2

  if (calibration.rotationDeg === 0) {
    return { x: rawX, y: rawY }
  }

  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const x = calibration.originX + (rawX - calibration.originX) * cos - (rawY - calibration.originY) * sin
  const y = calibration.originY + (rawX - calibration.originX) * sin + (rawY - calibration.originY) * cos

  return { x, y }
}

export const pixelToGrid = (pixel: { x: number; y: number }, calibration: GridCalibration) => {
  const radians = (-calibration.rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const unrotatedX =
    calibration.originX +
    (pixel.x - calibration.originX) * cos -
    (pixel.y - calibration.originY) * sin
  const unrotatedY =
    calibration.originY +
    (pixel.x - calibration.originX) * sin +
    (pixel.y - calibration.originY) * cos

  return {
    x: Math.max(0, Math.floor((unrotatedX - calibration.originX) / calibration.cellSizePx)),
    y: Math.max(0, Math.floor((unrotatedY - calibration.originY) / calibration.cellSizePx)),
  }
}

const smooth = (values: number[], radius = 2) =>
  values.map((_, index) => {
    let total = 0
    let count = 0

    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = values[index + offset]
      if (typeof value === 'number') {
        total += value
        count += 1
      }
    }

    return total / count
  })

const estimateSpacing = (peaks: number[], minSpacing: number, maxSpacing: number) => {
  const buckets = new Map<number, number>()

  for (let i = 0; i < peaks.length; i += 1) {
    for (let j = i + 1; j < peaks.length; j += 1) {
      const distance = peaks[j] - peaks[i]
      if (distance < minSpacing || distance > maxSpacing) {
        continue
      }

      const bucket = Math.round(distance)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
    }
  }

  const [spacing = 0, votes = 0] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
  return { spacing, votes }
}

const meanAndDeviation = (values: number[]) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length

  return {
    mean,
    deviation: Math.sqrt(variance),
  }
}

const findPeaks = (values: number[]) => {
  const { mean, deviation } = meanAndDeviation(values)
  const threshold = mean + deviation * 0.58
  const peaks: number[] = []
  let lastPeak = -999

  values.forEach((value, index) => {
    if (value > threshold && value >= (values[index - 1] ?? 0) && value >= (values[index + 1] ?? 0)) {
      if (index - lastPeak > 4) {
        peaks.push(index)
        lastPeak = index
      } else if (value > values[lastPeak]) {
        peaks[peaks.length - 1] = index
        lastPeak = index
      }
    }
  })

  return peaks
}

const percentile = (values: number[], ratio: number) => {
  if (!values.length) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]
}

const foldProfile = (values: number[], spacing: number) => {
  const buckets = new Array(spacing).fill(0)
  const counts = new Array(spacing).fill(0)

  values.forEach((value, index) => {
    const phase = index % spacing
    buckets[phase] += value
    counts[phase] += 1
  })

  return buckets.map((total, index) => (counts[index] ? total / counts[index] : 0))
}

const foldOriginalProfile = (values: number[], cellSize: number, scale: number) => {
  const buckets = new Array(cellSize).fill(0)
  const counts = new Array(cellSize).fill(0)

  values.forEach((value, index) => {
    const phase = Math.round(index / scale) % cellSize
    buckets[phase] += value
    counts[phase] += 1
  })

  return buckets.map((total, index) => (counts[index] ? total / counts[index] : 0))
}

const moduloOrigin = (origin: number, cellSize: number) => {
  const remainder = Math.round(origin) % cellSize
  return remainder < 0 ? remainder + cellSize : remainder
}

const estimatePeriodicSpacing = (values: number[], minSpacing: number, maxSpacing: number) => {
  const { mean, deviation } = meanAndDeviation(values)
  const normalized = deviation > 0 ? values.map((value) => (value - mean) / deviation) : values.map(() => 0)
  const candidates: Array<{ spacing: number; origin: number; score: number }> = []
  let strongestCandidate = {
    spacing: 0,
    origin: 0,
    score: 0,
  }

  for (let spacing = minSpacing; spacing <= maxSpacing; spacing += 1) {
    const folded = foldProfile(normalized, spacing)
    const strongest = Math.max(...folded)
    const baseline = percentile(folded, 0.72)
    const lineCount = values.length / spacing
    const coverage = Math.min(1, lineCount / 5)
    const score = Math.max(0, strongest - baseline) * coverage
    const candidate = {
      spacing,
      origin: folded.indexOf(strongest),
      score,
    }

    candidates.push(candidate)

    if (score > strongestCandidate.score) {
      strongestCandidate = candidate
    }
  }

  const fundamentalCandidate =
    candidates
      .filter((candidate) => candidate.score >= strongestCandidate.score * 0.72)
      .sort((a, b) => a.spacing - b.spacing)[0] ?? strongestCandidate

  return fundamentalCandidate
}

const estimateOriginalSpacing = (values: number[], scale: number, originalLength: number) => {
  if (scale <= 0) {
    return {
      cellSize: 0,
      origin: 0,
      score: 0,
    }
  }

  const { mean, deviation } = meanAndDeviation(values)
  const normalized = deviation > 0 ? values.map((value) => (value - mean) / deviation) : values.map(() => 0)
  const minCellSize = 12
  const maxCellSize = Math.min(768, Math.max(36, Math.floor(originalLength / 4)))
  const candidates: Array<{ cellSize: number; origin: number; score: number }> = []
  let strongestCandidate = {
    cellSize: 0,
    origin: 0,
    score: 0,
  }

  for (let cellSize = minCellSize; cellSize <= maxCellSize; cellSize += 1) {
    const folded = foldOriginalProfile(normalized, cellSize, scale)
    const strongest = Math.max(...folded)
    const baseline = percentile(folded, 0.7)
    const lineCount = originalLength / cellSize
    const density = Math.min(1.3, Math.log2(Math.max(2, lineCount)) / 4)
    const coverage = Math.min(1, lineCount / 5)
    const score = Math.max(0, strongest - baseline) * density * coverage
    const candidate = {
      cellSize,
      origin: folded.indexOf(strongest),
      score,
    }

    candidates.push(candidate)

    if (score > strongestCandidate.score) {
      strongestCandidate = candidate
    }
  }

  return (
    candidates
      .filter((candidate) => candidate.score >= strongestCandidate.score * 0.72)
      .sort((a, b) => a.cellSize - b.cellSize)[0] ?? strongestCandidate
  )
}

const detectAxis = (
  imageData: ImageData,
  axis: 'x' | 'y',
  sampleWidth: number,
  sampleHeight: number,
  scale: number,
) => {
  const length = axis === 'x' ? sampleWidth : sampleHeight
  const span = axis === 'x' ? sampleHeight : sampleWidth
  const values = new Array(length).fill(0)

  for (let main = 1; main < length - 1; main += 1) {
    let energy = 0
    let samples = 0

    for (let cross = 0; cross < span; cross += 3) {
      const previous =
        axis === 'x'
          ? ((cross * sampleWidth + main - 1) * 4)
          : (((main - 1) * sampleWidth + cross) * 4)
      const next =
        axis === 'x'
          ? ((cross * sampleWidth + main + 1) * 4)
          : (((main + 1) * sampleWidth + cross) * 4)

      const previousLight =
        imageData.data[previous] * 0.2126 +
        imageData.data[previous + 1] * 0.7152 +
        imageData.data[previous + 2] * 0.0722
      const nextLight =
        imageData.data[next] * 0.2126 +
        imageData.data[next + 1] * 0.7152 +
        imageData.data[next + 2] * 0.0722

      energy += Math.abs(nextLight - previousLight)
      samples += 1
    }

    values[main] = samples ? energy / samples : 0
  }

  const smoothed = smooth(values, 3)
  const peaks = findPeaks(smoothed)
  const minSpacing = Math.max(10, Math.floor(length / 160))
  const maxSpacing = Math.max(36, Math.floor(length / 4))
  const peakEstimate = estimateSpacing(peaks, minSpacing, maxSpacing)
  const periodicEstimate = estimatePeriodicSpacing(smoothed, minSpacing, maxSpacing)
  const peakConfidence = peakEstimate.spacing ? peakEstimate.votes / Math.max(4, peaks.length) : 0
  const periodicConfidence = Math.min(1, periodicEstimate.score / 2.4)
  const usePeriodic = periodicEstimate.spacing && periodicConfidence >= Math.max(0.12, peakConfidence * 0.72)
  const spacing = usePeriodic ? periodicEstimate.spacing : peakEstimate.spacing
  const origin = spacing
    ? usePeriodic
      ? periodicEstimate.origin
      : foldProfile(smoothed, spacing).indexOf(Math.max(...foldProfile(smoothed, spacing)))
    : 0
  const confidence = spacing ? Math.min(1, Math.max(peakConfidence, periodicConfidence)) : 0
  const originalEstimate = estimateOriginalSpacing(smoothed, scale, length / scale)
  const originalConfidence = Math.min(1, originalEstimate.score / 2.8)
  const useOriginal =
    scale >= 0.33 &&
    originalEstimate.cellSize &&
    originalConfidence >= Math.max(0.16, confidence * 0.76)

  return {
    peaks,
    origin: useOriginal ? originalEstimate.origin * scale : origin,
    spacing: useOriginal ? originalEstimate.cellSize * scale : spacing,
    confidence: useOriginal ? Math.max(confidence, originalConfidence) : confidence,
  }
}

export const detectGridCalibrationFromImageData = (
  imageData: ImageData,
  sampleWidth: number,
  sampleHeight: number,
  scale = 1,
): Partial<GridCalibration> => {
  const xAxis = detectAxis(imageData, 'x', sampleWidth, sampleHeight, scale)
  const yAxis = detectAxis(imageData, 'y', sampleWidth, sampleHeight, scale)
  const spacing = xAxis.spacing && yAxis.spacing ? (xAxis.spacing + yAxis.spacing) / 2 : xAxis.spacing || yAxis.spacing
  const axisCount = Number(Boolean(xAxis.spacing)) + Number(Boolean(yAxis.spacing))
  const confidence =
    axisCount > 0 ? Math.min(1, ((xAxis.spacing ? xAxis.confidence : 0) + (yAxis.spacing ? yAxis.confidence : 0)) / axisCount) : 0

  if (!spacing || confidence < 0.11) {
    return {
      confidence,
      detected: false,
    }
  }

  return {
    cellSizePx: Math.round(spacing / scale),
    originX: Math.round((xAxis.origin || 0) / scale),
    originY: Math.round((yAxis.origin || 0) / scale),
    rotationDeg: 0,
    confidence,
    detected: true,
  }
}

const parseGridHint = (fileName: string | undefined, width: number, height: number) => {
  if (!fileName) {
    return undefined
  }

  const normalizedName = fileName.toLowerCase()
  const pixelHint = normalizedName.match(/(?:^|[^0-9])(\d{2,4})\s*px(?:[^a-z]|$)/)
  const hintedCellSize = pixelHint ? Number(pixelHint[1]) : undefined

  if (hintedCellSize && hintedCellSize >= 12 && hintedCellSize <= 512) {
    return hintedCellSize
  }

  const gridPairs = [...normalizedName.matchAll(/(?:^|[^0-9])(\d{1,3})\s*x\s*(\d{1,3})(?:[^0-9]|$)/g)]

  for (const pair of gridPairs) {
    const columns = Number(pair[1])
    const rows = Number(pair[2])

    if (columns < 4 || rows < 4 || columns > 200 || rows > 200) {
      continue
    }

    const xCell = width / columns
    const yCell = height / rows
    const averageCell = (xCell + yCell) / 2
    const mismatch = Math.abs(xCell - yCell) / averageCell

    if (averageCell >= 12 && averageCell <= 512 && mismatch < 0.04) {
      return Math.round(averageCell)
    }
  }

  return undefined
}

const applyGridHint = (detected: Partial<GridCalibration>, hintedCellSize: number | undefined): Partial<GridCalibration> => {
  if (!hintedCellSize) {
    return detected
  }

  return {
    ...detected,
    cellSizePx: hintedCellSize,
    originX: moduloOrigin(detected.originX ?? 0, hintedCellSize),
    originY: moduloOrigin(detected.originY ?? 0, hintedCellSize),
    confidence: Math.max(detected.confidence ?? 0, 0.98),
    detected: true,
  }
}

export const detectGridFromImage = async (
  imageUrl: string,
  options: { fileName?: string } = {},
): Promise<Partial<GridCalibration>> => {
  const image = new Image()
  if (!imageUrl.startsWith('blob:') && !imageUrl.startsWith('data:')) {
    image.crossOrigin = 'anonymous'
  }
  image.src = imageUrl

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Unable to read map image for grid detection.'))
  })

  const maxDimension = 5000
  const maxAnalysisPixels = 20_000_000
  const dimensionScale = maxDimension / Math.max(image.naturalWidth, image.naturalHeight)
  const pixelScale = Math.sqrt(maxAnalysisPixels / (image.naturalWidth * image.naturalHeight))
  const scale = Math.min(1, dimensionScale, pixelScale)
  const sampleWidth = Math.max(1, Math.round(image.naturalWidth * scale))
  const sampleHeight = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = sampleWidth
  canvas.height = sampleHeight

  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('Canvas is unavailable.')
  }

  context.drawImage(image, 0, 0, sampleWidth, sampleHeight)
  const imageData = context.getImageData(0, 0, sampleWidth, sampleHeight)
  const detected = detectGridCalibrationFromImageData(imageData, sampleWidth, sampleHeight, scale)
  return applyGridHint(detected, parseGridHint(options.fileName, image.naturalWidth, image.naturalHeight))
}
