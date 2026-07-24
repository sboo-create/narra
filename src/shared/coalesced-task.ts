export class CoalescedTaskMap<K, V> {
  private readonly tasks = new Map<K, Promise<V>>()

  getOrCreate(key: K, create: () => Promise<V>): Promise<V> {
    const existing = this.tasks.get(key)
    if (existing) return existing
    let task: Promise<V>
    try {
      task = create()
    } catch (error) {
      task = Promise.reject(error)
    }
    this.tasks.set(key, task)
    void task.catch(() => {
      if (this.tasks.get(key) === task) this.tasks.delete(key)
    })
    return task
  }

  delete(key: K): void {
    this.tasks.delete(key)
  }
}
