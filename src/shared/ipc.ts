// Названия IPC-каналов — единый контракт main <-> renderer
export const IPC = {
  // контент
  loadBooks: 'content:loadBooks',

  // настройки
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  trackEvent: 'telemetry:track',
  touchTelemetrySession: 'telemetry:touchSession',

  // состояние (позиция чтения, история чатов, кэш и т.п.)
  getState: 'state:get',
  setState: 'state:set',
  deleteAllLocalData: 'privacy:deleteAllLocalData',

  // проверка прокси
  testProxy: 'test:proxy',

  // чат (стриминг через события)
  chatStart: 'chat:start',
  chatChunk: 'chat:chunk',
  chatDone: 'chat:done',
  chatError: 'chat:error',
  chatCancel: 'chat:cancel',

  // LLM без стрима
  llmJson: 'llm:json',
  llmText: 'llm:text',

  // изображения
  generateImage: 'image:generate',
  getCachedImage: 'image:getCached',
  deleteCachedImage: 'image:deleteCached',

  // озвучка
  synthesize: 'tts:synthesize',
  getCachedAudio: 'tts:getCached',

  // видео-аватар (говорящая голова)
  generateAvatar: 'avatar:generate',
  getCachedVideo: 'avatar:getCached',
  // idle-анимация портрета
  animatePortrait: 'avatar:animate',
  deleteCachedVideo: 'avatar:deleteCached',
  saveCachedVideo: 'avatar:saveCached',
  checkAppUpdate: 'app:checkUpdate',
  installUpdate: 'app:installUpdate',
  importBookFromUrl: 'books:importUrl',
  // распознавание речи
  recognize: 'asr:recognize',
  // импорт своих книг
  importBook: 'books:import',
  saveBookCharacters: 'books:saveCharacters',
  deleteBook: 'books:delete',
  bookExcerpt: 'books:excerpt'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
