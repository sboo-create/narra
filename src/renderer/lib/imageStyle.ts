// Ключи кэша изображений. Промпты собираются в lib/passport.ts (единый конструктор).
// IMAGE_VERSION поднимать ТОЛЬКО при смене промптов (всё перегенерируется).
export const IMAGE_VERSION = 'v10'

/** Ключ портрета. ВАЖНО: включает id книги — иначе одноимённые герои разных книг
 *  (Драко 17 лет из школьного фанфика и Драко 28 лет из другого) делят один портрет.
 *  Суффикс 'k' — портреты рисует Kandinsky, единым стилем со сценами и обложками. */
export function portraitKey(bookId: string, id: string): string {
  return `portrait-${bookId}-${id}-${IMAGE_VERSION}k`
}
export function coverKey(bookId: string): string {
  return `cover-${bookId}-${IMAGE_VERSION}c`
}
// Версия только сцен: промпты сцен поменялись, а портреты/обложки/анимации сохраняем.
const SCENE_VERSION = 'v13'
export function sceneKey(bookId: string, chapter: number): string {
  return `scene-${bookId}-c${chapter}-${SCENE_VERSION}`
}
