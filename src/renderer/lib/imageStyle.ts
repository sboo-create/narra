// Ключи кэша изображений. Промпты собираются в lib/passport.ts (единый конструктор).
// IMAGE_VERSION поднимать ТОЛЬКО при смене промптов (всё перегенерируется).
export const IMAGE_VERSION = 'v10'

export function portraitKey(bookId: string, id: string): string {
  return `portrait-${bookId}-${id}-${IMAGE_VERSION}`
}
export function coverKey(bookId: string): string {
  return `cover-${bookId}-${IMAGE_VERSION}c`
}
// Версия только сцен: промпты сцен поменялись, а портреты/обложки/анимации сохраняем.
const SCENE_VERSION = 'v12'
export function sceneKey(bookId: string, chapter: number): string {
  return `scene-${bookId}-c${chapter}-${SCENE_VERSION}`
}
