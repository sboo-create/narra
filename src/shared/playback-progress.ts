export function listenedFraction(
  completedChars: number,
  currentSegmentChars: number,
  currentRatio: number,
  totalChars: number
): number {
  const boundedRatio = Math.min(1, Math.max(0, Number.isFinite(currentRatio) ? currentRatio : 0))
  const listened = Math.max(0, completedChars) + Math.max(0, currentSegmentChars) * boundedRatio
  return Math.min(1, listened / Math.max(1, totalChars))
}
