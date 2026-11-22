/**
 * One git-changing operation per repository at a time. Tasks on the same repo each
 * have their own worktree, but they share the repo's refs and object store.
 */

const tails = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(repoPath) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  tails.set(repoPath, tail);
  void tail.then(() => {
    if (tails.get(repoPath) === tail) tails.delete(repoPath);
  });
  return next;
}
