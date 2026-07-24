import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AppStateCoordinator,
  removeBookFromAppState
} from '../src/main/app-state-coordinator.ts'

function initialState() {
  return {
    chapters: { 'u-book': 3, other: 2 },
    scenarios: { 'u-book-1': { private: 'book text' }, 'other-1': { safe: true } },
    chats: { 'u-book:hero': [{ content: 'private chat' }], 'other:hero': [] },
    memories: { 'u-book:hero': 'private memory', 'other:hero': 'keep' },
    notes: { 'u-book': [{ note: 'private note' }], other: [{ note: 'keep' }] },
    hiddenBooks: [],
    readerPrefs: { fontSize: 19 }
  }
}

test('queued whole-state write cannot restore a deleted book or lose its unrelated update', async () => {
  let state = initialState()
  const coordinator = new AppStateCoordinator(
    () => state,
    (next) => {
      state = next
    }
  )
  let releaseDelete
  let deletionStarted
  const started = new Promise((resolve) => {
    deletionStarted = resolve
  })

  const deletion = coordinator.transaction(async (current, commit) => {
    coordinator.blockBook('u-book')
    deletionStarted()
    await new Promise((resolve) => {
      releaseDelete = resolve
    })
    await commit(removeBookFromAppState(current, 'u-book'))
  })
  await started

  const rendererSnapshot = {
    ...initialState(),
    readerPrefs: { fontSize: 24 }
  }
  const concurrentWrite = coordinator.replace(rendererSnapshot)
  releaseDelete()
  await Promise.all([deletion, concurrentWrite])

  assert.deepEqual(state.chapters, { other: 2 })
  assert.deepEqual(state.scenarios, { 'other-1': { safe: true } })
  assert.deepEqual(state.chats, { 'other:hero': [] })
  assert.deepEqual(state.memories, { 'other:hero': 'keep' })
  assert.deepEqual(state.notes, { other: [{ note: 'keep' }] })
  assert.deepEqual(state.readerPrefs, { fontSize: 24 })
})

test('failed deletion can unblock future state for the still-existing book', async () => {
  let state = initialState()
  const coordinator = new AppStateCoordinator(
    () => state,
    (next) => {
      state = next
    }
  )
  await assert.rejects(
    coordinator.transaction(async () => {
      coordinator.blockBook('u-book')
      try {
        throw new Error('cache cleanup failed')
      } catch (error) {
        coordinator.unblockBook('u-book')
        throw error
      }
    }),
    /cache cleanup failed/
  )
  await coordinator.replace(initialState())
  assert.equal(state.chapters['u-book'], 3)
})
